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

// The backup service stages the archive; SQLite is swapped before the next
// server start and PostgreSQL is applied during startup.
const { restoreArchiveNow } = await import("../server/services/backup.ts");
const manifest = await restoreArchiveNow(buffer);
console.log(`Restored backup from ${manifest.createdAt} (schema ${manifest.schemaVersion}). Start SVault again.`);
