import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Guards against translation regressions:
 * - every literal/template `t("...")` key used in the client must exist in EL
 * - static server API error messages shown through t(error.message) must exist in EL
 * - interpolated server messages are compared with normalized `{x}` placeholders
 * - EL must not contain duplicate keys
 *
 * Dynamic `t(someVariable)` calls are intentionally skipped because their keys
 * cannot be resolved statically.
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

function createSource(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function forEachNode(node, callback) {
  callback(node);
  node.forEachChild((child) => forEachNode(child, callback));
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isStaticString(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** All string variants for an argument, expanding simple conditional branches. */
export function stringVariants(node) {
  if (isStaticString(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return stringVariants(node.expression);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = stringVariants(node.whenTrue);
    const whenFalse = stringVariants(node.whenFalse);
    return [...whenTrue, ...whenFalse].filter((value, index, all) => all.indexOf(value) === index);
  }
  if (ts.isTemplateExpression(node)) {
    let variants = [node.head.text];
    for (const span of node.templateSpans) {
      const values = stringVariants(span.expression);
      if (!values.length) values.push("{x}");
      const next = [];
      for (const prefix of variants) {
        for (const value of values) next.push(prefix + value + span.literal.text);
      }
      variants = next;
    }
    return variants;
  }
  return [];
}

export function extractClientKeys(source, file = "fixture.tsx") {
  const sourceFile = createSource(file, source);
  const keys = [];
  forEachNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "t") return;
    const argument = node.arguments[0];
    if (!argument) return;
    const variants = stringVariants(argument);
    if (!variants.length) return;
    for (const key of variants) {
      if (!key.trim() || !/[A-Za-z\u0370-\u03ff]/.test(key)) continue;
      keys.push({ key, file, line: lineOf(sourceFile, node) });
    }
  });
  return keys;
}

const ERROR_HELPERS = new Set(["notFound", "badRequest", "forbidden", "conflict"]);

/** Server messages that are later rendered through t(error.message). */
export function extractServerMessages(source, file = "fixture.ts") {
  const sourceFile = createSource(file, source);
  const messages = [];
  const collect = (argument) => {
    if (!argument) return;
    const variants = stringVariants(argument);
    if (!variants.length) return;
    for (const key of variants) {
      if (!key.trim()) continue;
      messages.push({ key, file, line: lineOf(sourceFile, argument) });
    }
  };

  forEachNode(sourceFile, (node) => {
    if (ts.isNewExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : "";
      if (name === "ApiError") collect(node.arguments?.[1]);
      else if (name === "OffWriteError") collect(node.arguments?.[0]);
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const name = ts.isIdentifier(node.expression) ? node.expression.text : "";
    if (ERROR_HELPERS.has(name)) {
      collect(node.arguments[0]);
      return;
    }
    // res.status(...).json({ error: "..." })
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "json" &&
      ts.isCallExpression(node.expression.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression.expression) &&
      node.expression.expression.expression.name.text === "status"
    ) {
      const body = node.arguments[0];
      if (!body || !ts.isObjectLiteralExpression(body)) return;
      for (const property of body.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "";
        if (propertyName === "error" || propertyName === "message") collect(property.initializer);
      }
    }
  });
  return messages;
}

/** Parse the flat `const EL = { ... }` object without evaluating it. */
export function extractDictionary(source, file = "i18n.tsx") {
  const sourceFile = createSource(file, source);
  const dictionary = new Set();
  const duplicates = new Set();
  let found = false;
  forEachNode(sourceFile, (node) => {
    if (found || !ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== "EL") return;
    const initializer = node.initializer;
    if (!initializer || !ts.isObjectLiteralExpression(initializer)) return;
    found = true;
    for (const property of initializer.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      if (key == null) continue;
      if (dictionary.has(key)) duplicates.add(key);
      dictionary.add(key);
    }
  });
  if (!found) throw new Error(`Could not locate the EL dictionary in ${file}`);
  return { dictionary, duplicates };
}

export function normalizeKey(key) {
  return key.replace(/\{[A-Za-z_$][\w$]*\}/g, "{x}");
}

export function findMissing(dictionary, entries) {
  const normalizedDictionary = new Set([...dictionary].map(normalizeKey));
  const dynamicPatterns = [];
  for (const key of dictionary) {
    if (normalizeKey(key) === key) continue;
    // Mirror DYNAMIC_EL: ignore ultra-short literal fragments such as "{count}d".
    if (key.replace(/\{[A-Za-z_$][\w$]*\}/g, "").trim().length < 2) continue;
    const pattern = normalizeKey(key)
      .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
      .replace(/\{x\}/g, "[\\s\\S]*");
    dynamicPatterns.push(new RegExp("^" + pattern + "$"));
  }

  const missing = [];
  for (const entry of entries) {
    const dynamic = normalizeKey(entry.key) !== entry.key || entry.key.includes("{x}");
    let found;
    if (dynamic) {
      found = normalizedDictionary.has(normalizeKey(entry.key));
    } else {
      found = dictionary.has(entry.key) || dynamicPatterns.some((pattern) => pattern.test(entry.key));
    }
    if (!found) missing.push(entry);
  }
  return missing;
}

export function checkRepository(repositoryRoot = root) {
  const i18nSource = fs.readFileSync(path.join(repositoryRoot, "client/i18n.tsx"), "utf8");
  const { dictionary, duplicates } = extractDictionary(i18nSource, "client/i18n.tsx");

  const clientKeys = [];
  for (const file of walk(path.join(repositoryRoot, "client"))) {
    if (file.endsWith("i18n.tsx")) continue;
    const source = fs.readFileSync(file, "utf8");
    clientKeys.push(...extractClientKeys(source, path.relative(repositoryRoot, file)));
  }

  const serverMessages = [];
  for (const file of walk(path.join(repositoryRoot, "server"))) {
    const source = fs.readFileSync(file, "utf8");
    serverMessages.push(...extractServerMessages(source, path.relative(repositoryRoot, file)));
  }

  return {
    dictionary,
    duplicates,
    missing: findMissing(dictionary, [...clientKeys, ...serverMessages]),
  };
}

function main() {
  const repositoryRoot = process.env.SV_I18N_ROOT ? path.resolve(process.env.SV_I18N_ROOT) : root;
  const { dictionary, duplicates, missing } = checkRepository(repositoryRoot);

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
