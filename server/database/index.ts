import { DATABASE_KIND } from "../config.js";
import { PostgresDriver } from "./postgres.js";
import { SqliteDriver } from "./sqlite.js";
import type { DatabaseDriver } from "./types.js";

export function createDatabase(): DatabaseDriver {
  return DATABASE_KIND === "postgres" ? new PostgresDriver() : new SqliteDriver();
}

export type { DatabaseDriver, DatabaseKind, RunResult, SqlParam } from "./types.js";
