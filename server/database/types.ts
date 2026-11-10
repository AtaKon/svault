/** Values that can be bound to a SQL statement on either backend. */
export type SqlParam = string | number | bigint | boolean | null | undefined | Uint8Array;

export interface RunResult {
  /** Number of rows changed by the statement (0 for statements that report none). */
  changes: number;
  /** SQLite only; kept for callers that used the old `node:sqlite` result. */
  lastInsertRowid?: number | bigint;
}

export type DatabaseKind = "sqlite" | "postgres";

/** SQL operations bound to the connection that owns a transaction. */
export interface DatabaseSession {
  all<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
}

export interface DatabaseTransactionOptions {
  /** Acquire SQLite's write reservation before running any transaction reads. */
  writeLock?: boolean;
}

/**
 * The database surface used by the rest of the server.
 *
 * Both implementations are asynchronous so a network-backed database does not
 * block the event loop. SQLite is wrapped in resolved promises; Postgres uses a
 * connection pool. Transactions are pinned to one connection (SQLite opens a
 * dedicated one) through AsyncLocalStorage, so concurrent requests cannot leak
 * into each other's transaction.
 */
export interface DatabaseDriver extends DatabaseSession {
  readonly kind: DatabaseKind;
  /** Create the schema and run any in-place migrations. Idempotent. */
  init(): Promise<void>;
  all<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  /** Execute one or more statements without binding parameters. */
  exec(sql: string): Promise<void>;
  /** Run `fn` inside a transaction; nested calls use savepoints. */
  tx<T>(fn: (session: DatabaseSession) => Promise<T>, options?: DatabaseTransactionOptions): Promise<T>;
  /** Table names in the current schema (used by backup and migrations). */
  tables(): Promise<string[]>;
  close(): Promise<void>;
}
