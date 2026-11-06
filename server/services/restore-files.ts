import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";

export function stagedRestoreFiles(): { marker: string; staging: string; ready: boolean } {
  const marker = path.join(DATA_DIR, ".restore-pending.json");
  const staging = path.join(DATA_DIR, ".restore-staging");
  return {
    marker,
    staging,
    ready: fs.existsSync(marker) && fs.existsSync(path.join(staging, "database.json")),
  };
}

/** Replace the uploads folder with the files captured in the staged archive. */
export function applyStagedUploads(): void {
  const staging = path.join(DATA_DIR, ".restore-staging");
  fs.rmSync(path.join(DATA_DIR, "uploads"), { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });
  const stagedUploads = path.join(staging, "uploads");
  if (fs.existsSync(stagedUploads)) {
    fs.cpSync(stagedUploads, path.join(DATA_DIR, "uploads"), { recursive: true });
  }
}

/**
 * Delete all but the newest `keep` files in `dir` whose names match `pattern`.
 * Names carry ISO timestamps, so the name breaks ties between equal mtimes.
 */
export function pruneOldFiles(dir: string, pattern: RegExp, keep: number): void {
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => ({ name: entry.name, at: fs.statSync(path.join(dir, entry.name)).mtimeMs }))
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  for (const file of files.slice(Math.max(0, keep))) fs.rmSync(path.join(dir, file.name), { force: true });
}

export function clearStagedRestore(): void {
  fs.rmSync(path.join(DATA_DIR, ".restore-staging"), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, ".restore-pending.json"), { force: true });
}
