import fs from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const input = arg("--in");
if (!input) {
  console.error("Usage: npm run restore -- --in svault-backup.zip");
  process.exit(1);
}
const file = path.resolve(input);
if (!fs.existsSync(file)) {
  console.error(`Backup not found: ${file}`);
  process.exit(1);
}
const buffer = fs.readFileSync(file);

// Open the service modules only after reading the archive, then close the
// SQLite handle before swapping the files so Windows can replace them.
const { db } = await import("../server/db.ts");
const { restoreArchiveNow } = await import("../server/services/backup.ts");
db.close();
const manifest = await restoreArchiveNow(buffer);
console.log(`Restored backup from ${manifest.createdAt} (schema ${manifest.schemaVersion}). Start SVault again.`);
