import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/state";
import { Badge, Button, ConfirmDialog, IconButton, Sheet } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { useI18n } from "@/i18n";
import { relativeTime, qty } from "@/format";
import {
  clearQueuedActions,
  listQueuedActions,
  removeQueuedAction,
  syncBackoffMs,
  syncQueue,
  updateQueuedAction,
  type QueueConflict,
  type QueuedStockAction,
} from "@/offline-queue";

/** Labels for the action verb stored in a queued change's body. */
const QUEUE_ACTION_LABELS: Record<string, string> = {
  add: "Stock in",
  remove: "Used",
  set: "Count",
  waste: "Wasted",
  move: "Moved",
};

export function OfflineQueueBar() {
  const { user, house } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [actions, setActions] = useState<QueuedStockAction[]>([]);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [syncing, setSyncing] = useState(false);
  const [conflict, setConflict] = useState<QueueConflict | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Guards the sync loop: `syncing` state stays out of the auto-sync effect
  // so a failed replay does not immediately retrigger itself.
  const syncingRef = useRef(false);
  const retryAttempt = useRef(0);
  const retryTimer = useRef<number | undefined>(undefined);
  // The head of the queue the user dismissed by closing the conflict sheet:
  // auto-sync waits for them to act instead of reopening the sheet.
  const dismissedRef = useRef<string | null>(null);

  // A manual queue action overrides the automatic backoff: the pending retry
  // timer is dropped and the attempt counter reset, so the auto-sync effect
  // can pick the queue up again right away instead of waiting out a delay
  // armed by an earlier transient failure.
  const clearBackoff = useCallback(() => {
    if (retryTimer.current !== undefined) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    }
    retryAttempt.current = 0;
  }, []);

  // The dismissed head only blocks auto-sync while it is still queued; when
  // the user's action removes that very action, the dismissal is resolved
  // and auto-sync may resume.
  const clearDismissed = useCallback((removedId: string) => {
    if (dismissedRef.current === removedId) dismissedRef.current = null;
  }, []);

  const refresh = useCallback(async () => {
    if (!user || !house) return;
    try {
      setActions(await listQueuedActions(user.id, house.id));
    } catch {
      /* private mode without IndexedDB */
    }
  }, [user, house]);

  // The backoff timer calls the latest runSync without retriggering the
  // auto-sync effect while a sync is in flight.
  const runSyncRef = useRef<(() => Promise<void>) | null>(null);

  const runSync = useCallback(async () => {
    if (!user || !house || syncingRef.current || !online) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const result = await syncQueue(user.id, house.id);
      if (result.conflict) {
        setConflict(result.conflict);
      } else if (result.synced > 0) {
        retryAttempt.current = 0;
        toast.success(t(result.synced === 1 ? "Synced {count} queued change" : "Synced {count} queued changes", { count: result.synced }));
      } else if (result.remaining === 0) {
        retryAttempt.current = 0;
      } else {
        // A transient failure made no progress: retry later instead of
        // hot-looping while the server is unreachable.
        if (retryTimer.current === undefined) {
          const delay = syncBackoffMs(retryAttempt.current + 1);
          retryAttempt.current += 1;
          retryTimer.current = window.setTimeout(() => {
            retryTimer.current = undefined;
            void runSyncRef.current?.();
          }, delay);
        }
      }
      await refresh();
    } catch {
      toast.error(t("Could not sync the offline queue"));
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [user, house, online, toast, refresh, t]);

  runSyncRef.current = runSync;

  useEffect(() => {
    void refresh();
    const onQueue = () => void refresh();
    const onOnline = () => {
      setOnline(true);
      // Coming back online is the strongest signal that a retry will work.
      retryAttempt.current = 0;
      if (retryTimer.current !== undefined) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = undefined;
      }
      void refresh();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("sv:queue-changed", onQueue);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("sv:queue-changed", onQueue);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (retryTimer.current !== undefined) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = undefined;
      }
    };
  }, [refresh]);

  // Keyed on the queue's size and head rather than the array: every sync
  // ends with refresh(), which yields a new array even when nothing changed,
  // and re-running on that would skip the backoff after a transient failure.
  const headId = actions[0]?.id;
  useEffect(() => {
    if (!online || actions.length === 0 || conflict || headId === dismissedRef.current) return;
    if (retryTimer.current !== undefined) return;
    void runSync();
  }, [online, actions.length, headId, conflict, runSync]);

  useEffect(() => {
    if (!actions.length) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [actions.length]);

  const discardOne = async (action: QueuedStockAction) => {
    setRemovingId(action.id);
    try {
      await removeQueuedAction(action.id);
      clearBackoff();
      clearDismissed(action.id);
      await refresh();
    } catch {
      toast.error(t("Could not remove the queued change"));
    } finally {
      setRemovingId(null);
    }
  };

  const discardAll = async () => {
    if (!user || !house) return;
    setDiscarding(true);
    try {
      await clearQueuedActions(user.id, house.id);
      // Everything is gone, including any dismissed head.
      clearBackoff();
      dismissedRef.current = null;
      setDiscardOpen(false);
      await refresh();
    } catch {
      toast.error(t("Could not remove the queued change"));
    } finally {
      setDiscarding(false);
    }
  };

  if (!actions.length) {
    return online ? null : (
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-[11px] text-warn">
        <Icon name="wifi" size={13} /> {t("You are offline. Stock changes will be queued.")}
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-[11px] text-warn">
        <Icon name="clock" size={13} />
        <span className="min-w-[10rem] flex-1">
          <strong>{t(actions.length === 1 ? "{count} stock change pending sync" : "{count} stock changes pending sync", { count: actions.length })}</strong>
          {!online && <> · {t("offline")}</>}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => { dismissedRef.current = null; void runSync(); }} loading={syncing} disabled={!online}>
            {t("Sync now")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setViewOpen(true)}>
            {t("View")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDiscardOpen(true)}>
            {t("Discard")}
          </Button>
        </span>
      </div>

      <Sheet
        open={viewOpen}
        onClose={() => setViewOpen(false)}
        title={t("Offline queue")}
        description={t("Changes saved on this device. They sync automatically when the connection returns.")}
      >
        <div className="space-y-2">
          {actions.map((action) => (
            <div key={action.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{action.itemName}</div>
                <div className="text-[11px] text-muted">
                  {t(QUEUE_ACTION_LABELS[String(action.body.action)] ?? "Count")}
                  {" · "}
                  {qty(Number(action.body.target ?? action.body.quantity ?? 0))} {action.unit}
                  {" · "}
                  {relativeTime(action.createdAt)}
                </div>
              </div>
              <IconButton
                icon="close"
                label={t("Discard {item}", { item: action.itemName })}
                disabled={removingId !== null}
                onClick={() => void discardOne(action)}
                className="h-8 w-8 text-muted hover:text-danger"
              />
            </div>
          ))}
        </div>
      </Sheet>

      <ConfirmDialog
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        onConfirm={() => void discardAll()}
        title={t("Discard every queued change?")}
        body={t("This cannot be undone. The queued stock changes are removed from this device.")}
        confirmLabel={t("Discard all")}
        loading={discarding}
      />

      <Sheet
        open={Boolean(conflict)}
        onClose={() => {
          if (conflict) dismissedRef.current = conflict.action.id;
          setConflict(null);
        }}
        title={t(conflict?.status === 409 ? "Stock count conflict" : "The server refused a queued change")}
        description={t(
          conflict?.status === 409
            ? "This queued count is older than a change made on the server. Pick how to resolve it."
            : "This queued change can never be applied. Discard it to unblock the rest of the queue.",
        )}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={async () => {
                if (!conflict) return;
                await removeQueuedAction(conflict.action.id);
                clearBackoff();
                clearDismissed(conflict.action.id);
                setConflict(null);
                await refresh();
              }}
            >
              {t(conflict?.status === 409 ? "Discard my count" : "Discard my change")}
            </Button>
            {conflict?.status === 409 && (
              <Button
                onClick={async () => {
                  if (!conflict) return;
                  const next = {
                    ...conflict.action,
                    baseUpdatedAt: conflict.details.currentUpdatedAt ?? new Date().toISOString(),
                  };
                  await updateQueuedAction(next);
                  clearBackoff();
                  clearDismissed(conflict.action.id);
                  setConflict(null);
                  await refresh();
                  void runSync();
                }}
              >
                {t("Retry on the new baseline")}
              </Button>
            )}
          </div>
        }
      >
        {conflict && (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <strong>{conflict.action.itemName}</strong>
              <Badge tone="warn">{t("conflict")}</Badge>
            </div>
            {conflict.status === 409 ? (
              <>
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  <div className="rounded-lg bg-raised px-3 py-2">
                    <div className="text-muted">{t("Queued count")}</div>
                    <div className="font-medium">{String(conflict.action.body.target ?? conflict.action.body.quantity ?? "—")} {conflict.action.unit}</div>
                  </div>
                  <div className="rounded-lg bg-raised px-3 py-2">
                    <div className="text-muted">{t("Server now")}</div>
                    <div className="font-medium">{String(conflict.details.currentQuantity ?? "—")} {conflict.action.unit}</div>
                  </div>
                </div>
                <p className="text-[11px] text-muted">
                  {t("Retrying keeps your count and uses the server's newer timestamp as the baseline. Discarding keeps the server value.")}
                </p>
              </>
            ) : (
              <p className="text-[12px] text-muted">{t(String(conflict.details.message ?? "Could not sync the offline queue"))}</p>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}
