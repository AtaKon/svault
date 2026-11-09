import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards against translation regressions:
 * - every literal t("...") key used in the client must exist in EL
 * - every static server API error message shown through t(error.message) must exist in EL
 * - EL must not contain duplicate keys
 *
 * Dynamic t(variable) keys and interpolated server messages are intentionally
 * skipped; they cannot be resolved statically.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const i18nFile = path.join(root, "client/i18n.tsx");
const i18n = fs.readFileSync(i18nFile, "utf8");
const elStart = i18n.indexOf("const EL");
const elEnd = i18n.indexOf("const DYNAMIC_EL");
if (elStart < 0 || elEnd < 0) {
  console.error("Could not locate the EL dictionary in client/i18n.tsx");
  process.exit(1);
}
const elBody = i18n.slice(elStart, elEnd);

const dictionary = new Set();
const duplicates = new Set();
for (const match of elBody.matchAll(
  /^\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([A-Za-z_$][\w$]*))\s*:/gm,
)) {
  const key = match[1] ?? match[2] ?? match[3];
  if (dictionary.has(key)) duplicates.add(key);
  dictionary.add(key);
}

const missing = [];
for (const file of walk(path.join(root, "client"))) {
  if (file === i18nFile) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
    const key = match[2].replace(/\\(["'\\])/g, "$1");
    if (!key.trim() || !/[A-Za-z\u0370-\u03ff]/.test(key)) continue;
    if (!dictionary.has(key)) missing.push(`${path.relative(root, file)}: ${JSON.stringify(key)}`);
  }
}

for (const file of walk(path.join(root, "server"))) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(
    /new (?:ApiError|OffWriteError)\(\s*(?:\d+\s*,\s*)?(?:"((?:\\.|[^"])*)"|`((?:\\.|[^`])*)`)/g,
  )) {
    const key = match[1] ?? match[2];
    if (!key || key.includes("${")) continue;
    if (!dictionary.has(key)) missing.push(`${path.relative(root, file)}: ${JSON.stringify(key)}`);
  }
}

if (duplicates.size > 0) {
  console.error("Duplicate EL keys:");
  for (const key of duplicates) console.error(`  ${JSON.stringify(key)}`);
}
if (missing.length > 0) {
  console.error("Missing EL translations:");
  for (const entry of missing) console.error(`  ${entry}`);
}
if (duplicates.size > 0 || missing.length > 0) process.exit(1);

console.log(`i18n check passed (${dictionary.size} EL keys).`);
