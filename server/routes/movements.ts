import { Router } from "express";
import { get } from "../db.js";
import { requireAuth, roleAtLeast } from "../auth.js";
import { ApiError, handler, requireHouse } from "../http.js";
import { afterStockChange, undoStockMovement } from "../services/stock.js";
import { syncHouseExpiry } from "../services/notifications.js";
import type { UndoStockResult } from "../../shared/types.js";

export const movementRoutes = Router();
movementRoutes.use(requireAuth);

/**
 * Undo one stock change by appending a compensating movement.
 *
 * Members may undo their own movements; admins and owners may undo anyone's.
 * The ledger is append-only: this never edits or deletes the original row, and
 * a unique index makes undoing the same movement twice impossible. Unsafe undo
 * (later use of the same batches, an archived item, an undo of an undo) is
 * refused with 409 and a message the client shows as-is.
 */
movementRoutes.post(
  "/:houseId/movements/:movementId/undo",
  handler(async (req, res) => {
    const { houseId, role } = await requireHouse(req, "member");
    const movement = await get<{ id: string; item_id: string; user_id: string | null }>(
      "SELECT id, item_id, user_id FROM stock_movements WHERE id = ? AND house_id = ?",
      [req.params.movementId, houseId],
    );
    if (!movement) throw new ApiError(404, "Stock change not found");
    if (!roleAtLeast(role, "admin") && movement.user_id !== req.user!.id) {
      throw new ApiError(403, "You can only undo your own stock changes");
    }
    const result: UndoStockResult = await undoStockMovement({
      houseId,
      movementId: movement.id,
      userId: req.user!.id,
    });
    // Same follow-up as any other stock change: reminders and expiry state are
    // derived, so they are re-evaluated now instead of waiting for the scan.
    await afterStockChange(result.itemId);
    await syncHouseExpiry(houseId);
    res.json(result);
  }),
);
