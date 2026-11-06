import fs from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const input = arg("--in");
if (!input) {
  console.error("Usage: npm run restore -- --in svault-backup.zip [--no-safety-copy]");
  process.exit(1);
}
const file = path.resolve(input);
if (!fs.existsSync(file)) {
  console.error(`Backup not found: ${file}`);
  process.exit(1);
}
const buffer = fs.readFileSync(file);

// Like the in-app restore, keep a pre-restore safety copy of the current data
// in DATA_DIR/backups/pre-restore (rotated separately, SV_PRE_RESTORE_KEEP).
// A fresh SQLite install has nothing to copy; --no-safety-copy skips it when
// the current database cannot be opened.
const { DB_FILE, DATABASE_KIND } = await import("../server/config.ts");
const safetyCopy =
  !process.argv.includes("--no-safety-copy") && (DATABASE_KIND === "postgres" || fs.existsSync(DB_FILE));

// The backup service stages the archive; SQLite is swapped before the next
// server start and PostgreSQL is applied during startup.
const { restoreArchiveNow } = await import("../server/services/backup.ts");
const result = await restoreArchiveNow(buffer, { safetyCopy });
if (result.safetyCopy) console.log(`Safety copy of the previous data: ${result.safetyCopy.path}`);
console.log(
  `Restored backup from ${result.manifest.createdAt} (schema ${result.manifest.schemaVersion}). Start SVault again.`,
);
