import test from "node:test";
import assert from "node:assert/strict";
import {
  clipComment,
  failureStopNote,
  mergeChunkReviews,
  splitDiff,
} from "../.github/scripts/ai-review-helpers.mjs";

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
  const result = splitDiff(diff, 10_000);
  assert.deepEqual(result, { chunks: [diff], oversized: [] });
});

test("splitDiff preserves file boundaries and reports oversized files", () => {
  const small = `diff --git a/a.ts b/a.ts\n+${"x".repeat(200)}\n`;
  const big = `diff --git a/big.ts b/big.ts\n+${"y".repeat(2_000)}\n`;
  const result = splitDiff(small + big, 1_000);
  assert.equal(result.chunks.length, 1);
  assert.match(result.chunks[0], /diff --git a\/a\.ts/);
  assert.deepEqual(result.oversized, ["big.ts"]);
});

test("splitDiff never cuts a file section", () => {
  const one = `diff --git a/a.ts b/a.ts\n+${"x".repeat(600)}\n`;
  const two = `diff --git a/b.ts b/b.ts\n+${"y".repeat(600)}\n`;
  const result = splitDiff(one + two, 700);
  assert.equal(result.chunks.length, 2);
  for (const chunk of result.chunks) assert.equal(chunk.match(/^diff --git /gm)?.length, 1);
});

test("failureStopNote reports the unreviewed range", () => {
  assert.match(failureStopNote(3, 8), /parts 4-8 were not reviewed/);
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

test("mergeChunkReviews treats unexpected formats as blocking", () => {
  const review = mergeChunkReviews([{ index: 2, text: "## Blocking\n- something" }]);
  assert.match(review, /Needs changes/);
  assert.match(review, /unexpected format/);
});

test("mergeChunkReviews treats empty and whitespace-only parts as blocking", () => {
  for (const text of ["", "   \n\n  "]) {
    const review = mergeChunkReviews([{ index: 1, text }]);
    assert.match(review, /Needs changes/);
  }
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
  assert.match(review, /Needs changes/);
  assert.match(review, /omitted the Blocking section/);
});

test("clipComment honors the limit including its marker", () => {
  const text = `x\n${"word ".repeat(5_000)}`;
  const clipped = clipComment(text, 1_000);
  assert.ok(clipped.length <= 1_000, `clipped is ${clipped.length}`);
  assert.match(clipped, /truncated/);
});

test("clipComment handles text without a newline before the limit", () => {
  const clipped = clipComment("x".repeat(500), 100);
  assert.match(clipped, /truncated/);
  assert.ok(clipped.length <= 100);
});

test("clipComment closes an unclosed code fence", () => {
  const text = `intro\n\`\`\`ts\n${"x".repeat(200)}`;
  const clipped = clipComment(text, 80);
  assert.match(clipped, /truncated/);
  assert.equal((clipped.match(/^```/gm) || []).length % 2, 0);
});
