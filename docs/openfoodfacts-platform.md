# Open Food Facts platform integration

**Status:** proposal for review  
**Branch:** `feat/off-multiservice-contribution`  
**Scope:** all four Open Food Facts product databases, the supporting read APIs, and opt-in contribution back to the commons.

SVault already reads Open Food Facts (OFF) for barcode lookup, receipt matching and nutrition. This
plan turns that single read-only integration into a complete, opt-in OFF platform integration:

1. **One product model** across Open Food Facts, Open Beauty Facts, Open Pet Food Facts and Open
   Products Facts, with automatic project detection.
2. **All useful public APIs** — search, taxonomy, knowledge panels, attributes, images, dumps — behind
   one cache and one rate-limit budget.
3. **Contribute back** from the UI when a signed-in user explicitly chooses to, with an eligibility
   engine that only offers products SVault can actually improve.
4. **Never auto-publish.** Reads are automatic and cached; writes are user-initiated, previewed,
   minimal, queued and auditable.

The design follows SVault's existing constraints: one Node process, one database, no queue service, no
new runtime dependency, mobile-first UI, and Open Database License (ODbL) compliance.

### Plan at a glance

| Phase | Outcome | Size |
| --- | --- | --- |
| 0. Spike | Verified endpoints, payloads and per-project capabilities | S |
| 1. Read foundation | One lookup across all four databases, project-aware cache and UI | M |
| 2. Contribution plumbing | Account links, consent, queue, preview; food edits and photos | M/L |
| 3. Other projects | Beauty, pet food and general products, wrong-project reports | M |
| 4. Ecosystem | Open Prices, NutriPatrol, Robotoff, optional Folksonomy | L |
| 5. Eligibility UX | Ranked contribution queue, bulk actions, history | M |
| 6. Hardening | Limits, metrics, docs, i18n, optional bulk data | M |

---

## 1. Why now

The existing integration proves the value: scanning and receipt import already fill brand, image,
category and nutrition. Three gaps remain:

- **Other product types are invisible.** Pet food, cosmetics and general products live on separate
  OFF instances with the same Product Opener API. A household that tracks pet food or cleaning
  supplies gets no lookup today.
- **The read side is already outdated.** SVault uses API v2, which OFF now marks deprecated in favour
  of v3. The universal `product_type=all` lookup is the supported way to scan any product.
- **SVault takes from the commons but cannot give back.** OFF's local-cache guidance explicitly asks
  applications that cache OFF data to integrate the write API and share corrections back. Households
  are the best source of the data OFF is missing: a real product in front of them, with photos, a
  receipt and a price.

The contribution side is also where the product becomes differentiated: instead of a generic "edit
Open Food Facts" form, SVault can say *"This pet food is missing from Open Pet Food Facts. You already
have its name, brand, weight and two photos — share it in 20 seconds?"*

---

## 2. Current state

| Area | Today |
| --- | --- |
| Read | `server/services/openfoodfacts.ts` — v2 product endpoint, barcode spellings, 30-day cache, search-a-licious name search |
| Cache | `catalog_products`, keyed by `code` only; `summary` + raw `payload` JSON |
| Item link | `items.off_code`, `off_source`, `off_linked_at`, `off_synced_at`, `off_filled`; `linkItemToOff` fills only blank fields |
| UI | `OffProductPicker`, item page "OpenFoodFacts" panel, barcode scan fallback, receipt line matching |
| Routes | `/api/catalog/search`, `/product/:code`, `/resolve`, admin mappings export/import/sync |
| Gaps | no OBF/OPFF/OPF, no universal project detection, no write path, no OFF account link, no contribution queue, no rate-limit budget shared across the instance, no project badge in the UI |

Two consequences matter for this plan:

- `catalog_products` has no `project` column. The same barcode can exist in more than one database
  (usually because it was added to the wrong project), so the cache and item link need a project
  dimension.
- There is no per-user secret storage for third-party credentials. This plan adds one, encrypted at
  rest, but only for OFF session cookies/tokens — never for passwords.

---

## 3. Goals and non-goals

### Goals

- Look up any barcode across all four databases in one call and show which project owns it.
- Keep the fast local-first behaviour: cache first, network second, negative cache for misses.
- Expose project-specific presentation: nutrition and Nutri-Score only for food, ingredients for
  beauty, photos-first for general products, and so on.
- Let a signed-in user connect an OFF account (or use an instance contribution account) and share
  product data, photos, prices, Folksonomy properties, Robotoff answers and NutriPatrol reports.
- Detect eligible products automatically and present a short, ranked, one-screen contribution queue.
- Make every write safe: field-level diff, additive-by-default payloads, license consent, rate limits,
  idempotency, retries and an audit trail.
- Keep all existing `/api/catalog/*` behaviour working during the migration.

### Non-goals

- No background crawling, scraping, bulk importing or data mirroring of OFF in v1. A local dump importer
  is an optional later step.
- No automatic edits, no "sync my inventory to OFF", no publishing receipts, prices or household data
  without an explicit action.
- No password storage. No OFF OAuth yet (OFF is migrating to Keycloak; the adapter leaves room for it).
- No new product fields in SVault merely to satisfy OFF. Contribution drafts can carry extra values
  without polluting the inventory schema.
- No promise of a stable public API; the endpoints follow the existing bundled-client convention.

---

## 4. Service and API inventory

### 4.1 Product databases

All four run Product Opener and share the read/write shape.

| Project | ID | Base URL | Main differences |
| --- | --- | --- | --- |
| Open Food Facts | `off` | `https://world.openfoodfacts.org` (country subdomains such as `https://gr.openfoodfacts.org`) | Nutrition, Nutri-Score, NOVA, Green-Score, Robotoff questions, Open Prices, full-text search |
| Open Beauty Facts | `obf` | `https://world.openbeautyfacts.org` | No nutrition table, no Nutri-Score/NOVA/Green-Score; ingredients and photos are the priority |
| Open Pet Food Facts | `opff` | `https://world.openpetfoodfacts.org` | Nutrition exists, but no Nutri-Score/NOVA/Green-Score; ingredients and nutrition photos are the priority |
| Open Products Facts | `opf` | `https://world.openproductsfacts.org` | No nutrition, no scores; packaging photos and Folksonomy properties carry most data |

**Universal lookup:** `GET https://world.openfoodfacts.org/api/v3/product/{barcode}?product_type=all`
returns the product from whichever database owns it, with `product_type` in the response, and redirects
to the owning instance when needed. This is the primary scan path. The response also tells us when a
product is on the wrong project, which becomes a "report/move" contribution instead of a duplicate.

**Write target:** always the owning project's domain. All four accept the same product edit, image and
taxonomy calls. A product that is missing everywhere is created on the project the user selects.

### 4.2 Public read APIs

| API | What SVault uses it for | Notes |
| --- | --- | --- |
| Product read v3 (`/api/v3/product/{code}`) | Full product, `fields=` projection, `blame=1` for last editor | Current; v2 is deprecated |
| Universal read (`product_type=all`) | One scan across all four projects, project detection | Follow redirects and record the final domain |
| Search-a-licious (`https://search.openfoodfacts.org/search`) | Full-text product search, autocomplete, facet-aware queries | **OFF only today**; not available on the other three instances |
| Structured search v2 (`/api/v2/search`) | Filter search on each project (brand, category, label, code list) and bulk code lookups | Still supported; no `/api/v3/search` yet |
| Taxonomy (`/api/v2/taxonomy`, `/api/v3/taxonomy_suggestions`) | Map a house category or free-text label to OFF taxonomy tags; suggest categories, labels, packaging | Avoid free-text tags that OFF cannot taxonomize |
| Knowledge panels / attributes (`/api/v3.4/attribute_groups`, product `knowledge_panels`) | Rich, localized display of Nutri-Score, Green-Score, allergens, additives, vegan/vegetarian | Presentation only; do not copy into item fields silently |
| Images (`images.openfoodfacts.org`, upload/select endpoints) | Product photos, front/ingredients/nutrition/packaging selection | Images are CC-BY-SA; only user-owned photos may be uploaded |
| Facets (`/{project}/facets/...json`) and legacy `suggest.pl` | Suggestion lists for categories, brands, labels, stores | Fallback only; prefer taxonomy suggestions |
| Bulk data (`https://world.openfoodfacts.org/data`, per-project `/data`) | Optional cold-cache seeding or offline mirror | Large (GBs); separate opt-in feature, not in v1 |
| Events | Real-time product updates | Not public (internal Redis); do not depend on it |

### 4.3 Contribution APIs

| API | Capability | Authentication |
| --- | --- | --- |
| Product Opener write (`POST /api/v3/product/{code}` or legacy `POST /cgi/product_jqm2.pl`) | Create/edit product fields; `add_*` prefix appends instead of replacing | OFF session cookie or `user_id`/`password` on the request; cookie preferred |
| Product images (`POST /api/v3.3/product/{code}/images` or legacy `/cgi/product_image_upload.pl`) | Upload front/ingredients/nutrition/packaging/other; select or unselect | Same OFF session |
| Open Prices (`https://prices.openfoodfacts.org/api/v1`) | Prices, receipts, proofs, locations, products, challenges, badges | `POST /api/v1/auth` → bearer token (OFF username/password or Keycloak access token) |
| Folksonomy Engine (`https://api.folksonomy.openfoodfacts.org`) | Free key/value properties beyond the product schema | `POST /auth` → bearer token |
| Robotoff (`https://robotoff.openfoodfacts.org/api/v1`) | Questions/insights/predictions that fill gaps from photos | Mostly public reads; annotation endpoint to be verified in Phase 0 |
| NutriPatrol (`https://nutripatrol.openfoodfacts.org/api/v1`) | Report product/image/search problems; moderators get a ticket | **Requires an OFF session token**; flags return `401` without one |

### 4.4 Capability matrix

| Capability | OFF | OBF | OPFF | OPF |
| --- | --- | --- | --- | --- |
| Product read v3 / universal scan | yes | yes | yes | yes |
| Product write + image upload | yes | yes | yes | yes |
| Structured v2 search | yes | yes | yes | yes |
| Search-a-licious full text | yes | docs say no | docs say no | docs say no |
| Robotoff questions | yes | docs say no questions yet | docs say no | docs say no |
| Nutrition | yes | no | yes | no |
| Nutri-Score / NOVA / Green-Score | yes | no | no | no |
| Knowledge panels / attributes | yes | yes | yes | yes |
| Folksonomy | yes | docs conflict | docs conflict | docs conflict |
| Open Prices | food-first | docs say no | docs say no | docs say no |
| NutriPatrol | yes | docs conflict | docs conflict | docs conflict |

Two documentation pages disagree about Folksonomy and NutriPatrol coverage on OBF/OPFF/OPF. The plan
therefore ships adapters behind per-project capability flags and verifies each flag against the live
service in Phase 0. A capability is enabled only after a successful read-only probe; contribution is
enabled only after a staging write test.

### 4.5 Operating rules (non-negotiable)

> Phase 0 found that NutriPatrol flags require an OFF session (`401 Missing session token`) and that
> Robotoff can return `502`. See [openfoodfacts-spike.md](openfoodfacts-spike.md). Treat both as
> account-gated, failure-tolerant features; never block product lookup on them.

- **Identify the app.** `User-Agent: SVault/<version> (<contact>)`; include `app_name=SVault`,
  `app_version`, `app_uuid` (a random per-user pseudonym) and a `comment` with a hashed local user id
  on writes. No email addresses, names or house ids.
- **Respect limits.** OFF documents 15 read requests/min/IP for product lookups and 10/min/IP for
  search, with IP bans for abuse. SVault's server is a single egress IP, so it must run one shared
  token bucket, not per-user buckets.
- **Cache aggressively.** Fresh cache wins; stale-while-revalidate; negative cache for misses; no
  search-as-you-type against the public API.
- **Register the app.** Fill in OFF's API usage form and create an application account before
  production writes. The form is how OFF prioritizes integrations and avoids mistaken bans.
- **Use staging for write tests.** `https://world.openfoodfacts.net` with HTTP Basic `off:off` and a
  separate staging account. Never write to production from tests or CI.
- **License hygiene.** Product data is ODbL; images are CC-BY-SA. Upload only photos taken by the user
  (or compatibly licensed), with explicit consent. Do not mix OFF data with external product data.
- **Share back.** OFF's local-cache guidance asks caching apps to integrate the write API. Any field
  SVault lets a user correct locally and that also exists in OFF should be offerable as a
  contribution, never silently discarded.

---

## 5. Architecture

### 5.1 Module layout

New server modules, kept small and boring:

```
server/services/off/
  projects.ts        Project registry + capability flags + field profiles
  client.ts          fetch wrapper: UA, timeout, redirects, retry, rate budget, redaction
  reader.ts          v3 product read, universal lookup, field projection, normalization
  search.ts          search-a-licious (OFF) + structured v2 search (all) + local cache
  writer.ts          product create/edit, add_* payload builder, image upload/select
  auth.ts            OFF session login/verify, Open Prices/Folksonomy token exchange
  secrets.ts         AES-256-GCM envelope for stored cookies/tokens
  eligibility.ts     Candidate detection and scoring
  contributions.ts   Queue, state machine, retries, idempotency
  prices.ts          Open Prices adapter
  folksonomy.ts      Folksonomy adapter
  robotoff.ts        Questions/insights adapter
  nutripatrol.ts     Flag/report adapter
  taxonomy.ts        Taxonomy lookup/suggestions with cache
  knowledge.ts       Knowledge panels/attributes normalization
```

Routes: extend `server/routes/catalog.ts` for read compatibility, add `server/routes/off.ts` for the
new surface. Keep admin/export endpoints where they are.

### 5.2 Project registry

A single typed registry removes project conditionals from the rest of the code:

```ts
export type OffProjectId = "off" | "obf" | "opff" | "opf";

interface OffProject {
  id: OffProjectId;
  label: string;                  // "Open Food Facts"
  shortLabel: string;             // "Food"
  worldDomain: string;
  contentTypes: string[];         // barcode/GTIN formats accepted
  capabilities: {
    read: boolean;
    write: boolean;
    images: boolean;
    fullTextSearch: boolean;
    structuredSearch: boolean;
    taxonomy: boolean;
    knowledgePanels: boolean;
    robotoff: boolean;
    folksonomy: boolean;
    openPrices: boolean;
    nutripatrol: boolean;
    nutrition: boolean;
    scores: boolean;
  };
  fields: {
    requiredForCreate: string[];
    highValue: string[];
    unsupported: string[];        // e.g. nutriments on OBF/OPF
  };
  categoryHints: string[];        // local category words that suggest this project
  defaultLocale: string;
}
```

The registry drives the UI (project badges, field pickers), the writer (which fields are allowed), the
eligibility engine and the admin toggles. Adding a project or flipping a capability is one edit.

### 5.3 Data model

**Product cache.** Extend `catalog_products` with a project dimension. SQLite needs a table rebuild;
PostgreSQL can drop and recreate the primary key.

```sql
-- target shape
CREATE TABLE catalog_products (
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
CREATE INDEX catalog_products_name ON catalog_products(project, name);
CREATE INDEX catalog_products_brand ON catalog_products(project, brand);
```

Existing rows become `project = 'off'`. `items.off_code` stays the barcode; add
`items.off_project TEXT NOT NULL DEFAULT 'off'`. Do the same for `receipt_lines.off_project` and
`catalog_mappings.off_project`. Keep a `getCachedOffProduct(code, project)` overload for old callers.

**Account links.** One row per user and project. Store only a session cookie or bearer token,
encrypted; never the password.

```sql
CREATE TABLE user_off_accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  username TEXT NOT NULL,              -- OFF user_id, not email
  secret_kind TEXT NOT NULL,           -- 'cookie' | 'bearer'
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_tag TEXT NOT NULL,
  secret_expires_at TEXT,
  app_uuid TEXT NOT NULL,              -- pseudonymous per-user id sent to OFF
  linked_at TEXT NOT NULL,
  verified_at TEXT,
  last_error TEXT,
  PRIMARY KEY (user_id, project)
);
```

**Contribution queue.** One row per action, with enough context to retry without re-reading the item
(which may have changed or been deleted).

```sql
CREATE TABLE off_contributions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  house_id TEXT REFERENCES houses(id) ON DELETE SET NULL,
  project TEXT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- product_edit | product_create | image | price | folksonomy | robotoff | flag
  payload TEXT NOT NULL,               -- exact request body / form fields, redacted of unrelated data
  field_keys TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,                -- draft | queued | sending | sent | failed | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  remote_status TEXT,
  remote_message TEXT,
  remote_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX off_contributions_user ON off_contributions(user_id, created_at);
CREATE INDEX off_contributions_queue ON off_contributions(status, next_attempt_at);
```

**Consent and audit.** Per-user `off_contribution_consent_at`, `off_license_version` (on `users`) and an
append-only `off_contribution_events` row for each state change. The event log is small and makes
support/debugging possible without storing credentials.

**Price provenance.** Record the receipt/price row that produced an Open Prices submission
(`off_contributions.kind='price'` payload contains `receiptLineId`), so a retry is traceable and the
user can see what was shared.

Both database backends must be updated: `server/database/sqlite.ts` (schema + `ensureColumn` migration
or table rebuild) and `server/database/postgres-schema.ts` (schema + `POSTGRES_MIGRATIONS`). The logical
backup takes every table automatically, so no allow-list change is needed.

### 5.4 Read path

```
barcode / name
      │
      ▼
local cache (project-aware) ──fresh──► normalize ──► UI
      │ miss/stale
      ▼
shared token bucket (read/search)
      │
      ▼
universal v3 read (product_type=all)
      │
      ├─ found → detect project → cache under (project, code) → normalize → UI
      └─ 404   → negative cache (24h) → UI offers "add this product"
```

Normalization keeps the existing `OffProduct` shape and adds:

```ts
interface OffProduct {
  // existing fields...
  project: OffProjectId;
  productType: "food" | "beauty" | "petfood" | "product";
  completeness: number;              // 0..1 from high-value fields
  missing: string[];                 // field keys SVault could fill
  knowledgePanels?: OffPanel[];
  attributes?: OffAttributeGroup[];
  lastModifiedAt?: string;
}
```

Country and language matter for writes, not reads: `cc` comes from `house.settings.purchases.country`
or the item, `lc` from `user.language`/product language. The UI shows the locale used before submitting.

### 5.5 Search

- **Cache first.** Local `catalog_products` search by name/brand/barcode, already present.
- **OFF online search.** Search-a-licious with `langs`, `page_size`, `fields`; cache results for 10
  minutes and enforce a 2-second minimum gap. No keystroke-by-keystroke calls.
- **Other projects.** Search-a-licious is not available. Use local cache and, only on explicit submit,
  the project's structured search or legacy search endpoint behind the same bucket. Label results
  "limited search" in the UI; barcode lookup remains the reliable path.
- **Taxonomy suggestions** are cached for 7 days per `(project, tagtype, query, locale)` and used in
  the contribution wizard, not in the main search box.

### 5.6 Contribution pipeline

```
eligible product ──► draft (prefill from item + last OFF snapshot)
                        │
                        ▼
                 field diff + license consent
                        │ user confirms
                        ▼
                 POST /api/off/contributions  (server rebuilds payload, validates again)
                        │
                        ▼
                 queue row (status=queued, idempotency key)
                        │ worker, serialized per user
                        ▼
                 writer → OFF API
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
          success: sent       transient: retry with backoff
          refresh cache        permanent: failed + reason
          show result          keep payload for edit/resubmit
```

The server never trusts a client-supplied payload for a write. It re-reads the item, re-runs
eligibility, rebuilds the OFF form from an allow-list and stores that exact payload. This prevents a
compromised client from injecting arbitrary OFF fields.

### 5.7 Credentials and account linking

Two supported modes, both opt-in:

1. **Individual OFF account (recommended).** The user enters their OFF username and password in
   Settings. SVault calls `POST /cgi/session.pl` over HTTPS, receives the session cookie, encrypts and
   stores it, and immediately discards the password. Contributions are attributed to the user's OFF
   account. OFF sessions are tied to the requesting IP and capped per user (currently 10), so SVault
   verifies and re-links on 401 rather than silently retrying. Never ask for an email address; OFF
   `user_id` is the username.
2. **Instance contribution account.** An admin configures `OFF_CONTRIB_USER` and
   `OFF_CONTRIB_PASSWORD` in the environment (not the database). Every user gets a stable random
   `app_uuid`; writes carry `app_name`, `app_version`, `app_uuid` and a hashed comment so moderators can
   ban one abusive user without banning the instance. No per-user OFF login is needed. This is the
   fallback for households that do not want another account, but attribution goes to the instance.

Encryption uses AES-256-GCM. The key comes from `SV_OFF_SECRET_KEY` (32 random bytes, base64) or, if
absent, an auto-generated `DATA_DIR/off-secret.key` with mode `0600`. The key is part of `DATA_DIR`, so
backups already include it; document that restoring a database without the key invalidates stored
sessions (users simply re-link). Rotating the key clears all links. Secrets are never logged; the
existing `server/lib/redact.ts` rules are extended for `password`, `session`, `token` and `cookie`.

Open Prices and Folksonomy use bearer tokens obtained from their `/auth` endpoints. They are stored in
the same encrypted column with `secret_kind='bearer'`. The OFF Keycloak/OIDC migration is handled by
keeping `auth.ts` behind a `linkAccount(mode)` interface; today only session/password exchange is
implemented.

### 5.8 Queue, retries and idempotency

- One worker loop in the server process, started after the database opens. No external queue.
- Serialize per user (and per project) to avoid parallel edits to the same product; allow a small
  global concurrency (2) across users.
- Exponential backoff with jitter: 5s, 15s, 45s, 2m, 5m, then `failed` after 6 attempts. Retry only
  network errors, timeouts, 429 and 5xx. Never retry 4xx validation/auth errors; surface them.
- `idempotency_key = sha256(userId + project + code + kind + canonical payload + bucket)`. A double-tap
  returns the existing row instead of queueing a duplicate.
- A write is considered successful only when OFF returns a success status. Afterwards, re-read the
  product, verify the fields, refresh the cache and record `remote_id` (revision/image id).
- A `cancelled` row can only be set before `sending`. Sent contributions are immutable; corrections are
  new rows.

### 5.9 Rate limits and caching

One shared limiter per external host, because OFF's limits are per IP:

| Bucket | Limit | Burst |
| --- | --- | --- |
| Product read | 12/min | 5 |
| Search | 8/min | 2 |
| Taxonomy | 10/min | 3 |
| Writes | 1/sec/user, 60/hour/instance | 2 |
| Image uploads | 10/day/user, 40/day/instance | 1 |

- Fresh cache: 30 days (existing `OFF_CACHE_DAYS`).
- Negative cache: 24 hours, project-aware.
- Search cache: 10 minutes, max 200 entries per project, LRU.
- Taxonomy cache: 7 days in `catalog_products`-adjacent table or in-memory with a size cap; if it must
  survive restarts, use a small `off_taxonomy_cache` table.
- Cache invalidation: any successful write immediately overwrites the cached product with a fresh read.
- `pruneOffProductCache` becomes project-aware and keeps rows linked from items.

### 5.10 Error mapping

OFF errors are often free text. Map to stable SVault codes the UI can localize:

| Code | Cause | UX |
| --- | --- | --- |
| `OFF_AUTH_REQUIRED` | no linked account | link prompt |
| `OFF_AUTH_EXPIRED` | 401/expired cookie | re-link prompt, keep draft |
| `OFF_RATE_LIMITED` | 429 / repeated 5xx | queued, show retry time |
| `OFF_VALIDATION` | 4xx with field errors | show per-field message |
| `OFF_UNAVAILABLE` | timeout/5xx after retries | queued, "will retry" |
| `OFF_DUPLICATE` | product already has the value | mark "already up to date" |
| `OFF_NOT_ELIGIBLE` | local rules changed | explain which rule failed |

---

## 6. Contribution experience

### 6.1 Account linking

- Settings → **Open Food Facts** → "Contribute back".
- Cards for each enabled project with state: `Not connected`, `Connected as <username>`,
  `Instance account`, `Session expired`.
- "Connect" opens a small form: username, password, explanation of what is stored (session only),
  link to OFF terms, and a checkbox confirming the user has the right to share the content.
- "Disconnect" clears the encrypted secret and any queued drafts for that project after confirmation.
- The page shows the exact app identity string that will be sent (`SVault/1.2 (contact)` + `app_uuid`)
  and a link to the user's OFF contributions page.

### 6.2 Eligibility engine

Eligibility is computed server-side per item and returned with a score and a reason list. It is the
heart of "make it easy": the UI only shows products SVault can genuinely improve.

**Hard rules (must all pass):**

1. The barcode is a valid GTIN-8/12/13/14. Internal shop codes and receipt article numbers are not
   eligible.
2. The item is not archived and belongs to a house where the user is at least `member`.
3. The user has linked an account (or the instance account is enabled) and accepted the current
   license/consent version.
4. The project is enabled by the admin and the capability (`write`, `images`, `openPrices`, ...) is on.
5. At least one field has a safe contribution: a blank OFF field with a local value, a user-confirmed
   correction, an eligible image, a price with proof, or an allowed report.
6. The payload passes project field rules (no nutrition on OBF/OPF, no scores on non-food, etc.).

**Candidate types and scores:**

| Candidate | Detect | Score |
| --- | --- | --- |
| `new_product` | universal lookup 404, valid GTIN, local name + (brand or category) | 100 |
| `missing_fields` | OFF product found, one or more high-value fields blank locally filled | 90 − 5 × missing count |
| `photo` | local item photo eligible, OFF lacks that image or has an older one | 70 |
| `wrong_project` | universal lookup returns another project than the item's declared type | 60 (report/move, not duplicate) |
| `price` | receipt line with code, price, date and vendor; Open Prices enabled | 50 |
| `report` | user flags a wrong barcode/image/field | manual |
| `robotoff` | opted-in user, question available | optional queue |

Tie-break by recency of purchase, then by house role (members before viewers), then alphabetically.
The list is paginated; the first screen is capped at 20 candidates so it feels like a short to-do list,
not an admin console.

**Per-project field rules:**

| Field | OFF | OBF | OPFF | OPF |
| --- | --- | --- | --- | --- |
| `product_name_{lc}` | required | required | required | required |
| `brands` / `add_brands` | high value | high value | high value | high value |
| `quantity` | high value | high value | high value | high value |
| `categories` / `add_categories` | high value | high value | high value | high value |
| `ingredients_text_{lc}` | high value | **priority** | **priority** | optional |
| `nutriments` + `nutrition_data_per` | allowed | **not allowed** | allowed | **not allowed** |
| `labels` / `add_labels` | allowed | allowed | allowed | allowed |
| `packaging` | allowed | allowed | allowed | high value |
| `image_front` | allowed | allowed | allowed | **priority** |
| `image_ingredients` | allowed | **priority** | **priority** | optional |
| `image_nutrition` | priority | not allowed | **priority** | not allowed |

**Corrections vs additions.** Additions use `add_*` and are pre-selected. Corrections show "Open Food
Facts has X / SVault has Y" and are never pre-selected. Sending a plain field replaces the whole value,
so the UI warns when a field contains a list. If a correction would remove data the user did not see,
block it and ask them to review the full remote value first.

**Photo eligibility:**

- The file is a user upload, not a generated thumbnail, receipt crop, screenshot or web image.
- At least 640×160 px, JPEG/PNG/WebP, ≤ 10 MB.
- Client normalizes to max 2000 px on the long edge and re-encodes, which strips EXIF/GPS.
- The user checks "I took this photo and license it under CC-BY-SA".
- Faces, ID documents, payment cards and price tags are not acceptable; the UI shows a short checklist.
- Receipt photos are never offered as product images.

**Price eligibility (Open Prices):**

- Barcode resolved, positive amount, known currency and date, vendor mapped to an Open Prices location
  (or the user picks one), and an explicit "share this price" checkbox.
- Proof is optional but recommended; the receipt image is previewed with a redaction step. The user is
  warned that the proof may contain other purchases.
- Only the selected line's price is submitted, never the whole receipt or household notes.

**Blocked states are informative:** "No barcode", "Product type unknown", "No account connected",
"Not enough information", "This project is disabled", "Recently contributed". Each links to the fix.

### 6.3 Contributions page

New route `/contribute` (desktop side nav + mobile bottom nav, bell-style badge only when new
candidates exist). Sections:

1. **Ready to share** — ranked candidate cards: image, name, brand, project badge, missing fields as
   chips, "Review" button. Multi-select for bulk product edits, with a shared preview.
2. **Needs a little info** — product type unknown, missing brand/category, photo consent missing. Each
   card has the one field to fill.
3. **In progress** — queued/sending with a progress bar; safe to leave the page.
4. **History** — sent/failed/cancelled with timestamp, fields, project, remote link and error code.
   Failed rows offer "Fix and retry" or "Delete draft".

Empty state: "Nothing to contribute right now. Scan a new product or add a photo to an item and it will
show up here." This keeps the feature discoverable without nagging.

### 6.4 Contribution flows

**A. Scan a barcode (`/scan`).**

- Universal lookup returns the owning project; the result card shows a project badge.
- Found + missing fields: "Improve this product" opens the preview with safe additions selected.
- Not found anywhere: "Add to Open Food Facts" opens the type picker (Food / Beauty / Pet food /
  Products), then the prefilled wizard from the scanned item or the current draft.
- Found on the wrong project: "This looks like pet food but is on Open Food Facts" → report/move flow,
  not a duplicate creation.

**B. Item page.**

- A compact "Open Food Facts" panel shows project, completeness, last sync and missing fields.
- Primary action: "Share what you know" (prefilled, review-first). Secondary: "Refresh from OFF",
  "Unlink", "Report a problem".
- If the item has a local photo and OFF lacks one, the panel offers "Share photo" as a separate,
  checkbox-only action.

**C. Receipt review (`/receipts/scan`).**

- Unmatched lines with a valid GTIN become "Add to OFF" candidates in a collapsible section; receipt
  names and shop-specific article codes are never sent.
- Matched lines with a price and a mapped vendor can become "Share price" candidates. The default is
  off; the user opts in per line or per receipt. A redaction preview is mandatory before upload.
- The existing receipt draft/offline queue remains the source of truth; contribution queueing never
  blocks finishing the receipt.

**D. Photos.**

- Item photo → "Use as front photo" / "Use as ingredients photo" with crop preview and consent.
- Multi-photo items let the user pick which photo maps to which OFF field.
- Upload progress is shown; the photo is deleted from the staging area after success or cancellation.

**E. Robotoff (opt-in).**

- Settings toggle "Help verify product facts" (default off).
- One question at a time, with the reference image and "Yes / No / Skip". Answers are submitted to
  Robotoff, not applied locally.
- Availability is checked first; questions are disabled for projects where Robotoff has no questions
  yet. A 5xx/502 hides the card without an error toast.

**F. Open Prices.**

- From a receipt line or the item's price history: "Share this price".
- Shows product, amount, currency, date, shop and the proof thumbnail. The user maps the shop to an
  Open Prices location (search by name/city) and confirms.
- This is the highest-privacy flow; keep it opt-in, separate from the "product" wizard, and clearly
  explain that the price and proof become public.

**G. NutriPatrol reports.**

- "Report a problem" on any product/image: wrong project, wrong barcode, incorrect data, inappropriate
  image. A short reason picker maps to NutriPatrol reasons. Reports appear in History.

**H. Folksonomy (advanced, later).**

- Only for projects where the probe succeeds; key/value editor with documented keys and a warning that
  the API is experimental and data may be removed. Hidden behind "Advanced" so it cannot confuse the
  main flow.

### 6.5 Safety rails

- **Review before send, always.** No blind one-tap public edits in v1. "Easy" means prefilled and two
  taps, not irreversible.
- **Additive by default.** `add_*` for list fields; plain fields only for blank values or confirmed
  replacements.
- **Field allow-list.** The server rebuilds the payload; the client cannot add arbitrary OFF keys.
- **No personal data.** Strip receipt numbers, payment data, notes, house names, coordinates and EXIF.
- **No local-only data.** Prices (except Open Prices), stock, locations, recipes and shopping lists are
  never product fields.
- **Rate and volume caps.** Per-user daily caps, per-instance caps, cooldowns, duplicate detection.
- **Admin kill switch.** Disable all writes, disable a project, or set a read-only mode from Settings →
  Admin without redeploying.
- **Dry-run mode.** Admins can validate payloads and see what would be sent without calling OFF.
- **Audit.** Every state transition is recorded with the actor, field keys and outcome; secrets are
  never recorded.

### 6.6 Success, history and gentle motivation

- Success sheet: what changed, a link to the OFF product page, and "Thanks — this helps every app that
  uses Open Food Facts."
- History is durable and filterable by project/status.
- Show a small monthly count and streak on the Contributions page. No points, badges or dark patterns;
  the reward is the public link and the household's own completeness score.
- Optionally emit an in-app notification when a queued contribution succeeds or fails, reusing the
  notifications table; no external channel by default.

---

## 7. API design

All routes require a session. House-scoped routes also check membership. Existing `/api/catalog/*`
routes stay for compatibility; new routes live under `/api/off/*`.

**Backward compatibility:** `/api/catalog/product/:code` keeps its `OffProduct` response but becomes
project-aware by default (universal lookup, `project` added to the payload). Callers that need the old
strict behaviour pass `?project=off`. `/api/catalog/search` defaults to `off` unless `project` is
given. Cache rows and item links created before the migration are treated as `project='off'`, so no
client change is required for existing food flows.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/off/projects` | Enabled projects, capabilities, labels, locale defaults |
| GET | `/api/off/lookup/:code?project=all` | Universal or project-specific lookup; returns `product`, `project`, `cached`, `source` |
| GET | `/api/off/product/:project/:code?full=1` | Full product + raw snapshot + knowledge panels |
| GET | `/api/off/search?q=&project=off&online=1&limit=20` | Local-first search; project-aware |
| GET | `/api/off/taxonomy/suggest?project=&tagtype=&q=` | Cached taxonomy suggestions |
| GET | `/api/off/contributions/candidates?houseId=&project=&limit=20` | Ranked eligible products with reasons |
| GET | `/api/off/contributions?status=&project=&limit=` | User's contribution history |
| POST | `/api/off/contributions` | Create a draft/queue a contribution (server rebuilds payload) |
| GET | `/api/off/contributions/:id` | Status, preview, error, remote link |
| POST | `/api/off/contributions/:id/retry` | Retry a failed row |
| DELETE | `/api/off/contributions/:id` | Cancel a draft/queued row |
| GET | `/api/off/accounts` | Linked accounts (no secrets) |
| POST | `/api/off/accounts/:project/link` | Exchange username/password for a session/token, store encrypted |
| POST | `/api/off/accounts/:project/verify` | Re-check a stored session |
| DELETE | `/api/off/accounts/:project` | Unlink and clear secrets |
| GET | `/api/off/robotoff/questions?project=off` | One or a small page of questions |
| POST | `/api/off/robotoff/answers` | Submit an answer |
| POST | `/api/off/prices` | Queue an Open Prices observation |
| POST | `/api/off/reports` | File a NutriPatrol flag |
| GET | `/api/off/stats` | Admin: counts, cache hit rate, queue depth, failures |
| PUT | `/api/off/settings` | Admin: enable/disable projects, writes, caps, dry-run, contact email |

Request/response types live in `shared/types.ts` (or a new `shared/off.ts` re-exported there). Errors
use the existing `{ error, details }` shape plus a stable `code` (Section 5.10).

**Create contribution body (sketch):**

```json
{
  "houseId": "hou_...",
  "itemId": "itm_...",
  "project": "opff",
  "code": "3700123456789",
  "kind": "product_edit",
  "fields": ["name", "brand", "quantity", "image_front"],
  "imageId": "pho_...",
  "corrections": { "quantity": "2 kg" },
  "consent": true
}
```

The server ignores unknown field keys, re-reads the item, recomputes eligibility, and returns either a
`draft` with a full preview or a `blocked` result with reasons.

---

## 8. Client changes

| File / area | Change |
| --- | --- |
| `client/App.tsx` | Add `/contribute` route |
| `client/components/AppShell.tsx` | Nav entry "Contribute" with candidate badge; mobile bottom nav slot |
| `client/pages/ContributionsPage.tsx` | New page: Ready / Needs info / In progress / History |
| `client/components/off/ProjectBadge.tsx` | Food / Beauty / Pet food / Products chip with accessible colour + label |
| `client/components/off/OffProductCard.tsx` | Shared card for search and scan, project-aware, shows completeness and missing fields |
| `client/components/off/ContributionPreview.tsx` | Side-by-side diff, field checkboxes, license consent, submit |
| `client/components/off/EligibilityList.tsx` | Candidate cards, reasons, bulk selection |
| `client/components/off/OffAccountCard.tsx` | Link / verify / unlink per project |
| `client/components/off/ImageConsent.tsx` | Photo checklist, crop preview, CC-BY-SA consent |
| `client/components/off/PriceContributionSheet.tsx` | Receipt line → Open Prices preview and redaction |
| `client/components/OffProductPicker.tsx` | Reuse the shared card; add project filter and project-aware lookup |
| `client/pages/ScanPage.tsx` | Universal result, project badge, add/improve/report actions |
| `client/pages/ItemPage.tsx` | Contribution panel, share photo, report |
| `client/pages/ItemFormPage.tsx` | Product type selector when creating from a barcode; preserve project |
| `client/pages/ReceiptScanPage.tsx` | "Add missing products" and opt-in "Share prices" sections |
| `client/pages/SettingsPage.tsx` | New "Open Food Facts" settings section; admin toggles |
| `client/pages/ProfilePage.tsx` | Connected accounts summary and consent status |
| `client/i18n.tsx` | All new strings, English first; keep Greek coverage |
| `client/api.ts` | Typed helpers for `/api/off/*`; no secret ever stored in client state beyond the link form |

UI rules: 360 px first, dark mode, no layout shift, `aria-live` for queue progress, no external images
without `referrerpolicy="no-referrer"`, and a clear "public" label on every contribution action.

---

## 9. Security, privacy and legal

- **Passwords:** accepted only in the link request over HTTPS, used for one exchange, never logged,
  never stored, never echoed in errors. The UI clears the field on submit.
- **Secrets at rest:** AES-256-GCM with a random IV per row; key from env or a `0600` file in `DATA_DIR`.
  Document that restoring a backup without the key invalidates links.
- **Logging:** extend `server/lib/redact.ts`; never log request bodies for `/api/off/accounts/*` or
  `/api/off/contributions` payloads. Log only field keys and status codes.
- **Authorization:** candidates and contributions are scoped to the user; house data requires at least
  `member`; only the owner/admin can change admin settings. A linked OFF account belongs to one SVault
  user and is never shared between users.
- **CSRF / origin:** keep the existing same-origin cookie model; write routes are JSON `POST`/`DELETE`
  with `SameSite=Lax`. Do not add a cross-origin callback in v1.
- **Data minimization:** submit only fields the user selected; strip EXIF client-side; never include
  receipts, prices (except Open Prices), locations, notes or house identifiers.
- **Licensing:** ODbL for data, CC-BY-SA for photos. Show the license and obtain affirmative consent
  before the first contribution; store the consent version. Never upload scraped or producer-owned
  images without permission.
- **Moderation:** per-user `app_uuid` and rate caps limit blast radius; NutriPatrol is the reporting
  channel for bad data. No hidden retries that could look like spam.
- **Data residency:** contributions go directly from the SVault server to OFF; no SVault proxy or
  third-party service is introduced.
- **Trademark:** call the feature "Open Food Facts" with the project names as labels; do not imply
  endorsement. Follow OFF brand guidance for any logo use.

---

## 10. Testing strategy

The existing suite is `server/tests/api.test.ts` with `node:test`. Add focused tests rather than one
giant file:

| Level | What |
| --- | --- |
| Unit | Project registry, field allow-list, `add_*` payload builder, barcode normalization, eligibility rules and scores, diff selection, redaction, AES round-trip |
| Contract fixtures | Trimmed v3 product payloads for food/beauty/pet/general; error payloads; image upload responses; Open Prices price/proof payloads; Folksonomy token/product responses |
| Integration (mocked fetch) | Universal lookup and redirects, cache hit/miss/negative cache, search throttle, auth exchange, queue transitions, retry/backoff, idempotency, 401 → re-link, 429 → queued, success → cache refresh |
| API tests | Authorization (viewer cannot contribute), house scoping, unknown project, invalid GTIN, disabled capability, dry-run, cancel/retry |
| Staging smoke (manual, gated) | `OFF_STAGING_URL=https://world.openfoodfacts.net`, Basic `off:off`, dedicated test account; create/edit a throwaway product and upload a test image. Never in CI |
| UI | Typecheck + production build; manual 360 px/dark; optionally add a small Playwright smoke later, but do not add a new test runner in this project |

Update `package.json` so `npm test` runs every file under `server/tests/` (currently only
`api.test.ts`). Mock `globalThis.fetch` in tests; no network access in CI. Add a `test:off` script for
the focused suite if the full suite gets slow.

Definition of done for each contribution flow: happy path, unauthenticated, expired session, rate
limited, remote validation error, duplicate, cancel, and retry all covered by tests.

---

## 11. Phased delivery

Sizes are rough, in the style of `docs/roadmap.md`.

### Phase 0 — API spike and decisions (S, 1–2 days)

- Probe all four domains with v3 read and `product_type=all`; record response shapes and project
  detection.
- Confirm v3 product write (`POST`/`PATCH /api/v3/product/{code}`) versus legacy `product_jqm2.pl`,
  image upload/selection endpoints, and auth/session behaviour.
- Confirm Open Prices auth + price/proof payload, Folksonomy token + property endpoints, NutriPatrol
  flag payload, Robotoff annotation endpoint, and which projects each actually supports.
- Decide contact email, default country/language, and whether the instance contribution account ships
  in Phase 1.
- **Exit:** a short `docs/openfoodfacts-spike.md` with verified endpoints and sample payloads; capability
  flags updated from facts, not docs.

### Phase 1 — Multi-project read foundation (M, ~1 week)

- Project registry, project-aware cache migration, v3 reader, universal lookup, project badges.
- Search: local + OFF search-a-licious; limited search on other projects.
- Update `OffProductPicker`, scan results, item panel, receipt matching to pass the project.
- Keep `/api/catalog/*` working; add `/api/off/*` read routes.
- **Exit:** a pet-food barcode resolves from OPFF, a cosmetic from OBF, a general product from OPF;
  existing food flows and tests still pass; cache hits work offline.

### Phase 2 — Contribution plumbing + food (M/L, 1–2 weeks)

- Encrypted account links, consent, queue, worker, audit events, admin kill switch/dry-run.
- Product edit and image upload for OFF only; contribution preview UI; item/scan entry points.
- Eligibility engine v1 (new_product, missing_fields, photo).
- **Exit:** a signed-in user submits a missing field and a photo to staging OFF; the queue retries a
  simulated 503; the cache refreshes; secrets never appear in logs; all tests pass.

### Phase 3 — Beauty, pet food and general products (M, ~1 week)

- Enable write/image flows per project after staging verification.
- Product type picker, wrong-project detection + NutriPatrol report, project-specific field rules
  (no nutrition on OBF/OPF, no scores outside food).
- **Exit:** each project has a staging create/edit/photo test; type inference is correct for the seeded
  category fixtures; wrong-project flow files a report instead of creating a duplicate.

### Phase 4 — Ecosystem contributions (L, 1–2 weeks)

- Open Prices (receipt price + proof + location), NutriPatrol reports, Robotoff opt-in review.
- Optional Folksonomy advanced editor behind a capability flag.
- Privacy redaction for proofs; per-flow consent.
- **Exit:** a receipt line can be shared as a price with a redacted proof; a report appears in History;
  Robotoff answers work when the service is available and degrade silently when it is not.

### Phase 5 — Eligibility and bulk UX (M, ~1 week)

- Contributions page with ranked candidates, needs-info cards, bulk product edits, history, success
  notifications.
- Cooldowns, duplicate detection, per-user caps, "recently contributed" state.
- **Exit:** a fresh house with 30 scanned items shows a useful, non-noisy queue; bulk contributes 5
  products sequentially with per-item results; 360 px UI is usable.

### Phase 6 — Hardening and optional bulk data (M, ~1 week)

- Rate-limit tuning, cache pruning, metrics, docs, i18n, changelog.
- Optional: opt-in local product dump importer for cold cache (separate issue, not required for launch).
- **Exit:** runbook for OFF outages/auth expiry, admin stats, backup/restore includes the key, and a
  production dry run with writes disabled.

---

## 12. File map and migration notes

**New server files:** `server/services/off/*` (Section 5.1), `server/routes/off.ts`,
`server/tests/off.test.ts` (plus fixtures under `server/tests/fixtures/off/`).

**Modified server files:** `server/config.ts` (env), `server/index.ts` (mount + worker start),
`server/routes/catalog.ts` (delegate to the new reader for compatibility), `server/services/nutrition.ts`
(reuse), `server/services/receipt-candidates.ts` (project-aware), `server/serialize.ts` and
`server/routes/recipes.ts` (cache join), `server/database/sqlite.ts`,
`server/database/postgres-schema.ts`, `server/services/backup.ts` (only if a table allow-list exists;
today it dumps all tables), `server/lib/redact.ts`, `shared/types.ts`, `docs/api.md`,
`docs/user-guide.md`, `docs/architecture.md`, `README.md`, `CHANGELOG.md`, `.env.example`.

**Migration order (both backends):**

1. Add `off_project` to `items`, `receipt_lines`, `catalog_mappings` with default `'off'`.
2. Rebuild `catalog_products` with `(project, code)` PK; copy rows as `'off'`.
3. Add `user_off_accounts`, `off_contributions`, `off_contribution_events`.
4. Backfill `off_project='off'` for existing links; leave `off_code` semantics unchanged.
5. Add indexes for candidate queries (`items_off`, `catalog_products(project, name)`,
   `off_contributions(status, next_attempt_at)`).

Migration must be idempotent and tested against a copy of a real SQLite database and PostgreSQL. Take a
backup before upgrading, as the project already recommends.

**Environment additions:**

```
# Public app identity for OFF requests (required for contributions).
SV_OFF_CONTACT=you@example.com
# Optional instance contribution account (otherwise users link their own).
OFF_CONTRIB_USER=
OFF_CONTRIB_PASSWORD=
# 32 random bytes, base64. If unset, DATA_DIR/off-secret.key is generated.
SV_OFF_SECRET_KEY=
# Feature flags; reads stay on, writes are opt-in.
SV_OFF_WRITE_ENABLED=false
SV_OFF_PROJECTS=off,obf,opff,opf
SV_OFF_DRY_RUN=false
# Optional overrides for a proxy or staging.
OFF_API_BASE=https://world.openfoodfacts.org
OFF_STAGING_URL=https://world.openfoodfacts.net
```

---

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| OFF API drift (v2 deprecated, v3 evolving) | Read/write breakage | Versioned adapter, fixtures, Phase 0 verification, v2 fallback during migration |
| Per-IP rate limits / bans | Lookups fail for every house | Shared bucket, 30-day cache, negative cache, no type-ahead, UA + contact, optional dump importer |
| Session auth is IP-bound and capped | Contributions fail after network change | Detect 401, prompt re-link, keep draft, instance-account fallback |
| Keycloak/OIDC migration at OFF | Legacy auth may change | `linkAccount()` interface; add OAuth device/PKCE in a later phase |
| Destructive writes | Data loss on OFF | `add_*` default, diff preview, allow-list, corrections off by default, dry-run |
| License/privacy mistakes | Legal and trust damage | Explicit consent, EXIF strip, receipt redaction, only user-owned photos, no PII in comments |
| Spam/abuse from one instance | OFF ban | Per-user `app_uuid`, daily caps, cooldowns, admin kill switch |
| Wrong-project duplicates | Messy commons | Universal lookup first, type inference, report/move flow, never auto-create on ambiguity |
| Scope ("all APIs") | Never ships | Tiered phases, capability flags, read first, write per project only after staging proof |
| Storage growth from cache/photos | Disk pressure | TTL/prune, delete staged photos after send, cap payload size, project-aware pruning |
| Secret key loss on restore | Links stop working | Documented re-link path; key lives in `DATA_DIR` and backups |

---

## 14. Decisions needed (with recommended defaults)

1. **Account model.** Recommend shipping both: individual OFF account for attribution (default), instance
   account as the admin-enabled fallback. This satisfies "contribute if users log in" without forcing an
   OFF account on every household.
2. **First non-food project.** Pet food (the prompt names Open Pet Food Facts) or beauty? Recommend
   pet food first, because households already track pet supplies and OPFF accepts nutrition.
3. **Open Prices.** Recommend opt-in, per-receipt, with proof redaction; never automatic.
4. **Contact email for the OFF User-Agent.** Needed before any production write. Use a project address
   such as `svault@<domain>`; do not use a personal address.
5. **Default country/language.** Use `house.settings.purchases.country` and `user.language`, with a
   per-contribution override. Fall back to `en`/no country.
6. **Robotoff and Folksonomy.** Recommend Robotoff opt-in in Phase 4 and Folksonomy behind "Advanced"
   only if the Phase 0 probe confirms multi-project support.
7. **Local dump importer.** Recommend deferring until read volume justifies it; the cache plus rate
   budget should be enough for a household instance.
8. **Translation.** English first, but add all keys to the existing i18n catalog so Greek can follow.

---

## 15. References

- OFF API introduction, rate limits, authentication, v2 vs v3:
  <https://openfoodfacts.github.io/openfoodfacts-server/api/>
- v3 reference: <https://openfoodfacts.github.io/openfoodfacts-server/api/ref-v3/>
- API cheat sheet: <https://openfoodfacts.github.io/openfoodfacts-server/api/ref-cheatsheet/>
- Adding missing products (write, `add_*`, app identity):
  <https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/adding-missing-products/>
- Uploading images: <https://openfoodfacts.github.io/openfoodfacts-server/api/tutorial-uploading-photo-to-a-product/>
- OBF/OPFF/OPF specifics and universal scan:
  <https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/scanning-cosmetics-pet-food-and-other-products/>
- Local caching and ODbL share-back guidance:
  <https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/creating-a-local-cache-of-open-food-facts-data/>
- Open Prices API: <https://prices.openfoodfacts.org/api/docs>
- Folksonomy API: <https://api.folksonomy.openfoodfacts.org/docs>
- Robotoff: <https://openfoodfacts.github.io/robotoff/>
- NutriPatrol: <https://nutripatrol.openfoodfacts.org/api/docs>
- Search-a-licious: <https://search.openfoodfacts.org/docs>
- OFF terms of use: <https://world.openfoodfacts.org/terms-of-use>
