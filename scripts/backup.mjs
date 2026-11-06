import fs from "node:fs";
import path from "node:path";
import { initDb, closeDb } from "../server/db.ts";
import { createBackupArchive } from "../server/services/backup.ts";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

await initDb();
const out = path.resolve(arg("--out", `svault-backup-${new Date().toISOString().slice(0, 10)}.zip`));
const { buffer, name } = await createBackupArchive({ keepLocal: false });
await closeDb();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buffer);
console.log(`Backup written to ${out} (${buffer.length} bytes, ${name})`);
