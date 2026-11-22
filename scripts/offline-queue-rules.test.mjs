import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMANENT_REJECTIONS, rebaseQueuedAction, syncBackoffMs } from "../client/offline-queue.js";

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
  for (const status of [400, 404, 409, 410, 422]) {
    assert.equal(PERMANENT_REJECTIONS.has(status), true, `status ${status} must be permanent`);
  }
  // Offline, auth, throttling and server faults may pass on a later attempt.
  for (const status of [0, 401, 403, 408, 425, 429, 500, 503]) {
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

test("a later queued action is rebased onto the timestamp the server just returned", () => {
  // The user queued "add" and then "set" on the same item; the add bumps
  // updated_at server-side, so the set must not keep the add's old baseline.
  const queued = action({ id: "q_2", body: { action: "set", target: 300 } });
  const rebased = rebaseQueuedAction(queued, "2026-01-02T00:00:00.000Z");
  assert.equal(rebased.baseUpdatedAt, "2026-01-02T00:00:00.000Z");
  // The rest of the action is untouched.
  assert.equal(rebased.id, "q_2");
  assert.deepEqual(rebased.body, queued.body);
});

test("without a fresher timestamp the queued action keeps its own baseline", () => {
  const queued = action({ id: "q_3" });
  assert.equal(rebaseQueuedAction(queued, null).baseUpdatedAt, queued.baseUpdatedAt);
  // The first action on an item in a replay batch has nothing to rebase onto.
  const withoutBase = action({ id: "q_4", baseUpdatedAt: null });
  assert.equal(rebaseQueuedAction(withoutBase, null).baseUpdatedAt, null);
});
