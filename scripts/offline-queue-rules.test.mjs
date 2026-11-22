import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMANENT_REJECTIONS, applySyncedBaseline, rebaseQueuedAction, syncBackoffMs } from "../client/offline-queue.js";

/** @typedef {import("../client/offline-queue.js").QueuedStockAction} QueuedStockAction */

/** @param {Partial<QueuedStockAction>} over */
const action = (over = {}) => ({
  id: "q_1",
  userId: "usr_1",
  houseId: "hse_1",
  itemId: "itm_1",
  itemName: "Flour",
  unit: "g",
  body: { action: "set", target: 500 },
  baseUpdatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:01.000Z",
  ...over,
});

test("statuses the server can never accept surface as a conflict, not a retry", () => {
  for (const status of [400, 403, 404, 409, 410, 422]) {
    assert.equal(PERMANENT_REJECTIONS.has(status), true, `status ${status} must be permanent`);
  }
  // A lowered role (403) never passes on retry; offline, an expired session,
  // throttling and server faults may pass on a later attempt.
  for (const status of [0, 401, 408, 425, 429, 500, 503]) {
    assert.equal(PERMANENT_REJECTIONS.has(status), false, `status ${status} must stay retryable`);
  }
});

test("transient sync failures back off exponentially and cap at 30 seconds", () => {
  assert.equal(syncBackoffMs(1), 1000);
  assert.equal(syncBackoffMs(2), 2000);
  assert.equal(syncBackoffMs(3), 4000);
  assert.equal(syncBackoffMs(6), 30000);
  assert.equal(syncBackoffMs(50), 30000);
  // A defensive call never fires immediately.
  assert.equal(syncBackoffMs(0), 1000);
});

test("a later queued action from the same view is rebased onto the timestamp the server just returned", () => {
  // The user queued "add" and then "set" on the same item from the same view
  // (both carry baseUpdatedAt T0); the add bumps updated_at server-side, so
  // the set must not keep the add's old baseline.
  const queued = action({ id: "q_2", body: { action: "set", target: 300 } });
  const rebased = rebaseQueuedAction(queued, {
    queuedBase: "2026-01-01T00:00:00.000Z",
    returnedUpdatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(rebased.baseUpdatedAt, "2026-01-02T00:00:00.000Z");
  // The rest of the action is untouched.
  assert.equal(rebased.id, "q_2");
  assert.deepEqual(rebased.body, queued.body);
});

test("a later queued action from a different view keeps its own baseline", () => {
  // The second action was queued after the app saw a newer item (for example
  // a change someone else made); rebasing it would hide that change, so the
  // queued base stands and a genuine conflict can still surface as 409.
  const queued = action({ id: "q_5", baseUpdatedAt: "2026-01-03T00:00:00.000Z" });
  const rebased = rebaseQueuedAction(queued, {
    queuedBase: "2026-01-01T00:00:00.000Z",
    returnedUpdatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(rebased.baseUpdatedAt, "2026-01-03T00:00:00.000Z");
});

test("without a previous success the queued action keeps its own baseline", () => {
  const queued = action({ id: "q_3" });
  assert.equal(rebaseQueuedAction(queued, null).baseUpdatedAt, queued.baseUpdatedAt);
  // The first action on an item in a replay batch has nothing to rebase onto.
  const withoutBase = action({ id: "q_4", baseUpdatedAt: null });
  assert.equal(rebaseQueuedAction(withoutBase, null).baseUpdatedAt, null);
  // A missing server timestamp is not a rebase either: there is nothing newer
  // to trust, so the queued baseline decides.
  const noTimestamp = action({ id: "q_6" });
  assert.equal(
    rebaseQueuedAction(noTimestamp, { queuedBase: noTimestamp.baseUpdatedAt, returnedUpdatedAt: "" }).baseUpdatedAt,
    noTimestamp.baseUpdatedAt,
  );
});

test("a successful replay records the returned timestamp as the next baseline", () => {
  const baselines = new Map();
  applySyncedBaseline(baselines, action({ id: "q_7" }), { updatedAt: "2026-01-05T00:00:00.000Z" });
  const baseline = baselines.get("itm_1");
  assert.equal(baseline.queuedBase, "2026-01-01T00:00:00.000Z");
  assert.equal(baseline.returnedUpdatedAt, "2026-01-05T00:00:00.000Z");
});

test("a successful replay without a timestamp drops the item's earlier baseline", () => {
  // The server applied an earlier queued action but returned no timestamp;
  // keeping that entry would let a later action rebase onto a timestamp
  // older than the user's own last write, so the entry is deleted.
  const baselines = new Map();
  applySyncedBaseline(baselines, action({ id: "q_8" }), { updatedAt: "2026-01-05T00:00:00.000Z" });
  applySyncedBaseline(baselines, action({ id: "q_9" }), {});
  assert.equal(baselines.has("itm_1"), false);

  // With no entry left, a later action keeps its own queued baseline.
  const later = action({ id: "q_10", baseUpdatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(rebaseQueuedAction(later, baselines.get("itm_1") ?? null).baseUpdatedAt, later.baseUpdatedAt);

  // A replay with no response body at all clears the entry the same way.
  applySyncedBaseline(baselines, action({ id: "q_11" }), { updatedAt: "2026-01-05T00:00:00.000Z" });
  applySyncedBaseline(baselines, action({ id: "q_12" }), null);
  assert.equal(baselines.has("itm_1"), false);
});
