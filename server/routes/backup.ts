import { Router } from "express";
import fs from "node:fs";
import { get } from "../db.js";
import { requireAuth, verifyPassword } from "../auth.js";
import { ApiError, handler, requireHouse, requireInstanceAdmin } from "../http.js";
import { setMaintenance } from "../maintenance.js";
import { createBackupArchive, createPreRestoreCopy, listBackups, stageRestore, validateBackup } from "../services/backup.js";
import { IS_PROD, RESTORE_MAX_BYTES } from "../config.js";
import { archiveUploader } from "../upload.js";

export const backupRoutes = Router();
backupRoutes.use(requireAuth);

/*
 * Backups contain the whole instance (every house, every user, all uploads),
 * so they are limited to the instance administrator. The house-scoped URL is
 * kept for client compatibility; the caller must still be a member of it.
 */

/* The admin check runs before multer and the archive goes to a temp file, so
   nobody else can push a large body onto the server. */
const restoreUpload = archiveUploader("backup", RESTORE_MAX_BYTES, async (req) => {
  requireInstanceAdmin(req);
  await requireHouse(req);
});

backupRoutes.get(
  "/:houseId/backup",
  handler(async (req, res) => {
    requireInstanceAdmin(req);
    await requireHouse(req);
    const archive = await createBackupArchive();
    // Stream the finished zip from disk. The path is server-generated; allow
    // dot folders so a DATA_DIR such as ~/.svault does not turn into a 404.
    res.download(archive.path, archive.name, { dotfiles: "allow" });
  }),
);

backupRoutes.get(
  "/:houseId/backups",
  handler(async (req, res) => {
    requireInstanceAdmin(req);
    await requireHouse(req);
    res.json({ backups: listBackups() });
  }),
);

backupRoutes.post(
  "/:houseId/restore",
  restoreUpload,
  handler(async (req, res) => {
    requireInstanceAdmin(req);
    const { houseId } = await requireHouse(req);
    if (!req.file) throw new ApiError(400, "Attach a SVault backup zip");
    const body = (req.body ?? {}) as Record<string, string>;
    const house = (await get<any>("SELECT * FROM houses WHERE id = ?", [houseId]))!;
    const named = String(body.houseName ?? "").trim().toLowerCase() === String(house.name).trim().toLowerCase();
    const passwordHash = body.password
      ? (await get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [req.user!.id]))?.password_hash
      : null;
    const confirmed = Boolean(named || (body.password && passwordHash && verifyPassword(body.password, passwordHash)));
    if (!confirmed) throw new ApiError(400, "Type the house name or your password to confirm the restore");

    let validation;
    try {
      validation = await validateBackup(await fs.promises.readFile(req.file.path));
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : "Invalid backup archive");
    }

    // Keep a safety copy of the current data before replacing anything.
    await createPreRestoreCopy();
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
