import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDynamicMatcher, isDynamicTranslationKey, matchDynamicTranslation } from "../shared/i18n.ts";
import {
  checkRepository,
  extractClientKeys,
  extractDictionary,
  extractServerMessages,
  findMissing,
  PLACEHOLDER_SENTINEL,
} from "./check-i18n.ts";

test("extracts single-line and multi-line t() keys", () => {
  const keys = extractClientKeys(`
    const short = t("Short key");
    const long = t(
      "A long description that spans \\
      multiple source lines"
    );
  `);
  assert.deepEqual(
    keys.map((entry) => entry.key),
    ["Short key", "A long description that spans       multiple source lines"],
  );
});

test("ignores t() lookalikes in comments and strings", () => {
  const keys = extractClientKeys(`
    // t("Commented key")
    /* t("Block commented key") */
    const example = 'call t("String example")';
    const real = t("Real key");
  `);
  assert.deepEqual(keys.map((entry) => entry.key), ["Real key"]);
});

test("extracts no-substitution template literals", () => {
  const keys = extractClientKeys("const label = t(`Template key`);");
  assert.deepEqual(keys.map((entry) => entry.key), ["Template key"]);
});

test("reports missing keys, including multi-line ones", () => {
  const source = `
    const a = t("Present");
    const b = t(
      "Missing multi-line"
    );
  `;
  const dictionary = new Set(["Present"]);
  const missing = findMissing(dictionary, extractClientKeys(source));
  assert.deepEqual(missing.map((entry) => entry.key), ["Missing multi-line"]);
});

test("detects duplicate EL keys", () => {
  const { dictionary, duplicates } = extractDictionary(`
    const EL = {
      Present: "one",
      "Quoted key": "two",
      Present: "three",
      "Quoted key": "four",
    };
  `);
  assert.equal(dictionary.size, 2);
  assert.deepEqual([...duplicates].sort(), ["Present", "Quoted key"]);
});

test("extracts literal and helper-based server errors", () => {
  const messages = extractServerMessages(`
    throw new ApiError(400, "Literal error");
    throw new OffWriteError("Write error", { retryable: true });
    notFound("Helper error");
    badRequest("Bad request error");
    res.status(500).json({ error: "JSON error" });
  `);
  assert.deepEqual(
    messages.map((entry) => entry.key),
    ["Literal error", "Write error", "Helper error", "Bad request error", "JSON error"],
  );
});

test("normalizes interpolated and conditional server messages", () => {
  const messages = extractServerMessages(`
    throw new ApiError(429, \`Daily limit (\${limit}). Try again tomorrow.\`);
    throw new ApiError(503, \`Could not reach \${service === "prices" ? "Open Prices" : "Folksonomy"}\`);
  `);
  assert.deepEqual(
    messages.map((entry) => entry.key),
    [
      `Daily limit (${PLACEHOLDER_SENTINEL}). Try again tomorrow.`,
      "Could not reach Open Prices",
      "Could not reach Folksonomy",
    ],
  );

  const dictionary = new Set([
    "Daily limit ({count}). Try again tomorrow.",
    "Could not reach Open Prices",
    "Could not reach Folksonomy",
  ]);
  assert.deepEqual(findMissing(dictionary, messages), []);
});

test("extracts JSON errors through chained status calls", () => {
  const messages = extractServerMessages(`
    res.status(400).type("json").json({ error: "Chained error" });
    reply.status(500).json({ error: "Reply error" });
    res.json({ error: "No status call" });
  `);
  assert.deepEqual(messages.map((entry) => entry.key), ["Chained error", "Reply error"]);
});

test("flags dynamic messages the dictionary cannot match", () => {
  const messages = extractServerMessages("throw new ApiError(400, `X ${one} of ${two}`);");
  assert.deepEqual(messages.map((entry) => entry.key), [`X ${PLACEHOLDER_SENTINEL} of ${PLACEHOLDER_SENTINEL}`]);

  const twoPlaceholders = new Set(["X {a} of {b}"]);
  assert.deepEqual(findMissing(twoPlaceholders, messages), []);

  const threePlaceholders = new Set(["X {a} of {b} of {c}"]);
  assert.equal(findMissing(threePlaceholders, messages).length, 1);
});

test("requires matching placeholder counts for server messages", () => {
  const messages = extractServerMessages("throw new ApiError(400, `Value ${one}`);");
  assert.deepEqual(messages.map((entry) => entry.key), [`Value ${PLACEHOLDER_SENTINEL}`]);
  assert.deepEqual(findMissing(new Set(["Value {a}"]), messages), []);
  assert.equal(findMissing(new Set(["Value {a} of {b}"]), messages).length, 1);
});

test("excludes ultra-short dynamic keys like {count}d", () => {
  assert.equal(buildDynamicMatcher("{count}d"), null);
  assert.equal(buildDynamicMatcher("{count}d ago")?.regex.test("3d ago"), true);

  const dictionary = new Set(["{count}d"]);
  const unrelated = { key: "Catalogue sync failed", file: "fixture", line: 1 };
  const missing = findMissing(dictionary, [unrelated]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].key, "Catalogue sync failed");
  assert.equal(missing[0].reason, "missing");
});

test("rejects lossy adjacent-placeholder matches", () => {
  const messages = extractServerMessages("throw new ApiError(400, `Value: ${one}`);");
  assert.deepEqual(messages.map((entry) => entry.key), [`Value: ${PLACEHOLDER_SENTINEL}`]);
  assert.equal(findMissing(new Set(["Value: {a}{b}"]), messages).length, 1);
});

test("flags client template calls that would bypass DYNAMIC_EL", () => {
  const keys = extractClientKeys("const label = t(`${count}d`);");
  assert.deepEqual(keys.map((entry) => entry.key), [PLACEHOLDER_SENTINEL + "d"]);
  const unmatchable = findMissing(new Set(["{count}d"]), keys);
  assert.equal(unmatchable.length, 1);
  assert.equal(unmatchable[0].reason, "unmatchable");
  assert.equal(findMissing(new Set(), keys)[0].reason, "missing");
});

test("accepts client dynamic keys that the runtime can match", () => {
  const keys = extractClientKeys("const label = t(`${count} items`);");
  assert.deepEqual(keys.map((entry) => entry.key), [PLACEHOLDER_SENTINEL + " items"]);
  assert.deepEqual(findMissing(new Set(["{count} items"]), keys), []);
});

test("covers dynamic key boundary shapes", () => {
  assert.equal(isDynamicTranslationKey("{count} d"), false);
  assert.equal(isDynamicTranslationKey("{a} {b}"), false);
  assert.equal(isDynamicTranslationKey("{a}{b}"), false);
  assert.equal(isDynamicTranslationKey("{x}"), false);
  assert.equal(isDynamicTranslationKey("{field}: {message}"), true);
  assert.equal(isDynamicTranslationKey("{count} items"), true);
  assert.equal(buildDynamicMatcher("{count} d"), null);
  assert.equal(buildDynamicMatcher("{a} {b}"), null);
  assert.equal(buildDynamicMatcher("{x}"), null);
  assert.notEqual(buildDynamicMatcher("{field}: {message}"), null);
  assert.notEqual(buildDynamicMatcher("{count} items"), null);
});

test("checkRepository passes on the repository and fails on a fixture", () => {
  assert.equal(checkRepository().missing.length, 0);

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "svault-i18n-"));
  try {
    fs.mkdirSync(path.join(fixture, "client"), { recursive: true });
    fs.mkdirSync(path.join(fixture, "server/tests"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "client/i18n.tsx"), 'const EL = { Present: "ok" };');
    fs.writeFileSync(
      path.join(fixture, "client/page.tsx"),
      'const { t } = useI18n();\nconst a = t("Present");\nconst b = t("Missing key");',
    );
    fs.writeFileSync(
      path.join(fixture, "client/helper.ts"),
      'function t(value: string) { return value; }\nconst ignored = t("Ignore helper");',
    );
    fs.writeFileSync(
      path.join(fixture, "server/tests/api.test.ts"),
      'throw new ApiError(400, "Ignore test fixture");',
    );
    assert.deepEqual(checkRepository(fixture).missing.map((entry) => entry.key), ["Missing key"]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("SV_I18N_ROOT cannot redirect the default scan", () => {
  const original = process.env.SV_I18N_ROOT;
  process.env.SV_I18N_ROOT = "/does/not/exist";
  try {
    assert.equal(checkRepository().missing.length, 0);
  } finally {
    if (original === undefined) delete process.env.SV_I18N_ROOT;
    else process.env.SV_I18N_ROOT = original;
  }
});

test("static server messages require an exact translation", () => {
  const messages = extractServerMessages('throw new ApiError(404, "Widget failed");');
  assert.equal(findMissing(new Set(["Widget failed"]), messages).length, 0);
  assert.equal(findMissing(new Set(["{field} failed"]), messages).length, 1);
});

test("run-i18n-check is import-safe", async () => {
  const module = await import("./run-i18n-check.ts");
  assert.equal(typeof module.runI18nCheck, "function");
});

test("rejects dynamic messages with extra literal text", () => {
  const messages = extractServerMessages("throw new ApiError(400, `Value ${one} of`);");
  assert.deepEqual(messages.map((entry) => entry.key), [`Value ${PLACEHOLDER_SENTINEL} of`]);
  assert.equal(findMissing(new Set(["Value {a}"]), messages).length, 1);
});

test("does not treat literal braces as placeholders", () => {
  const messages = extractServerMessages('throw new ApiError(400, "Literal {x} text");');
  assert.deepEqual(messages.map((entry) => entry.key), ["Literal {x} text"]);
  assert.deepEqual(findMissing(new Set(["Literal {x} text"]), messages), []);
  assert.equal(findMissing(new Set(["Literal {count} text"]), messages).length, 1);
});

test("normalizes braces in interpolated messages like runtime", () => {
  const messages = extractServerMessages("throw new ApiError(400, `Bad JSON {x}: ${detail}`);");
  // DYNAMIC_EL treats every brace token as a placeholder, so the checker mirrors
  // that for interpolated messages.
  assert.deepEqual(findMissing(new Set(["Bad JSON {x}: {detail}"]), messages), []);
});

test("keeps literal short dynamic keys available for exact lookup", () => {
  const { dictionary } = extractDictionary(fs.readFileSync(path.join(process.cwd(), "client/i18n.tsx"), "utf8"));
  assert.ok(dictionary.has("{count}d"));
});

test("classifies same-shape but unusable dynamic keys as unmatchable", () => {
  const messages = extractServerMessages("throw new ApiError(400, `${first} ${second}`);");
  const missing = findMissing(new Set(["{a} {b}"]), messages);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].reason, "unmatchable");
});

test("substitutes dynamic placeholders at runtime", () => {
  const matcher = buildDynamicMatcher("Queued {count} contributions");
  assert.ok(matcher);
  assert.deepEqual(matchDynamicTranslation("Queued 3 contributions", matcher), { count: "3" });
  assert.equal(matchDynamicTranslation("No match", matcher), null);
});

test("counts multiple literal brace groups with interpolations", () => {
  const messages = extractServerMessages("throw new ApiError(400, `Bad ${first} and {x}{y} and ${second}`);");
  assert.deepEqual(
    findMissing(new Set(["Bad {a} and {x}{y} and {b}"]), messages),
    [],
  );
});

test("does not extract unrecognized error helpers", () => {
  const messages = extractServerMessages('unauthorized("Nope"); tooManyRequests("Slow down");');
  assert.deepEqual(messages, []);
});
