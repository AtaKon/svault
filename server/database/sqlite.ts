import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DB_FILE, PRE_RESTORE_DIR, PRE_RESTORE_KEEP, UPLOAD_DIR, ensureDirs } from "../config.js";
import { pruneOldFiles } from "../services/restore-files.js";
import { RESERVED_ATTRIBUTE_KEYS } from "../../shared/types.js";
import type { DatabaseDriver, RunResult } from "./types.js";

/** A restore is staged by the API and applied before SQLite is opened. */
export function applyPendingSqliteRestore() {
  const marker = path.join(path.dirname(DB_FILE), ".restore-pending.json");
  const staging = path.join(path.dirname(DB_FILE), ".restore-staging");
  if (!fs.existsSync(marker) || !fs.existsSync(path.join(staging, "svault.db"))) return;
  // Raw copy of the database being replaced, next to the pre-restore zips and
  // rotated with them (the zip taken when the restore was staged also has uploads).
  if (fs.existsSync(DB_FILE)) {
    fs.mkdirSync(PRE_RESTORE_DIR, { recursive: true });
    fs.copyFileSync(DB_FILE, path.join(PRE_RESTORE_DIR, `pre-restore-${Date.now()}.db`));
    pruneOldFiles(PRE_RESTORE_DIR, /^pre-restore-.*\.db$/, PRE_RESTORE_KEEP);
  }
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${DB_FILE}${suffix}`, { force: true });
  fs.copyFileSync(path.join(staging, "svault.db"), DB_FILE);
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const uploads = path.join(staging, "uploads");
  if (fs.existsSync(uploads)) fs.cpSync(uploads, UPLOAD_DIR, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(marker, { force: true });
}

function normaliseParams(params: unknown[]): any[] {
  return params.map((value) => (value === undefined ? null : value));
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface SqliteTx {
  conn: DatabaseSync;
  depth: number;
}

const txStorage = new AsyncLocalStorage<SqliteTx>();

export class SqliteDriver implements DatabaseDriver {
  readonly kind = "sqlite" as const;
  private main!: DatabaseSync;

  async init(): Promise<void> {
    ensureDirs();
    applyPendingSqliteRestore();
    const conn = new DatabaseSync(DB_FILE);
    conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    // Create the current tables before applying in-place column migrations below.
    conn.exec(SCHEMA);

    /**
     * Lightweight in-place migrations for databases created by older versions.
     * CREATE TABLE IF NOT EXISTS never adds columns, so patch them explicitly.
     */
    const columns = (table: string) =>
      conn.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    const ensureColumn = (table: string, column: string, definition: string) => {
      if (!columns(table).some((entry) => entry.name === column)) {
        conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        return true;
      }
      return false;
    };
    const runLocal = (sql: string, params: unknown[] = []) =>
      conn.prepare(sql).run(...normaliseParams(params));

    ensureColumn("users", "username", "TEXT");
    ensureColumn("users", "language", "TEXT");
    ensureColumn("users", "developer_mode", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("users", "password_set", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn("ai_call_logs", "metadata", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("user_totp", "last_used_step", "INTEGER");
    ensureColumn("login_challenges", "attempts", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("notifications", "user_id", "TEXT REFERENCES users(id) ON DELETE CASCADE");
    ensureColumn("stock_lots", "vendor_id", "TEXT REFERENCES vendors(id) ON DELETE SET NULL");
    ensureColumn("stock_lots", "receipt_id", "TEXT REFERENCES receipts(id) ON DELETE SET NULL");
    ensureColumn("stock_movements", "vendor_id", "TEXT REFERENCES vendors(id) ON DELETE SET NULL");
    ensureColumn("stock_movements", "receipt_id", "TEXT REFERENCES receipts(id) ON DELETE SET NULL");
    ensureColumn("receipts", "subtotal", "REAL");
    ensureColumn("receipts", "tax", "REAL");
    ensureColumn("receipts", "tax_breakdown", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("receipts", "template_id", "TEXT");
    ensureColumn("receipts", "template_confidence", "REAL");
    ensureColumn("receipts", "provider", "TEXT");
    ensureColumn("receipts", "ai_cost", "REAL");
    ensureColumn("receipts", "savings", "REAL");
    ensureColumn("receipts", "paid_by", "TEXT REFERENCES users(id) ON DELETE SET NULL");
    ensureColumn("receipts", "split_with", "TEXT NOT NULL DEFAULT '[]'");
    // Fresh rows default to unconfirmed; preserve the old ledger behavior for
    // shared bills that predate the acknowledgement column.
    if (!columns("bills").some((entry) => entry.name === "ledger_confirmed")) {
      // Adding the marker and preserving the old shared-bill ledger in one
      // transaction prevents a crash from leaving migrated rows unconfirmed.
      conn.exec("BEGIN");
      try {
        conn.exec("ALTER TABLE bills ADD COLUMN ledger_confirmed INTEGER NOT NULL DEFAULT 0");
        runLocal("UPDATE bills SET ledger_confirmed = 1 WHERE category = 'to_split'");
        conn.exec("COMMIT");
      } catch (error) {
        conn.exec("ROLLBACK");
        throw error;
      }
    }
    ensureColumn("receipt_lines", "raw_description", "TEXT");
    ensureColumn("receipt_lines", "tax_rate", "REAL");
    ensureColumn("receipt_lines", "discount", "REAL");
    ensureColumn("receipt_lines", "off_code", "TEXT");
    ensureColumn("recipes", "ai_cost", "REAL");
    ensureColumn("items", "off_code", "TEXT");
    ensureColumn("items", "off_linked_at", "TEXT");
    ensureColumn("items", "off_source", "TEXT");
    ensureColumn("items", "off_synced_at", "TEXT");
    ensureColumn("items", "off_filled", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("items", "nutrition", "TEXT");
    conn.exec("CREATE INDEX IF NOT EXISTS items_off ON items(off_code)");
    conn.exec(`UPDATE receipts SET savings = (
  SELECT ROUND(SUM(COALESCE(discount, 0)), 2) FROM receipt_lines WHERE receipt_id = receipts.id
) WHERE savings IS NULL AND EXISTS (
  SELECT 1 FROM receipt_lines WHERE receipt_id = receipts.id AND COALESCE(discount, 0) > 0
)`);
    ensureColumn("product_aliases", "raw_text", "TEXT");
    conn.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username COLLATE NOCASE) WHERE username IS NOT NULL");
    conn.exec("CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at)");

    /* catalog_mappings gained house_id and a wider unique key. SQLite cannot
       change a table constraint in place, so rebuild the table once. Rows
       learned before this change stay shared (house_id ''). */
    if (!columns("catalog_mappings").some((entry) => entry.name === "house_id")) {
      conn.exec(`BEGIN;
CREATE TABLE catalog_mappings_scoped (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  vendor_key TEXT NOT NULL DEFAULT '',
  vendor_label TEXT,
  raw_key TEXT NOT NULL,
  raw_text TEXT,
  off_code TEXT,
  name TEXT,
  brand TEXT,
  unit TEXT,
  category TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  confidence REAL NOT NULL DEFAULT 0.5,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (house_id, country, vendor_key, raw_key)
);
INSERT INTO catalog_mappings_scoped
  (id, house_id, country, vendor_key, vendor_label, raw_key, raw_text, off_code, name, brand, unit, category,
   source, confidence, uses, created_at, updated_at)
SELECT id, '', country, vendor_key, vendor_label, raw_key, raw_text, off_code, name, brand, unit, category,
   source, confidence, uses, created_at, updated_at FROM catalog_mappings;
DROP TABLE catalog_mappings;
ALTER TABLE catalog_mappings_scoped RENAME TO catalog_mappings;
CREATE INDEX IF NOT EXISTS catalog_mappings_lookup ON catalog_mappings(country, vendor_key, raw_key);
CREATE INDEX IF NOT EXISTS catalog_mappings_off ON catalog_mappings(off_code);
COMMIT;`);
    }
    conn.exec("CREATE INDEX IF NOT EXISTS catalog_mappings_house ON catalog_mappings(house_id)");

    /**
     * Older versions shipped `brand` both as an items column and as a default
     * custom attribute, so every item showed Brand twice. Keep the column and
     * fold any value stored in the attribute JSON back into it. Other reserved
     * keys are stripped from stored attributes for the same reason.
     */
    const version = Number(
      (conn.prepare("PRAGMA user_version").get() as any)?.user_version ?? 0,
    );
    if (version < 1) {
      const reserved = new Set<string>(RESERVED_ATTRIBUTE_KEYS);
      const placeholders = RESERVED_ATTRIBUTE_KEYS.map(() => "?").join(", ");
      runLocal(`DELETE FROM attribute_defs WHERE key IN (${placeholders})`, [...RESERVED_ATTRIBUTE_KEYS]);

      const items = conn
        .prepare("SELECT id, brand, attributes FROM items WHERE attributes <> '{}'")
        .all() as any[];
      for (const item of items) {
        const attributes = parseJson<Record<string, unknown>>(item.attributes, {});
        const reservedKeys = Object.keys(attributes).filter((key) => reserved.has(key));
        if (!reservedKeys.length) continue;
        const legacyBrand = attributes.brand;
        for (const key of reservedKeys) delete attributes[key];
        const currentBrand = typeof item.brand === "string" ? item.brand.trim() : "";
        const fallbackBrand =
          typeof legacyBrand === "string"
            ? legacyBrand.trim()
            : legacyBrand == null
              ? ""
              : String(legacyBrand).trim();
        runLocal("UPDATE items SET brand = ?, attributes = ? WHERE id = ?", [
          currentBrand || fallbackBrand || null,
          JSON.stringify(attributes),
          item.id,
        ]);
      }

      const aliases = conn
        .prepare("SELECT id, attributes FROM product_aliases WHERE attributes <> '{}'")
        .all() as any[];
      for (const alias of aliases) {
        const attributes = parseJson<Record<string, unknown>>(alias.attributes, {});
        const reservedKeys = Object.keys(attributes).filter((key) => reserved.has(key));
        if (!reservedKeys.length) continue;
        for (const key of reservedKeys) delete attributes[key];
        runLocal("UPDATE product_aliases SET attributes = ? WHERE id = ?", [
          JSON.stringify(attributes),
          alias.id,
        ]);
      }

      conn.exec("PRAGMA user_version = 1");
    }

    this.main = conn;
  }

  private conn(): DatabaseSync {
    return txStorage.getStore()?.conn ?? this.main;
  }

  async all<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.conn().prepare(sql).all(...normaliseParams(params)) as unknown as T[];
  }

  async get<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.conn().prepare(sql).get(...normaliseParams(params)) as unknown as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = this.conn().prepare(sql).run(...normaliseParams(params)) as any;
    return {
      changes: Number(result?.changes ?? 0),
      lastInsertRowid: result?.lastInsertRowid,
    };
  }

  async exec(sql: string): Promise<void> {
    this.conn().exec(sql);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const existing = txStorage.getStore();
    if (existing) {
      const savepoint = `sp_${existing.depth}`;
      existing.conn.exec(`SAVEPOINT ${savepoint}`);
      existing.depth++;
      try {
        const result = await fn();
        existing.depth--;
        existing.conn.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        existing.depth--;
        try {
          existing.conn.exec(`ROLLBACK TO ${savepoint}`);
          existing.conn.exec(`RELEASE ${savepoint}`);
        } catch {
          /* the original error is more useful */
        }
        throw error;
      }
    }

    // A transaction gets its own connection so concurrent requests cannot see
    // or join its uncommitted writes. WAL keeps readers available.
    const conn = new DatabaseSync(DB_FILE);
    conn.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    conn.exec("BEGIN");
    const context: SqliteTx = { conn, depth: 0 };
    try {
      const result = await txStorage.run(context, fn);
      conn.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch {
        /* the original error is more useful */
      }
      throw error;
    } finally {
      conn.close();
    }
  }

  async tables(): Promise<string[]> {
    const rows = await this.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    return rows.map((row) => row.name);
  }

  async close(): Promise<void> {
    this.main.close();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_set INTEGER NOT NULL DEFAULT 1,
  language TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  developer_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

/* Read-only API tokens for dashboards and home automation. Only a hash is
   stored; the plain token is shown once when it is created. */
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);

/* Instance-wide switches an admin can change without a restart. */
CREATE TABLE IF NOT EXISTS instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  backup_codes TEXT NOT NULL DEFAULT '[]',
  last_used_step INTEGER,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL DEFAULT 'Passkey',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  challenge TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry ON webauthn_challenges(expires_at);

CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities(user_id);

CREATE TABLE IF NOT EXISTS login_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_challenges_user ON login_challenges(user_id, type);

CREATE TABLE IF NOT EXISTS houses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'home',
  address TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  settings TEXT NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS house_members (
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (house_id, user_id)
);

CREATE TABLE IF NOT EXISTS house_invites (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  code TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  accepted_at TEXT,
  accepted_by TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'shelf',
  icon TEXT,
  parent_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS locations_house ON locations(house_id);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS categories_house ON categories(house_id);

CREATE TABLE IF NOT EXISTS attribute_defs (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  unit TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (house_id, key)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  brand TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  reorder_point REAL NOT NULL DEFAULT 0,
  target_stock REAL,
  attributes TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  image TEXT,
  nutrition TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_house ON items(house_id);

CREATE TABLE IF NOT EXISTS item_barcodes (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  format TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (house_id, code)
);
CREATE INDEX IF NOT EXISTS barcodes_item ON item_barcodes(item_id);

CREATE TABLE IF NOT EXISTS stock_lots (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL,
  unit_price REAL,
  currency TEXT,
  purchased_at TEXT,
  expires_at TEXT,
  note TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lots_item ON stock_lots(item_id);
CREATE INDEX IF NOT EXISTS lots_house ON stock_lots(house_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  lot_id TEXT REFERENCES stock_lots(id) ON DELETE SET NULL,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  delta REAL NOT NULL,
  unit TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL,
  normalized_price REAL,
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  note TEXT,
  balance_after REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS movements_item ON stock_movements(item_id, created_at);
CREATE INDEX IF NOT EXISTS movements_house ON stock_movements(house_id, created_at);

CREATE TABLE IF NOT EXISTS stock_mutations (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  response TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (house_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'shop',
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (house_id, name COLLATE NOCASE)
);
CREATE INDEX IF NOT EXISTS vendors_house ON vendors(house_id);

CREATE TABLE IF NOT EXISTS vendor_catalog (
  id TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'shop',
  aliases TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  UNIQUE (country, name)
);
CREATE INDEX IF NOT EXISTS vendor_catalog_country ON vendor_catalog(country, sort);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name TEXT,
  purchased_at TEXT,
  currency TEXT,
  total REAL,
  subtotal REAL,
  tax REAL,
  tax_breakdown TEXT NOT NULL DEFAULT '[]',
  template_id TEXT,
  template_confidence REAL,
  provider TEXT,
  ai_cost REAL,
  savings REAL,
  image TEXT,
  ocr_text TEXT,
  source TEXT NOT NULL DEFAULT 'scan',
  notes TEXT,
  paid_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  split_with TEXT NOT NULL DEFAULT '[]',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_house ON receipts(house_id, created_at);

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bill_type TEXT NOT NULL DEFAULT 'other' CHECK (bill_type IN ('electricity', 'water', 'natural_gas', 'heating_oil', 'internet_telecom', 'rent', 'building_fees', 'municipal_fees', 'insurance', 'other')),
  category TEXT NOT NULL DEFAULT 'personal',
  ledger_confirmed INTEGER NOT NULL DEFAULT 0,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  due_date TEXT,
  paid_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  split_with TEXT NOT NULL DEFAULT '[]',
  document TEXT,
  notes TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bills_house ON bills(house_id, due_date, created_at);

CREATE TABLE IF NOT EXISTS receipt_lines (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  raw_description TEXT,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  unit_price REAL,
  line_total REAL,
  tax_rate REAL,
  discount REAL,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  barcode TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS receipt_lines_receipt ON receipt_lines(receipt_id);
CREATE INDEX IF NOT EXISTS receipt_lines_item ON receipt_lines(item_id);

CREATE TABLE IF NOT EXISTS product_aliases (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  vendor_key TEXT NOT NULL DEFAULT '',
  raw_key TEXT NOT NULL,
  raw_text TEXT,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  unit TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  attributes TEXT NOT NULL DEFAULT '{}',
  uses INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (house_id, vendor_key, raw_key)
);
CREATE INDEX IF NOT EXISTS product_aliases_house ON product_aliases(house_id, vendor_key);

/* Shared product catalogue. Cached products and seed/community mappings are
   instance-wide; mappings learned from one house's receipts carry that
   house_id ('' marks a shared row) so they never leak into other houses. */
CREATE TABLE IF NOT EXISTS catalog_products (
  code TEXT PRIMARY KEY,
  name TEXT,
  brand TEXT,
  quantity TEXT,
  image TEXT,
  categories TEXT,
  summary TEXT NOT NULL DEFAULT '{}',
  payload TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'openfoodfacts',
  fetched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS catalog_products_name ON catalog_products(name);
CREATE INDEX IF NOT EXISTS catalog_products_brand ON catalog_products(brand);

CREATE TABLE IF NOT EXISTS catalog_mappings (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  vendor_key TEXT NOT NULL DEFAULT '',
  vendor_label TEXT,
  raw_key TEXT NOT NULL,
  raw_text TEXT,
  off_code TEXT,
  name TEXT,
  brand TEXT,
  unit TEXT,
  category TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  confidence REAL NOT NULL DEFAULT 0.5,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (house_id, country, vendor_key, raw_key)
);
CREATE INDEX IF NOT EXISTS catalog_mappings_lookup ON catalog_mappings(country, vendor_key, raw_key);
CREATE INDEX IF NOT EXISTS catalog_mappings_off ON catalog_mappings(off_code);

CREATE TABLE IF NOT EXISTS receipt_templates (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'GR',
  vendor_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  rules TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (house_id, name COLLATE NOCASE)
);
CREATE INDEX IF NOT EXISTS receipt_templates_house ON receipt_templates(house_id, active);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  read_by TEXT NOT NULL DEFAULT '[]',
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (house_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_house ON notifications(house_id, created_at);

CREATE TABLE IF NOT EXISTS shopping_list_items (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  checked INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shopping_house ON shopping_list_items(house_id, checked, created_at);

/* Remembers which source (a recipe line, a low-stock item, a whole week of
   planned meals) produced a shopping-list line, so adding it twice is a no-op. */
CREATE TABLE IF NOT EXISTS shopping_list_sources (
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  line_id TEXT NOT NULL REFERENCES shopping_list_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (house_id, source_key)
);
CREATE INDEX IF NOT EXISTS shopping_sources_line ON shopping_list_sources(line_id);

CREATE TABLE IF NOT EXISTS meal_plan_entries (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  slot TEXT NOT NULL,
  recipe_id TEXT REFERENCES recipes(id) ON DELETE CASCADE,
  idea_id TEXT REFERENCES food_ideas(id) ON DELETE CASCADE,
  idea_index INTEGER,
  title TEXT,
  servings REAL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meal_plan_house ON meal_plan_entries(house_id, day, slot, sort);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (house_id, channel_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS deliveries_house ON notification_deliveries(house_id, created_at);

CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  servings INTEGER,
  prep_minutes INTEGER,
  cook_minutes INTEGER,
  steps TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  image TEXT,
  source_image TEXT,
  ocr_text TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  ai_notes TEXT,
  ai_cost REAL,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recipes_house ON recipes(house_id, updated_at);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  optional INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ingredients_recipe ON recipe_ingredients(recipe_id);

CREATE TABLE IF NOT EXISTS food_ideas (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  prompt TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photo_collections (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  collection_id TEXT REFERENCES photo_collections(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  notes TEXT,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  split TEXT NOT NULL DEFAULT 'unassigned',
  captured_at TEXT,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_house ON photos(house_id, created_at);
CREATE INDEX IF NOT EXISTS photos_collection ON photos(collection_id);

CREATE TABLE IF NOT EXISTS photo_labels (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  x REAL,
  y REAL,
  w REAL,
  h REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS labels_photo ON photo_labels(photo_id);
CREATE INDEX IF NOT EXISTS labels_house ON photo_labels(house_id);

CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

/* One row per request sent to an OpenAI-compatible provider. Kept separate
   from receipts and recipes so the developer page can show every call,
   including failed ones and calls that never produced a saved object. */
CREATE TABLE IF NOT EXISTS ai_call_logs (
  id TEXT PRIMARY KEY,
  house_id TEXT REFERENCES houses(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  image_count INTEGER NOT NULL DEFAULT 0,
  request_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  request_preview TEXT,
  response_preview TEXT,
  error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_logs_house ON ai_call_logs(house_id, created_at);
CREATE INDEX IF NOT EXISTS ai_logs_user ON ai_call_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS ai_logs_operation ON ai_call_logs(operation);
`;

