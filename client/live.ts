import { useEffect, useRef } from "react";
import { api } from "./api";
import type { LiveEvent, LiveEventType } from "@shared/types";

/**
 * Client half of the live-update channel: one EventSource per tab, shared by
 * every page through a tiny subscription bus. The server sends minimal
 * invalidation events, so subscribers simply refetch through the normal API.
 *
 * The connection pauses while the tab is hidden, reconnects with exponential
 * backoff (capped at 30 s) and refetches on visibility. A 90 s poll remains as
 * a fallback only while the stream is not connected.
 */

export interface LiveContext {
  houseId: string;
  userId: string;
}

interface Subscription {
  types: Set<LiveEventType>;
  handler: (event: LiveEvent, self: boolean) => void;
}

const EVENT_TYPES: LiveEventType[] = [
  "stock",
  "shopping",
  "items",
  "recipes",
  "plan",
  "notifications",
  "receipts",
  "bills",
];
const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);
const DEBOUNCE_MS = 300;
const FALLBACK_POLL_MS = 90_000;
const MAX_BACKOFF_MS = 30_000;

let context: LiveContext | null = null;
let source: EventSource | null = null;
let reconnectTimer: number | undefined;
let reconnectAttempts = 0;
let connected = false;
let needsCatchUp = false;
const subscriptions = new Set<Subscription>();
const memberNames = new Map<string, Map<string, string>>();

function notifyStatus() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("sv:live-status"));
}

function isLiveEvent(value: unknown): value is LiveEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<LiveEvent>;
  return (
    typeof event.type === "string" &&
    EVENT_TYPE_SET.has(event.type) &&
    typeof event.actorUserId === "string" &&
    typeof event.at === "string"
  );
}

function dispatch(event: LiveEvent) {
  const self = context ? event.actorUserId === context.userId : false;
  for (const subscription of subscriptions) {
    if (!subscription.types.has(event.type)) continue;
    try {
      subscription.handler(event, self);
    } catch (error) {
      console.error("Live update handler failed:", error);
    }
  }
}

function scheduleReconnect() {
  if (typeof window === "undefined" || reconnectTimer !== undefined) return;
  if (!context || document.hidden || subscriptions.size === 0) return;
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(reconnectAttempts, 5));
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, base + Math.floor(Math.random() * 250));
}

function connect() {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return;
  if (!context || document.hidden || subscriptions.size === 0 || source) return;
  if (reconnectTimer !== undefined) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const es = new EventSource(`/api/houses/${encodeURIComponent(context.houseId)}/events`);
  source = es;
  es.onopen = () => {
    connected = true;
    reconnectAttempts = 0;
    notifyStatus();
    // Events that happened while the stream was down were not queued. A
    // refetch closes that gap; the first connection needs no catch-up.
    if (needsCatchUp) {
      needsCatchUp = false;
      if (typeof window !== "undefined") window.dispatchEvent(new Event("sv:live-catchup"));
    }
  };
  es.onmessage = (message) => {
    if (!message.data) return;
    try {
      const parsed: unknown = JSON.parse(message.data);
      if (isLiveEvent(parsed)) dispatch(parsed);
    } catch {
      /* Ignore a malformed frame; the next heartbeat or event still works. */
    }
  };
  es.onerror = () => {
    // Close immediately: the browser's own retry would ignore our backoff and
    // could keep hammering a disabled or forbidden endpoint.
    connected = false;
    needsCatchUp = true;
    es.close();
    if (source === es) source = null;
    notifyStatus();
    scheduleReconnect();
  };
}

function disconnect() {
  if (source) {
    source.onerror = null;
    source.close();
    source = null;
  }
  connected = false;
  if (reconnectTimer !== undefined && typeof window !== "undefined") {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

/** Point the singleton at one house, or clear it when signed out. */
export function setLiveContext(next: LiveContext | null) {
  if (context?.houseId === next?.houseId && context?.userId === next?.userId) return;
  context = next;
  reconnectAttempts = 0;
  disconnect();
  if (next) connect();
}

/** Force an immediate reconnect, for example when the tab becomes visible. */
export function reconnectLive() {
  reconnectAttempts = 0;
  disconnect();
  connect();
}

export function liveConnected(): boolean {
  return connected;
}

export function subscribeLive(
  types: LiveEventType[],
  handler: (event: LiveEvent, self: boolean) => void,
): () => void {
  const subscription: Subscription = { types: new Set(types), handler };
  subscriptions.add(subscription);
  connect();
  return () => {
    subscriptions.delete(subscription);
    if (subscriptions.size === 0) disconnect();
  };
}

/**
 * Subscribe the current page to the event types that affect its data and
 * refetch with a short debounce. `refresh` may change on every render; the
 * effect keeps only the event types and the house in its dependencies.
 */
export function useLiveRefresh(
  houseId: string | null,
  types: LiveEventType[],
  refresh: () => void | Promise<void>,
  options: { enabled?: boolean } = {},
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const typesKey = types.join(",");
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!houseId || !enabled || typeof window === "undefined") return;
    const selected = typesKey.split(",") as LiveEventType[];
    let timer: number | undefined;
    const schedule = () => {
      if (document.hidden) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void refreshRef.current();
      }, DEBOUNCE_MS);
    };
    const unsubscribe = subscribeLive(selected, () => schedule());
    const onVisible = () => {
      if (document.hidden) return;
      schedule();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    window.addEventListener("sv:live-catchup", onVisible);
    const fallback = window.setInterval(() => {
      if (!document.hidden && !liveConnected()) void refreshRef.current();
    }, FALLBACK_POLL_MS);
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
      window.clearInterval(fallback);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      window.removeEventListener("sv:live-catchup", onVisible);
    };
  }, [houseId, typesKey, enabled]);
}

/**
 * Resolve the member name for a foreign event once per house. Events carry the
 * actor id but deliberately no display name.
 */
export async function liveActorName(houseId: string, userId: string): Promise<string | null> {
  let names = memberNames.get(houseId);
  if (!names) {
    try {
      const members = await api<{ id: string; name: string }[]>(`/api/houses/${houseId}/members`);
      names = new Map(members.map((member) => [member.id, member.name]));
      memberNames.set(houseId, names);
    } catch {
      return null;
    }
  }
  return names.get(userId) ?? null;
}

// A tab that goes away should not keep a subscriber slot until the socket
// times out on the server.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", disconnect);
  // The singleton owns reconnection so several subscribing pages do not each
  // tear down and reopen the same stream when the tab becomes visible.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      disconnect();
      return;
    }
    reconnectLive();
  });
  window.addEventListener("online", reconnectLive);
}
