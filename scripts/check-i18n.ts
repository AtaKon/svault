import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts, { type Node, type SourceFile } from "typescript";
import { buildDynamicMatcher } from "../shared/i18n";

/**
 * Guards against translation regressions:
 * - every literal/template `t("...")` key used in the client must exist in EL
 * - static server API error messages shown through t(error.message) must exist in EL
 * - interpolated server messages are matched with the same DYNAMIC_EL matcher as runtime
 * - EL must not contain duplicate keys
 *
 * The server scan is intentionally partial: it understands ApiError,
 * OffWriteError, notFound/badRequest/forbidden/conflict and
 * `*.status(...).json({ error })`. Other error constructors, `send()`
 * responses and dynamic `t(someVariable)` client calls are not resolved.
 *
 * Interpolated messages normalize brace-like tokens the same way as EL keys,
 * mirroring DYNAMIC_EL at runtime. Literal braces in static messages are not
 * treated as placeholders.
 */

export type TranslationEntry = {
  key: string;
  file: string;
  line: number;
  kind: "client" | "server";
  reason?: "missing" | "unmatchable";
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".next" ||
      entry.name === "coverage"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function createSource(file: string, source: string): SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function forEachNode(node: Node, callback: (node: Node) => void): void {
  callback(node);
  node.forEachChild((child) => forEachNode(child, callback));
}

function lineOf(sourceFile: SourceFile, node: Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isStaticString(node: Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function propertyName(node: ts.PropertyName): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isPrivateIdentifier(node)) return node.text;
  return null;
}

/** All string variants for an argument, expanding simple conditional branches. */
export function stringVariants(node: Node): string[] {
  if (isStaticString(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return stringVariants(node.expression);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = stringVariants(node.whenTrue);
    const whenFalse = stringVariants(node.whenFalse);
    return [...whenTrue, ...whenFalse].filter((value, index, all) => all.indexOf(value) === index);
  }
  if (ts.isTemplateExpression(node)) {
    let variants = [escapeLiteralText(node.head.text)];
    for (const span of node.templateSpans) {
      const values = stringVariants(span.expression);
      if (!values.length) values.push(PLACEHOLDER_SENTINEL);
      const next: string[] = [];
      for (const prefix of variants) {
        for (const value of values) next.push(prefix + value + escapeLiteralText(span.literal.text));
      }
      variants = next;
    }
    return variants;
  }
  return [];
}

export function extractClientKeys(source: string, file = "fixture.tsx"): TranslationEntry[] {
  const sourceFile = createSource(file, source);
  const keys: TranslationEntry[] = [];
  forEachNode(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "t") return;
    const argument = node.arguments[0];
    if (!argument) return;
    const variants = stringVariants(argument);
    if (!variants.length) return;
    for (const key of variants) {
      if (!key.trim() || !/[A-Za-z\u0370-\u03ff]/.test(key)) continue;
      keys.push({ key, file, line: lineOf(sourceFile, node), kind: "client" });
    }
  });
  return keys;
}

const ERROR_HELPERS = new Set(["notFound", "badRequest", "forbidden", "conflict"]);

/** Walk a chained expression down to any `.status(...)` call. */
function hasStatusCall(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (ts.isCallExpression(current)) {
      const callee: ts.Expression = current.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "status") return true;
      current = callee;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return false;
  }
  return false;
}

/** Server messages that are later rendered through t(error.message). */
export function extractServerMessages(source: string, file = "fixture.ts"): TranslationEntry[] {
  const sourceFile = createSource(file, source);
  const messages: TranslationEntry[] = [];
  const collect = (argument: Node | undefined) => {
    if (!argument) return;
    const variants = stringVariants(argument);
    if (!variants.length) return;
    for (const key of variants) {
      if (!key.trim()) continue;
      messages.push({ key, file, line: lineOf(sourceFile, argument), kind: "server" });
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
    // res.status(...)[.type(...)].json({ error: "..." }) and any receiver
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "json" &&
      hasStatusCall(node.expression.expression)
    ) {
      const body = node.arguments[0];
      if (!body || !ts.isObjectLiteralExpression(body)) return;
      for (const property of body.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        if (name === "error") collect(property.initializer);
      }
    }
  });
  return messages;
}

/** Parse the flat `const EL = { ... }` object without evaluating it. */
export function extractDictionary(
  source: string,
  file = "i18n.tsx",
): { dictionary: Set<string>; duplicates: Set<string> } {
  const sourceFile = createSource(file, source);
  const dictionary = new Set<string>();
  const duplicates = new Set<string>();
  let found = false;
  forEachNode(sourceFile, (node) => {
    if (found || !ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== "EL") return;
    const initializer = node.initializer;
    if (!initializer || !ts.isObjectLiteralExpression(initializer)) return;
    found = true;
    for (const property of initializer.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name);
      if (key == null) continue;
      if (dictionary.has(key)) duplicates.add(key);
      dictionary.add(key);
    }
  });
  if (!found) throw new Error(`Could not locate the EL dictionary in ${file}`);
  return { dictionary, duplicates };
}

export const PLACEHOLDER_SENTINEL = "\u001f";
const LITERAL_OPEN = "\u001e";
const LITERAL_CLOSE = "\u001d";

function escapeLiteralText(text: string): string {
  return text.replaceAll("{", LITERAL_OPEN).replaceAll("}", LITERAL_CLOSE);
}

export function normalizeKey(key: string): string {
  return key.replace(/\{[A-Za-z_$][\w$]*\}/g, PLACEHOLDER_SENTINEL);
}

function placeholderCount(normalizedKey: string): number {
  return normalizedKey.split(PLACEHOLDER_SENTINEL).length - 1;
}

function normalizeEntryKey(key: string): string {
  // DYNAMIC_EL treats any brace token as a placeholder, so escaped literal
  // braces in interpolated messages are collapsed back to a placeholder for
  // shape comparison.
  return normalizeKey(key).replace(/\u001e[\s\S]*?\u001d/g, PLACEHOLDER_SENTINEL);
}

export function findMissing(dictionary: Set<string>, entries: TranslationEntry[]): TranslationEntry[] {
  const dynamicByShape = new Map<string, { regex: RegExp; names: string[] }[]>();
  for (const key of dictionary) {
    const matcher = buildDynamicMatcher(key);
    if (!matcher) continue;
    const shape = normalizeKey(key);
    const list = dynamicByShape.get(shape) ?? [];
    list.push(matcher);
    dynamicByShape.set(shape, list);
  }
  const normalizedDictionary = new Set([...dictionary].map(normalizeKey));

  const missing: TranslationEntry[] = [];
  for (const entry of entries) {
    if (dictionary.has(entry.key)) continue;

    if (!entry.key.includes(PLACEHOLDER_SENTINEL)) {
      // Static messages (client or server) must have an exact translation;
      // dynamic patterns must not mask a missing literal.
      missing.push({ ...entry, reason: "missing" });
      continue;
    }

    const normalized = normalizeEntryKey(entry.key);
    const count = placeholderCount(normalized);
    const sample = normalized.split(PLACEHOLDER_SENTINEL).join("v");
    // Match the exact normalized shape, the same placeholder count, and run
    // the shared matcher just as DYNAMIC_EL does at runtime.
    const found =
      dynamicByShape
        .get(normalized)
        ?.some((matcher) => matcher.names.length === count && matcher.regex.test(sample)) ?? false;
    if (!found) {
      const reason = normalizedDictionary.has(normalized) ? "unmatchable" : "missing";
      missing.push({ ...entry, reason });
    }
  }
  return missing;
}

export function checkRepository(repositoryRoot = root): {
  dictionary: Set<string>;
  duplicates: Set<string>;
  missing: TranslationEntry[];
} {
  const i18nSource = fs.readFileSync(path.join(repositoryRoot, "client/i18n.tsx"), "utf8");
  const { dictionary, duplicates } = extractDictionary(i18nSource, "client/i18n.tsx");

  const clientKeys: TranslationEntry[] = [];
  for (const file of walk(path.join(repositoryRoot, "client"))) {
    if (file.endsWith("i18n.tsx")) continue;
    const source = fs.readFileSync(file, "utf8");
    // Only files using the i18n hook contribute keys; this avoids treating an
    // unrelated local helper named `t` as a translation call.
    if (!/useI18n/.test(source)) continue;
    clientKeys.push(...extractClientKeys(source, path.relative(repositoryRoot, file)));
  }

  const serverMessages: TranslationEntry[] = [];
  for (const file of walk(path.join(repositoryRoot, "server"))) {
    const relative = path.relative(repositoryRoot, file);
    // Test fixtures are not production messages.
    if (relative.startsWith(`server${path.sep}tests${path.sep}`) || /\.test\.ts$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    serverMessages.push(...extractServerMessages(source, relative));
  }

  return {
    dictionary,
    duplicates,
    missing: findMissing(dictionary, [...clientKeys, ...serverMessages]),
  };
}
