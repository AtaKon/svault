/**
 * Run the API suite against a disposable PostgreSQL database.
 *
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5432/svault_test npm run test:postgres
 *
 * The public schema is dropped first, so never point this at a real database.
 */
import { spawn } from "node:child_process";
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
