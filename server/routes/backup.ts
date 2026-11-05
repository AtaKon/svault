import { Router } from "express";
import multer from "multer";
import { get } from "../db.js";
import { requireAuth, verifyPassword } from "../auth.js";
import { ApiError, handler, requireHouse } from "../http.js";
import { setMaintenance } from "../maintenance.js";
import { createBackupArchive, listBackups, stageRestore, validateBackup } from "../services/backup.js";
import { IS_PROD } from "../config.js";

export const backupRoutes = Router();
backupRoutes.use(requireAuth);

const restoreUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 },
}).single("backup");

backupRoutes.get(
  "/:houseId/backup",
  handler(async (req, res) => {
    requireHouse(req, "owner");
    const { buffer, name } = await createBackupArchive();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Content-Length", String(buffer.length));
    res.send(buffer);
  }),
);

backupRoutes.get(
  "/:houseId/backups",
  handler((req, res) => {
    requireHouse(req, "owner");
    res.json({ backups: listBackups() });
  }),
);

backupRoutes.post(
  "/:houseId/restore",
  restoreUpload,
  handler(async (req, res) => {
    const { houseId } = requireHouse(req, "owner");
    if (!req.file) throw new ApiError(400, "Attach a SVault backup zip");
    const body = (req.body ?? {}) as Record<string, string>;
    const house = get<any>("SELECT * FROM houses WHERE id = ?", [houseId])!;
    const named = String(body.houseName ?? "").trim().toLowerCase() === String(house.name).trim().toLowerCase();
    const passwordHash = body.password
      ? get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [req.user!.id])?.password_hash
      : null;
    const confirmed = Boolean(named || (body.password && passwordHash && verifyPassword(body.password, passwordHash)));
    if (!confirmed) throw new ApiError(400, "Type the house name or your password to confirm the restore");

    let validation;
    try {
      validation = await validateBackup(req.file.buffer);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "Invalid backup archive");
    }

    // Keep a safety copy of the current data before replacing anything.
    await createBackupArchive();
    stageRestore(validation);
    setMaintenance(true);
    res.json({
      ok: true,
      restarting: IS_PROD,
      manifest: validation.manifest,
      message: IS_PROD ? "Restore staged. The server is restarting." : "Restore staged. Restart the server to apply it.",
    });
    if (IS_PROD) {
      const timer = setTimeout(() => process.exit(0), 300);
      timer.unref();
    }
  }),
);
