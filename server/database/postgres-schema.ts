/**
 * PostgreSQL schema.
 *
 * Kept in sync with the SQLite schema in `sqlite.ts`. Tables are listed in
 * dependency order because PostgreSQL validates foreign keys at creation time,
 * unlike SQLite. Case-insensitive uniqueness that SQLite expresses with
 * `COLLATE NOCASE` is enforced with `lower(...)` unique indexes here.
 */
export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  username TEXT,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_set INTEGER NOT NULL DEFAULT 1,
  language TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  developer_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_ci ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci ON users (lower(username)) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

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
  last_used_step BIGINT,
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

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'shop',
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vendors_house_name_ci ON vendors (house_id, lower(name));
CREATE INDEX IF NOT EXISTS vendors_house ON vendors(house_id);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  brand TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  reorder_point DOUBLE PRECISION NOT NULL DEFAULT 0,
  target_stock DOUBLE PRECISION,
  attributes TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  image TEXT,
  nutrition TEXT,
  espresso INTEGER NOT NULL DEFAULT 0,
  off_code TEXT,
  off_linked_at TEXT,
  off_source TEXT,
  off_synced_at TEXT,
  off_filled TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_house ON items(house_id);
CREATE INDEX IF NOT EXISTS items_off ON items(off_code);

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

CREATE TABLE IF NOT EXISTS espresso_shots (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  brewed_at TEXT NOT NULL,
  rating INTEGER NOT NULL,
  roast_level TEXT,
  grind_setting TEXT,
  grind_seconds DOUBLE PRECISION,
  dose_grams DOUBLE PRECISION,
  yield_grams DOUBLE PRECISION,
  extraction_seconds DOUBLE PRECISION,
  water_temp_c DOUBLE PRECISION,
  pressure_bar DOUBLE PRECISION,
  tds_percent DOUBLE PRECISION,
  grinder TEXT,
  machine TEXT,
  tasting_notes TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS espresso_shots_house ON espresso_shots(house_id, brewed_at);
CREATE INDEX IF NOT EXISTS espresso_shots_item ON espresso_shots(item_id, brewed_at);
CREATE INDEX IF NOT EXISTS espresso_shots_user ON espresso_shots(user_id, brewed_at);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name TEXT,
  purchased_at TEXT,
  currency TEXT,
  total DOUBLE PRECISION,
  subtotal DOUBLE PRECISION,
  tax DOUBLE PRECISION,
  tax_breakdown TEXT NOT NULL DEFAULT '[]',
  template_id TEXT,
  template_confidence DOUBLE PRECISION,
  provider TEXT,
  ai_cost DOUBLE PRECISION,
  savings DOUBLE PRECISION,
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
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL,
  due_date TEXT,
  paid_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  split_with TEXT NOT NULL DEFAULT '[]',
  document TEXT,
  notes TEXT,
  subtotal DOUBLE PRECISION,
  tax_total DOUBLE PRECISION,
  breakdown TEXT NOT NULL DEFAULT '[]',
  ocr_text TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'scan')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bills_house ON bills(house_id, due_date, created_at);

CREATE TABLE IF NOT EXISTS stock_lots (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
  receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL,
  quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit TEXT NOT NULL,
  unit_price DOUBLE PRECISION,
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
  delta DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  unit_price DOUBLE PRECISION,
  normalized_price DOUBLE PRECISION,
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
  receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  note TEXT,
  balance_after DOUBLE PRECISION,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS movements_item ON stock_movements(item_id, created_at);
CREATE INDEX IF NOT EXISTS movements_house ON stock_movements(house_id, created_at);

CREATE TABLE IF NOT EXISTS receipt_lines (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  raw_description TEXT,
  quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
  unit TEXT,
  unit_price DOUBLE PRECISION,
  line_total DOUBLE PRECISION,
  tax_rate DOUBLE PRECISION,
  discount DOUBLE PRECISION,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  barcode TEXT,
  off_code TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS receipt_lines_receipt ON receipt_lines(receipt_id);
CREATE INDEX IF NOT EXISTS receipt_lines_item ON receipt_lines(item_id);

CREATE TABLE IF NOT EXISTS stock_mutations (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  response TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (house_id, idempotency_key)
);

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

CREATE TABLE IF NOT EXISTS catalog_products (
  project TEXT NOT NULL DEFAULT 'off',
  code TEXT NOT NULL,
  name TEXT,
  brand TEXT,
  quantity TEXT,
  image TEXT,
  categories TEXT,
  summary TEXT NOT NULL DEFAULT '{}',
  payload TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'openfoodfacts',
  fetched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project, code)
);

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
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS catalog_mappings_lookup ON catalog_mappings(country, vendor_key, raw_key);
CREATE INDEX IF NOT EXISTS catalog_mappings_off ON catalog_mappings(off_code);

/* Open Food Facts contribution plumbing. Accounts store only an encrypted
   session/token; contributions keep the exact write payload for retry/audit. */
CREATE TABLE IF NOT EXISTS user_off_accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project TEXT NOT NULL DEFAULT 'off',
  username TEXT NOT NULL,
  secret_kind TEXT NOT NULL DEFAULT 'cookie',
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_tag TEXT NOT NULL,
  secret_expires_at TEXT,
  app_uuid TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  verified_at TEXT,
  last_error TEXT,
  PRIMARY KEY (user_id, project)
);

CREATE TABLE IF NOT EXISTS off_consents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  accepted_at TEXT NOT NULL,
  version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS off_service_tokens (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  username TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_tag TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (user_id, service)
);

CREATE TABLE IF NOT EXISTS off_contributions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  house_id TEXT REFERENCES houses(id) ON DELETE SET NULL,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  project TEXT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  field_keys TEXT NOT NULL DEFAULT '[]',
  image_field TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  remote_status TEXT,
  remote_message TEXT,
  remote_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS off_contributions_user ON off_contributions(user_id, created_at);
CREATE INDEX IF NOT EXISTS off_contributions_queue ON off_contributions(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS off_contribution_events (
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES off_contributions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS off_contribution_events_contribution ON off_contribution_events(contribution_id, created_at);

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
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS receipt_templates_house_name_ci ON receipt_templates (house_id, lower(name));
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
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS shopping_list_items (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  quantity DOUBLE PRECISION,
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

CREATE TABLE IF NOT EXISTS shopping_list_sources (
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  line_id TEXT NOT NULL REFERENCES shopping_list_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (house_id, source_key)
);
CREATE INDEX IF NOT EXISTS shopping_sources_line ON shopping_list_sources(line_id);

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
  ai_cost DOUBLE PRECISION,
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
  quantity DOUBLE PRECISION,
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

CREATE TABLE IF NOT EXISTS meal_plan_entries (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  slot TEXT NOT NULL,
  recipe_id TEXT REFERENCES recipes(id) ON DELETE CASCADE,
  idea_id TEXT REFERENCES food_ideas(id) ON DELETE CASCADE,
  idea_index INTEGER,
  title TEXT,
  servings DOUBLE PRECISION,
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
  x DOUBLE PRECISION,
  y DOUBLE PRECISION,
  w DOUBLE PRECISION,
  h DOUBLE PRECISION,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS labels_photo ON photo_labels(photo_id);
CREATE INDEX IF NOT EXISTS labels_house ON photo_labels(house_id);

CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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
  cost DOUBLE PRECISION,
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

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * In-place migrations for databases created by older versions.
 * CREATE TABLE IF NOT EXISTS never adds columns, so every column added after
 * the first PostgreSQL release is listed here. Each statement is idempotent.
 */
export const POSTGRES_MIGRATIONS: string[] = [
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS developer_mode INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE user_totp ADD COLUMN IF NOT EXISTS last_used_step BIGINT",
  "ALTER TABLE login_challenges ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0",
  // Learned catalogue mappings are scoped per house ('' = shared row).
  "ALTER TABLE catalog_mappings ADD COLUMN IF NOT EXISTS house_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE catalog_mappings DROP CONSTRAINT IF EXISTS catalog_mappings_country_vendor_key_raw_key_key",
  "CREATE UNIQUE INDEX IF NOT EXISTS catalog_mappings_scope ON catalog_mappings(house_id, country, vendor_key, raw_key)",
  "CREATE INDEX IF NOT EXISTS catalog_mappings_house ON catalog_mappings(house_id)",
  "ALTER TABLE receipts ADD COLUMN IF NOT EXISTS paid_by TEXT",
  "ALTER TABLE receipts ADD COLUMN IF NOT EXISTS split_with TEXT NOT NULL DEFAULT '[]'",
  // Open Food Facts projects: the shared product cache is keyed by project.
  "ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'off'",
  // Existing databases have no project column until the ALTER above runs.
  "DROP INDEX IF EXISTS catalog_products_name",
  "DROP INDEX IF EXISTS catalog_products_brand",
  "CREATE INDEX IF NOT EXISTS catalog_products_project_name ON catalog_products(project, name)",
  "CREATE INDEX IF NOT EXISTS catalog_products_project_brand ON catalog_products(project, brand)",
  `DO $$ DECLARE pk text; BEGIN
     SELECT c.conname INTO pk
     FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'catalog_products' AND c.contype = 'p' AND array_length(c.conkey, 1) = 1;
     IF pk IS NOT NULL THEN EXECUTE format('ALTER TABLE catalog_products DROP CONSTRAINT %I', pk); END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'catalog_products' AND c.contype = 'p'
     ) THEN ALTER TABLE catalog_products ADD PRIMARY KEY (project, code); END IF;
   END $$;`,
  "ALTER TABLE items ADD COLUMN IF NOT EXISTS off_project TEXT NOT NULL DEFAULT 'off'",
  "ALTER TABLE receipt_lines ADD COLUMN IF NOT EXISTS off_project TEXT NOT NULL DEFAULT 'off'",
  "ALTER TABLE catalog_mappings ADD COLUMN IF NOT EXISTS off_project TEXT NOT NULL DEFAULT 'off'",
  "ALTER TABLE items ADD COLUMN IF NOT EXISTS espresso INTEGER NOT NULL DEFAULT 0",
  // POSTGRES_SCHEMA creates bills on fresh installs; this atomically upgrades
  // an existing bills table created before ledger_confirmed was introduced.
  `DO $$
  BEGIN
    IF to_regclass('bills') IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'bills' AND column_name = 'ledger_confirmed'
      ) THEN
        -- Serialize concurrent startup migrations, then recheck in case another
        -- process added the column while this one waited for the table lock.
        LOCK TABLE bills IN ACCESS EXCLUSIVE MODE;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'bills' AND column_name = 'ledger_confirmed'
        ) THEN
          ALTER TABLE bills ADD COLUMN ledger_confirmed INTEGER NOT NULL DEFAULT 0;
          UPDATE bills SET ledger_confirmed = 1 WHERE category = 'to_split';
        END IF;
      END IF;
    END IF;
  END $$`,
  // Bills gained an optional OCR breakdown and printed totals.
  "ALTER TABLE bills ADD COLUMN IF NOT EXISTS subtotal DOUBLE PRECISION",
  "ALTER TABLE bills ADD COLUMN IF NOT EXISTS tax_total DOUBLE PRECISION",
  "ALTER TABLE bills ADD COLUMN IF NOT EXISTS breakdown TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE bills ADD COLUMN IF NOT EXISTS ocr_text TEXT",
  "ALTER TABLE bills ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'",
  // Fresh installs get the CHECK from CREATE TABLE; upgraded databases are
  // backfilled first so the constraint can validate every existing row.
  "UPDATE bills SET source = 'manual' WHERE source IS NULL OR source NOT IN ('manual', 'scan')",
  `DO $$
  BEGIN
    IF to_regclass('bills') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'bills_source_check' AND conrelid = to_regclass('bills')
      ) THEN
      ALTER TABLE bills ADD CONSTRAINT bills_source_check CHECK (source IN ('manual', 'scan'));
    END IF;
  END $$`,
];

/**
 * Parent-first order used when inserting a logical restore. TRUNCATE ... CASCADE
 * clears everything first, but rows still have to be inserted without breaking
 * foreign keys.
 */
export const POSTGRES_TABLE_ORDER = [
  "users",
  "sessions",
  "user_totp",
  "passkeys",
  "webauthn_challenges",
  "user_identities",
  "login_challenges",
  "houses",
  "house_members",
  "house_invites",
  "locations",
  "categories",
  "attribute_defs",
  "vendors",
  "items",
  "item_barcodes",
  "espresso_shots",
  "receipts",
  "bills",
  "stock_lots",
  "stock_movements",
  "receipt_lines",
  "stock_mutations",
  "vendor_catalog",
  "product_aliases",
  "catalog_products",
  "catalog_mappings",
  "user_off_accounts",
  "off_consents",
  "off_service_tokens",
  "off_contributions",
  "off_contribution_events",
  "receipt_templates",
  "notifications",
  "shopping_list_items",
  "shopping_list_sources",
  "recipes",
  "recipe_ingredients",
  "food_ideas",
  "meal_plan_entries",
  "notification_deliveries",
  "photo_collections",
  "photos",
  "photo_labels",
  "ai_cache",
  "ai_call_logs",
] as const;

