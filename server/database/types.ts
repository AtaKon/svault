/** Values that can be bound to a SQL statement on either backend. */
export type SqlParam = string | number | bigint | boolean | null | undefined | Uint8Array;

export interface RunResult {
  /** Number of rows changed by the statement (0 for statements that report none). */
  changes: number;
  /** SQLite only; kept for callers that used the old `node:sqlite` result. */
  lastInsertRowid?: number | bigint;
}

export type DatabaseKind = "sqlite" | "postgres";

/**
 * The database surface used by the rest of the server.
 *
 * Both implementations are asynchronous so a network-backed database does not
 * block the event loop. SQLite is wrapped in resolved promises; Postgres uses a
 * connection pool. Transactions are pinned to one connection (SQLite opens a
 * dedicated one) through AsyncLocalStorage, so concurrent requests cannot leak
 * into each other's transaction.
 */
export interface DatabaseDriver {
  readonly kind: DatabaseKind;
  /** Create the schema and run any in-place migrations. Idempotent. */
  init(): Promise<void>;
  all<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  /** Execute one or more statements without binding parameters. */
  exec(sql: string): Promise<void>;
  /** Run `fn` inside a transaction; nested calls use savepoints. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  /** Table names in the current schema (used by backup and migrations). */
  tables(): Promise<string[]>;
  close(): Promise<void>;
}
