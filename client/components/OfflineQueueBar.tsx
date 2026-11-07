import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/state";
import { Badge, Button, Sheet } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { useI18n } from "@/i18n";
import {
  clearQueuedActions,
  listQueuedActions,
  removeQueuedAction,
  syncQueue,
  updateQueuedAction,
  type QueueConflict,
  type QueuedStockAction,
} from "@/offline-queue";

export function OfflineQueueBar() {
  const { user, house } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [actions, setActions] = useState<QueuedStockAction[]>([]);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [syncing, setSyncing] = useState(false);
  const [conflict, setConflict] = useState<QueueConflict | null>(null);

  const refresh = useCallback(async () => {
    if (!user || !house) return;
    try {
      setActions(await listQueuedActions(user.id, house.id));
    } catch {
      /* private mode without IndexedDB */
    }
  }, [user, house]);

  const runSync = useCallback(async () => {
    if (!user || !house || syncing || !online) return;
    setSyncing(true);
    try {
      const result = await syncQueue(user.id, house.id);
      if (result.conflict) {
        setConflict(result.conflict);
      } else if (result.synced > 0) {
        toast.success(t(result.synced === 1 ? "Synced {count} queued change" : "Synced {count} queued changes", { count: result.synced }));
      }
      await refresh();
    } catch {
      toast.error(t("Could not sync the offline queue"));
    } finally {
      setSyncing(false);
    }
  }, [user, house, syncing, online, toast, refresh, t]);

  useEffect(() => {
    void refresh();
    const onQueue = () => void refresh();
    const onOnline = () => {
      setOnline(true);
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
    };
  }, [refresh]);

  useEffect(() => {
    if (online && actions.length > 0 && !syncing && !conflict) void runSync();
  }, [online, actions.length, syncing, conflict, runSync]);

  useEffect(() => {
    if (!actions.length) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [actions.length]);

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
        <strong>{t(actions.length === 1 ? "{count} stock change pending sync" : "{count} stock changes pending sync", { count: actions.length })}</strong>
        {!online && <span>· {t("offline")}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => void runSync()} loading={syncing} disabled={!online}>
            {t("Sync now")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (!user || !house) return;
              await clearQueuedActions(user.id, house.id);
              await refresh();
            }}
          >
            {t("Discard")}
          </Button>
        </span>
      </div>

      <Sheet
        open={Boolean(conflict)}
        onClose={() => setConflict(null)}
        title={t("Stock count conflict")}
        description={t("This queued count is older than a change made on the server. Pick how to resolve it.")}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              onClick={async () => {
                if (!conflict) return;
                await removeQueuedAction(conflict.action.id);
                setConflict(null);
                await refresh();
              }}
            >
              {t("Discard my count")}
            </Button>
            <Button
              onClick={async () => {
                if (!conflict) return;
                const next = {
                  ...conflict.action,
                  baseUpdatedAt: conflict.details.currentUpdatedAt ?? new Date().toISOString(),
                };
                await updateQueuedAction(next);
                setConflict(null);
                await refresh();
                void runSync();
              }}
            >
              {t("Retry on the new baseline")}
            </Button>
          </div>
        }
      >
        {conflict && (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <strong>{conflict.action.itemName}</strong>
              <Badge tone="warn">{t("conflict")}</Badge>
            </div>
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
          </div>
        )}
      </Sheet>
    </>
  );
}
