import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { POSTGRES_TABLE_ORDER } from "./postgres-schema.js";
import { applyStagedUploads, clearStagedRestore, stagedRestoreFiles } from "../services/restore-files.js";

interface LogicalDump {
  format: 2;
  schemaVersion: number;
  tables: Record<string, Record<string, unknown>[]>;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalise(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value && typeof value === "object" && !(value instanceof Date)) return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Apply a staged logical restore before the app starts serving.
 *
 * The archive is validated by the API/CLI before staging, so this only has to
 * move rows. It runs in one transaction: either the whole dump lands or the
 * existing database is left untouched.
 */
export async function applyPendingPostgresRestore(pool: pg.Pool): Promise<void> {
  const { marker, staging, ready } = stagedRestoreFiles();
  if (!ready) return;
  const rawManifest = JSON.parse(fs.readFileSync(marker, "utf8")) as { format?: number };
  if (rawManifest.format !== 2) {
    throw new Error("This backup contains a SQLite database and cannot be restored into PostgreSQL");
  }
  const dump = JSON.parse(fs.readFileSync(path.join(staging, "database.json"), "utf8")) as LogicalDump;
  if (dump.format !== 2 || !dump.tables) throw new Error("The staged backup is not a valid logical dump");

  const present = Object.keys(dump.tables);
  const order = [
    ...POSTGRES_TABLE_ORDER.filter((name) => present.includes(name)),
    ...present.filter((name) => !(POSTGRES_TABLE_ORDER as readonly string[]).includes(name)),
  ].filter((name) => name !== "schema_meta");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (order.length) {
      await client.query(`TRUNCATE TABLE ${order.map(quoteIdent).join(", ")} RESTART IDENTITY CASCADE`);
    }
    for (const table of order) {
      const rows = dump.tables[table] ?? [];
      if (!rows.length) continue;
      const columnSet = new Set<string>();
      for (const row of rows) for (const key of Object.keys(row)) columnSet.add(key);
      const columns = [...columnSet];
      const width = columns.length;
      const chunkSize = Math.max(1, Math.min(200, Math.floor(60000 / Math.max(width, 1))));
      for (let offset = 0; offset < rows.length; offset += chunkSize) {
        const chunk = rows.slice(offset, offset + chunkSize);
        const placeholders: string[] = [];
        const values: unknown[] = [];
        let index = 1;
        for (const row of chunk) {
          const tuple: string[] = [];
          for (const column of columns) {
            tuple.push(`$${index}`);
            index += 1;
            values.push(normalise(row[column]));
          }
          placeholders.push(`(${tuple.join(", ")})`);
        }
        await client.query(
          `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES ${placeholders.join(", ")}`,
          values,
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the original error is more useful */
    }
    throw error;
  } finally {
    client.release();
  }

  applyStagedUploads();
  clearStagedRestore();
}
