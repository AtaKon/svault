import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { APP_VERSION, BACKUP_DIR, DATA_DIR, SCHEMA_VERSION, UPLOAD_DIR, ensureDirs } from "../config.js";
import { all, databaseKind, exec, get, tables } from "../db.js";

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

function pruneBackups(keep = 5) {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => /^svault-backup-.*\.zip$/.test(name))
    .map((name) => ({ name, at: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const file of files.slice(keep)) fs.rmSync(path.join(BACKUP_DIR, file.name), { force: true });
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

/**
 * Build a consistent snapshot, checksum every uploaded file and zip everything
 * with a manifest. SQLite keeps its raw file (format 1); PostgreSQL uses a
 * logical JSON dump (format 2) because a database server has no single file to
 * copy. Also leaves a timestamped copy in DATA_DIR/backups.
 */
export async function createBackupArchive(opts: { keepLocal?: boolean } = {}): Promise<{ buffer: Buffer; name: string }> {
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const postgres = databaseKind() === "postgres";
  let database: Buffer;
  let snapshot: string | null = null;
  try {
    if (postgres) {
      database = await logicalDump();
    } else {
      snapshot = path.join(BACKUP_DIR, `.snapshot-${stamp}.db`);
      await exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      database = fs.readFileSync(snapshot);
    }

    const files = walk(UPLOAD_DIR);
    const zip = new JSZip();
    zip.file(postgres ? "database.json" : "svault.db", database);
    const uploads: Record<string, string> = {};
    for (const file of files) {
      const data = fs.readFileSync(file.absolute);
      uploads[file.relative] = sha256(data);
      zip.file(`uploads/${file.relative}`, data);
    }
    const manifest: BackupManifest = {
      format: postgres ? 2 : 1,
      appVersion: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      counts: await countRows(),
      checksums: { database: sha256(database), uploads },
    };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const name = `svault-backup-${stamp}.zip`;
    if (opts.keepLocal !== false) {
      fs.writeFileSync(path.join(BACKUP_DIR, name), buffer);
      pruneBackups(5);
    }
    return { buffer, name };
  } finally {
    if (snapshot) fs.rmSync(snapshot, { force: true });
  }
}

export function listBackups() {
  ensureDirs();
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => /^svault-backup-.*\.zip$/.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
export async function restoreArchiveNow(buffer: Buffer) {
  const validation = await validateBackup(buffer);
  stageRestore(validation);
  if (validation.database) {
    // SQLite swaps the file before the next open; callers run this before start.
    const { applyPendingSqliteRestore } = await import("../database/sqlite.js");
    applyPendingSqliteRestore();
  }
  return validation.manifest;
}

/** Build an archive from the current data and return its manifest for tests. */
export async function backupForTest() {
  const { buffer } = await createBackupArchive({ keepLocal: false });
  const validation = await validateBackup(buffer);
  return { buffer, validation };
}
