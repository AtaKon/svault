import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LiveEvent } from "../../shared/types.js";

/**
 * Live-update (SSE) integration tests.
 *
 * They run against a real Express app and a temporary SQLite database, like
 * the main API suite. The membership and heartbeat timers are shortened so the
 * failure paths (removal, keep-alive) can be observed without waiting a minute.
 */
const dataDir = mkdtempSync(path.join(tmpdir(), "svault-live-test-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.SV_REGISTRATION = "open";
process.env.LIVE_HEARTBEAT_MS = "40";
process.env.LIVE_MEMBERSHIP_CHECK_MS = "40";
process.env.LIVE_RETRY_MS = "40";
process.env.OPENAI_API_KEY = "";
process.env.SVAI_API_KEY = "";

const { app } = await import("../index.js");
const { closeDb, run } = await import("../db.js");
const { publishLive, subscribeLive, liveSubscriberCount, LiveLimitError } = await import("../services/live.js");
const { tx } = await import("../db.js");

let server: import("node:http").Server;
let base = "";

interface Account {
  cookie: string;
  userId: string;
  houseId: string;
}

async function request(
  pathname: string,
  options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { connection: "close", ...(options.headers ?? {}) };
  if (options.cookie) headers.cookie = options.cookie;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const res = await fetch(base + pathname, { method: options.method ?? (body ? "POST" : "GET"), headers, body });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return {
    status: res.status,
    data,
    cookie: setCookie ? setCookie.split(";")[0] : null,
  };
}

async function register(name: string, email: string): Promise<Account> {
  const result = await request("/api/auth/register", {
    method: "POST",
    body: { name, email, password: "test password" },
  });
  assert.equal(result.status, 201);
  return {
    cookie: result.cookie!,
    userId: result.data.user.id,
    houseId: result.data.houses[0].id,
  };
}

async function addMember(houseId: string, userId: string) {
  await run("INSERT INTO house_members (house_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
    houseId,
    userId,
    "member",
    new Date().toISOString(),
  ]);
}

interface SseStream {
  status: number;
  headers: Headers;
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  close: () => void;
}

async function openStream(houseId: string, cookie: string): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/houses/${houseId}/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  const reader = response.body ? response.body.getReader() : null;
  return {
    status: response.status,
    headers: response.headers,
    controller,
    reader,
    close: () => controller.abort(),
  };
}

function blocks(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  const END = "\u0000end";
  let buffer = "";
  return {
    async next(timeoutMs: number): Promise<string | null> {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const index = buffer.indexOf("\n\n");
        if (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          return block;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
        const result = await Promise.race([reader.read(), timer]);
        if (!result) return null;
        if (result.done) return END;
        buffer += decoder.decode(result.value, { stream: true });
      }
    },
    END,
  };
}

function eventFromBlock(block: string): LiveEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data) return null;
  return JSON.parse(data) as LiveEvent;
}

async function waitForEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  type: LiveEvent["type"],
  timeoutMs = 2000,
): Promise<LiveEvent> {
  const deadline = Date.now() + timeoutMs;
  const { next, END } = blocks(reader);
  while (Date.now() < deadline) {
    const block = await next(deadline - Date.now());
    if (block === null || block === END) break;
    const event = eventFromBlock(block);
    if (event?.type === type) return event;
  }
  throw new Error(`No ${type} event arrived`);
}

async function expectNoEvent(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  const { next, END } = blocks(reader);
  while (Date.now() < deadline) {
    const block = await next(deadline - Date.now());
    if (block === null || block === END) return;
    if (eventFromBlock(block)) throw new Error(`Unexpected live event: ${block}`);
  }
}

async function waitForEnd(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const { next, END } = blocks(reader);
  while (Date.now() < deadline) {
    const block = await next(deadline - Date.now());
    if (block === null) return false;
    if (block === END) return true;
  }
  return false;
}

let owner: Account;
let member: Account;
let other: Account;
let outsider: Account;
let stockMember: Account;
let capped: Account;
let revoked: Account;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;

  owner = await register("Live Owner", "live-owner@example.com");
  member = await register("Live Member", "live-member@example.com");
  other = await register("Other House", "live-other@example.com");
  outsider = await register("Not A Member", "live-outsider@example.com");
  stockMember = await register("Stock Member", "live-stock@example.com");
  capped = await register("Cap Member", "live-capped@example.com");
  revoked = await register("Revoked Member", "live-revoked@example.com");

  await addMember(owner.houseId, member.userId);
  await addMember(owner.houseId, stockMember.userId);
  await addMember(owner.houseId, capped.userId);
  await addMember(owner.houseId, revoked.userId);
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("live updates over Server-Sent Events", () => {
  it("delivers a house's event to members and never to another house", async () => {
    const memberStream = await openStream(owner.houseId, member.cookie);
    assert.equal(memberStream.status, 200);
    assert.match(memberStream.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(memberStream.headers.get("x-accel-buffering"), "no");

    const otherStream = await openStream(other.houseId, other.cookie);
    assert.equal(otherStream.status, 200);

    const added = await request(`/api/houses/${owner.houseId}/shopping`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Olive oil", quantity: 1 },
    });
    assert.equal(added.status, 201);

    const event = await waitForEvent(memberStream.reader!, "shopping");
    assert.equal(event.type, "shopping");
    assert.equal(event.actorUserId, owner.userId);
    assert.equal(typeof event.at, "string");

    await expectNoEvent(otherStream.reader!);
    memberStream.close();
    otherStream.close();
  });

  it("carries no household payload in the event JSON", async () => {
    const stream = await openStream(owner.houseId, member.cookie);
    await request(`/api/houses/${owner.houseId}/shopping`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Secret 12 pack", quantity: 12 },
    });
    const event = await waitForEvent(stream.reader!, "shopping");
    assert.deepEqual(Object.keys(event).sort(), ["actorUserId", "at", "type"]);
    assert.equal(JSON.stringify(event).includes("Secret 12 pack"), false);
    stream.close();
  });

  it("emits a stock event from the stock service after a write", async () => {
    const created = await request(`/api/houses/${owner.houseId}/items`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Live milk", unit: "pcs" },
    });
    assert.equal(created.status, 201);

    const stream = await openStream(owner.houseId, stockMember.cookie);
    const stocked = await request(`/api/items/${created.data.id}/stock`, {
      method: "POST",
      cookie: owner.cookie,
      body: { action: "add", quantity: 2 },
    });
    assert.equal(stocked.status, 200);

    const event = await waitForEvent(stream.reader!, "stock");
    assert.equal(event.id, created.data.id);
    stream.close();
  });

  it("refuses a non-member and an API token", async () => {
    const denied = await request(`/api/houses/${owner.houseId}/events`, { cookie: outsider.cookie });
    assert.equal(denied.status, 404);

    const token = await request("/api/tokens", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Live automation" },
    });
    assert.equal(token.status, 201);
    const withToken = await fetch(`${base}/api/houses/${owner.houseId}/events`, {
      headers: { authorization: `Bearer ${token.data.token}` },
    });
    assert.equal(withToken.status, 403);
    await withToken.body?.cancel();
  });

  it("sends a heartbeat comment while idle", async () => {
    const stream = await openStream(owner.houseId, member.cookie);
    const { next } = blocks(stream.reader!);
    let sawHeartbeat = false;
    for (let attempt = 0; attempt < 20 && !sawHeartbeat; attempt++) {
      const block = await next(500);
      if (block === null) break;
      if (block.includes("heartbeat")) sawHeartbeat = true;
    }
    assert.equal(sawHeartbeat, true);
    stream.close();
  });

  it("closes the stream when the member is removed from the house", async () => {
    const stream = await openStream(owner.houseId, revoked.cookie);
    assert.equal(stream.status, 200);
    const removed = await request(`/api/houses/${owner.houseId}/members/${revoked.userId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    assert.equal(removed.status, 200);
    assert.equal(await waitForEnd(stream.reader!), true);
    stream.close();
  });

  it("caps connections per user with 429", async () => {
    const streams: SseStream[] = [];
    for (let index = 0; index < 5; index++) {
      const stream = await openStream(owner.houseId, capped.cookie);
      assert.equal(stream.status, 200);
      streams.push(stream);
    }
    const extra = await openStream(owner.houseId, capped.cookie);
    assert.equal(extra.status, 429);
    assert.equal(extra.headers.get("retry-after"), "30");
    await extra.reader?.cancel();
    for (const stream of streams) stream.close();
    // Let the server notice the aborted sockets before the next test.
    for (let attempt = 0; attempt < 20 && liveSubscriberCount(capped.userId) > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(liveSubscriberCount(capped.userId), 0);

    // The house cap protects the process even when many different accounts
    // connect at once.
    const houseSubscriptions = Array.from({ length: 100 }, (_, index) =>
      subscribeLive({ houseId: "hse_cap_test", userId: `usr_cap_${index}`, onEvent: () => undefined }),
    );
    try {
      assert.throws(
        () => subscribeLive({ houseId: "hse_cap_test", userId: "usr_cap_extra", onEvent: () => undefined }),
        (error: unknown) => error instanceof LiveLimitError && error.scope === "house",
      );
    } finally {
      for (const subscription of houseSubscriptions) subscription.close();
    }
  });

  it("emits only after commit and drops rolled-back writes", async () => {
    const seen: LiveEvent[] = [];
    const subscription = subscribeLive({
      houseId: owner.houseId,
      userId: stockMember.userId,
      onEvent: (event) => seen.push(event),
    });
    try {
      await assert.rejects(
        tx(async () => {
          publishLive(owner.houseId, { type: "items", id: "itm_rolled_back", actorUserId: owner.userId });
          throw new Error("rollback");
        }),
      );
      assert.equal(seen.length, 0);

      await tx(async () => {
        publishLive(owner.houseId, { type: "plan", id: "pln_committed", actorUserId: owner.userId });
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].type, "plan");
      assert.equal(seen[0].id, "pln_committed");
    } finally {
      subscription.close();
    }
  });
});
