import path from "node:path";
import { initDb, closeDb } from "../server/db.ts";
import { createBackupArchive } from "../server/services/backup.ts";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

await initDb();
const out = path.resolve(arg("--out", `svault-backup-${new Date().toISOString().slice(0, 10)}.zip`));
// The archive is streamed straight to --out; it is not added to the in-app rotation.
let archive;
try {
  archive = await createBackupArchive({ outFile: out });
} finally {
  await closeDb();
}
console.log(`Backup written to ${archive.path} (${archive.size} bytes)`);
