import express from "express";
import fs from "node:fs";
import path from "node:path";
import { PORT, CLIENT_DIR, IS_PROD, UPLOAD_DIR, ensureDirs } from "./config.js";
import { ApiError } from "./http.js";
import { IMAGE_EXTENSIONS } from "./upload.js";
import { RateLimitError, limitRequests, limiters, userOrIp } from "./rate-limit.js";
import { attachUser } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { passkeyRoutes } from "./routes/passkeys.js";
import { twoFactorRoutes } from "./routes/twofactor.js";
import { oidcRoutes } from "./routes/oidc.js";
import { houseRoutes } from "./routes/houses.js";
import { inventoryRoutes, itemRoutes } from "./routes/inventory.js";
import { receiptRoutes, singleReceiptRoutes } from "./routes/receipts.js";
import { receiptTemplateRoutes } from "./routes/receipt-templates.js";
import { recipeRoutes, singleRecipeRoutes } from "./routes/recipes.js";
import { ideaRoutes, singleIdeaRoutes } from "./routes/ideas.js";
import { photoRoutes, singlePhotoRoutes } from "./routes/photos.js";
import { globalNotificationRoutes, notificationRoutes } from "./routes/notifications.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { catalogRoutes } from "./routes/catalog.js";
import { shoppingRoutes } from "./routes/shopping.js";
import { planRoutes } from "./routes/plan.js";
import { intakeRoutes } from "./routes/intake.js";
import { importRoutes } from "./routes/imports.js";
import { backupRoutes } from "./routes/backup.js";
import { datasetRoutes } from "./routes/dataset.js";
import { aiLogRoutes } from "./routes/ai-logs.js";
import { inMaintenance } from "./maintenance.js";
import { scanAllHouses } from "./services/notifications.js";
import { seedVendorCatalog } from "./services/vendors.js";
import { seedProductCatalog } from "./services/product-catalog.js";
import { pruneOffProductCache } from "./services/openfoodfacts.js";
import { pruneAiCallLogs } from "./services/ai-logs.js";
import { initDb, closeDb, databaseKind } from "./db.js";

await initDb();
ensureDirs();
await seedVendorCatalog();
await seedProductCatalog();
await pruneOffProductCache();
await pruneAiCallLogs();

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  if (IS_PROD && req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(attachUser);

app.use((_req, res, next) => {
  if (!inMaintenance()) {
    next();
    return;
  }
  res.status(503).json({ error: "SVault is restoring a backup. Try again in a moment." });
});

if (!IS_PROD) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      if (req.path.startsWith("/api")) {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
      }
    });
    next();
  });
}

/* Rate limits for credential, invite and AI endpoints. Mounted by path ahead
   of the routers so every router gets the same treatment. */
const authLimit = limitRequests(limiters.login, undefined, "Too many sign-in attempts. Wait a few minutes and try again.");
app.post("/api/auth/login", authLimit);
app.post("/api/auth/register", limitRequests(limiters.register, undefined, "Too many sign-ups from this address. Try again later."));
app.post("/api/auth/2fa/verify", limitRequests(limiters.twoFactor, undefined, "Too many codes entered. Wait a few minutes and try again."));
app.post("/api/auth/passkeys/login/options", limitRequests(limiters.passkey));
app.post("/api/auth/passkeys/login/verify", limitRequests(limiters.passkey));
app.get("/api/auth/invites/:code", limitRequests(limiters.invite));
app.post("/api/auth/invites/:code/accept", limitRequests(limiters.invite));
const aiLimit = limitRequests(limiters.ai, userOrIp, "Too many AI requests. Wait a few minutes and try again.");
app.post("/api/houses/:houseId/receipts/scan", aiLimit);
app.post("/api/houses/:houseId/recipes/scan", aiLimit);
app.post("/api/houses/:houseId/intake/parse", aiLimit);
app.post("/api/houses/:houseId/ideas", aiLimit);
app.post("/api/houses/:houseId/ai/test", aiLimit);
app.post("/api/recipes/:recipeId/ai", aiLimit);

app.use("/api/auth", authRoutes);
app.use("/api/auth", passkeyRoutes);
app.use("/api/auth", twoFactorRoutes);
app.use("/api/auth", oidcRoutes);
app.use("/api/houses", houseRoutes);
app.use("/api/houses", aiLogRoutes);
app.use("/api/houses", inventoryRoutes);
app.use("/api/houses", receiptRoutes);
app.use("/api/houses", receiptTemplateRoutes);
app.use("/api/houses", recipeRoutes);
app.use("/api/houses", ideaRoutes);
app.use("/api/houses", photoRoutes);
app.use("/api/houses", notificationRoutes);
app.use("/api/houses", dashboardRoutes);
app.use("/api/houses", shoppingRoutes);
app.use("/api/houses", planRoutes);
app.use("/api/houses", intakeRoutes);
app.use("/api/houses", importRoutes);
app.use("/api/houses", backupRoutes);
app.use("/api/houses", datasetRoutes);
app.use("/api/notifications", globalNotificationRoutes);
app.use("/api/catalog", catalogRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/recipes", singleRecipeRoutes);
app.use("/api/receipts", singleReceiptRoutes);
app.use("/api/ideas", singleIdeaRoutes);
app.use("/api/photos", singlePhotoRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: 1, database: databaseKind(), time: new Date().toISOString() });
});

/* Uploaded files are user content served from the app's own origin. Lock them
   down so nothing under /uploads can run script, even if a non-image slipped
   in through an older version: no sniffing, a sandboxing CSP, and anything
   that is not a known image extension is forced to download. */
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    maxAge: "30d",
    fallthrough: true,
    index: false,
    dotfiles: "deny",
    setHeaders: (res, filePath) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox");
      if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", "attachment");
      }
    },
  }),
);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Unknown API route" });
});

if (fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR, { index: false, maxAge: IS_PROD ? "1h" : 0 }));
  // send() mis-resolves absolute Windows paths under Express 5, so pass a
  // relative file name with an explicit root instead.
  app.get(/^(?!\/api|\/uploads).*/, (_req, res) => {
    res.sendFile("index.html", { root: CLIENT_DIR });
  });
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof RateLimitError) res.setHeader("Retry-After", String(err.retryAfter));
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, details: err.details ?? undefined });
    return;
  }
  if (err?.name === "MulterError") {
    res.status(400).json({
      error: err.code === "LIMIT_FILE_SIZE" ? "That file is too large" : `Upload failed: ${err.message}`,
    });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong on the server" });
});

if (process.env.NODE_ENV !== "test") {
  const server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`SVault API listening on http://localhost:${PORT}`);
    try {
      await scanAllHouses();
    } catch (err) {
      console.error("Reminder scan failed:", err);
    }
    const timer = setInterval(async () => {
      try {
        await scanAllHouses();
      } catch (err) {
        console.error("Reminder scan failed:", err);
      }
    }, 30 * 60 * 1000);
    timer.unref();

    const logTimer = setInterval(() => void pruneAiCallLogs(), 24 * 60 * 60 * 1000);
    logTimer.unref();
    void server;
  });

  const shutdown = () => {
    server.close(() => {
      void closeDb().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
