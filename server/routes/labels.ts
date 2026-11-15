import { Router } from "express";
import { requireAuth } from "../auth.js";
import { PUBLIC_URL } from "../config.js";
import { handler } from "../http.js";

/**
 * Configuration for printable QR labels.
 *
 * The client builds the deep link, so all the server contributes is the
 * operator's public base URL (`PUBLIC_URL`). `null` means "use the origin the
 * browser is already on", which is right for localhost and single-origin
 * installs. No household data is returned here on purpose: a label is a link,
 * never a copy of the inventory.
 */
export const labelRoutes = Router();
labelRoutes.use(requireAuth);

labelRoutes.get(
  "/",
  handler(async (_req, res) => {
    res.json({ baseUrl: PUBLIC_URL || null });
  }),
);
