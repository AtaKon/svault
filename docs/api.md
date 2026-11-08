# API reference

SVault exposes a JSON API for its own web client. It is cookie-authenticated, same-origin and not
versioned separately from the app. If you are building an integration, treat it as an internal API:
breaking changes are possible in minor releases until a versioned public API exists.

## Conventions

- **Base URL:** `http://<host>:<port>/api`
- **Content type:** `application/json` for requests and responses, except uploads
  (`multipart/form-data`) and exports (`application/zip`).
- **Auth:** the `sv_session` cookie. Send it on every request; the client uses
  `credentials: "include"`.
- **Errors:** non-2xx responses return `{ "error": "message" }`. Validation errors add
  `details` from Zod.
- **IDs:** prefixed strings such as `itm_...`. Treat them as opaque.
- **Dates:** ISO-8601 timestamps for events; `YYYY-MM-DD` for dates.
- **Pagination:** endpoints that paginate use `limit` and `offset` and usually return a `total`.
- **Cross-site requests:** `POST`/`PUT`/`PATCH`/`DELETE` from a browser must be same-origin. A request
  whose `Origin` does not match the host (or `ORIGIN`), or that a browser marks `Sec-Fetch-Site:
  cross-site` without an `Origin`, gets `403`. Scripts that send neither header are unaffected.
- **Rate limits:** credential, invite and AI endpoints answer `429` with `Retry-After` when over their
  limit (see [deployment](deployment.md#rate-limits)).

### Roles

House routes use these ranks: `viewer < member < admin < owner`.

| Notation | Meaning |
| --- | --- |
| `viewer+` | Any member of the house, including viewers |
| `member+` | Members, admins and owners |
| `admin+` | Admins and owners |
| `owner` | The single house owner |

`GET /api/houses/:houseId` returns `role` so a client can hide actions. The server enforces the same
rules independently.

### Quick example

```bash
# Log in and keep the session cookie
curl -c cookies.txt -H 'content-type: application/json' \
  -d '{"email":"demo@svault.local","password":"demo1234"}' \
  http://localhost:8080/api/auth/login

# List houses
curl -b cookies.txt http://localhost:8080/api/houses

# Add stock to an item
curl -b cookies.txt -H 'content-type: application/json' \
  -d '{"action":"add","quantity":500,"unit":"ml","unitPrice":0.8}' \
  http://localhost:8080/api/items/itm_xxx/stock
```

## Authentication

Mounted at `/api/auth`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/registration` | public | `{ mode: "open" \| "invite" \| "closed", inviteRequired, firstUser }` for the sign-up page. |
| `POST` | `/register` | public | Create an account; first user becomes instance admin. Accepts an optional `username`, `inviteCode`, or creates a house. `403` when registration is `closed`, or `invite` and no `inviteCode` is sent; `400` for an unknown, used or expired invite. |
| `POST` | `/login` | public | Email **or** username + password; sets the session cookie. `429` after too many attempts from one IP or failed attempts for one account. |
| `POST` | `/logout` | any | Deletes the current session and clears the cookie. |
| `GET` | `/me` | user | Current user plus all houses with roles. |
| `PATCH` | `/me` | user | Change `name`, `email`, `username`, `language` and/or `developerMode`. Changing `email` or `username` needs `currentPassword` (`400` when missing or wrong). Single sign-on accounts without a password (`user.hasPassword: false`) cannot change their email here (`403`). |
| `POST` | `/me/password` | user | Requires `currentPassword`; rotates every session and issues a new cookie. |
| `GET` | `/invites/:code` | public | Preview an invite (house name, role, inviter, `expiresAt`). Does not accept it. `404` when unknown, used or expired. |
| `POST` | `/invites/:code/accept` | user | Join the house if the invite is valid, unexpired and the email matches. |

Register body:

```json
{
  "name": "Alex",
  "email": "alex@example.com",
  "username": "alex",
  "password": "at-least-8-characters",
  "houseName": "Alex's Home",
  "inviteCode": "optional-code"
}
```

`username` is optional. When omitted, a unique one is derived from the email local part, so every
account can sign in with either identifier. Usernames are 3–32 characters: letters, numbers, dots,
dashes and underscores.

Login accepts `{ "identifier": "alex", "password": "..." }`, or `email`/`username` instead of
`identifier`. The older `{ "email": "alex@example.com" }` form keeps working.

Read-only API tokens authenticate with `Authorization: Bearer svt_...` instead of the session cookie.
They can call `GET`/`HEAD` endpoints for every house the user belongs to; any write returns `403`.
Create and revoke them under `/api/tokens` (see below).

`POST /api/auth/login` and `/register` return:

```json
{
  "user": { "id": "usr_...", "email": "alex@example.com", "username": "alex", "name": "Alex", "isAdmin": false, "developerMode": false, "hasPassword": true, "createdAt": "..." },
  "houses": [ { "id": "hse_...", "name": "Alex's Home", "role": "owner", "...": "..." } ]
}
```

## Houses and members

Mounted at `/api/houses`.

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | user | Houses the caller belongs to. |
| `POST` | `/` | user | Create a house. Optional `template`: `home`, `cabin`, `fridge`, `closet`, `garage`. |
| `GET` | `/:houseId` | viewer+ | House detail with members and counts. |
| `PATCH` | `/:houseId` | admin+ | Name, kind, address, currency and `settings` (merged, not replaced). |
| `DELETE` | `/:houseId` | owner | Delete the house and all database rows. Uploaded files stay on disk. |
| `POST` | `/:houseId/ai/test` | admin+ | Send a ping to the configured provider. The server key is only used with the server's base URL; `400` when `SV_OUTBOUND_ALLOW_PRIVATE=false` and the house base URL is on a private network. |
| `GET` | `/:houseId/ai/logs` | developer | AI call audit trail. Filters: `scope=mine\|all`, `operation`, `status=ok\|error`, `limit`, `offset`. |
| `GET` | `/:houseId/ai/logs/:logId` | developer | Full call detail, including request/response previews and metadata. |
| `DELETE` | `/:houseId/ai/logs` | admin+ & developer | Clear the AI call log for this house. |
| `GET` | `/:houseId/members` | viewer+ | List members. |
| `POST` | `/:houseId/members` | admin+ | Create an email-bound invite (`{ invite: { code, url, expiresAt, existingAccount } }`). Existing accounts are no longer added directly; they join by accepting the invite. Invites expire after `SV_INVITE_DAYS` (14). |
| `PATCH` | `/:houseId/members/:userId` | owner | Change a role (`admin`, `member` or `viewer`). Ownership transfer is not implemented yet ([#16](https://github.com/AtaKon/svault/issues/16)). |
| `DELETE` | `/:houseId/members/:userId` | admin+ | Remove a member. Only the owner can remove an admin. |
| `GET` | `/:houseId/invites` | admin+ | List invites with codes, URLs, `expiresAt` and `expired`. |
| `DELETE` | `/:houseId/invites/:inviteId` | admin+ | Revoke an invite. |
| `POST` | `/:houseId/leave` | viewer+ | Leave the house. The sole owner cannot leave until ownership transfer exists ([#16](https://github.com/AtaKon/svault/issues/16)). |

`settings` accepts a partial object and is deep-merged for `ai` and `notifications`:

```json
{
  "settings": {
    "currency": "EUR",
    "units": "metric",
    "ai": {
      "enabled": true,
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "visionModel": "",
      "apiKey": "sk-..."
    },
    "notifications": { "lowStock": true, "expiryDays": 7 }
  }
}
```

Send `"apiKey": "***"` to keep the stored key, `""` to delete it. The API never returns the real key.

### AI call log

Every request SVault sends to an OpenAI-compatible provider is stored in `ai_call_logs`: receipt scans,
bulk intake, recipe scans, recipe completion, food ideas and connection tests. Each row records the
operation, user, house, provider host, model, HTTP status, retry count, duration, token counts, cost,
image count, request/response sizes, truncated prompt/response previews, error text and arbitrary
operation metadata. Logging never fails the scan that triggered it.

The endpoints require `developerMode` on the account (toggle it on the profile page). Non-admins see
their own calls; house admins can pass `scope=all` to see every member's calls. The response shape is:

```json
{
  "scope": "mine",
  "logs": [ { "id": "ail_...", "operation": "receipt.scan", "status": "ok", "model": "gpt-4o-mini", "totalTokens": 1500, "cost": 0.00125, "durationMs": 812, "...": "..." } ],
  "total": 42,
  "summary": { "calls": 42, "errors": 1, "cost": 0.042, "promptTokens": 39000, "completionTokens": 12000, "totalTokens": 51000 }
}
```

The same calls are written to stdout as one structured `[ai] {...}` JSON line, so Docker logs, Loki,
Grafana, Vector or any log collector can consume them. API keys are never written to the log.

## Taxonomy: places, categories, attributes

All mounted under `/api/houses/:houseId`.

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/locations` | viewer+ | List places with item counts. |
| `POST` | `/locations` | member+ | Create a place (`name`, `kind`, `icon`, `parentId`). |
| `PATCH` | `/locations/:locationId` | member+ | Rename or re-parent. |
| `DELETE` | `/locations/:locationId` | admin+ | Delete a place; batches become unassigned. |
| `GET` | `/categories` | viewer+ | List categories with item counts. |
| `POST` | `/categories` | member+ | Create a category. |
| `PATCH` | `/categories/:categoryId` | member+ | Rename or re-parent. |
| `DELETE` | `/categories/:categoryId` | admin+ | Delete a category; items become uncategorised. |
| `GET` | `/attributes` | viewer+ | List custom attribute definitions. |
| `POST` | `/attributes` | admin+ | Create an attribute (`key`, `label`, `type`, `unit`, `options`, `required`, `categoryId`, `sort`). |
| `PATCH` | `/attributes/:attributeId` | admin+ | Update a definition. |
| `DELETE` | `/attributes/:attributeId` | admin+ | Delete a definition; stored values remain in item JSON but are no longer shown. |

Attribute types: `text`, `number`, `select`, `date`, `boolean`, `url`. Built-in item fields
(`name`, `description`, `brand`, `category`, `unit`, `reorder_point`, `target_stock`, `tags`,
`barcode`, `image`, `quantity`, `value`, …) are reserved and rejected as custom attribute keys.

## Inventory

### Items

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/items` | viewer+ | List/search items. |
| `POST` | `/api/houses/:houseId/items` | member+ | Create an item, optional barcodes and initial stock. |
| `GET` | `/api/houses/:houseId/scan?code=...` | viewer+ | Resolve a barcode in this house, then OpenFoodFacts. |
| `GET` | `/api/items/:itemId` | viewer+ | Item detail: lots, movements, price history, linked recipes, OpenFoodFacts link. |
| `PATCH` | `/api/items/:itemId` | member+ | Update fields or `archived`. Pass `offCode` to link, or `null` to unlink. |
| `DELETE` | `/api/items/:itemId` | member+ | Delete the item, its batches and barcodes. Recipes stay. |
| `POST` | `/api/items/:itemId/stock` | member+ | Add, remove, waste, set or move stock. |
| `GET` | `/api/items/:itemId/movements` | viewer+ | Movement ledger (`limit` 1-300, default 50). |
| `POST` | `/api/items/:itemId/image` | member+ | `multipart/form-data` field `image`. |
| `POST` | `/api/items/:itemId/barcodes` | member+ | Attach `{ "code": "...", "format": "ean13" }`. |
| `DELETE` | `/api/items/:itemId/barcodes/:barcodeId` | member+ | Detach a barcode. |
| `GET` | `/api/items/:itemId/off` | viewer+ | Current OpenFoodFacts link and product. |
| `POST` | `/api/items/:itemId/off/link` | member+ | Link `{ "code": "..." }`. Fills empty fields and attaches the code as a barcode. `fill: false` links without filling. |
| `POST` | `/api/items/:itemId/off/fill` | member+ | Re-apply OpenFoodFacts to blank fields. `force=1` refreshes the cached product first. |
| `DELETE` | `/api/items/:itemId/off` | member+ | Remove the link. Filled values stay; the code stays as a barcode. |
| `GET` | `/api/items/:itemId/aliases` | viewer+ | Receipt names mapped to this item. |
| `POST` | `/api/items/:itemId/aliases` | member+ | Add `{ "rawName": "...", "vendorId": "vnd_..." }` (vendor optional). |
| `DELETE` | `/api/items/:itemId/aliases/:aliasId` | member+ | Forget a receipt name. |

List query parameters:

| Parameter | Meaning |
| --- | --- |
| `q` | Matches name, brand, description or barcode |
| `categoryId` | Category filter |
| `locationId` | Items with positive stock in that place |
| `tag` | Tag substring match |
| `low=1` | Quantity at or below reorder point |
| `expiring=1` | Has a batch expiring within 14 days |
| `archived=1` | Include archived items |
| `sort` | `name` (default), `recent`, `quantity`, `value` |
| `limit`, `offset` | 1-1000, default 300 |

Create item body:

```json
{
  "name": "Olive oil",
  "brand": "Kalamata",
  "categoryId": "cat_...",
  "unit": "l",
  "reorderPoint": 0.5,
  "targetStock": 2,
  "attributes": { "origin": "Messinia" },
  "tags": ["kitchen", "greek"],
  "nutrition": {
    "basis": "100ml",
    "energyKcal": 884,
    "energyKj": 3699,
    "fat": 100,
    "saturatedFat": 14,
    "carbohydrates": 0,
    "sugars": 0,
    "fiber": 0,
    "proteins": 0,
    "salt": 0,
    "sodium": 0,
    "servingSize": "15 ml",
    "servingQuantity": 14
  },
  "barcodes": ["5201234567890"],
  "offCode": "5201234567890",
  "initialStock": {
    "quantity": 750,
    "unit": "ml",
    "unitPrice": 6.9,
    "locationId": "loc_...",
    "purchasedAt": "2026-10-30",
    "expiresAt": "2028-10-30",
    "note": "Gift",
    "vendorId": "vnd_..."
  }
}
```

`nutrition` is optional and can be sent as `null` to clear it. All nutrient values except
`energyKcal`/`energyKj` are grams per `basis` (`100g` or `100ml`). `servingQuantity` is the serving
weight in grams or millilitres and is used to estimate count-based recipe ingredients. Linking an
OpenFoodFacts product fills a blank panel automatically; existing values are kept.

Stock action body:

```json
{ "action": "add", "quantity": 500, "unit": "ml", "unitPrice": 0.8, "locationId": "loc_...", "expiresAt": "2026-12-01", "vendorId": "vnd_..." }
{ "action": "remove", "quantity": 200, "unit": "ml", "note": "Dinner" }
{ "action": "waste", "quantity": 100, "reason": "Spoiled" }
{ "action": "set", "target": 1.5, "unit": "l" }
{ "action": "move", "quantity": 2, "fromLocationId": "loc_a", "toLocationId": "loc_b" }
```

Every successful stock action returns the complete item detail. Its `priceHistory` contains one entry
per incoming purchase: `at`, normalized `price` per item unit, entered `unit`, `quantity`, `unitPrice`,
`vendorId`, `vendorName`, `receiptId` and `note`. Clients can filter this list by shop for per-vendor
price comparisons.

Barcode scan response:

```json
{ "code": "5201234567890", "match": "local", "item": { "...": "..." }, "product": null }
```

`match` is `local`, `external` or `none`. For `external`, `product` contains the cached
OpenFoodFacts product (`code`, `project`, `productType`, `name`, `brand`, `genericName`, `quantity`,
`categories`, `image`, `ingredients`, `allergens`, `labels`, `nutriscore`, `novaGroup`, `countries`,
`packaging`, `servingSize`, `nutrition`) and `item` is null. `nutrition` is the parsed per-100 panel,
or null when the product has no nutrition data.

## OpenFoodFacts catalogue

SVault reads four Open Food Facts databases: Open Food Facts (`off`), Open Beauty Facts (`obf`), Open
Pet Food Facts (`opff`) and Open Products Facts (`opf`). Products are cached in a shared
`catalog_products` table keyed by `(project, code)` for `OFF_CACHE_DAYS` (default 30). A universal
lookup asks `product_type=all` and records the project returned by the owning database.

Receipt text mappings live in `catalog_mappings`: bundled seed rows ship in
`assets/catalog/off-mappings.json`, mappings learned on the instance are `local`, and imported files
are `community`. A local mapping is never overwritten by a seed file or import.

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/catalog/search?q=...&project=off` | signed in | Search the cache, then OpenFoodFacts. `online=0` skips the network; `limit` 1-20. `project=all` searches every cache plus OFF full text; other projects search their cache only. |
| `GET` | `/api/catalog/product/:code?project=all` | signed in | Cached or live product. `project=all` (default) routes to the owning database; `full=1` adds the stored OFF payload. |
| `GET` | `/api/off/projects` | signed in | Project registry: labels, product types, sites and capability flags. |
| `GET` | `/api/off/lookup/:code?project=all` | signed in | Universal or project-specific lookup. Returns `{ product, project }`. |
| `GET` | `/api/off/product/:project/:code?full=1` | signed in | Full read from one project; `project` must be `off`, `obf`, `opff` or `opf`. |
| `GET` | `/api/catalog/resolve?raw=...&houseId=...` | signed in | Best mapping for a raw receipt line: shared rows, plus that house's learned rows when the caller is a member. |
| `GET` | `/api/catalog/mappings` | signed in | List/search shared mappings (`q`, `limit` 1-500). |
| `GET` | `/api/catalog/stats` | instance admin | Mapping and cache counts plus the configured sync URL. |
| `GET` | `/api/catalog/export` | instance admin | Download the catalogue JSON (includes local mappings and raw receipt text). |
| `POST` | `/api/catalog/import` | instance admin | Merge `{ "version": 1, "mappings": [...] }`. Local rows are skipped. |
| `POST` | `/api/catalog/sync` | instance admin | Download and merge `SV_CATALOG_URL`, or a `{ "url": "https://..." }` override. |

Search responses include `project` and a stable `warningCode`: `NOTHING_FOUND` when an online search
had no result, or `LIMITED_SEARCH` when the selected non-food project can only search this server's
cache. The legacy warning text is kept for older clients.

Linking an item returns `{ item, product, filled, skipped }`. `filled` lists the first-class fields
that were blank and are now populated (name, description, brand, image, category); `skipped` explains
values that were kept. Existing values are never overwritten. The item's `off` link includes the
product's `project`, so a pet-food or beauty product never resolves against the food cache.

Receipt imports accept `offCode` per line. When a line also has a printed `barcode`, the barcode wins;
otherwise the shared catalogue resolves the raw text. Line responses expose `offCode` and `offProject`.

### Contributing back

Contributions are opt-in and disabled until `SV_OFF_WRITE_ENABLED=true`. A user connects an Open Food
Facts account (or the instance account is configured), accepts the license, and reviews the exact
fields before anything is queued. SVault stores an encrypted session cookie, never a password.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/off/accounts` | Linked accounts, instance-account availability, consent state and write flags. |
| `POST` | `/api/off/accounts/:project/link` | `{ username, password, consent? }`. Exchanges the credentials for a session, stores it encrypted, discards the password. |
| `POST` | `/api/off/accounts/:project/verify` | Re-check a stored session. |
| `DELETE` | `/api/off/accounts/:project` | Remove the link and its secret. |
| `GET` | `/api/off/consent` | Current consent version and timestamp. |
| `POST` | `/api/off/consent` | `{ accept: true }`. Required before contributing. |
| `GET` | `/api/off/contributions/candidates?houseId=` | Ranked eligible items with fields, preview values and blockers (`account`, `consent`, `writes_disabled`). Includes missing fields, new products, Open Prices lines and wrong-project reports. |
| `GET` | `/api/off/contributions` | The caller's queue/history (`status`, `limit`). |
| `POST` | `/api/off/contributions` | `{ houseId, itemId?, receiptLineId?, kind, fields }`. Re-runs eligibility and queues the write. `kind` is `new_product`, `missing_fields`, `photo`, `price`, `report` or `wrong_project`; prices use `receiptLineId`. |
| `GET` | `/api/off/contributions/:id` | Status, remote message and retry/cancel flags. |
| `POST` | `/api/off/contributions/:id/retry` | Requeue a failed/retrying contribution. |
| `DELETE` | `/api/off/contributions/:id` | Cancel a queued/retrying contribution. |
| `GET` | `/api/off/services/:service` | Secondary service status is included in `/api/off/accounts` (`prices`, `folksonomy`). |
| `POST` | `/api/off/services/:service/link` | `{ username, password }`. Exchange OFF credentials for an Open Prices or Folksonomy bearer token, stored encrypted. |
| `DELETE` | `/api/off/services/:service` | Remove a secondary service token. |
| `GET` | `/api/off/report-reasons` | NutriPatrol reason values and labels. |
| `GET` | `/api/off/prices/locations?q=` | Search Open Prices locations when sharing a receipt price. |
| `GET` | `/api/off/robotoff/questions?project=off&count=1` | Optional Robotoff questions. Returns `{ questions, supported }`; unavailable services return an empty list. |
| `POST` | `/api/off/robotoff/answers` | `{ insightId, annotation: 1 \| 0 \| -1 }`. |
| `POST` | `/api/off/folksonomy` | Advanced: `{ project, code, key, value }` writes one Folksonomy property. |
| `GET` | `/api/off/stats` | Instance admin: queue counts and write flags. |

Price contributions upload the receipt as an Open Prices proof, then submit `{ product_code, price, currency, date, proof_id }`. NutriPatrol reports reuse the linked OFF session and send `{ barcode, type, url, user_id, source, flavor, reason, comment }`. Both are queued through the same retry/cancel history as product edits.

The queue retries network, `429` and `5xx` failures with exponential backoff. Validation and auth failures stop and keep the draft. A successful write refreshes the local cache immediately. With `SV_OFF_DRY_RUN=true`, the full payload is built and queued but no request is sent.

## Receipts and shops

Shops (`vendors`) are per house. Receipts store the shop, date, totals, the original image and every
line. Importing a receipt creates stock batches through the normal stock engine and can create items
for unknown products.

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/vendors` | viewer+ | Shops with a purchase count. |
| `GET` | `/api/houses/:houseId/vendor-suggestions` | viewer+ | Suggested shops from the catalog. Filters: `country` (default `GR`), `q`. |
| `POST` | `/api/houses/:houseId/vendors` | member+ | Create a shop (`name`, `kind`, `note`), or pass `catalogId` from the suggestions list. Names are unique per house. |
| `PATCH` | `/api/houses/:houseId/vendors/:vendorId` | member+ | Rename or edit a shop. |
| `DELETE` | `/api/houses/:houseId/vendors/:vendorId` | admin+ | Delete a shop. Batches and movements lose the link; receipts keep the name they were saved with. |
| `GET` | `/api/houses/:houseId/receipts` | viewer+ | Recent receipts. Filters: `vendorId`, `q`, `limit` (default 50, max 300). |
| `GET` | `/api/houses/:houseId/purchases/analytics` | viewer+ | Spend totals, net/tax split, by shop, monthly, VAT rates and categories. Filters: `from`, `to` (`YYYY-MM-DD`). |
| `POST` | `/api/houses/:houseId/receipts` | member+ | Import lines as stock and save the receipt. `409` for a likely duplicate unless `allowDuplicate: true`. |
| `POST` | `/api/houses/:houseId/receipts/validate` | member+ | Dry run of an import (same body): per-line item match, new items and errors. Writes nothing. |
| `POST` | `/api/houses/:houseId/receipts/upload` | member+ | Upload a receipt photo (`field: image`) and get `{ path }`. |
| `DELETE` | `/api/houses/:houseId/receipts/upload` | member+ | Delete a draft upload `{ "path": "/uploads/receipts/..." }`. `409` when a saved receipt uses it. |
| `POST` | `/api/houses/:houseId/receipts/scan` | member+ | Parse OCR text and/or page images into a receipt draft with a reconciliation and a `scanId`. |
| `GET` | `/api/receipts/:receiptId` | viewer+ | Receipt with its lines and linked item names. |
| `DELETE` | `/api/receipts/:receiptId` | member+ | Delete the receipt and its image. `?revertStock=true` also removes the stock it added that is still there. |

Suggested-shop response:

```json
{
  "country": "GR",
  "countries": [{ "code": "GR", "name": "Greece" }],
  "entries": [
    { "id": "vct_...", "country": "GR", "name": "Σκλαβενίτης", "kind": "supermarket", "added": false },
    { "id": "vct_...", "country": "GR", "name": "Lidl", "kind": "supermarket", "added": true }
  ]
}
```

The catalog is seeded with common Greek supermarkets, delis, kiosks, markets and online shops. It is
keyed by `country`, so other countries can be added later without changing the receipt flow. A receipt
scan resolves known merchant aliases (for example `LIDL HELLAS` or `SKLAVENITIS`) to the catalog name,
and importing with a `vendorName` reuses an existing house shop when the alias matches.

Scan body:

```json
{
  "text": "OCR text from the browser",
  "candidates": ["alternative OCR text from the browser"],
  "image": "/uploads/receipts/stitched.jpg",
  "images": ["/uploads/receipts/page-1.jpg", "/uploads/receipts/page-2.jpg"],
  "preferAi": false
}
```

`images` (up to 8) are the individual page photos, sent to the vision model one by one; `image` is the
stitched scan kept with the receipt and is used for the vision call only when `images` is absent (older
clients). Every path must match `/uploads/receipts/<file>`, otherwise the request is rejected with 400.
The mime type sent to the model comes from the file extension. A photo that is missing or larger than
8 MB is skipped and named in `warning`.

Parsing is local by default. Up to two `candidates` can be supplied when the original text has not been
edited. A matched template compares them against the original total and keeps an alternative only if
its arithmetic improves without reducing line or priced-line counts or losing recognized barcodes. When chosen, `selectedText`
contains the text used. The original total anchors the comparison, so a different total in an alternative
is not selected automatically. `warning` calls out uncertainties; matching arithmetic does not verify names.
`selectedText` is present only when a candidate was selected; `aiAvailable` indicates that the current
scan has an enabled AI provider and usable text or vision input.
`preferAi: true` (the "Re-read with AI" button) explicitly requests AI and uses its draft when it finds
lines. This also applies to bulk receipt intake.

Response:

```json
{
  "provider": "template",
  "warning": null,
  "aiCost": null,
  "scanId": "scn_...",
  "aiAvailable": true,
  "selectedText": "OCR text selected from an alternative pass",
  "reconciliation": { "linesTotal": 10.63, "savings": 1.04, "printedTotal": 10.73, "difference": 0.1, "ok": true },
  "draft": {
    "vendorName": "Lidl",
    "purchasedAt": "2026-10-08",
    "currency": "EUR",
    "total": 10.73,
    "subtotal": 9.33,
    "tax": 1.4,
    "taxBreakdown": [{ "rate": 13, "net": 7.64, "tax": 0.99, "gross": 8.63 }],
    "templateId": "lidl-gr",
    "templateConfidence": 0.99,
    "savings": 1.04,
    "notes": null,
    "lines": [
      {
        "description": "ΑΠΟΓΥΜΝΩΤΗΣ",
        "rawDescription": "ΑΠΟΓΥΜΝΩΤΗΣ -0523350",
        "quantity": 1,
        "unit": null,
        "unitPrice": 1.99,
        "lineTotal": 1.99,
        "taxRate": 24,
        "discount": 0,
        "barcode": null
      }
    ]
  }
}
```

`provider` is `ai`, `local` or `template`. A recognised layout (the built-in `lidl-gr` and
`sklavenitis-gr` templates) wins before generic/AI parsing. The response includes `templateId`,
`templateConfidence` and `savings`, and each line can carry the original `rawDescription`, `taxRate`,
`discount` and `barcode`.

`reconciliation` compares the lines with the printed total. `linesTotal` sums `lineTotal` (or
`unitPrice × quantity`). Templates already subtract a product's discount from its line, so only savings
not attributed to a line are subtracted; when a line carries a discount but may still be gross (AI
drafts), the closer of the two readings is used. `difference` is the printed total minus the expected
total (positive: lines probably missing). `ok` is true when `|difference| ≤ max(0.05, 2 % of the
total)`; it is false and `difference` null when no total was printed.

`scanId` refers to a short-lived server-side record (6 hours, in memory) of the scan's provider, AI cost,
template and images. Pass it to the import: the receipt's `provider`, `aiCost`, `templateId` and
`templateConfidence` are copied from that record, never from the request. Without a valid `scanId` for
the same house they are stored as `null` and the receipt counts as manual unless it has an image.

Import body:

```json
{
  "vendorName": "Corner Market",
  "purchasedAt": "2026-10-12",
  "currency": "EUR",
  "total": 5.5,
  "subtotal": 4.44,
  "tax": 1.06,
  "taxBreakdown": [{ "rate": 24, "net": 4.44, "tax": 1.06, "gross": 5.5 }],
  "scanId": "scn_...",
  "allowDuplicate": false,
  "savings": 1.04,
  "image": "/uploads/receipts/....jpg",
  "ocrText": "raw text, optional",
  "notes": null,
  "lines": [
    {
      "description": "Milk",
      "rawDescription": "ΓΑΛΑ 1,5L",
      "quantity": 2,
      "unit": "l",
      "unitPrice": 1.2,
      "lineTotal": 2.4,
      "taxRate": 13,
      "discount": 0,
      "offCode": "5201234567890"
    },
    {
      "description": "Sourdough bread",
      "quantity": 1,
      "unitPrice": 3.1,
      "lineTotal": 3.1,
      "locationId": "loc_...",
      "expiresAt": "2026-10-16"
    }
  ]
}
```

Use `vendorId` instead of `vendorName` to pick an existing shop; an unknown `vendorName` creates one.
`image` must be an existing `/uploads/receipts/<file>` upload (anything else is a 400). The old
`provider`, `aiCost`, `templateId` and `templateConfidence` fields are still accepted but ignored — see
`scanId` above. A line may set `locationId` (overrides the place for that line) and `expiresAt`
(`YYYY-MM-DD`) for its batch.

Item resolution, shared by the import and `/receipts/validate`: `itemId` (the user's choice) → a learned
product alias for the raw name → `barcode` → exact name → a fuzzy name match → a new item with the
line's unit. The fuzzy match compares normalised word tokens (accents removed, Greek kept, pack sizes
dropped) with a Dice score of at least 0.85, skips items whose unit cannot take the line's unit, and
gives up when two items tie — so "Oat milk chocolate" is not booked as "Oat milk". `offCode` links the
item to an OpenFoodFacts product; a printed `barcode` is tried before `offCode` for that lookup, and the
shared catalogue fills gaps when neither is present. Every imported line creates a normal `in` movement
carrying `vendorId` and `receiptId`.

All lines are checked before anything is written. Problems (incompatible units, an item or place from
another house) are returned together:

```json
{ "error": "2 lines cannot be imported", "details": { "lines": [{ "index": 0, "error": "Cannot add “Milk” in pcs to an item stocked in l. Pick another unit or item." }] } }
```

A receipt with the same shop (id or normalised name), purchase date and total (within 0.01) as a saved
one is refused unless `allowDuplicate` is `true`:

```json
{ "error": "This receipt looks like one you already saved", "duplicateOf": { "id": "rct_...", "purchasedAt": "2026-10-12", "total": 5.5, "vendorName": "Corner Market" } }
```

When the import used a `scanId`, page photos of that scan other than the stored `image` are deleted.

`POST /receipts/validate` takes the same body and answers without writing:

```json
{
  "ok": false,
  "newItems": 1,
  "duplicateOf": null,
  "lines": [
    { "index": 0, "itemId": "itm_...", "itemName": "Milk", "itemUnit": "l", "match": "alias", "willCreate": false, "error": null },
    { "index": 1, "itemId": null, "itemName": "Sourdough bread", "itemUnit": "pcs", "match": "new", "willCreate": true, "error": null }
  ]
}
```

`match` is `chosen`, `alias`, `barcode`, `name`, `fuzzy` or `new`. A second line for a product the same
receipt creates has `willCreate: false` and shares the new item.

Deleting a receipt removes its image file unless another receipt record points at the same file. With
`?revertStock=true`, every batch created by the receipt (including parts moved to another place) is
emptied and one `adjust` movement per item records it; quantities already used stay used:

```json
{ "ok": true, "imageRemoved": true, "reverted": [{ "itemId": "itm_...", "itemName": "Apples", "unit": "pcs", "added": 3, "reverted": 2, "consumed": 1 }] }
```

Product aliases are learned only for lines whose item the user chose (`itemId`) or that created a new
item, keyed by `rawDescription` and the shop. Automatic fuzzy matches are not learned, so a wrong guess
does not become permanent. The next receipt from that shop resolves the same abbreviation to the same
item.

Scan responses also include `suggestedItemId`, `suggestedItemName`, `suggestedItemUnit`,
`suggestedItemScore` and `suggestedItemSource` on each line, plus `offCode`, `offName`, `offBrand`,
`offImage`, `offQuantity` and `offScore` when a cached product or shared mapping matched. Suggestions
combine exact aliases, item names and a local character-vector similarity (hashed trigram cosine plus
token overlap), so slightly
different abbreviations can still surface the right product. An item may have many aliases, optionally
scoped to one shop.

Receipt templates can be managed per house:

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/receipt-templates` | viewer+ | Built-in and custom templates, with rules. |
| `POST` | `/api/houses/:houseId/receipt-templates` | admin+ | Create a custom template. |
| `PATCH` | `/api/houses/:houseId/receipt-templates/:templateId` | admin+ | Update and version a template. |
| `DELETE` | `/api/houses/:houseId/receipt-templates/:templateId` | admin+ | Delete a custom template. |
| `POST` | `/api/houses/:houseId/receipt-templates/test` | admin+ | Validate and test unsaved `rules` against sample `text`. |

Template rules:

```json
{
  "keywords": ["TEST MART"],
  "threshold": 0.7,
  "sections": { "start": ["ΦΟΡΟΛΟΓΙΚΗ"], "end": ["^ΣΥΝΟΛΟ"] },
  "product": {
    "pattern": "^(?<name>.+?)\\s+(?<total>\\d+[.,]\\d{2})\\s+(?<rate>\\d{1,2})\\s*%$",
    "ignore": ["^ΣΑΚΟΥ", "^ΤΣ\\.?Π\\.?ΧΡ"]
  },
  "quantity": ["^(?<qty>\\d+)\\s*[x×]\\s*(?<unitPrice>\\d+[.,]\\d{2})$"],
  "weight": ["^(?<qty>\\d+(?:[.,]\\d+)?)\\s*(?<unit>kg|g|l|ml)\\s*[x×]\\s*(?<unitPrice>\\d+[.,]\\d{2})"],
  "discount": { "patterns": ["κπτωση", "discount"] },
  "savings": {
    "patterns": ["ΣΥΝΟΛΙΚΗ ΕΚΠΤΩΣΗ", "YOU SAVED", "TOTAL DISCOUNT"]
  },
  "tax": {
    "start": ["^ΦΠΑ"],
    "rowPattern": "^[A-ZΑ-Ω]\\s+(?<rate>\\d{1,2}(?:[.,]\\d+)?)\\s*%",
    "summaryPattern": "^ΣΥΝΟΛΟ(?=\\s|$)"
  },
  "total": { "pattern": "^ΣΥΝΟΛΟ(?=\\s|$)" }
}
```

Patterns are JavaScript regular expressions using named groups: `name`, `total`, `rate`; `qty`,
`unit`, `unitPrice`; `amount`; `net`, `tax`, `gross`. `LIDL_TEMPLATE_RULES` and
`SKLAVENITIS_TEMPLATE_RULES` are exposed as the built-in examples and can be cloned in the UI.
`discount` lines are folded into their product; `savings` lines are receipt-level totals (for example
`ΣΥΝΟΛΙΚΗ ΕΚΠΤΩΣΗ` or `YOU SAVED`) and are summed into `draft.savings` without becoming products.

Spending analytics response (`from`/`to` optional):

```json
{
  "range": { "from": "2025-11-03", "to": null },
  "totals": { "receipts": 12, "total": 486.2, "net": 392.1, "tax": 94.1, "average": 40.52 },
  "byVendor": [
    { "vendorId": "vnd_...", "vendorName": "Σκλαβενίτης", "receipts": 5, "total": 210.4, "net": 169.7, "tax": 40.7 }
  ],
  "monthly": [{ "month": "2026-10", "receipts": 2, "total": 80.1, "net": 64.6, "tax": 15.5 }],
  "taxRates": [{ "rate": 24, "net": 392.1, "tax": 94.1, "gross": 486.2 }],
  "byCategory": [{ "categoryId": "cat_...", "categoryName": "Food", "total": 300.5 }]
}
```

Net falls back to `total - tax`, or to `total` when no tax was recorded. Category totals use the
matched item's category; unlinked lines are reported as `Uncategorised`.

## Recipes

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/recipes` | viewer+ | List with ingredient coverage and nutrition estimates. Filters: `q`, `tag`, `favorite=1`. |
| `POST` | `/api/houses/:houseId/recipes` | member+ | Create a recipe. |
| `POST` | `/api/houses/:houseId/recipes/upload` | member+ | Upload a source image (`field: image`) and get `{ path }`. |
| `POST` | `/api/houses/:houseId/recipes/scan` | member+ | Parse OCR text and/or an image into a draft, optionally save. |
| `GET` | `/api/recipes/:recipeId` | viewer+ | Recipe detail with `match` (available/total/missing) and `nutrition`. |
| `PATCH` | `/api/recipes/:recipeId` | member+ | Partial update. |
| `DELETE` | `/api/recipes/:recipeId` | member+ | Delete a recipe. |
| `POST` | `/api/recipes/:recipeId/favorite` | member+ | Toggle or set `{ "favorite": true }`. |
| `POST` | `/api/recipes/:recipeId/ai` | member+ | Improve a recipe. Returns the updated recipe. |

Recipe body:

```json
{
  "title": "Gemista",
  "description": "Stuffed vegetables",
  "servings": 4,
  "prepMinutes": 30,
  "cookMinutes": 60,
  "tags": ["greek", "oven"],
  "steps": [
    { "text": "Hollow the tomatoes and peppers.", "timerSeconds": null },
    { "text": "Bake until tender.", "timerSeconds": 3600 }
  ],
  "ingredients": [
    { "name": "tomatoes", "quantity": 4, "unit": "pcs", "itemId": null, "optional": false, "note": null },
    { "name": "rice", "quantity": 200, "unit": "g", "itemId": "itm_...", "optional": false, "note": null }
  ],
  "source": "manual"
}
```

Scan body:

```json
{ "text": "OCR text from the browser", "image": "/uploads/recipes/....jpg", "title": "Yiayia's cake", "save": false }
```

Without `save`, the response contains `draft`. With `save: true`, it also contains `recipe`. The
response always includes `provider` (`ai` or `local`) and an optional `warning`.

Every serialized recipe also carries `nutrition`, derived at read time from the ingredients and the
nutrition panels of matching items:

```json
{
  "total": { "energyKcal": 1840, "fat": 62, "proteins": 48, "...": "..." },
  "perServing": { "energyKcal": 460, "...": "..." },
  "servings": 4,
  "ingredients": 9,
  "matched": 7,
  "coverage": 0.78
}
```

`matched` and `coverage` show how many ingredients could contribute. The estimate is null when no
ingredient matches an item with nutrition data. Ingredient amounts are converted between mass and
volume units; a count-based ingredient (`pcs`, `box`, `can`…) uses the item's `servingQuantity`.

## Food ideas

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/ideas` | viewer+ | Last 12 idea requests and their results. |
| `POST` | `/api/houses/:houseId/ideas` | member+ | Generate ideas from stock and recipes. |
| `POST` | `/api/ideas/:ideaId/save` | member+ | Save one idea as a recipe (`{ "index": 0 }`). |

Request body for generation:

```json
{ "prompt": "something quick", "maxTimeMinutes": 30, "dietary": ["vegetarian"] }
```

Response: `{ id, prompt, createdAt, provider: "ai"|"local", summary, ideas: [...] }`, plus `warning`
when the AI failed or is not configured.

## Photos and datasets

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/collections` | viewer+ | Folders with photo/labelled counts. |
| `POST` | `/api/houses/:houseId/collections` | member+ | Create a folder. |
| `PATCH` | `/api/houses/:houseId/collections/:collectionId` | member+ | Rename or change description. |
| `DELETE` | `/api/houses/:houseId/collections/:collectionId` | member+ | Delete a folder; photos become unfiled. |
| `GET` | `/api/houses/:houseId/labels` | viewer+ | Label names with counts. |
| `GET` | `/api/houses/:houseId/photos` | viewer+ | List photos. Filters: `collectionId`, `split`, `label`, `unlabeled=1`, `itemId`, `limit`, `offset`. |
| `POST` | `/api/houses/:houseId/photos` | member+ | Upload up to 30 images (`photos` field), plus `collectionId`, `split`, `itemId`, `meta` JSON. |
| `PATCH` | `/api/photos/:photoId` | member+ | Change folder, notes, split, item, dimensions or capture date. |
| `DELETE` | `/api/photos/:photoId` | admin+ | Delete the record and the file. |
| `POST` | `/api/photos/:photoId/labels` | member+ | Add one label/box. |
| `PUT` | `/api/photos/:photoId/labels` | member+ | Replace all labels (`{ "labels": [...] }`). |
| `DELETE` | `/api/photos/:photoId/labels/:labelId` | member+ | Delete one label. |
| `GET` | `/api/houses/:houseId/photos/export?format=yolo\|coco&collectionId=` | viewer+ | Download a dataset zip. |

Label body:

```json
{ "label": "tomato", "x": 0.12, "y": 0.2, "w": 0.3, "h": 0.25 }
```

Coordinates are fractions of the image (`0..1`). Omit all four to create a classification-only label.

Upload example:

```bash
curl -b cookies.txt \
  -F "photos=@one.jpg" -F "photos=@two.jpg" \
  -F "collectionId=col_xxx" -F "split=train" \
  http://localhost:8080/api/houses/hse_xxx/photos
```

Export sets `X-Photo-Count` and returns `application/zip` with images, labels, classes and manifest.
See the [user guide](user-guide.md#export-a-dataset) for the archive layout.

## Dashboard and notifications

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/dashboard` | viewer+ | Counts, value, low stock, expiring lots, recent movements, recipe and counts. |
| `GET` | `/api/houses/:houseId/notifications` | viewer+ | Active reminders. `unread=1`, `limit` up to 200. |
| `POST` | `/api/houses/:houseId/notifications/read` | viewer+ | Mark all or `{ "ids": [...] }` as read for the current user. |
| `POST` | `/api/houses/:houseId/notifications/scan` | viewer+ | Recompute low-stock and expiry reminders for the house. |
| `GET` | `/api/notifications` | user | Reminders from every house the caller belongs to, including house invitations. `unread=1`, `limit` up to 200. |
| `POST` | `/api/notifications/read` | user | Mark all or `{ "ids": [...] }` across houses as read. |

Joining a house — by accepting an invite or being added by an admin — creates a `house` notification
addressed to that user only. Other members do not see it.

## Insights

Mounted at `/api/houses/:houseId/insights`. Reads need `viewer`; changing settings needs `admin`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/spend?months=6` | Month-to-date spend, budget progress, monthly averages, spend by month, shop and category. Includes the house's insight settings. |
| `GET` | `/waste?months=6` | Value of `waste` stock movements by month and item. Cost is quantity times the weighted price of the batches. |
| `GET` | `/price-alerts` | Purchases in the last 45 days at least the threshold above the item's earlier average. |
| `POST` | `/price-alerts/scan` | Create in-app reminders for those alerts (one per item per month) and return `{ created, alerts }`. |
| `GET` | `/use-it-up?days=7` | Expiring lots grouped by item plus recipes that use them. Defaults to `useItUpDays` from settings. |
| `GET` | `/shopping-prices` | Best recent unit price and shop for each open shopping-list line. |
| `GET` | `/household` | Per-member `paid`, `share` and `balance`, settle-up transfers, and the recent receipts used. |
| `PATCH` | `/settings` | Set `{ monthlyBudget, priceAlertPercent, useItUpDays }`; stored in the house settings. |

Receipts accept `paidBy` and `splitWith` on import, and `PATCH /api/receipts/:receiptId` changes them
later. An empty `splitWith` means everyone currently in the house.

`POST /api/houses/:houseId/receipts/e-receipt/parse` takes `{ text }` (plain receipt text or e-invoice
JSON) and returns `{ format, draft, reconciliation, currency }`. It writes nothing; post the draft to
`/receipts` to import it.

## API tokens

Mounted at `/api/tokens`, session-authenticated.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Tokens for the caller (never the secret). |
| `POST` | `/` | `{ name }`; returns the token once as `token`. Maximum 20 per user. |
| `DELETE` | `/:id` | Revoke one token. |

Tokens are stored as SHA-256 hashes, authenticate as `Authorization: Bearer svt_...`, and are read-only.

## Admin console

Mounted at `/api/admin`. Every route requires the instance administrator (`403` otherwise).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/overview` | Counts of people, houses, sessions and pending invites, orphaned uploads, AI spend and registration mode. |
| `GET` | `/users?q=` | People with house/session counts and last session. |
| `PATCH` | `/users/:id` | `{ isAdmin, developerMode }`. You cannot demote yourself or remove the last admin. |
| `GET` | `/sessions` | Active sessions with user and device. |
| `DELETE` | `/sessions/:id` | End one session. |
| `GET` | `/registration` | Effective mode, its source, the admin override and the environment value. |
| `PATCH` | `/registration` | `{ mode: "open" \| "invite" \| "closed" \| "environment" }`. `environment` removes the override. |
| `GET` | `/files` | Orphaned uploads older than a day (largest first). |
| `POST` | `/files/sweep` | Delete them. |
| `GET` | `/ai?days=30` | AI calls and cost by house and by operation, plus the monthly budget and spend. |
| `PATCH` | `/ai/budget` | `{ monthlyBudget }` in USD. `0` removes the limit. Once reached, AI endpoints return `429`. |

## Utility

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | public | `{ ok: true, version, time }`; used by Docker health checks. |
| `GET` | `/uploads/<kind>/<file>` | public | Static uploaded image. Unauthenticated by design. Served with `nosniff` and a sandboxing CSP; anything that is not an image extension is sent as a download. |

## Shopping list

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/shopping` | viewer+ | Open lines and checked lines. `?checked=0` hides checked. |
| `POST` | `/api/houses/:houseId/shopping` | member+ | Add a manual line. |
| `PATCH` | `/api/houses/:houseId/shopping/:entryId` | member+ | Edit name, quantity, unit, item, note or `checked`. |
| `DELETE` | `/api/houses/:houseId/shopping/:entryId` | member+ | Remove a line. |
| `DELETE` | `/api/houses/:houseId/shopping?checked=1` | member+ | Clear checked lines (omit the query to clear all). |
| `POST` | `/api/houses/:houseId/shopping/from-recipe` | member+ | Add missing (default) or all ingredients. Body: `{ recipeId, includeOptional?, missingOnly? }`. |
| `POST` | `/api/houses/:houseId/shopping/from-low-stock` | member+ | Add every item at or below its reorder point, up to `targetStock` (or twice the reorder point). |
| `POST` | `/api/houses/:houseId/shopping/:entryId/check` | member+ | Check a line and optionally record a normal `in` movement. |

Lines merge by linked `itemId` first, then by normalised name. Compatible units are summed; incompatible
units stay as separate lines. Every generated line carries a source key (`recipe:…`, `low:…`, `plan:…`)
and a `shopping_list_sources` row, so repeating the same action is idempotent.

Check body:

```json
{
  "quantity": 2,
  "unit": "l",
  "unitPrice": 1.49,
  "locationId": "loc_...",
  "expiresAt": "2026-12-01",
  "itemId": "itm_...",
  "addStock": true
}
```

`addStock: false` marks the line bought without touching inventory. Otherwise the unit is converted to the
item's base unit and the movement is recorded by the stock engine.

## Meal planner

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/plan?week=YYYY-MM-DD` | viewer+ | Week entries; any date in the week resolves to Monday–Sunday. |
| `POST` | `/api/houses/:houseId/plan` | member+ | Add a recipe, saved food idea or custom title to a slot. |
| `PATCH` | `/api/houses/:houseId/plan/:entryId` | member+ | Move, retitle, change servings or swap the recipe/idea. |
| `POST` | `/api/houses/:houseId/plan/:entryId/duplicate` | member+ | Copy to the next day (or `{ day, slot }`). |
| `DELETE` | `/api/houses/:houseId/plan/:entryId` | member+ | Remove an entry. |
| `POST` | `/api/houses/:houseId/plan/shopping-list` | member+ | Aggregate the week's missing ingredients into the shopping list. |

Entry body:

```json
{ "day": "2026-11-02", "slot": "dinner", "recipeId": "rcp_...", "servings": 6 }
```

Slots are `breakfast`, `lunch`, `dinner` and `snack`. `servings` scales ingredient quantities at read time;
the recipe itself is never modified. The shopping list merges identical ingredients across the week,
subtracts stock once per ingredient, and uses the plan week as the idempotency key.

## Bulk intake

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/houses/:houseId/intake/upload` | member+ | Upload a receipt image (`field: image`), returns `{ path }`. |
| `POST` | `/api/houses/:houseId/intake/parse` | member+ | Parse `{ text?, image?, candidates?, preferAi?, barcodes? }` and return review rows. AI is used only when requested. Never writes. |
| `POST` | `/api/houses/:houseId/intake/commit` | member+ | Validate and apply reviewed rows atomically. |

`parse` returns `provider` (`ai`, `local`, `template`, `barcode`), a warning and rows. Each row contains
`description`, `quantity`, `unit`, `unitPrice`, `barcode`, `itemId`, candidate matches and an initial
`action`. Barcode mode also looks up OpenFoodFacts for unknown codes. No item, stock or receipt row is
written during parsing.

Commit body:

```json
{
  "rows": [
    { "description": "Milk", "quantity": 2, "unit": "l", "unitPrice": 1.49, "itemId": "itm_...", "action": "update" },
    { "description": "Bread", "quantity": 1, "unit": "pcs", "barcode": "520...", "action": "create" }
  ]
}
```

Rows are validated first (unit conversion, duplicate barcodes, item ownership, places). If any row fails,
nothing is written and the response details include the offending row indexes. Valid rows commit in one
transaction and use `addStock`, so prices are normalised to the item base unit.

## CSV import

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/houses/:houseId/import/csv/preview` | member+ | Parse and validate a CSV without writing. |
| `POST` | `/api/houses/:houseId/import/csv/commit` | member+ | Re-validate and import in one transaction. |

Body: `{ "csv": "Name;Unit...", "mapping"?: { "name": "Product", ... }, "mode"?: "create" | "update" }`.
`mapping` keys are `name`, `brand`, `category`, `place`, `unit`, `quantity`, `reorderPoint`, `targetStock`,
`price`, `barcodes` and `attributes`; values are header names. Missing mapping is auto-detected.

The parser accepts comma or semicolon delimiters, quoted fields, a UTF-8 BOM, CRLF and decimal commas.
The preview reports `create`, `update`, `skip` and per-line `errors`/`warnings` with line numbers.

- `create` only creates new items; rows matching an existing barcode or exact name are skipped.
- `update` matches by barcode first, then by exact name; unmatched rows are created.
- Ambiguous name matches are skipped with a warning.
- Imported quantities become normal `in` movements with the same unit conversion as the stock engine.
- Unknown units, duplicate barcodes and missing names are reported per row; any error blocks the commit.

## Ownership transfer

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/houses/:houseId/members/:userId/transfer-ownership` | owner | Promote a member to owner and demote the caller to admin. |

Body: `{ "houseName": "The house name" }` or `{ "password": "..." }`. Self-transfer is rejected, the
target must already be a member, and the two role updates run in one transaction that asserts exactly one
owner. The new owner receives an in-app notification; the former owner can leave the house afterwards.

## Reminder delivery

Reminder channels live in `house.settings.notifications.channels`. Secrets are masked as `***` in every
API response, and sending `***` back preserves the stored value.

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/houses/:houseId/notifications/test` | admin+ | Send a real test message. Body: `{ channelId }` or an unsaved `{ channel }`. |
| `GET` | `/api/houses/:houseId/reminder-deliveries` | admin+ | Recent delivery attempts, statuses, HTTP codes and errors. |

Channel shape:

```json
{
  "id": "ch_...",
  "type": "ntfy",
  "name": "Phone",
  "enabled": true,
  "url": "https://ntfy.sh",
  "topic": "svault-home",
  "token": "***",
  "events": { "lowStock": true, "expiring": true, "weeklySummary": false }
}
```

`ntfy` posts to `url/topic` with an optional bearer token. `apprise` posts JSON to the configured endpoint
with an optional `x-api-key`. Webhooks receive
`{ event, title, body, houseId, houseName, data, sentAt }` and, when a secret is set, an
`x-svault-signature: sha256=…` header. Delivery is detached from the triggering request, deduped per
notification key and channel, and retried three times with backoff. Resolved reminders are not re-sent.
The weekly summary runs from the reminder scan once per ISO week when at least one channel enables it.

## Two-factor authentication

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/auth/2fa` | user | `{ enabled, configured, backupCodesRemaining }`. |
| `POST` | `/api/auth/2fa/setup` | user | Confirm password, return `{ secret, otpauth }`. |
| `POST` | `/api/auth/2fa/enable` | user | Verify a 6-digit code and return 8 backup codes. |
| `POST` | `/api/auth/2fa/disable` | user | Confirm password and a current TOTP/backup code. |
| `POST` | `/api/auth/2fa/backup-codes` | user | Regenerate backup codes after password + code confirmation. |
| `POST` | `/api/auth/2fa/verify` | public | Exchange `{ challenge, code }` for a session cookie. |

When 2FA is enabled, `POST /api/auth/login` returns
`{ twoFactorRequired: true, challenge }` and **does not** set a session cookie. The challenge expires
after five minutes. A wrong code does not consume it, but after five wrong codes the challenge is
deleted and the password has to be entered again. A TOTP code is accepted once: a code from the same or
an earlier 30-second step than the last accepted one is rejected. Backup codes are stored hashed and
consumed once.

## Passkeys (WebAuthn)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/auth/passkeys` | user | List passkeys and the RP ID/origin. |
| `POST` | `/api/auth/passkeys/options` | user | Registration options + `challengeId`. |
| `POST` | `/api/auth/passkeys/verify` | user | Verify `{ challengeId, response, name? }`. |
| `DELETE` | `/api/auth/passkeys/:passkeyId` | user | Remove one passkey. |
| `DELETE` | `/api/auth/passkeys/user/:userId` | owner/admin | Reset another user's passkeys. |
| `POST` | `/api/auth/passkeys/login/options` | public | Authentication options; body `{ identifier? }`. |
| `POST` | `/api/auth/passkeys/login/verify` | public | Verify `{ challengeId, response }`, set a session. |

Registration/authentication responses are the standard WebAuthn JSON from `@simplewebauthn/browser`.
Challenges are stored server-side with a five-minute expiry and deleted after use. The relying party
comes from `RP_ID` / `ORIGIN`, falling back to the request host. Counters are persisted and a
non-advancing counter is rejected as a replay. Passkeys still require HTTPS or localhost.

## OIDC single sign-on

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/auth/oidc/status` | public | `{ enabled, label }`; never returns secrets. |
| `GET` | `/api/auth/oidc/start` | public | Start the authorization-code flow with PKCE, state and nonce. |
| `GET` | `/api/auth/oidc/callback` | public | Validate the response, link/provision the user and set a session. |

Configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, optional `OIDC_REDIRECT_URI`,
`OIDC_ALLOWED_DOMAINS`, `OIDC_AUTO_PROVISION` and `OIDC_DEFAULT_HOUSE_ID`. Only verified email addresses
are accepted. Existing users are linked by email; new users are provisioned only when
`OIDC_AUTO_PROVISION` is on and registration is `open` (`SV_REGISTRATION`). Password login
and the first local owner remain as the break-glass path. Errors redirect to `/login?oidc_error=...`.

## Offline stock mutations

`POST /api/items/:itemId/stock` accepts an optional `idempotencyKey` (8–120 chars). The response is stored
in `stock_mutations`; replaying the same key returns the original response without applying the change
again. For absolute counts, send `baseUpdatedAt`; if the item was changed later the server returns `409`
with `details: { conflict, currentUpdatedAt, currentQuantity }` so the client can resolve it.

## Backup and restore

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/backup` | instance admin, member of the house | Download a zip with `svault.db`, `uploads/` and `manifest.json`. |
| `GET` | `/api/houses/:houseId/backups` | instance admin, member of the house | List retained local backups (last five). |
| `POST` | `/api/houses/:houseId/restore` | instance admin, member of the house | Upload `backup` plus `houseName` or `password`. At most `SV_RESTORE_MAX_MB` (512). |

A backup contains every house and account on the instance, so these endpoints answer `403` for anyone
but the instance administrator, whatever their house role. The check runs before the upload is read.

The snapshot uses `VACUUM INTO`, runs while the server is live, and is checked with
`PRAGMA integrity_check`. The manifest records the app version, schema version, counts and SHA-256
checksums for the database and every upload. Restore rejects unsafe zip paths, checksum failures and
archives from a newer schema, keeps a pre-restore copy, then stages the archive and restarts the server.
During the swap API requests return `503`.

The download is streamed from the finished zip on disk. `GET …/backups` returns
`{ backups: [{ name, kind, size, createdAt }] }`, newest first, where `kind` is `backup` (regular, last
five in `DATA_DIR/backups`) or `pre-restore` (safety copies in `DATA_DIR/backups/pre-restore`, rotated
separately, newest three by default via `SV_PRE_RESTORE_KEEP`).

CLI (stop the server first for restore):

```bash
npm run backup -- --out svault-backup.zip
npm run restore -- --in svault-backup.zip
```

## Dataset import and review

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/houses/:houseId/photos/dataset/preview` | member+ | Inspect a YOLO/COCO zip without writing. |
| `POST` | `/api/houses/:houseId/photos/dataset/import` | member+ | Import images, boxes, classes and splits. Zips up to `SV_DATASET_MAX_MB` (256). |
| `GET` | `/api/houses/:houseId/photos/review` | viewer+ | Unlabelled and classification-only review queue. |
| `POST` | `/api/houses/:houseId/photos/labels/bulk` | member+ | Rename, merge or delete a label across the house. |
| `POST` | `/api/houses/:houseId/photos/splits` | member+ | Bulk reassign train/val/test/unassigned. |
| `POST` | `/api/houses/:houseId/photos/delete-bulk` | admin+ | Delete selected photos and files. |

The importer accepts `images/` + `labels/` + `classes.txt`/`data.yaml`, or `images/` + a COCO
`annotations.json`/`instances*.json`. It validates zip paths, converts YOLO normalised boxes and COCO
absolute boxes to SVault's format, preserves train/val/test folders, reports per-file errors, and lets the
caller map class names (or `__skip`) before writing. Rounds back to the existing YOLO/COCO exporter.

## Language

`PATCH /api/auth/me` accepts `{ "language": "en" | "el" }`. The stored preference is returned on `user`
and drives the client dictionary and `Intl` date/number/currency formatting.

## Status codes

| Code | Meaning |
| --- | --- |
| `200` | Success |
| `201` | Created (house, item, recipe, upload, label) |
| `400` | Validation error, bad unit conversion, insufficient stock, an upload above `MAX_UPLOAD_MB`, or a file that is not a supported image (JPEG, PNG, WebP, GIF, AVIF, HEIC, BMP, TIFF; checked by content) |
| `401` | Not signed in |
| `403` | Signed in but below the required role, registration closed, or a blocked cross-site request |
| `404` | Resource not found or not visible to this user |
| `409` | Conflict (duplicate email, barcode already linked) |
| `429` | Rate limited; wait for `Retry-After` seconds |
| `413` | Reverse proxy body limit (raise `client_max_body_size`) |
| `500` | Unexpected server error (details are logged, not returned) |
| `502` | Upstream AI provider or reminder channel test failed |

## Extending the API

If you add an endpoint:

1. Mount it on the correct router and use `requireAuth` plus `requireHouse(req, minRole)`.
2. Validate the body with Zod through `parseBody`.
3. Put stock changes in `server/services/stock.ts`, not in the route.
4. Return the same serialized shapes as the existing endpoints (`server/serialize.ts`).
5. Add a test in `server/tests/api.test.ts` and update this page.

See [development.md](development.md) for the workflow.
