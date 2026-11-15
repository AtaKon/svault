import { useCallback, useMemo } from "react";
import { api } from "./api";
import { useHouse, useAuth } from "./state";
import { useToast } from "./components/toast";
import { useI18n } from "./i18n";
import { listQueuedActions, removeQueuedAction } from "./offline-queue";
import type { UndoStockResult } from "@shared/types";

export interface StockUndoAction {
  itemId: string;
  /** Movement the server recorded for the action; null/absent when it never reached it. */
  movementId?: string | null;
  /** Offline queue entry to cancel instead of calling the server. */
  queuedId?: string | null;
  /** Runs after the queued entry was actually cancelled. */
  onQueuedCancelled?: () => void;
  /** Runs after the server appended the compensating movement. */
  onUndone?: () => void;
}

export interface StockUndo {
  /** Show the success message with an Undo button for 9 seconds. */
  notify: (message: string, action: StockUndoAction) => void;
  /** Reverse the change now, with the same messages but no toast countdown. */
  run: (action: StockUndoAction) => Promise<boolean>;
}

/**
 * Undo for the last stock action.
 *
 * Online the server appends a compensating movement, so the ledger stays
 * append-only. While a change is still waiting in the offline queue there is
 * nothing to reverse on the server: the queued entry is removed instead.
 */
export function useStockUndo(): StockUndo {
  const { house } = useHouse();
  const { user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();

  const run = useCallback(
    async (action: StockUndoAction): Promise<boolean> => {
      try {
        if (action.queuedId) {
          const queued = user ? await listQueuedActions(user.id, house.id) : [];
          if (queued.some((entry) => entry.id === action.queuedId)) {
            await removeQueuedAction(action.queuedId);
            toast.success(t("Queued change removed"));
            action.onQueuedCancelled?.();
            window.dispatchEvent(new Event("sv:refresh-badges"));
            return true;
          }
          // It was sent while the toast was on screen, so the entry is gone and
          // the caller reloads the item from the server instead of reverting.
          toast.success(t("That change already reached the server"));
          action.onUndone?.();
          window.dispatchEvent(new Event("sv:refresh-badges"));
          return false;
        }
        if (!action.movementId) return false;
        await api<UndoStockResult>(`/api/houses/${house.id}/movements/${action.movementId}/undo`, {
          method: "POST",
        });
        toast.success(t("Stock change undone"));
        action.onUndone?.();
        window.dispatchEvent(new Event("sv:refresh-badges"));
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Could not undo the stock change"));
        return false;
      }
    },
    [house.id, toast, t, user],
  );

  const notify = useCallback(
    (message: string, action: StockUndoAction) => {
      // Nothing was recorded and nothing is queued (for example a count that
      // changed nothing): there is nothing to undo, so offer no button.
      if (!action.movementId && !action.queuedId) {
        toast.push(message, "success");
        return;
      }
      toast.push(message, "success", {
        duration: 9000,
        action: { label: t("Undo"), onClick: () => void run(action) },
      });
    },
    [run, t, toast],
  );

  return useMemo(() => ({ notify, run }), [notify, run]);
}
