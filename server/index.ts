import express from "express";
import fs from "node:fs";
import { PORT, CLIENT_DIR, IS_PROD, UPLOAD_DIR, ensureDirs } from "./config.js";
import { ApiError } from "./http.js";
import { attachUser } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
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
import { scanAllHouses } from "./services/notifications.js";
import { seedVendorCatalog } from "./services/vendors.js";
import { seedProductCatalog } from "./services/product-catalog.js";
import { pruneOffProductCache } from "./services/openfoodfacts.js";
import { db } from "./db.js";

ensureDirs();
seedVendorCatalog();
seedProductCatalog();
pruneOffProductCache();

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

app.use("/api/auth", authRoutes);
app.use("/api/houses", houseRoutes);
app.use("/api/houses", inventoryRoutes);
app.use("/api/houses", receiptRoutes);
app.use("/api/houses", receiptTemplateRoutes);
app.use("/api/houses", recipeRoutes);
app.use("/api/houses", ideaRoutes);
app.use("/api/houses", photoRoutes);
app.use("/api/houses", notificationRoutes);
app.use("/api/houses", dashboardRoutes);
app.use("/api/notifications", globalNotificationRoutes);
app.use("/api/catalog", catalogRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/recipes", singleRecipeRoutes);
app.use("/api/receipts", singleReceiptRoutes);
app.use("/api/ideas", singleIdeaRoutes);
app.use("/api/photos", singlePhotoRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: 1, time: new Date().toISOString() });
});

app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "30d", fallthrough: true, index: false }));

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
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, details: err.details ?? undefined });
    return;
  }
  if (err?.name === "MulterError") {
    res.status(400).json({
      error: err.code === "LIMIT_FILE_SIZE" ? "That image is too large" : `Upload failed: ${err.message}`,
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
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`SVault API listening on http://localhost:${PORT}`);
    try {
      scanAllHouses();
    } catch (err) {
      console.error("Reminder scan failed:", err);
    }
    const timer = setInterval(() => {
      try {
        scanAllHouses();
      } catch (err) {
        console.error("Reminder scan failed:", err);
      }
    }, 30 * 60 * 1000);
    timer.unref();
    void server;
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
