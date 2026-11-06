import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { DATABASE_URL, PG_POOL_SIZE, PG_SSL } from "../config.js";
import { POSTGRES_SCHEMA } from "./postgres-schema.js";
import { applyPendingPostgresRestore } from "./postgres-restore.js";
import type { DatabaseDriver, RunResult } from "./types.js";

const { Pool } = pg;

/* node-postgres returns int8/numeric columns as strings by default. SVault
   stores counts, sums and ids in those types, so parse them as numbers to keep
   the API responses identical to SQLite. */
pg.types.setTypeParser(20, (value: string) => Number(value));
pg.types.setTypeParser(1700, (value: string) => Number(value));

function normaliseParams(params: unknown[]): unknown[] {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}

/**
 * Rewrite SQLite-style positional placeholders (`?`) as PostgreSQL
 * placeholders (`$1`, `$2`, ...) while leaving quoted strings and comments
 * untouched.
 */
export function toPostgresPlaceholders(sql: string): string {
  let out = "";
  let index = 0;
  let count = 0;
  let quote: string | null = null;
  while (index < sql.length) {
    const char = sql[index];
    if (quote) {
      out += char;
      if (char === quote) {
        if (sql[index + 1] === quote) {
          out += sql[index + 1];
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "?") {
      count += 1;
      out += `$${count}`;
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

interface PgTx {
  client: pg.PoolClient;
  depth: number;
}

const txStorage = new AsyncLocalStorage<PgTx>();

export class PostgresDriver implements DatabaseDriver {
  readonly kind = "postgres" as const;
  private pool!: pg.Pool;

  async init(): Promise<void> {
    this.pool = new Pool({
      connectionString: DATABASE_URL,
      max: PG_POOL_SIZE,
      ssl: PG_SSL,
      application_name: "svault",
    });
    // Fail fast with a useful message instead of waiting for the first request.
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
    await this.pool.query(POSTGRES_SCHEMA);
    // CREATE TABLE IF NOT EXISTS does not add columns to existing installations.
    await this.pool.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS developer_mode INTEGER NOT NULL DEFAULT 0",
    );
    await this.pool.query(
      "INSERT INTO schema_meta (key, value) VALUES ('version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      ["3"],
    );
    await applyPendingPostgresRestore(this.pool);
  }

  private client(): pg.Pool | pg.PoolClient {
    return txStorage.getStore()?.client ?? this.pool;
  }

  async all<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client().query(toPostgresPlaceholders(sql), normaliseParams(params));
    return result.rows as T[];
  }

  async get<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = await this.client().query(toPostgresPlaceholders(sql), normaliseParams(params));
    return { changes: Number(result.rowCount ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    await this.client().query(sql);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const existing = txStorage.getStore();
    if (existing) {
      const savepoint = `sp_${existing.depth}`;
      await existing.client.query(`SAVEPOINT ${savepoint}`);
      existing.depth++;
      try {
        const result = await fn();
        existing.depth--;
        await existing.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        existing.depth--;
        try {
          await existing.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await existing.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          /* the original error is more useful */
        }
        throw error;
      }
    }

    const client = await this.pool.connect();
    await client.query("BEGIN");
    const context: PgTx = { client, depth: 0 };
    try {
      const result = await txStorage.run(context, fn);
      await client.query("COMMIT");
      return result;
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
  }

  async tables(): Promise<string[]> {
    const rows = await this.all<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    return rows.map((row) => row.table_name);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
