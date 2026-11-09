import { pathToFileURL } from "node:url";
import { checkRepository } from "./check-i18n";

/** Explicit entrypoint for `npm test`; always scans the repository root. */
export function runI18nCheck(): void {
  const { dictionary, duplicates, missing } = checkRepository();

  if (duplicates.size > 0) {
    console.error("Duplicate EL keys:");
    for (const key of duplicates) console.error(`  ${JSON.stringify(key)}`);
  }
  if (missing.length > 0) {
    console.error("Missing EL translations:");
    for (const entry of missing) console.error(`  ${entry.file}:${entry.line}: ${JSON.stringify(entry.key)}`);
  }
  if (duplicates.size > 0 || missing.length > 0) process.exit(1);

  console.log(`i18n check passed (${dictionary.size} EL keys).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runI18nCheck();
}
