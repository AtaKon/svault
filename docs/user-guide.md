# User guide

This guide walks through SVault from the first login to a populated vault. It assumes SVault is
already running; if not, follow the [quick start](../README.md#quick-start-docker) or the
[deployment guide](deployment.md).

![Desktop dashboard](screenshots/desktop-dashboard.png)

## 1. First login

Open the URL printed by your deployment (for example `http://localhost:8080`).

1. Create an account with your name, email and a password of at least 8 characters.
2. The first account becomes the instance administrator and the **owner** of a new house named
   after you.
3. Houses come with sensible default places (Kitchen, Pantry, Fridge, Freezer...), categories and a
   few attributes. Rename or delete anything you do not need.

If the deployment was started with `SEED_DEMO=true`, you can sign in with the demo accounts instead:

```
demo@svault.local / demo1234
sofia@svault.local / demo1234
```

Demo data is only created when the database is empty. It never overwrites real data.

## 2. Houses, people and roles

A **house** is the unit of isolation. Every item, stock movement, recipe and photo belongs to
exactly one house. A user can belong to several houses and switch between them from the sidebar or
the **More** page.

Open **More -> House settings -> Members** to invite people.

| Role | Can do |
| --- | --- |
| **Viewer** | Read everything in the house, mark reminders as read, download exports |
| **Member** | Everything a viewer can, plus create/edit items, change stock, manage places and categories, create recipes and ideas, label photos |
| **Admin** | Everything a member can, plus house settings, attributes, AI and reminder settings, invites, member management, deleting places/categories |
| **Owner** | Everything an admin can, plus delete the house and manage other admins |

Notes:

- A house has one owner. Ownership transfer is not implemented yet
  ([#16](https://github.com/AtaKon/svault/issues/16)); until it lands, the owner cannot be demoted or
  removed, and cannot leave without deleting the house.
- Invites are links, not emails. Create an invite, copy `/join/<code>` and send it yourself. If you
  enter an email address, only that address can accept it.
- Revoked invite links stop working immediately. Invites do not expire automatically; revoke them in
  **Settings -> Members** when they are no longer needed.
- There is no password-reset email. The owner can reset a password from the database or you can
  re-seed a fresh volume. This is a deliberate self-hosted trade-off.

## 3. Inventory concepts

SVault separates four ideas that most inventory apps mix together:

- **Item** - the product or thing ("Olive oil", "AA batteries"). It has a name, category, base unit,
  reorder point, target stock, optional attributes, tags and barcodes.
- **Batch (lot)** - one purchase of that item. Each batch has its own quantity, location, purchase
  date, expiry date and unit price. Two bottles of oil bought on different days are two batches.
- **Movement** - an immutable ledger entry describing a change: in, out, waste, count (adjust) or
  move. Movements store the balance after the change.
- **Place** - where a batch physically is (Pantry, Garage shelf, Cabin). Places can be nested.

The quantity shown on an item is the sum of its batches. Value is the sum of
`quantity x unit price` where a price is known.

### Units

Units are grouped into mass, volume and countable units:

| Family | Units |
| --- | --- |
| Mass | `mg`, `g`, `kg`, `oz`, `lb` |
| Volume | `ml`, `cl`, `dl`, `l`, `tsp`, `tbsp`, `cup`, `floz`, `pint`, `qt` |
| Count | `pcs`, `pc`, `pack`, `box`, `bottle`, `can`, `jar`, `bag`, `roll`, `pair`, `set`, `dozen` |

An item has one **base unit**. Stock can be entered in any compatible unit and is converted before it
is stored. For example, adding `500 ml` to an item whose base unit is `l` stores `0.5 l`. You cannot
convert mass to volume; SVault rejects it instead of guessing a density.

Count aliases (`pack`, `box`...) are treated as one piece because their real contents are unknown.
If the pack size matters, create the item in `g`, `ml` or `pcs` and enter the true amount.

### Prices

Record a unit price whenever you add stock. SVault normalises it to the item's base unit:

- `500 ml` for 0.80 EUR becomes `1.60 EUR/l` on the price chart.
- The item page shows the latest, average, minimum and maximum per-unit price and the change since
  the previous purchase.
- Price history is derived from purchase movements. Editing or deleting movements later can change
  the chart.

## 4. Everyday inventory tasks

### Add an item

1. **Inventory -> New item** (or the `+` button).
2. Enter a name, choose a category and base unit.
3. Optionally set a reorder point, target stock, brand, attributes, tags and barcodes.
4. You can add an initial batch at the same time: quantity, price, place, purchase date and expiry.

Attributes are defined per house in **Settings -> Attributes**. Supported types are text, number,
select, date, boolean and URL.

### Change stock

Open an item and use the stock dialog. There are five actions:

| Action | What it does |
| --- | --- |
| **Add** | Creates a new batch. Optionally records unit price, place, purchase date and expiry. |
| **Remove** | Consumes stock FIFO: soonest expiry first, then oldest purchase. |
| **Waste** | Same as remove, but records a `waste` movement so waste is visible separately. |
| **Set** | Absolute count. SVault records the difference as an adjustment; use this after a physical count. |
| **Move** | Transfers quantity between two places without changing the total. |

Removing more than is available is rejected. Wasting or removing with a `locationId` restricts FIFO to
that place.

### Barcodes and scanning

- Each item can hold several barcodes, unique per house.
- **Scan** opens the rear camera (ZXing). On plain HTTP or a browser without camera support, type the
  code instead.
- A known code opens the matching item.
- An unknown code is looked up on OpenFoodFacts. If found, the name, brand, quantity and image
  pre-fill the new-item form. The lookup times out after six seconds, so offline use still works.
- You can also scan from an item page to attach a code to an existing item.

### Low stock and expiry

- An item is low when its quantity is at or below its reorder point. Set the reorder point to `0` to
  disable the reminder for that item.
- Expiry reminders cover batches with quantity left whose expiry is within the configured number of
  days (7 by default). Expired batches are flagged separately.
- Reminders are recalculated after every stock change and by a scan at boot and every 30 minutes.
- **Reminders** shows the active list. Press the bell icon to enable browser notifications; they only
  arrive while SVault is open in a tab. See [roadmap](roadmap.md) for external delivery.

### Search, filters and bulk actions

The inventory page supports free-text search, category and place filters, low-stock and expiring
filters, sorting by value, and inline `+/-` one-unit adjustments. The dashboard repeats the most
useful slices: running low, use-it-up (expiring), places and recent activity.

## 5. Recipes

### Add a recipe manually

**Kitchen -> New recipe**. Ingredients have a name, optional quantity and unit, an optional link to an
inventory item, and an optional/required flag. Steps are free text; a timer can be attached to a step.

### Scan a handwritten recipe

1. **Kitchen -> Scan recipe**.
2. Photograph the card. The image is compressed in the browser and uploaded as the source image.
3. Tesseract OCR runs **in the browser** using assets served from `/tesseract`. The image and the OCR
   text are not sent to an AI provider unless a vision model is configured.
4. Correct the recognised text if needed and press **Digitise**.
5. The server cleans the text:
   - with an AI provider, it returns structured ingredients and steps and notes any inferences;
   - without one, a local parser handles sections, quantities, fractions, ranges and timers.
6. Review the draft, edit anything, then save.

The recipe records which path was used (AI or local) and keeps the OCR text for reference.

### Improve with AI

Open a saved recipe and press **Improve with AI**. The action fills missing quantities, times and
temperatures and rewrites unclear steps, noting what changed. It requires a configured provider and
member access.

### Cook from what you have

Every recipe shows ingredient availability against current stock. Matching is deliberately loose:
"eggs" matches "Free-range eggs". Missing ingredients are listed with quantities, which is the input
for the planned shopping list.

### Food ideas

**Food ideas** sends your prompt, current stock and saved recipes to the AI, or to the local matcher
when no provider is configured. Local suggestions rank saved recipes by ingredient coverage and add
inventory-only ideas. Saving an idea creates a normal recipe tagged `ai` and `idea`.

Nothing about stock, barcodes, prices or reminders is sent to an AI provider.

## 6. Photo library and vision datasets

![Photo labelling](screenshots/desktop-photo-label.png)

### Folders and uploads

- Photos live in **collections** (folders) per house.
- Upload up to 30 images at once, up to `MAX_UPLOAD_MB` each (20 MB by default).
- Supported formats depend on the browser, but uploads are stored unchanged. JPEG, PNG, WebP, GIF,
  AVIF, HEIC/HEIF, BMP and TIFF are accepted by the server.

### Labels and boxes

- Drag on a photo to draw a bounding box, then type or pick a label. Boxes are stored as fractions of
  the image size, so they survive resizing.
- A label without a box works as a classification tag.
- Labels are shared across the house, which keeps class names consistent.

### Splits

Each photo has a split: `train`, `val`, `test` or `unassigned`. Set it while uploading or later in the
photo detail. Splits are preserved in exports.

### Export a dataset

**Photos -> Export dataset** produces a zip:

```
images/<split>/<file>
labels/<split>/<file>.txt
classes.txt
data.yaml
manifest.csv
annotations.json        (COCO format only)
```

- YOLO boxes are normalised (`class x_center y_center width height`).
- COCO boxes are absolute pixel coordinates with categories.
- Photos without boxes still appear in `manifest.csv` as classification samples.

## 7. Settings

**House settings** has eight tabs:

| Tab | Purpose |
| --- | --- |
| General | House name, kind, address, currency, and leaving the house |
| Places | Add, rename, nest and delete locations |
| Categories | Same for categories, with icons |
| Attributes | Custom fields available on items (admin only) |
| Members | Invites, roles and removal |
| AI | Provider preset, base URL, models, key, connection test |
| Reminders | Low-stock toggle and expiry warning window |
| Data | Inventory CSV export, dataset export, data location, house deletion |

**Profile** (under More) holds your name, email, password, theme and install prompt. Phones and
desktops can install SVault as a PWA from the browser menu.

## 8. Connecting AI

1. Open **Settings -> AI** as owner or admin.
2. Pick a preset or fill the fields manually:
   - **OpenAI** - `https://api.openai.com/v1`, model `gpt-4o-mini`
   - **OpenRouter** - `https://openrouter.ai/api/v1`
   - **Ollama** - `http://host.docker.internal:11434/v1` (Docker Desktop) or your host IP
   - **LM Studio** - `http://host.docker.internal:1234/v1`
3. Save, then press **Test saved connection**.

A key saved in house settings wins over the server environment. The API never returns the stored key;
the UI shows a `***` placeholder. Without a key everything still works, with local OCR and parsing and
local meal suggestions.

If you use a vision model, SVault can read the recipe photo when OCR finds no text. Without one, it
sends only the edited OCR text. A text-only local model never receives images.

## 9. Data, backup and moving house

- Everything is stored under `DATA_DIR`: `svault.db` (SQLite, WAL mode) plus `uploads/`.
- **Settings -> Data -> Inventory CSV** downloads the current inventory as CSV. It uses the API's
  1000-item page, so very large vaults should use the API or database directly.
- Dataset exports are generated on demand.
- For a full backup, copy the whole `DATA_DIR` (or the `svault-data` Docker volume). Stop the
  container first for the most consistent SQLite copy, or use `sqlite3 svault.db ".backup ..."`.
- To move to another server, copy `DATA_DIR` to the new host and start the same image with the same
  `DATA_DIR`.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Login succeeds but the next request is signed out | `COOKIE_SECURE=true` while browsing over plain HTTP. Set it to `false` or use HTTPS. |
| Camera scanner says unavailable | Browsers require HTTPS or localhost. Use a TLS reverse proxy; manual entry still works. |
| 413 when uploading photos | Reverse proxy body limit. Raise `client_max_body_size` (NPM) or the equivalent. |
| AI test times out | Proxy timeout or wrong base URL. For Ollama on Linux use the host IP, not `host.docker.internal`. |
| AI returns "no provider configured" | No key in house settings and none in the environment. |
| Reminder never appears | Reorder point is `0`, low-stock reminders are disabled, or the quantity is above the threshold. |
| Photo labels look shifted after cropping | Boxes are relative to the original uploaded image; re-upload rather than crop outside SVault. |
| Data disappeared after recreating the stack | The volume or host path changed. Check `DATA_DIR` and the compose volume mapping. |

More deployment-specific fixes are in [deployment.md](deployment.md) and the
[TrueNAS guide](../deploy/dockge/README.md#troubleshooting).
