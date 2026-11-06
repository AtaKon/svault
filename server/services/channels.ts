import { createHmac } from "node:crypto";
import { all, get, newId, now, parseJson, run } from "../db.js";
import { assertOutboundUrl, outboundRedirectMode } from "../lib/outbound.js";
import type { NotificationChannel, NotificationChannelEvents, NotificationChannelType } from "../../shared/types.js";

export type DeliveryEvent = "low_stock" | "expiring" | "weekly_summary" | "test";

export const CHANNEL_SECRET_FIELDS = ["token", "key", "secret"] as const;

const DEFAULT_EVENTS: NotificationChannelEvents = {
  lowStock: true,
  expiring: true,
  weeklySummary: false,
};

export function channelsFromSettings(settings: Record<string, any> | null | undefined): NotificationChannel[] {
  const raw = settings?.notifications?.channels;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry: any) => entry && typeof entry === "object")
    .map((entry: any) => ({
      id: String(entry.id ?? `ch_${Math.random().toString(36).slice(2)}`),
      type: (["ntfy", "apprise", "webhook"].includes(entry.type) ? entry.type : "webhook") as NotificationChannelType,
      name: String(entry.name ?? entry.type ?? "Reminder channel").slice(0, 80),
      enabled: entry.enabled !== false,
      url: String(entry.url ?? "").slice(0, 500),
      topic: entry.topic ? String(entry.topic).slice(0, 200) : undefined,
      token: entry.token ? String(entry.token) : undefined,
      key: entry.key ? String(entry.key) : undefined,
      secret: entry.secret ? String(entry.secret) : undefined,
      events: {
        lowStock: entry.events?.lowStock !== false,
        expiring: entry.events?.expiring !== false,
        weeklySummary: entry.events?.weeklySummary === true,
      },
    }));
}

export function maskChannels(channels: NotificationChannel[]): NotificationChannel[] {
  return channels.map((channel) => {
    const next: NotificationChannel = { ...channel };
    for (const field of CHANNEL_SECRET_FIELDS) {
      if (next[field]) next[field] = "***";
    }
    return next;
  });
}

/** Preserve stored secrets when the client sends back the masked placeholder. */
export function mergeChannels(current: NotificationChannel[], incoming: NotificationChannel[]): NotificationChannel[] {
  return incoming.map((channel) => {
    const id = channel.id && channel.id !== "new" ? channel.id : newId("ch");
    const previous = current.find((entry) => entry.id === id) ?? current.find((entry) => entry.id === channel.id);
    const next: NotificationChannel = {
      ...channel,
      id,
      events: { ...DEFAULT_EVENTS, ...(channel.events ?? {}) },
    };
    for (const field of CHANNEL_SECRET_FIELDS) {
      if (next[field] === "***") {
        if (previous?.[field]) next[field] = previous[field];
        else delete next[field];
      }
      if (next[field] === "") delete next[field];
    }
    return next;
  });
}

function eventEnabled(channel: NotificationChannel, event: DeliveryEvent): boolean {
  if (event === "test") return true;
  if (!channel.enabled || !channel.url) return false;
  if (event === "low_stock") return channel.events.lowStock;
  if (event === "expiring") return channel.events.expiring;
  return channel.events.weeklySummary;
}

export interface ChannelMessage {
  title: string;
  body: string;
  event: DeliveryEvent;
  houseId: string;
  houseName?: string;
  data?: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

function ntfyUrl(channel: NotificationChannel) {
  if (!channel.topic) return channel.url;
  const base = channel.url.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(channel.topic)}`;
}

function asciiHeader(value: string) {
  return value.replace(/[^\x20-\x7E]/g, "?").slice(0, 250);
}

/** Send one message synchronously. Used by the Test button and by delivery runs. */
export async function sendChannelMessage(channel: NotificationChannel, message: ChannelMessage): Promise<DeliveryResult> {
  if (!channel.url) return { ok: false, status: null, error: "No URL configured" };
  try {
    await assertOutboundUrl(channel.url, "The channel URL");
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : "Channel URL is not allowed" };
  }
  const redirect = outboundRedirectMode();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    if (channel.type === "ntfy") {
      const headers: Record<string, string> = {
        "content-type": "text/plain; charset=utf-8",
        Title: asciiHeader(message.title),
        Tags: message.event === "low_stock" ? "warning" : message.event === "expiring" ? "hourglass" : "bell",
      };
      if (channel.token) headers.authorization = `Bearer ${channel.token}`;
      response = await fetch(ntfyUrl(channel), {
        method: "POST",
        headers,
        body: message.body,
        redirect,
        signal: controller.signal,
      });
    } else if (channel.type === "apprise") {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (channel.key) headers["x-api-key"] = channel.key;
      let endpoint = channel.url.replace(/\/+$/, "");
      if (channel.key && !/\/notify\/[^/]+$/.test(endpoint)) {
        endpoint = endpoint.endsWith("/notify") ? `${endpoint}/${encodeURIComponent(channel.key)}` : `${endpoint}/notify/${encodeURIComponent(channel.key)}`;
      }
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: message.title,
          body: message.body,
          type: message.event === "low_stock" ? "warning" : "info",
        }),
        redirect,
        signal: controller.signal,
      });
    } else {
      const body = JSON.stringify({
        event: message.event,
        title: message.title,
        body: message.body,
        houseId: message.houseId,
        houseName: message.houseName ?? null,
        data: message.data ?? {},
        sentAt: now(),
      });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": "SVault-Reminders/1.1",
      };
      if (channel.secret) {
        headers["x-svault-signature"] = `sha256=${createHmac("sha256", channel.secret).update(body).digest("hex")}`;
      }
      response = await fetch(channel.url, { method: "POST", headers, body, redirect, signal: controller.signal });
    }
    clearTimeout(timer);
    const ok = response.ok;
    let detail: string | null = null;
    if (!ok) {
      detail = (await response.text().catch(() => "")).slice(0, 500) || `HTTP ${response.status}`;
    }
    return { ok, status: response.status, error: detail };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : "Delivery failed" };
  }
}

async function deliveryRow(houseId: string, channelId: string, dedupeKey: string) {
  return await get<any>(
    "SELECT * FROM notification_deliveries WHERE house_id = ? AND channel_id = ? AND dedupe_key = ?",
    [houseId, channelId, dedupeKey],
  );
}

async function updateDelivery(id: string, status: string, attempts: number, httpStatus: number | null, error: string | null) {
  await run("UPDATE notification_deliveries SET status = ?, attempts = ?, http_status = ?, error = ?, updated_at = ? WHERE id = ?", [
    status,
    attempts,
    httpStatus,
    error,
    now(),
    id,
  ]);
}

async function runDelivery(id: string, channel: NotificationChannel, message: ChannelMessage, attempt = 1) {
  const result = await sendChannelMessage(channel, message);
  if (result.ok) {
    await updateDelivery(id, "sent", attempt, result.status, null);
    return;
  }
  if (attempt >= 3) {
    await updateDelivery(id, "failed", attempt, result.status, result.error);
    return;
  }
  await updateDelivery(id, "pending", attempt, result.status, result.error);
  const timer = setTimeout(async () => {
    void await runDelivery(id, channel, message, attempt + 1);
  }, 500 * attempt * attempt);
  timer.unref?.();
}

/** Queue one delivery per configured channel, deduped by key. Network work is
 * detached from the request that triggered it. */
export async function queueDeliveries(message: ChannelMessage, dedupeKey: string): Promise<number> {
  const house = await get<any>("SELECT id, name, settings FROM houses WHERE id = ?", [message.houseId]);
  if (!house) return 0;
  const channels = channelsFromSettings(parseJson(house.settings, {}));
  let queued = 0;
  for (const channel of channels) {
    if (!eventEnabled(channel, message.event)) continue;
    if (await deliveryRow(house.id, channel.id, dedupeKey)) continue;
    const id = newId("dlv");
    await run(
      `INSERT INTO notification_deliveries
        (id, house_id, channel_id, dedupe_key, event, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      [id, house.id, channel.id, dedupeKey, message.event, now(), now()],
    );
    queued++;
    void await runDelivery(id, channel, { ...message, houseName: house.name });
  }
  return queued;
}

export async function deliveryLog(houseId: string, limit = 40) {
  return (await all<any>(
    `SELECT id, channel_id, dedupe_key, event, status, attempts, http_status, error, created_at, updated_at
     FROM notification_deliveries WHERE house_id = ? ORDER BY created_at DESC LIMIT ?`,
    [houseId, limit],
  )).map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    dedupeKey: row.dedupe_key,
    event: row.event,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    httpStatus: row.http_status == null ? null : Number(row.http_status),
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Build the weekly summary message body from the same reminders the in-app
 * list shows. */
export async function weeklySummaryMessage(houseId: string): Promise<ChannelMessage | null> {
  const house = await get<any>("SELECT id, name, settings FROM houses WHERE id = ?", [houseId]);
  if (!house) return null;
  const low = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM items i WHERE i.house_id = ? AND i.archived = 0 AND i.reorder_point > 0
       AND (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_lots l WHERE l.item_id = i.id) <= i.reorder_point`,
    [houseId],
  );
  const today = new Date().toISOString().slice(0, 10);
  const weekAhead = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const sixDaysAhead = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
  const expiring = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stock_lots l JOIN items i ON i.id = l.item_id
     WHERE l.house_id = ? AND l.quantity > 0 AND l.expires_at IS NOT NULL
       AND l.expires_at <= ? AND i.archived = 0`,
    [houseId, weekAhead],
  );
  const planned = await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM meal_plan_entries WHERE house_id = ? AND day >= ? AND day <= ?",
    [houseId, today, sixDaysAhead],
  );
  const lowCount = Number(low?.n ?? 0);
  const expiringCount = Number(expiring?.n ?? 0);
  const plannedCount = Number(planned?.n ?? 0);
  if (!lowCount && !expiringCount && !plannedCount) return null;
  return {
    event: "weekly_summary",
    houseId,
    title: `${house.name} weekly summary`,
    body: [
      lowCount ? `${lowCount} item${lowCount === 1 ? "" : "s"} running low` : null,
      expiringCount ? `${expiringCount} expiring this week` : null,
      plannedCount ? `${plannedCount} meal${plannedCount === 1 ? "" : "s"} planned` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    data: { lowStock: lowCount, expiring: expiringCount, planned: plannedCount },
  };
}

/** Send the weekly summary once per ISO week, only to houses that opted in. */
export async function maybeSendWeeklySummaries() {
  const start = new Date();
  const week = Math.floor(
    (Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()) - Date.UTC(start.getUTCFullYear(), 0, 1)) /
      864e5,
  );
  const weekKey = `${start.getUTCFullYear()}-W${String(Math.floor(week / 7) + 1).padStart(2, "0")}`;
  const houses = await all<any>("SELECT id, settings FROM houses");
  for (const house of houses) {
    const channels = channelsFromSettings(parseJson(house.settings, {}));
    if (!channels.some((channel) => channel.enabled && channel.events.weeklySummary)) continue;
    const message = await weeklySummaryMessage(house.id);
    if (!message) continue;
    await queueDeliveries(message, `weekly:${weekKey}`);
  }
}

export async function deliveryStats(houseId: string) {
  const rows = await all<any>(
    "SELECT status, COUNT(*) AS n FROM notification_deliveries WHERE house_id = ? GROUP BY status",
    [houseId],
  );
  const stats: Record<string, number> = { pending: 0, sent: 0, failed: 0 };
  for (const row of rows) stats[row.status] = Number(row.n ?? 0);
  return stats;
}
