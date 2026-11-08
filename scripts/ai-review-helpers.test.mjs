import test from "node:test";
import assert from "node:assert/strict";
import { clipComment, mergeChunkReviews, splitDiff } from "../.github/scripts/ai-review-helpers.mjs";

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

test("splitDiff marks oversized single-file continuations and cuts on lines", () => {
  const diff = `diff --git a/big.ts b/big.ts\n${Array.from({ length: 300 }, (_, i) => `+line ${i}`).join("\n")}`;
  const chunks = splitDiff(diff, 1_000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(0, -1)) assert.match(chunk, /\[Diff part continues in the next chunk\]/);
  assert.ok(chunks.every((chunk) => !/\+\s*$/.test(chunk) || chunk.includes("continues")));
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
