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
| `POST` | `/register` | public | Create an account; first user becomes instance admin. Accepts `inviteCode` or creates a house. |
| `POST` | `/login` | public | Email + password; sets the session cookie. |
| `POST` | `/logout` | any | Deletes the current session and clears the cookie. |
| `GET` | `/me` | user | Current user plus all houses with roles. |
| `PATCH` | `/me` | user | Change `name` and/or `email`. |
| `POST` | `/me/password` | user | Requires `currentPassword`; rotates every session and issues a new cookie. |
| `GET` | `/invites/:code` | public | Preview an invite (house name, role, inviter). Does not accept it. |
| `POST` | `/invites/:code/accept` | user | Join the house if the invite is valid and the email matches. |

Register body:

```json
{
  "name": "Alex",
  "email": "alex@example.com",
  "password": "at-least-8-characters",
  "houseName": "Alex's Home",
  "inviteCode": "optional-code"
}
```

`POST /api/auth/login` and `/register` return:

```json
{
  "user": { "id": "usr_...", "email": "alex@example.com", "name": "Alex", "isAdmin": false, "createdAt": "..." },
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
| `PATCH` | `/:houseId/members/:userId` | owner | Change a role. Ownership can only be taken by yourself. |
| `DELETE` | `/:houseId/members/:userId` | admin+ | Remove a member. Only the owner can remove an admin. |
| `GET` | `/:houseId/invites` | admin+ | List invites with codes and URLs. |
| `DELETE` | `/:houseId/invites/:inviteId` | admin+ | Revoke an invite. |
| `POST` | `/:houseId/leave` | viewer+ | Leave the house. The owner must transfer ownership first. |

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

Attribute types: `text`, `number`, `select`, `date`, `boolean`, `url`.

## Inventory

### Items

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/items` | viewer+ | List/search items. |
| `POST` | `/api/houses/:houseId/items` | member+ | Create an item, optional barcodes and initial stock. |
| `GET` | `/api/houses/:houseId/scan?code=...` | viewer+ | Resolve a barcode in this house, then OpenFoodFacts. |
| `GET` | `/api/items/:itemId` | viewer+ | Item detail: lots, movements, price history, linked recipes. |
| `PATCH` | `/api/items/:itemId` | member+ | Update fields or `archived`. |
| `DELETE` | `/api/items/:itemId` | member+ | Delete the item, its batches and barcodes. Recipes stay. |
| `POST` | `/api/items/:itemId/stock` | member+ | Add, remove, waste, set or move stock. |
| `GET` | `/api/items/:itemId/movements` | viewer+ | Movement ledger (`limit` 1-300, default 50). |
| `POST` | `/api/items/:itemId/image` | member+ | `multipart/form-data` field `image`. |
| `POST` | `/api/items/:itemId/barcodes` | member+ | Attach `{ "code": "...", "format": "ean13" }`. |
| `DELETE` | `/api/items/:itemId/barcodes/:barcodeId` | member+ | Detach a barcode. |

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
  "barcodes": ["5201234567890"],
  "initialStock": {
    "quantity": 750,
    "unit": "ml",
    "unitPrice": 6.9,
    "locationId": "loc_...",
    "purchasedAt": "2026-10-30",
    "expiresAt": "2028-10-30",
    "note": "Gift"
  }
}
```

Stock action body:

```json
{ "action": "add", "quantity": 500, "unit": "ml", "unitPrice": 0.8, "locationId": "loc_...", "expiresAt": "2026-12-01" }
{ "action": "remove", "quantity": 200, "unit": "ml", "note": "Dinner" }
{ "action": "waste", "quantity": 100, "reason": "Spoiled" }
{ "action": "set", "target": 1.5, "unit": "l" }
{ "action": "move", "quantity": 2, "fromLocationId": "loc_a", "toLocationId": "loc_b" }
```

Every successful stock action returns the complete item detail.

Barcode scan response:

```json
{ "code": "5201234567890", "match": "local", "item": { "...": "..." }, "product": null }
```

`match` is `local`, `external` or `none`. For `external`, `product` contains the OpenFoodFacts
suggestion (name, brand, quantity, image, categories) and `item` is null.

## Recipes

| Method | Path | Min role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/houses/:houseId/recipes` | viewer+ | List with ingredient coverage. Filters: `q`, `tag`, `favorite=1`. |
| `POST` | `/api/houses/:houseId/recipes` | member+ | Create a recipe. |
| `POST` | `/api/houses/:houseId/recipes/upload` | member+ | Upload a source image (`field: image`) and get `{ path }`. |
| `POST` | `/api/houses/:houseId/recipes/scan` | member+ | Parse OCR text and/or an image into a draft, optionally save. |
| `GET` | `/api/recipes/:recipeId` | viewer+ | Recipe detail with `match` (available/total/missing). |
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
| `400` | Validation error, bad unit conversion, insufficient stock |
| `401` | Not signed in |
| `403` | Signed in but below the required role |
| `404` | Resource not found or not visible to this user |
| `409` | Conflict (duplicate email, barcode already linked) |
| `413` | Upload exceeds `MAX_UPLOAD_MB` |
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
