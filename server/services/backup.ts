import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import {
  APP_VERSION,
  BACKUP_DIR,
  BACKUP_KEEP,
  DATA_DIR,
  PRE_RESTORE_DIR,
  PRE_RESTORE_KEEP,
  SCHEMA_VERSION,
  UPLOAD_DIR,
  ensureDirs,
} from "../config.js";
import { all, closeDb, databaseKind, exec, get, initDb, tables } from "../db.js";
import { pruneOldFiles } from "./restore-files.js";

export interface BackupManifest {
  format: 1 | 2;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  counts: { items: number; photos: number; recipes: number; users: number };
  checksums: { database: string; uploads: Record<string, string> };
}

export interface LogicalDump {
  format: 2;
  schemaVersion: number;
  tables: Record<string, Record<string, unknown>[]>;
}

export interface BackupValidation {
  manifest: BackupManifest;
  /** Present for SQLite archives (format 1). */
  database?: Buffer;
  /** Present for logical archives (format 2), used by PostgreSQL. */
  dump?: LogicalDump;
  uploads: { name: string; data: Buffer }[];
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function walk(dir: string, base = dir): { relative: string; absolute: string }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { relative: string; absolute: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(absolute, base));
    else if (entry.isFile()) out.push({ relative: path.relative(base, absolute).replace(/\\/g, "/"), absolute });
  }
  return out;
}

function safeEntryName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !normalized.split("/").includes("..");
}

function countRows(): Promise<{ items: number; photos: number; recipes: number; users: number }> {
  return (async () => {
    const [items, photos, recipes, users] = await Promise.all([
      get<{ n: number }>("SELECT COUNT(*) AS n FROM items"),
      get<{ n: number }>("SELECT COUNT(*) AS n FROM photos"),
      get<{ n: number }>("SELECT COUNT(*) AS n FROM recipes"),
      get<{ n: number }>("SELECT COUNT(*) AS n FROM users"),
    ]);
    return {
      items: Number(items?.n ?? 0),
      photos: Number(photos?.n ?? 0),
      recipes: Number(recipes?.n ?? 0),
      users: Number(users?.n ?? 0),
    };
  })();
}

/** Copy every table into a JSON document for a backend-independent logical dump. */
async function logicalDump(): Promise<Buffer> {
  const names = (await tables()).filter((name) => name !== "schema_meta").sort();
  const dump: LogicalDump = { format: 2, schemaVersion: SCHEMA_VERSION, tables: {} };
  for (const name of names) {
    dump.tables[name] = await all<Record<string, unknown>>(`SELECT * FROM ${quoteIdent(name)}`);
  }
  return Buffer.from(JSON.stringify(dump), "utf8");
}

/** SHA-256 of a file, read as a stream so large uploads never sit in memory. */
async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  // pipeline destroys the read stream on error, so a failed read never leaks it.
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * A readable that opens its file on the first read. JSZip binds every stream
 * when the entry is added but drains them one at a time, so this keeps at most
 * one upload open (and one chunk buffered) however many photos there are.
 */
class LazyFileStream extends Readable {
  private source: fs.ReadStream | null = null;

  constructor(private readonly file: string) {
    super();
  }

  override _read() {
    if (this.source) {
      this.source.resume();
      return;
    }
    this.source = fs.createReadStream(this.file);
    this.source
      .on("data", (chunk) => {
        if (!this.push(chunk)) this.source?.pause();
      })
      .on("end", () => this.push(null))
      .on("error", (error) => this.destroy(error));
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.source?.destroy();
    callback(error);
  }
}

export interface BackupArchive {
  /** Absolute path of the finished zip. */
  path: string;
  name: string;
  size: number;
}

export type BackupKind = "backup" | "pre-restore";

export interface BackupListEntry {
  name: string;
  kind: BackupKind;
  size: number;
  createdAt: string;
}

const BACKUP_PATTERN = /^svault-backup-.*\.zip$/;
const PRE_RESTORE_PATTERN = /^pre-restore-.*\.zip$/;

/** ISO time plus a short random suffix, so two backups in the same millisecond never share a name. */
function backupStamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

const STALE_SCRATCH_MS = 60 * 60 * 1000;

/**
 * Remove scratch files a crashed backup left behind: the `.snapshot-*.db`
 * SQLite copy and half-written `*.partial` zips. Neither matches a rotation
 * pattern, so without this they would stay forever. Only files older than an
 * hour are touched, so a backup running in parallel keeps its own.
 */
function removeStaleScratch(dir: string) {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - STALE_SCRATCH_MS;
  for (const name of fs.readdirSync(dir)) {
    if (!/^\.snapshot-.*\.db$/.test(name) && !name.endsWith(".partial")) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  }
}

/**
 * Build a consistent snapshot, checksum every uploaded file and stream a zip
 * with a manifest to `target`. SQLite keeps its raw file (format 1);
 * PostgreSQL uses a logical JSON dump (format 2) because a database server has
 * no single file to copy. Uploads are hashed in a first streaming pass (the
 * manifest needs the checksums) and then streamed into the archive, so memory
 * use does not grow with the size of the uploads folder. The zip is written to
 * a `.partial` file and renamed when complete, so rotation and listings never
 * see a half-written archive. Only UPLOAD_DIR is walked: BACKUP_DIR (and its
 * pre-restore copies) never ends up inside an archive.
 */
async function writeArchive(target: string): Promise<BackupArchive> {
  ensureDirs();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  removeStaleScratch(BACKUP_DIR);
  removeStaleScratch(PRE_RESTORE_DIR);
  removeStaleScratch(path.dirname(target));
  const stamp = backupStamp();
  const postgres = databaseKind() === "postgres";
  const partial = `${target}.partial`;
  let snapshot: string | null = null;
  try {
    const zip = new JSZip();
    let databaseChecksum: string;
    if (postgres) {
      const dump = await logicalDump();
      databaseChecksum = sha256(dump);
      zip.file("database.json", dump);
    } else {
      snapshot = path.join(BACKUP_DIR, `.snapshot-${stamp}.db`);
      await exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      databaseChecksum = await sha256File(snapshot);
      zip.file("svault.db", new LazyFileStream(snapshot), { binary: true });
    }

    const uploads: Record<string, string> = {};
    for (const file of walk(UPLOAD_DIR)) {
      uploads[file.relative] = await sha256File(file.absolute);
      zip.file(`uploads/${file.relative}`, new LazyFileStream(file.absolute), { binary: true });
    }
    const manifest: BackupManifest = {
      format: postgres ? 2 : 1,
      appVersion: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      counts: await countRows(),
      checksums: { database: databaseChecksum, uploads },
    };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));

    await pipeline(
      zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE" }),
      fs.createWriteStream(partial),
    );
    fs.renameSync(partial, target);
    return { path: target, name: path.basename(target), size: fs.statSync(target).size };
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  } finally {
    if (snapshot) fs.rmSync(snapshot, { force: true });
  }
}

/**
 * Write a regular backup. By default it lands in BACKUP_DIR as
 * `svault-backup-<stamp>.zip` and the newest BACKUP_KEEP copies are kept.
 * Pass `outFile` to write somewhere else (the CLI does); that file is not
 * rotated. Pre-restore safety copies are never counted by this rotation.
 */
export async function createBackupArchive(opts: { outFile?: string } = {}): Promise<BackupArchive> {
  if (opts.outFile) return writeArchive(path.resolve(opts.outFile));
  const archive = await writeArchive(path.join(BACKUP_DIR, `svault-backup-${backupStamp()}.zip`));
  pruneOldFiles(BACKUP_DIR, BACKUP_PATTERN, BACKUP_KEEP);
  return archive;
}

/**
 * Safety copy of the current data, taken before a restore replaces it. Stored
 * as `pre-restore-<stamp>.zip` in BACKUP_DIR/pre-restore and rotated on its
 * own (newest PRE_RESTORE_KEEP, env SV_PRE_RESTORE_KEEP, default 3).
 */
export async function createPreRestoreCopy(): Promise<BackupArchive> {
  const archive = await writeArchive(path.join(PRE_RESTORE_DIR, `pre-restore-${backupStamp()}.zip`));
  pruneOldFiles(PRE_RESTORE_DIR, PRE_RESTORE_PATTERN, PRE_RESTORE_KEEP);
  return archive;
}

function listDir(dir: string, pattern: RegExp, kind: BackupKind): BackupListEntry[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => {
      const stat = fs.statSync(path.join(dir, entry.name));
      return { name: entry.name, kind, size: stat.size, createdAt: stat.mtime.toISOString() };
    });
}

/** Retained regular backups and pre-restore safety copies, newest first. */
export function listBackups(): BackupListEntry[] {
  ensureDirs();
  return [
    ...listDir(BACKUP_DIR, BACKUP_PATTERN, "backup"),
    ...listDir(PRE_RESTORE_DIR, PRE_RESTORE_PATTERN, "pre-restore"),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

/** Validate the archive without touching live data. */
export async function validateBackup(buffer: Buffer): Promise<BackupValidation> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("This file is not a readable zip archive");
  }
  for (const name of Object.keys(zip.files)) {
    if (!safeEntryName(name)) throw new Error(`Unsafe archive path: ${name}`);
  }
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("The archive has no manifest.json");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await manifestFile.async("string"));
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  if (manifest.format !== 1 && manifest.format !== 2) throw new Error("Unsupported backup format");
  if (Number(manifest.schemaVersion) > SCHEMA_VERSION) {
    throw new Error(`This backup uses schema ${manifest.schemaVersion}; this server supports up to ${SCHEMA_VERSION}`);
  }

  const uploads: { name: string; data: Buffer }[] = [];
  for (const [name, expected] of Object.entries(manifest.checksums?.uploads ?? {})) {
    if (!/^uploads\//.test(`uploads/${name}`)) continue;
    const entry = zip.file(`uploads/${name}`);
    if (!entry) throw new Error(`Upload is missing from the archive: ${name}`);
    const data = await entry.async("nodebuffer");
    if (sha256(data) !== expected) throw new Error(`Checksum failed for upload: ${name}`);
    uploads.push({ name, data });
  }

  const live = databaseKind();
  if (manifest.format === 1) {
    if (live !== "sqlite") {
      throw new Error("This is a SQLite backup. Restore it on a server using SQLite.");
    }
    const dbFile = zip.file("svault.db");
    if (!dbFile) throw new Error("The archive has no svault.db");
    const database = await dbFile.async("nodebuffer");
    if (manifest.checksums?.database && sha256(database) !== manifest.checksums.database) {
      throw new Error("The database checksum does not match the manifest");
    }
    const temp = path.join(BACKUP_DIR, `.validate-${Date.now()}.db`);
    fs.writeFileSync(temp, database);
    try {
      const check = new DatabaseSync(temp);
      try {
        const integrity = check.prepare("PRAGMA integrity_check").get() as any;
        if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("The SQLite snapshot is not valid");
        const table = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
        if (!table) throw new Error("The snapshot is missing SVault tables");
      } finally {
        check.close();
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return { manifest, database, uploads };
  }

  if (live !== "postgres") {
    throw new Error("This is a PostgreSQL backup. Restore it on a server using PostgreSQL.");
  }
  const dumpFile = zip.file("database.json");
  if (!dumpFile) throw new Error("The archive has no database.json");
  const raw = await dumpFile.async("nodebuffer");
  if (manifest.checksums?.database && sha256(raw) !== manifest.checksums.database) {
    throw new Error("The database checksum does not match the manifest");
  }
  let dump: LogicalDump;
  try {
    dump = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("database.json is not valid JSON");
  }
  if (dump.format !== 2 || typeof dump.tables !== "object" || !dump.tables) {
    throw new Error("database.json does not contain a SVault logical dump");
  }
  if (!dump.tables.users) throw new Error("The dump is missing SVault tables");
  return { manifest, dump, uploads };
}

/** Write a validated backup to a staging folder. The next server start applies it. */
export function stageRestore(validation: BackupValidation): string {
  const staging = path.join(DATA_DIR, ".restore-staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, "uploads"), { recursive: true });
  if (validation.database) fs.writeFileSync(path.join(staging, "svault.db"), validation.database);
  if (validation.dump) fs.writeFileSync(path.join(staging, "database.json"), JSON.stringify(validation.dump));
  for (const upload of validation.uploads) {
    const target = path.join(staging, "uploads", upload.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, upload.data);
  }
  fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(validation.manifest, null, 2));
  const marker = path.join(DATA_DIR, ".restore-pending.json");
  fs.writeFileSync(
    marker,
    JSON.stringify({ format: validation.manifest.format, stagedAt: new Date().toISOString(), manifest: validation.manifest }, null, 2),
  );
  return staging;
}

/** Copy staged uploads into place. Shared by both restore paths. */
/** CLI path: apply an archive immediately when no server is running. */
export async function restoreArchiveNow(
  buffer: Buffer,
  opts: { safetyCopy?: boolean } = {},
): Promise<{ manifest: BackupManifest; safetyCopy: BackupArchive | null }> {
  const validation = await validateBackup(buffer);
  // Same safety net as the in-app restore: a pre-restore zip of the current
  // data, rotated separately from regular backups. Taken only after the
  // archive validated, so a bad file never rotates an older copy away.
  let safetyCopy: BackupArchive | null = null;
  if (opts.safetyCopy) {
    try {
      await initDb();
    } catch (error) {
      throw new Error(
        `Could not open the current database to take a pre-restore safety copy: ${
          error instanceof Error ? error.message : String(error)
        }. Fix the connection, or pass --no-safety-copy to restore without one.`,
      );
    }
    try {
      safetyCopy = await createPreRestoreCopy();
    } finally {
      await closeDb();
    }
  }
  stageRestore(validation);
  if (validation.database) {
    // SQLite swaps the file before the next open; callers run this before start.
    const { applyPendingSqliteRestore } = await import("../database/sqlite.js");
    applyPendingSqliteRestore();
  }
  return { manifest: validation.manifest, safetyCopy };
}

/** Build an archive from the current data and return its manifest for tests. */
export async function backupForTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svault-backup-test-"));
  try {
    const archive = await createBackupArchive({ outFile: path.join(dir, "backup.zip") });
    const buffer = fs.readFileSync(archive.path);
    const validation = await validateBackup(buffer);
    return { buffer, validation };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
