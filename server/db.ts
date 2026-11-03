import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { DB_FILE, ensureDirs } from "./config.js";
import { RESERVED_ATTRIBUTE_KEYS } from "../shared/types.js";
import { usernameFromEmail, usernameWithSuffix } from "./username.js";

ensureDirs();

export const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
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
  savings REAL,
  image TEXT,
  ocr_text TEXT,
  source TEXT NOT NULL DEFAULT 'scan',
  notes TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_house ON receipts(house_id, created_at);

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
`;

db.exec(SCHEMA);

/**
 * Lightweight in-place migrations for databases created by older versions.
 * CREATE TABLE IF NOT EXISTS never adds columns, so patch them explicitly.
 */
function ensureColumn(table: string, column: string, definition: string) {
  const columns = all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("users", "username", "TEXT");
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
ensureColumn("receipts", "savings", "REAL");
ensureColumn("receipt_lines", "raw_description", "TEXT");
ensureColumn("receipt_lines", "tax_rate", "REAL");
ensureColumn("receipt_lines", "discount", "REAL");
db.exec(`UPDATE receipts SET savings = (
  SELECT ROUND(SUM(COALESCE(discount, 0)), 2) FROM receipt_lines WHERE receipt_id = receipts.id
) WHERE savings IS NULL AND EXISTS (
  SELECT 1 FROM receipt_lines WHERE receipt_id = receipts.id AND COALESCE(discount, 0) > 0
)`);
ensureColumn("product_aliases", "raw_text", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username COLLATE NOCASE) WHERE username IS NOT NULL");
db.exec("CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at)");

/**
 * Older versions shipped `brand` both as an items column and as a default
 * custom attribute, so every item showed Brand twice. Keep the column and fold
 * any value stored in the attribute JSON back into it. Other reserved keys are
 * stripped from stored attributes for the same reason.
 */
function dedupeBuiltInAttributes() {
  const version = Number(get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
  if (version >= 1) return;
  const reserved = new Set<string>(RESERVED_ATTRIBUTE_KEYS);

  const placeholders = RESERVED_ATTRIBUTE_KEYS.map(() => "?").join(", ");
  run(`DELETE FROM attribute_defs WHERE key IN (${placeholders})`, [...RESERVED_ATTRIBUTE_KEYS]);

  const items = all<{ id: string; brand: string | null; attributes: string }>(
    "SELECT id, brand, attributes FROM items WHERE attributes <> '{}'",
  );
  for (const item of items) {
    const attributes = parseJson<Record<string, unknown>>(item.attributes, {});
    const reservedKeys = Object.keys(attributes).filter((key) => reserved.has(key));
    if (!reservedKeys.length) continue;
    const legacyBrand = attributes.brand;
    for (const key of reservedKeys) delete attributes[key];
    const currentBrand = typeof item.brand === "string" ? item.brand.trim() : "";
    const fallbackBrand =
      typeof legacyBrand === "string" ? legacyBrand.trim() : legacyBrand == null ? "" : String(legacyBrand).trim();
    run("UPDATE items SET brand = ?, attributes = ? WHERE id = ?", [
      currentBrand || fallbackBrand || null,
      JSON.stringify(attributes),
      item.id,
    ]);
  }

  const aliases = all<{ id: string; attributes: string }>(
    "SELECT id, attributes FROM product_aliases WHERE attributes <> '{}'",
  );
  for (const alias of aliases) {
    const attributes = parseJson<Record<string, unknown>>(alias.attributes, {});
    const reservedKeys = Object.keys(attributes).filter((key) => reserved.has(key));
    if (!reservedKeys.length) continue;
    for (const key of reservedKeys) delete attributes[key];
    run("UPDATE product_aliases SET attributes = ? WHERE id = ?", [JSON.stringify(attributes), alias.id]);
  }

  db.exec("PRAGMA user_version = 1");
}

dedupeBuiltInAttributes();

// Give every existing account a username so it can sign in with either one.
const missingUsernames = all<{ id: string; email: string }>(
  "SELECT id, email FROM users WHERE username IS NULL OR username = '' ORDER BY created_at",
);
if (missingUsernames.length) {
  const taken = new Set(
    all<{ username: string }>("SELECT username FROM users WHERE username IS NOT NULL")
      .map((entry) => String(entry.username).toLowerCase())
      .filter(Boolean),
  );
  for (const user of missingUsernames) {
    const base = usernameFromEmail(user.email);
    let candidate = base;
    let suffix = 1;
    while (taken.has(candidate)) {
      suffix += 1;
      candidate = usernameWithSuffix(base, suffix);
    }
    taken.add(candidate);
    run("UPDATE users SET username = ? WHERE id = ?", [candidate, user.id]);
  }
}

export type Row = Record<string, any>;

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as any[])) as unknown as T[];
}

export function get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  return db.prepare(sql).get(...(params as any[])) as unknown as T | undefined;
}

export function run(sql: string, params: unknown[] = []) {
  return db.prepare(sql).run(...(params as any[]));
}

let txDepth = 0;

/** Runs fn inside a transaction, using savepoints for nested calls. */
export function tx<T>(fn: () => T): T {
  const savepoint = `sp_${txDepth}`;
  const outer = txDepth === 0;
  db.exec(outer ? "BEGIN" : `SAVEPOINT ${savepoint}`);
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    db.exec(outer ? "COMMIT" : `RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    txDepth--;
    try {
      db.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${savepoint}`);
      if (!outer) db.exec(`RELEASE ${savepoint}`);
    } catch {
      /* the original error is more useful */
    }
    throw error;
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
