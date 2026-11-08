/**
 * Run the API suite against a disposable PostgreSQL database.
 *
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5432/svault_test npm run test:postgres
 *
 * The public schema is dropped first, so never point this at a real database.
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("Set TEST_DATABASE_URL to a disposable PostgreSQL database.");
  process.exit(1);
}
if (url === process.env.DATABASE_URL) {
  console.error("TEST_DATABASE_URL must not be the same as DATABASE_URL.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
try {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  // Exercise startup against the old single-project cache before the API suite
  // creates a fresh schema. Existing indexes must not hide a missing column.
  await pool.query(`CREATE TABLE catalog_products (
    code TEXT PRIMARY KEY, name TEXT, brand TEXT, quantity TEXT, image TEXT,
    categories TEXT, summary TEXT NOT NULL DEFAULT '{}', payload TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'openfoodfacts', fetched_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX catalog_products_name ON catalog_products(name);
  CREATE INDEX catalog_products_brand ON catalog_products(brand);
  INSERT INTO catalog_products (code, name, fetched_at, updated_at)
    VALUES ('123', 'Legacy product', '2026-01-01', '2026-01-01');`);
  process.env.DATABASE_URL = url;
  const { PostgresDriver } = await import("../server/database/postgres.ts");
  const driver = new PostgresDriver();
  try {
    await driver.init();
    assert.deepEqual(await driver.get("SELECT project, code, name FROM catalog_products WHERE code = ?", ["123"]),
      { project: "off", code: "123", name: "Legacy product" });
    const indexes = await driver.all("SELECT indexname FROM pg_indexes WHERE tablename = 'catalog_products'");
    assert.ok(indexes.some((row) => row.indexname === "catalog_products_project_name"));
    assert.ok(indexes.some((row) => row.indexname === "catalog_products_project_brand"));
  } finally {
    await driver.close();
  }
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
} catch (error) {
  console.error(`Could not reset ${url.split("@").pop()}:`, error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  await pool.end();
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--disable-warning=ExperimentalWarning", "--test", "server/tests/api.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: "" },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
