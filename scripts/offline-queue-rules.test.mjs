import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMANENT_REJECTIONS, syncBackoffMs } from "../client/offline-queue.js";

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
