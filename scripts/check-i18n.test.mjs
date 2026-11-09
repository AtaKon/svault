import test from "node:test";
import assert from "node:assert/strict";
import {
  extractClientKeys,
  extractDictionary,
  extractServerMessages,
  findMissing,
} from "./check-i18n.mjs";

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
    ["Daily limit ({x}). Try again tomorrow.", "Could not reach Open Prices", "Could not reach Folksonomy"],
  );

  const dictionary = new Set([
    "Daily limit ({count}). Try again tomorrow.",
    "Could not reach Open Prices",
    "Could not reach Folksonomy",
  ]);
  assert.deepEqual(findMissing(dictionary, messages), []);
});
