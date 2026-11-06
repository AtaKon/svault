/**
 * Copy an existing SQLite vault into PostgreSQL.
 *
 *   DATABASE_URL=postgres://svault:secret@db:5432/svault npm run migrate:postgres
 *
 * The target must be empty unless --force is passed (which truncates it first).
 * Run the app with the same DATABASE_URL afterwards. Uploads stay in DATA_DIR.
 */
import fs from "node:fs";
import { SqliteDriver } from "../server/database/sqlite.ts";
import { PostgresDriver } from "../server/database/postgres.ts";
import { POSTGRES_TABLE_ORDER } from "../server/database/postgres-schema.ts";
import { DATA_DIR, DB_FILE } from "../server/config.ts";

const force = process.argv.includes("--force");

if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL to the PostgreSQL database you want to copy into.");
  process.exit(1);
}
if (!fs.existsSync(DB_FILE)) {
  console.error(`No SQLite database found at ${DB_FILE}. Set DATA_DIR if it lives elsewhere.`);
  process.exit(1);
}

function quote(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function redact(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(invalid connection string)";
  }
}

function value(input) {
  if (input === undefined) return null;
  if (typeof input === "boolean") return input ? 1 : 0;
  return input;
}

const sqlite = new SqliteDriver();
const postgres = new PostgresDriver();

try {
  console.log(`Reading ${DB_FILE}`);
  await sqlite.init();
  console.log(`Preparing PostgreSQL schema at ${redact(process.env.DATABASE_URL)}`);
  await postgres.init();

  const sourceTables = new Set(await sqlite.tables());
  const ordered = [
    ...POSTGRES_TABLE_ORDER.filter((table) => sourceTables.has(table)),
    ...[...sourceTables].filter((table) => !POSTGRES_TABLE_ORDER.includes(table) && table !== "schema_meta"),
  ];
  const missing = [...sourceTables].filter((table) => table !== "schema_meta" && !ordered.includes(table));
  if (missing.length) {
    console.warn(`Skipping unknown tables: ${missing.join(", ")}`);
  }

  const existingUsers = await postgres.get("SELECT COUNT(*) AS n FROM users");
  if (Number(existingUsers?.n ?? 0) > 0 && !force) {
    console.error("The PostgreSQL database already has users. Re-run with --force to replace its data.");
    process.exit(1);
  }

  const targetTables = (await postgres.tables()).filter((table) => table !== "schema_meta");

  await postgres.tx(async () => {
    if (targetTables.length) {
      await postgres.exec(`TRUNCATE TABLE ${targetTables.map(quote).join(", ")} RESTART IDENTITY CASCADE`);
    }
    for (const table of ordered) {
      const rows = await sqlite.all(`SELECT * FROM ${quote(table)}`);
      if (!rows.length) {
        console.log(`  ${table}: 0 rows`);
        continue;
      }
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const placeholders = `(${columns.map(() => "?").join(", ")})`;
      for (const row of rows) {
        await postgres.run(
          `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES ${placeholders}`,
          columns.map((column) => value(row[column])),
        );
      }
      console.log(`  ${table}: ${rows.length} rows`);
    }
  });

  let failed = false;
  for (const table of ordered) {
    const source = await sqlite.get(`SELECT COUNT(*) AS n FROM ${quote(table)}`);
    const target = await postgres.get(`SELECT COUNT(*) AS n FROM ${quote(table)}`);
    if (Number(source?.n ?? 0) !== Number(target?.n ?? 0)) {
      console.error(`Count mismatch on ${table}: ${source?.n} -> ${target?.n}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`Migration complete. Start SVault with DATABASE_URL and DATA_DIR=${DATA_DIR}.`);
} finally {
  await postgres.close().catch(() => {});
  await sqlite.close().catch(() => {});
}
