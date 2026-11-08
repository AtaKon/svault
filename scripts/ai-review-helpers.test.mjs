import test from "node:test";
import assert from "node:assert/strict";
import { clipComment, failureStopNote, mergeChunkReviews, splitDiff } from "../.github/scripts/ai-review-helpers.mjs";

test("splitDiff keeps a small multi-file diff in one chunk", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "+line",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "+other",
  ].join("\n");
  assert.deepEqual(splitDiff(diff, 10_000), [diff]);
});

test("splitDiff preserves every file header when splitting", () => {
  const one = `diff --git a/a.ts b/a.ts\n+${"x".repeat(400)}\n`;
  const two = `diff --git a/b.ts b/b.ts\n+${"y".repeat(400)}\n`;
  const chunks = splitDiff(one + two, 500);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join("").match(/diff --git a\/a\.ts/g)?.length, 1);
  assert.equal(chunks.join("").match(/diff --git a\/b\.ts/g)?.length, 1);
});

test("splitDiff marks oversized single-file continuations and repeats file context", () => {
  const diff = `diff --git a/big.ts b/big.ts\nindex 111..222 100644\n--- a/big.ts\n+++ b/big.ts\n@@ -1 +1 @@\n${Array.from({ length: 300 }, (_, i) => `+line ${i}`).join("\n")}`;
  const chunks = splitDiff(diff, 1_000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(0, -1)) assert.match(chunk, /\[Diff part continues in the next chunk\]/);
  for (const chunk of chunks.slice(1)) assert.match(chunk, /^diff --git a\/big\.ts/);
});

test("mergeChunkReviews keeps prose blocking findings", () => {
  const review = mergeChunkReviews([
    {
      index: 1,
      text: "### Blocking\nThis change drops rows during migration without a backup.\n### Non-blocking\nNone.\n### Tests\nNone.",
    },
  ]);
  assert.match(review, /Needs changes/);
  assert.match(review, /drops rows during migration/);
});

test("mergeChunkReviews flags a missing Blocking section", () => {
  const review = mergeChunkReviews([
    { index: 1, text: "### Non-blocking\n- some note\n### Tests\nNone." },
  ]);
  assert.match(review, /omitted the Blocking section/);
});

test("splitDiff keeps chunks within the limit even with a long header", () => {
  const header = `diff --git a/very-long.ts b/very-long.ts\n${"index 111..222 100644\n".repeat(40)}`;
  const diff = `${header}@@ -1 +1 @@\n${Array.from({ length: 300 }, (_, i) => `+line ${i}`).join("\n")}`;
  const limit = 1_200;
  const chunks = splitDiff(diff, limit);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= limit, `chunk is ${chunk.length}`);
});

test("splitDiff hard-caps a single line with no newline", () => {
  const diff = `diff --git a/min.js b/min.js\n@@ -1 +1 @@\n+${"x".repeat(5_000)}`;
  const chunks = splitDiff(diff, 1_000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 1_060, `chunk is ${chunk.length}`);
});

test("failureStopNote reports the unreviewed range", () => {
  assert.match(failureStopNote(4, 8), /parts 5-8 were not reviewed/);
});

test("splitDiff keeps continuation lines intact", () => {
  const diff = `diff --git a/lines.ts b/lines.ts\n@@ -1 +1 @@\n${Array.from({ length: 200 }, (_, i) => `+line-${i}`).join("\n")}`;
  const chunks = splitDiff(diff, 700);
  for (const chunk of chunks.slice(1)) {
    const lines = chunk.split("\n").filter((line) => line.startsWith("+line-"));
    for (const line of lines) assert.match(line, /^\+line-\d+$/);
  }
});

test("clipComment handles text without a newline before the limit", () => {
  const clipped = clipComment("x".repeat(500), 100);
  assert.match(clipped, /truncated at \d+ characters/);
  assert.ok(clipped.length < 220);
});

test("mergeChunkReviews says ready when every part is clean", () => {
  const review = mergeChunkReviews([
    { index: 1, text: "### Blocking\nNo blocking issues found.\n### Non-blocking\nNone.\n### Tests\nNone." },
  ]);
  assert.match(review, /Ready for review/);
  assert.match(review, /No blocking issues found/);
});

test("mergeChunkReviews says needs changes when any part blocks", () => {
  const review = mergeChunkReviews([
    { index: 1, text: "### Blocking\n- **real bug**\n### Non-blocking\nNone.\n### Tests\nNone." },
  ]);
  assert.match(review, /Needs changes/);
  assert.match(review, /real bug/);
});

test("mergeChunkReviews preserves overflow blocking notes", () => {
  const review = mergeChunkReviews([
    {
      index: "overflow",
      text: "### Blocking\n- The diff needs 25 parts; only the first 20 were reviewed.\n",
    },
  ]);
  assert.match(review, /Needs changes/);
  assert.match(review, /only the first 20/);
});

test("mergeChunkReviews puts unexpected formats in non-blocking", () => {
  const review = mergeChunkReviews([{ index: 2, text: "## Blocking\n- something" }]);
  assert.match(review, /Ready for review/);
  assert.match(review, /unexpected format/);
});

test("clipComment closes an unclosed code fence", () => {
  const text = `intro\n\`\`\`ts\n${"x".repeat(200)}`;
  const clipped = clipComment(text, 80);
  assert.match(clipped, /truncated/);
  assert.equal((clipped.match(/^```/gm) || []).length % 2, 0);
});
