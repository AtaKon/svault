import { randomBytes } from "node:crypto";
import { DATABASE_KIND } from "./config.js";
import { createDatabase } from "./database/index.js";
import type { DatabaseDriver, DatabaseKind, DatabaseSession, DatabaseTransactionOptions, RunResult } from "./database/types.js";
import { usernameFromEmail, usernameWithSuffix } from "./username.js";

export type Row = Record<string, any>;

let driver: DatabaseDriver | null = null;
let initPromise: Promise<void> | null = null;

function active(): DatabaseDriver {
  if (!driver) throw new Error("The database has not been initialised. Call initDb() before serving requests.");
  return driver;
}

/**
 * Open the configured database and apply its schema. Safe to call more than
 * once; concurrent callers share the same promise.
 */
export function initDb(): Promise<void> {
  initPromise ??= (async () => {
    const next = createDatabase();
    await next.init();
    driver = next;
    await backfillUsernames();
  })();
  return initPromise;
}

export async function closeDb(): Promise<void> {
  const current = driver;
  driver = null;
  initPromise = null;
  if (current) await current.close();
}

export function databaseKind(): DatabaseKind {
  return driver?.kind ?? DATABASE_KIND;
}

export function all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return active().all<T>(sql, params);
}

export function get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return active().get<T>(sql, params);
}

export function run(sql: string, params: unknown[] = []): Promise<RunResult> {
  return active().run(sql, params);
}

/** Execute one or more statements without binding parameters. */
export function exec(sql: string): Promise<void> {
  return active().exec(sql);
}

/** Run `fn` inside a transaction; nested calls use savepoints. */
export function tx<T>(fn: (session: DatabaseSession) => Promise<T>, options?: DatabaseTransactionOptions): Promise<T> {
  return active().tx(fn, options);
}

/**
 * Lock the house inside a transaction before any household-ledger reads/writes.
 * Postgres uses a row lock; SQLite's UPDATE takes the database write reservation.
 */
export async function lockHouseholdLedger(session: DatabaseSession, houseId: string): Promise<void> {
  if (active().kind === "postgres") {
    await session.get("SELECT id FROM houses WHERE id = ? FOR UPDATE", [houseId]);
    return;
  }
  await session.run("UPDATE houses SET id = id WHERE id = ?", [houseId]);
}

export function tables(): Promise<string[]> {
  return active().tables();
}

// Give every existing account a username so it can sign in with either one.
async function backfillUsernames(): Promise<void> {
  const missing = await all<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE username IS NULL OR username = '' ORDER BY created_at",
  );
  if (!missing.length) return;
  const taken = new Set(
    (
      await all<{ username: string }>("SELECT username FROM users WHERE username IS NOT NULL")
    )
      .map((entry) => String(entry.username).toLowerCase())
      .filter(Boolean),
  );
  for (const user of missing) {
    const base = usernameFromEmail(user.email);
    let candidate = base;
    let suffix = 1;
    while (taken.has(candidate)) {
      suffix += 1;
      candidate = usernameWithSuffix(base, suffix);
    }
    taken.add(candidate);
    await run("UPDATE users SET username = ? WHERE id = ?", [candidate, user.id]);
  }
}

export function now(): string {
  return new Date().toISOString();
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newId(prefix: string): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 36];
  return `${prefix}_${out}`;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function numeric(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function houseSettings(house: Row): Record<string, any> {
  return parseJson<Record<string, any>>(house.settings, {});
}
