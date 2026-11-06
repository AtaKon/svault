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

export function clearStagedRestore(): void {
  fs.rmSync(path.join(DATA_DIR, ".restore-staging"), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, ".restore-pending.json"), { force: true });
}
