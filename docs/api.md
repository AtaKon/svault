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
| `POST` | `/register` | public | Create an account; first user becomes instance admin. Accepts an optional `username`, `inviteCode`, or creates a house. |
| `POST` | `/login` | public | Email **or** username + password; sets the session cookie. |
| `POST` | `/logout` | any | Deletes the current session and clears the cookie. |
| `GET` | `/me` | user | Current user plus all houses with roles. |
| `PATCH` | `/me` | user | Change `name`, `email` and/or `username`. |
| `POST` | `/me/password` | user | Requires `currentPassword`; rotates every session and issues a new cookie. |
| `GET` | `/invites/:code` | public | Preview an invite (house name, role, inviter). Does not accept it. |
| `POST` | `/invites/:code/accept` | user | Join the house if the invite is valid and the email matches. |

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

`POST /api/auth/login` and `/register` return:

```json
{
  "user": { "id": "usr_...", "email": "alex@example.com", "username": "alex", "name": "Alex", "isAdmin": false, "createdAt": "..." },
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
| `POST` | `/:houseId/ai/test` | admin+ | Send a ping to the configured provider. |
| `GET` | `/:houseId/members` | viewer+ | List members. |
| `POST` | `/:houseId/members` | admin+ | Add an existing user by email, or create an invite for a new one. |
| `PATCH` | `/:houseId/members/:userId` | owner | Change a role (`admin`, `member` or `viewer`). Ownership transfer is not implemented yet ([#16](https://github.com/AtaKon/svault/issues/16)). |
| `DELETE` | `/:houseId/members/:userId` | admin+ | Remove a member. Only the owner can remove an admin. |
| `GET` | `/:houseId/invites` | admin+ | List invites with codes and URLs. |
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
OpenFoodFacts product (`code`, `name`, `brand`, `genericName`, `quantity`, `categories`, `image`,
`ingredients`, `allergens`, `labels`, `nutriscore`, `novaGroup`, `countries`, `packaging`,
`servingSize`, `nutrition`) and `item` is null. `nutrition` is the parsed per-100 panel, or null when
the product has no nutrition data.

## OpenFoodFacts catalogue

Barcode scans and receipt imports enrich inventory from OpenFoodFacts. Products are cached in a
shared `catalog_products` table for `OFF_CACHE_DAYS` (default 30). Receipt text mappings live in
`catalog_mappings`: bundled seed rows ship in `assets/catalog/off-mappings.json`, mappings learned on
the instance are `local`, and imported files are `community`. A local mapping is never overwritten by
a seed file or import.

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/catalog/search?q=...` | signed in | Search the cache, then OpenFoodFacts. `online=0` skips the network; `limit` 1-20. |
| `GET` | `/api/catalog/product/:code` | signed in | Cached or live product. `full=1` adds the stored OFF payload. |
| `GET` | `/api/catalog/resolve?raw=...` | signed in | Best shared mapping for a raw receipt line. |
| `GET` | `/api/catalog/mappings` | signed in | List/search shared mappings (`q`, `limit` 1-500). |
| `GET` | `/api/catalog/stats` | instance admin | Mapping and cache counts plus the configured sync URL. |
| `GET` | `/api/catalog/export` | instance admin | Download the catalogue JSON (includes local mappings and raw receipt text). |
| `POST` | `/api/catalog/import` | instance admin | Merge `{ "version": 1, "mappings": [...] }`. Local rows are skipped. |
| `POST` | `/api/catalog/sync` | instance admin | Download and merge `SV_CATALOG_URL`, or a `{ "url": "https://..." }` override. |

Linking an item returns `{ item, product, filled, skipped }`. `filled` lists the first-class fields
that were blank and are now populated (name, description, brand, image, category); `skipped` explains
values that were kept. Existing values are never overwritten.

Receipt imports accept `offCode` per line. When a line also has a printed `barcode`, the barcode wins;
otherwise the shared catalogue resolves the raw text. Line responses expose `offCode`.

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
| `POST` | `/api/houses/:houseId/receipts` | member+ | Import lines as stock and save the receipt. |
| `POST` | `/api/houses/:houseId/receipts/upload` | member+ | Upload a receipt photo (`field: image`) and get `{ path }`. |
| `POST` | `/api/houses/:houseId/receipts/scan` | member+ | Parse OCR text and/or an image into a receipt draft. |
| `GET` | `/api/receipts/:receiptId` | viewer+ | Receipt with its lines and linked item names. |
| `DELETE` | `/api/receipts/:receiptId` | member+ | Delete the receipt record. Stock and price history stay. |

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

Scan body (same AI/local fallback behaviour as recipe scans):

```json
{ "text": "OCR text from the browser", "image": "/uploads/receipts/....jpg" }
```

Response:

```json
{
  "provider": "template",
  "warning": null,
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
`discount` and `barcode`. The receipt stores `provider` so clients can show whether AI was used.

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
  "templateId": "lidl-gr",
  "templateConfidence": 0.99,
  "provider": "template",
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
    { "description": "Sourdough bread", "quantity": 1, "unitPrice": 3.1, "lineTotal": 3.1, "locationId": "loc_..." }
  ]
}
```

Use `vendorId` instead of `vendorName` to pick an existing shop; an unknown `vendorName` creates one.
A line may set `itemId` to force a match, `barcode` to match by barcode, or `offCode` to link the
created item to an OpenFoodFacts product. A printed `barcode` is tried before `offCode` for the
OpenFoodFacts lookup, and the shared catalogue fills gaps when neither is present. Without any of
these, the server matches an item by name (with a conservative loose match) and otherwise creates a
new item using the line's unit. Incompatible units are rejected with a 400 before anything is written.
Every imported line creates a normal `in` movement carrying `vendorId` and `receiptId`; delete the
receipt later without touching stock.

If `rawDescription` is supplied, the resolved item is remembered as a vendor-specific product alias.
The next receipt from that shop resolves the same abbreviation to the same item. Correcting a line in
the UI therefore trains the mapping without a separate training step.

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

## Utility

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | public | `{ ok: true, version, time }`; used by Docker health checks. |
| `GET` | `/uploads/<kind>/<file>` | public | Static uploaded image. Unauthenticated by design. |

## Status codes

| Code | Meaning |
| --- | --- |
| `200` | Success |
| `201` | Created (house, item, recipe, upload, label) |
| `400` | Validation error, bad unit conversion, insufficient stock, or an upload above `MAX_UPLOAD_MB` |
| `401` | Not signed in |
| `403` | Signed in but below the required role |
| `404` | Resource not found or not visible to this user |
| `409` | Conflict (duplicate email, barcode already linked) |
| `413` | Reverse proxy body limit (raise `client_max_body_size`) |
| `500` | Unexpected server error (details are logged, not returned) |
| `502` | Upstream AI provider failed |

## Extending the API

If you add an endpoint:

1. Mount it on the correct router and use `requireAuth` plus `requireHouse(req, minRole)`.
2. Validate the body with Zod through `parseBody`.
3. Put stock changes in `server/services/stock.ts`, not in the route.
4. Return the same serialized shapes as the existing endpoints (`server/serialize.ts`).
5. Add a test in `server/tests/api.test.ts` and update this page.

See [development.md](development.md) for the workflow.
