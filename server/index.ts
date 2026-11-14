import express from "express";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PORT, CLIENT_DIR, IS_PROD, RP_ORIGIN, UPLOAD_DIR, ensureDirs, trustProxySetting } from "./config.js";
import { ApiError } from "./http.js";
import { IMAGE_EXTENSIONS } from "./upload.js";
import { RateLimitError, limitRequests, limiters, userOrIp } from "./rate-limit.js";
import { attachUser } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { passkeyRoutes } from "./routes/passkeys.js";
import { twoFactorRoutes } from "./routes/twofactor.js";
import { oidcRoutes } from "./routes/oidc.js";
import { houseRoutes } from "./routes/houses.js";
import { itemDocumentRoutes } from "./routes/item-documents.js";
import { inventoryRoutes, itemRoutes } from "./routes/inventory.js";
import { receiptRoutes, singleReceiptRoutes } from "./routes/receipts.js";
import { billRoutes, singleBillRoutes } from "./routes/bills.js";
import { receiptTemplateRoutes } from "./routes/receipt-templates.js";
import { recipeRoutes, singleRecipeRoutes } from "./routes/recipes.js";
import { ideaRoutes, singleIdeaRoutes } from "./routes/ideas.js";
import { photoRoutes, singlePhotoRoutes } from "./routes/photos.js";
import { globalNotificationRoutes, notificationRoutes } from "./routes/notifications.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { catalogRoutes } from "./routes/catalog.js";
import { offRoutes } from "./routes/off.js";
import { shoppingRoutes } from "./routes/shopping.js";
import { planRoutes } from "./routes/plan.js";
import { intakeRoutes } from "./routes/intake.js";
import { importRoutes } from "./routes/imports.js";
import { backupRoutes } from "./routes/backup.js";
import { datasetRoutes } from "./routes/dataset.js";
import { aiLogRoutes } from "./routes/ai-logs.js";
import { insightRoutes } from "./routes/insights.js";
import { adminRoutes } from "./routes/admin.js";
import { apiTokenRoutes } from "./routes/api-tokens.js";
import { inMaintenance } from "./maintenance.js";
import { stripQuery } from "./lib/redact.js";
import { assertAiBudget } from "./services/ai-budget.js";
import { scanAllHouses } from "./services/notifications.js";
import { seedVendorCatalog } from "./services/vendors.js";
import { seedProductCatalog } from "./services/product-catalog.js";
import { pruneOffProductCache } from "./services/openfoodfacts.js";
import { startOffContributionWorker } from "./services/off/contributions.js";
import { offWritesEnabled } from "./services/off/auth.js";
import { validateSecretKey } from "./services/off/secrets.js";
import { pruneAiCallLogs } from "./services/ai-logs.js";
import { sweepOrphanUploads } from "./services/upload-cleanup.js";
import { initDb, closeDb, databaseKind } from "./db.js";

// Apply every schema migration before creating or serving the application.
// Insights may then safely query the bills table without a mid-migration gap.
await initDb();
ensureDirs();
await seedVendorCatalog();
await seedProductCatalog();
await pruneOffProductCache();
await pruneAiCallLogs();
if (offWritesEnabled() || process.env.SV_OFF_SECRET_KEY) validateSecretKey();
startOffContributionWorker();

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", trustProxySetting(process.env.SV_TRUST_PROXY));

/**
 * Content-Security-Policy for the app shell. The only inline script is the
 * theme bootstrap in index.html, allowed by its hash. Tesseract OCR needs
 * WebAssembly ('wasm-unsafe-eval') and a blob: worker; product photos come
 * from OpenFoodFacts over https. Set SV_CSP=off to disable it.
 */
function inlineScriptHashes(): string[] {
  try {
    const html = fs.readFileSync(path.join(CLIENT_DIR, "index.html"), "utf8");
    const hashes: string[] = [];
    for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      hashes.push(`'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
    }
    return hashes;
  } catch {
    return [];
  }
}

const SHELL_CSP = [
  "default-src 'self'",
  ["script-src 'self' 'wasm-unsafe-eval'", ...inlineScriptHashes()].join(" "),
  "worker-src 'self' blob:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");
const CSP_ENABLED = (process.env.SV_CSP ?? "on").trim().toLowerCase() !== "off";

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  if (CSP_ENABLED && !req.path.startsWith("/uploads")) res.setHeader("Content-Security-Policy", SHELL_CSP);
  if (IS_PROD && req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

/**
 * CSRF defence in depth on top of SameSite=Lax cookies: a state-changing API
 * request from a browser must come from this origin. Browsers mark requests
 * with Sec-Fetch-Site and Origin; non-browser clients send neither and pass.
 */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function trustedHosts(req: express.Request): Set<string> {
  const hosts = new Set<string>();
  if (req.headers.host) hosts.add(req.headers.host.toLowerCase());
  const forwarded = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim().toLowerCase();
  if (forwarded) hosts.add(forwarded);
  if (RP_ORIGIN) {
    try {
      hosts.add(new URL(RP_ORIGIN).host.toLowerCase());
    } catch {
      /* ignore a malformed ORIGIN */
    }
  }
  return hosts;
}
app.use("/api", (req, res, next) => {
  if (!UNSAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (site === "same-origin" || site === "none") {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      host = "";
    }
    if (host && trustedHosts(req).has(host)) {
      next();
      return;
    }
  } else if (!site) {
    next();
    return;
  }
  res.status(403).json({ error: "Cross-site request blocked" });
});

app.use(express.json({ limit: "2mb" }));
app.use(attachUser);

/* API tokens are read-only by design: they exist for dashboards and home
   automation. Anything that changes data needs a signed-in session. */
app.use("/api", (req, res, next) => {
  if (!req.apiTokenReadOnly) {
    next();
    return;
  }
  // Even an administrator's token should not expose the instance console or
  // mint further tokens. Those stay behind a real signed-in session.
  if (req.path.startsWith("/admin") || req.path.startsWith("/tokens")) {
    res.status(403).json({ error: "API tokens cannot use this endpoint. Sign in with a session." });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  res.status(403).json({ error: "API tokens are read-only. Sign in to change data." });
});

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
        console.log(`${req.method} ${stripQuery(req.originalUrl)} ${res.statusCode} ${Date.now() - start}ms`);
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
const aiBudgetGuard: express.RequestHandler = (_req, _res, next) => {
  assertAiBudget().then(() => next()).catch(next);
};
app.post("/api/houses/:houseId/receipts/scan", aiLimit, aiBudgetGuard);
app.post("/api/houses/:houseId/recipes/scan", aiLimit, aiBudgetGuard);
app.post("/api/houses/:houseId/recipes/import", aiLimit, aiBudgetGuard);
app.post("/api/houses/:houseId/intake/parse", aiLimit, aiBudgetGuard);
app.post("/api/houses/:houseId/ideas", aiLimit, aiBudgetGuard);
app.post("/api/houses/:houseId/ai/test", aiLimit, aiBudgetGuard);
app.post("/api/recipes/:recipeId/ai", aiLimit, aiBudgetGuard);
app.post(
  "/api/houses/:houseId/insights/price-alerts/scan",
  limitRequests(limiters.insights, userOrIp, "Too many price checks. Wait a few minutes and try again."),
);

app.use("/api/auth", authRoutes);
app.use("/api/auth", passkeyRoutes);
app.use("/api/auth", twoFactorRoutes);
app.use("/api/auth", oidcRoutes);
app.use("/api/houses", houseRoutes);
app.use("/api/houses", aiLogRoutes);
app.use("/api/houses", inventoryRoutes);
app.use("/api/houses", receiptRoutes);
app.use("/api/houses", billRoutes);
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
app.use("/api/houses", insightRoutes);
app.use("/api/notifications", globalNotificationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/tokens", apiTokenRoutes);
app.use("/api/catalog", catalogRoutes);
app.use("/api/off", offRoutes);
app.use("/api/items", itemDocumentRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/recipes", singleRecipeRoutes);
app.use("/api/receipts", singleReceiptRoutes);
app.use("/api/bills", singleBillRoutes);
app.use("/api/ideas", singleIdeaRoutes);
app.use("/api/photos", singlePhotoRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: 1, database: databaseKind(), time: new Date().toISOString() });
});

/* Uploaded files are user content served from the app's own origin. Lock them
   down so nothing under /uploads can run script, even if a non-image slipped
   in through an older version: no sniffing, a sandboxing CSP, and anything
   that is not a known image extension is forced to download. */
// Keep this before express.static below: bill PDFs are served by authenticated
// API routes, never by their storage paths.
app.use("/uploads/item-documents", (_req, _res, next) => next(new ApiError(404, "Not found")));
app.use("/uploads/bills", (_req, _res, next) => next(new ApiError(404, "Not found")));
// Receipt photos and other uploads hold household data. Their names are random,
// but a leaked link must not be enough on its own: require a signed-in session.
// API tokens are for automation and are not accepted here either.
app.use("/uploads", (req, _res, next) => {
  if (!req.user || req.apiTokenReadOnly) return next(new ApiError(404, "Not found"));
  next();
});
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    maxAge: "30d",
    fallthrough: true,
    index: false,
    dotfiles: "deny",
    setHeaders: (res, filePath) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Signed-in content: browsers may cache it, shared proxies may not.
      res.setHeader("Cache-Control", "private, max-age=2592000");
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

export function apiErrorHandler(err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) {
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
}

app.use(apiErrorHandler);

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

    const sweepUploads = async () => {
      try {
        const removed = await sweepOrphanUploads();
        if (removed) console.log(`Removed ${removed} orphaned upload${removed === 1 ? "" : "s"}`);
      } catch (err) {
        console.error("Upload cleanup failed:", err);
      }
    };
    void sweepUploads();

    const logTimer = setInterval(() => {
      void pruneAiCallLogs();
      void sweepUploads();
    }, 24 * 60 * 60 * 1000);
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
