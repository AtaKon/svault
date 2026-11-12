<img src="assets/icon.svg" width="56" height="56" alt="">

# SVault

**A self-hosted, mobile-first vault for everything you own — house by house.**

Track what is in the fridge, the cabin and the closet. Scan barcodes, watch prices, digitise your
grandma's recipes, get dinner ideas from your actual shelves, and label photos into a vision-model
dataset — all from one PWA that runs in a single Docker container.

[![CI](https://github.com/AtaKon/svault/actions/workflows/ci.yml/badge.svg)](https://github.com/AtaKon/svault/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![One container](https://img.shields.io/badge/docker-one%20container-2496ED?logo=docker&logoColor=white)](docker-compose.yml)

![Dashboard](docs/screenshots/desktop-dashboard.png)

## What it does

| | |
|---|---|
| **Several houses, several people** | Every house has its own stock, places, categories, recipes and photos. Invite family with owner/admin/member/viewer roles, and hand ownership over explicitly when the household changes. Optional per-user TOTP two-factor, passkeys and OIDC single sign-on. |
| **Dynamic inventory** | Items get whatever attributes *you* define per house (size, flavour, material, warranty date…). Units are handled properly (g/kg, ml/l, pcs, pairs…). |
| **Espresso log** | Flag a bag of coffee beans as espresso and keep a tasting history: 1-5 star ratings, roast level, grind setting, decimal dose, yield and extraction time, water temperature, pressure, TDS, and saved machine and grinder dropdowns. SVault computes the brew ratio and extraction yield, summarises averages per bean, and lets the whole house compare shots. |
| **Stock that adds up** | Every change is a movement. Batches keep purchase price, location and expiry, so stock counts, value and FIFO consumption stay honest. |
| **Price history that means something** | Record a unit price on every purchase and see per-unit trends, averages and highs/lows, filtered by shop or across all shops. Every individual buy is listed with its date, quantity and vendor. Prices are normalised when units differ (e.g. 500 ml at €0.80 becomes €1.60/l). |
| **Barcode scanning** | Camera scan (ZXing) works in the browser; unknown EAN/UPC codes fall back to an OpenFoodFacts lookup and pre-fill a new item. |
| **OpenFoodFacts enrichment** | Link any inventory item to an OpenFoodFacts product, or let receipt lines and barcode scans do it automatically. Brand, description, image, category and the full nutrition panel are filled only when empty; values you set are never overwritten. Recipes estimate calories and macros per whole recipe and per portion from those panels. A shared receipt-name catalogue ships with the app, learns locally, and can be exported or synced between installs. |
| **Contribute back** | Look up food, beauty, pet food and general products across all four Open Food Facts databases. A **Contribute** page ranks items whose product is missing a brand, category, nutrition panel or photo, lets a signed-in user review the exact fields, and queues a safe additive edit. Accounts are optional, passwords are never stored, and writes stay off until the administrator enables them. |
| **Receipt intake & shops** | Photograph or upload a weekly shop: OCR reads the lines, you fix anything it missed, and the whole basket becomes stock. Built-in layout templates handle Lidl Greece, Sklavenitis Greece and My market Greece quantities, weights, barcodes and discounts; templates for other stores can be built and tested in the app. Each receipt records whether AI, a template or the local parser read it, and discount lines roll up into a **money saved** total instead of becoming products. The shop is detected automatically, with a country-based catalogue. Receipts keep net and VAT, feeding spend-by-shop, tax and category analytics. Corrections and local vector suggestions map shop shorthand to the right products. |
| **Bills & splitting** | Drop a utility-bill PDF or photo, or snap one with the camera button (which always produces a JPEG): the PDF text layer is read directly and scanned bills go through on-device OCR. Camera-roll photos the browser can decode (HEIC on Safari, plus AVIF, GIF, BMP and TIFF) are converted to JPEG first; elsewhere SVault asks for the camera button or a JPEG. SVault fills the supplier, amount and due date, then extracts the breakdown — charges, multiple taxes (VAT, municipal fees, stamp duty) and consumption prices per kWh/m³. Review it before saving, split the bill with the household, and keep the breakdown next to the stored document. |
| **Bulk intake** | Bring in a receipt or a queue of scanned barcodes, review every editable line against suggested matches, then commit in one transaction. Works with AI vision or text-only/local parsing. |
| **Shopping list** | Fill it from a recipe's missing ingredients, from everything below its reorder point, or from a week of planned meals. Lines merge unit-aware, group by category, and checking one records a normal stock movement with price and expiry. House admins can optionally enable cautious, exact-barcode PosoKanei price and promotion lookups. |
| **Meal planner** | A seven-day breakfast/lunch/dinner/snack grid. Pick saved recipes or food ideas, scale servings per slot, duplicate a meal, and turn the week's missing ingredients into the shopping list. |
| **CSV import** | Bring a spreadsheet in with automatic column mapping, a dry-run preview and per-line errors. Supports comma/semicolon, quoted fields, BOM, CRLF and decimal commas; commits create normal stock movements. |
| **Low stock & expiry reminders** | Set a reorder point, get a reminder when it is reached. Expiring batches warn you days ahead. Checked on every stock change plus every 30 minutes. Deliver to the bell, the browser, ntfy, Apprise or a signed webhook. |
| **Recipes, digitised** | Photograph a handwritten card or a notebook page. The page is straightened and cropped to the paper; the configured vision model reads the handwriting, with English & Greek on-device OCR as a private fallback (measured: OCR alone does not read handwriting — see `docs/recipe-ocr-evaluation.md`). Diary furniture, Greek abbreviations and ditto marks are handled, and a page with several recipes is split into separate drafts. "Improve with AI" fills gaps and rewrites steps. Paste a recipe link to import it from a cooking site, with schema.org data read exactly and a text fallback. |
| **Calories, portions and cook mode** | Recipe nutrition is estimated from linked OpenFoodFacts or hand-entered panels, with a built-in reference table for untracked ingredients. Every recipe also estimates whole-recipe and per-portion weight in grams. Cook mode scales the portions up or down, converts every ingredient to grams, and keeps a tick-off step list on screen while you cook. |
| **Cook what you have** | Meal suggestions built from current stock and saved recipes, with realistic missing-ingredient lists — AI or fully local. |
| **AI call log** | Turn on developer mode to inspect every AI request: operation, model, tokens, cost, duration, retries, errors and truncated prompt/response previews. Failed calls are included, filters cover the whole house for admins, and the same records stream to stdout as structured JSON for Docker, Loki or Grafana. |
| **Vision datasets** | Upload photos into folders, draw boxes, name labels, assign train/val/test splits, and export a ready-to-train YOLO or COCO zip (classes, `data.yaml`, manifest included). Import existing YOLO/COCO datasets with a class-mapping preview and review queue. |
| **Backup & restore** | Download a checksummed zip of the SQLite snapshot and uploads from Settings, or use the CLI for cron. Restore validates schema and checksums, keeps a pre-restore copy and returns 503 while it swaps. |
| **Offline-friendly stock** | Stock changes made while offline are queued in IndexedDB with idempotency keys, replayed in order on reconnect and stopped at conflicts with a resolution UI. |
| **Greek & English UI** | Per-user language choice, Greek dictionary, locale-aware dates, numbers and currency, plus Greek recipe/receipt parsing. |
| **Installable & offline-ish** | Real PWA with manifest and service worker; app shell is cached, API always hits the server. |

<table>
<tr>
<td><img src="docs/screenshots/mobile-inventory.png" width="260" alt="Mobile inventory"></td>
<td><img src="docs/screenshots/mobile-dashboard.png" width="260" alt="Mobile dashboard"></td>
<td><img src="docs/screenshots/desktop-item.png" width="420" alt="Item detail with price history"></td>
</tr>
</table>

### A closer look

<table>
<tr>
<td><img src="docs/screenshots/desktop-recipe-draft.png" width="420" alt="Digitised recipe draft"><br><sub>OCR + AI recipe digitisation (works offline with the local parser too)</sub></td>
<td><img src="docs/screenshots/desktop-photo-label.png" width="420" alt="Photo labelling"><br><sub>Bounding boxes, classes and train/val/test splits</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/desktop-ideas.png" width="420" alt="Food ideas"><br><sub>Meal ideas from current stock and saved recipes</sub></td>
<td><img src="docs/screenshots/desktop-dark.png" width="420" alt="Dark mode"><br><sub>Dark mode, also on mobile</sub></td>
</tr>
</table>

## Documentation

| Guide | What it covers |
|---|---|
| [Documentation index](docs/README.md) | Start here for every guide and project document |
| [User guide](docs/user-guide.md) | Houses, roles, inventory, stock actions, recipes, datasets, reminders, AI and troubleshooting |
| [Architecture](docs/architecture.md) | Runtime, data model, auth, stock engine, reminders, AI fallbacks, uploads and PWA |
| [API reference](docs/api.md) | Conventions, roles, every endpoint, payloads and status codes |
| [Deployment](docs/deployment.md) | Docker, environment variables, HTTPS, TrueNAS, backups, upgrades and hardening |
| [Bring your own database](docs/database.md) | Run on PostgreSQL, migrate an existing SQLite vault and back it up |
| [Self-hosted CI/CD](deploy/woodpecker/README.md) | Woodpecker CI, private registry, automatic deploys and the AI review bot |
| [Development](docs/development.md) | Local setup, scripts, tests, project layout and conventions |
| [Roadmap](docs/roadmap.md) | Planned features, priorities, dependencies and non-goals |

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md). New feature ideas are tracked as GitHub issues.

## Quick start (Docker)

```bash
docker compose up -d --build
```

Open **http://localhost:8080** and create your first account. Houses, places and categories get
sensible defaults automatically.

Want a populated vault to explore? Set `SEED_DEMO=true` in `.env` **before the first start** (or run
`npm run seed` locally). Demo login:

```
demo@svault.local / demo1234
sofia@svault.local / demo1234   (member of the same house)
```

Data lives in the `svault-data` volume (`/data` inside the container): one SQLite database plus
uploads. Back up that volume and you have backed up everything. Set `SVAULT_PORT` if `8080` is
already taken by another service on your machine.

### TrueNAS / Dockge

A ready-to-paste Dockge stack, the image transfer steps and TrueNAS-specific permission notes live in
[`deploy/dockge`](deploy/dockge/README.md).

### Access from your phone (same Wi-Fi)

1. Find the PC's LAN IP (`ipconfig`, e.g. `192.168.0.148`).
2. Open `http://<pc-ip>:<SVAULT_PORT>` on the phone.
3. Allow inbound TCP on that port in Windows Firewall, for example in an elevated PowerShell:
   ```powershell
   New-NetFirewallRule -DisplayName "SVault (TCP 8095)" -Direction Inbound -Protocol TCP `
     -LocalPort 8095 -Action Allow -Profile Any
   ```
4. Give the PC a DHCP reservation in your router so the address survives reboots, and make sure
   Docker Desktop starts when you log in (Settings → General).

Browsers only expose the camera on secure origins, so barcode scanning works over `localhost` or
**HTTPS**. On a plain-HTTP LAN address everything else works, but the scanner will ask you to type
the code. Use a TLS reverse proxy (Caddy/Traefik with a trusted or locally trusted certificate) or
Tailscale Serve if you want one-tap scanning from the phone.

### Camera on a phone

Browsers only allow `getUserMedia` on **HTTPS** or `localhost`. To scan barcodes from your phone,
serve SVault through a reverse proxy with TLS (Caddy, Traefik, npm, Tailscale Serve…) and set
`COOKIE_SECURE=true`. Everything else works over plain HTTP on your LAN.

## Local development

```bash
npm install
npm run dev        # API on :4000, Vite on :5173
npm run seed       # optional demo data
```

- Web: http://localhost:5173 (proxies `/api` and `/uploads` to :4000)
- API: http://localhost:4000/api/health

Production build:

```bash
npm run build      # client -> dist/client, server -> dist/server
npm start          # serves both from :4000
npm test           # 42 API, parser, AI-mock and dataset tests
npm run typecheck
```

Requires **Node 22.13+**. No native modules: SQLite comes from `node:sqlite`, which keeps the Docker
image small and the install painless.

## Configuration

Copy `.env.example` to `.env` (Docker Compose reads it) or export the variables yourself.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API / web port inside the container |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite database and uploads |
| `COOKIE_SECURE` | `true` in production | Set `false` for plain-HTTP LAN installs |
| `SEED_DEMO` | `false` | Load demo data when the database is empty (Docker entrypoint) |
| `OPENAI_API_KEY` | — | Optional AI key shared by all houses |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter…) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Text model for recipes/ideas |
| `OPENAI_VISION_MODEL` | falls back to text model | Vision model used to read recipe photos |
| `OPENAI_RECIPE_REASONING` | `auto` | Recipe-scan reasoning: `auto`, `off`, `low`, `medium`, `high` (sent to OpenRouter as `reasoning`) |
| `OPENAI_RECIPE_VISION_MODELS` | provider default | Comma-separated recipe-scan models, at most four. OpenRouter defaults to Gemini 3 Flash Preview → Qwen3.6 35B → Gemini 3.8 Flash; other endpoints use `OPENAI_VISION_MODEL` only |
| `MAX_UPLOAD_MB` | `20` | Per-image upload limit |

AI can also be configured **per house** in *Settings → AI*. A stored key wins over the environment.
Without a key everything still works: OCR is local, recipe parsing is heuristic and food ideas come
from your own inventory and saved recipes. The UI tells you which path was used.

### Connecting AI (2 minutes)

1. Open **Settings → AI** (as owner/admin of the house).
2. Pick a preset or fill the fields, press **Save AI settings**, then **Test saved connection**.

| Provider | Base URL | Text model | Vision model | Key |
|---|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `gpt-4o-mini` | your key |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` | `openai/gpt-4o-mini` | your key |
| Ollama (local) | `http://host.docker.internal:11434/v1` | `llama3.2` | `qwen2.5vl:7b` (optional) | any placeholder |
| LM Studio (local) | `http://host.docker.internal:1234/v1` | the loaded model id | leave empty | any placeholder |

For a fully local setup:

```bash
ollama pull llama3.2
# optional, only for reading photos without OCR:
ollama pull qwen2.5vl:7b
```

Then choose **Ollama (local)** in Settings → AI, press Save and Test. SVault only sends the scan image
when a vision model is configured; otherwise it relies on the on-device OCR text, which is what most
local text models expect. On Linux hosts replace `host.docker.internal` with your Docker gateway
(`172.17.0.1`) or the service name if Ollama runs in Compose.

### Recipe reasoning and model choice

Recipe scans are the one operation where a reasoning ("thinking") model can help or hurt: some models
read handwriting more accurately with thinking on, while hybrid models such as Qwen3 can spend the
whole answer budget thinking and return no recipe. **Settings → AI → Recipe reasoning** offers
`auto` (default, no field sent), `off`, `low`, `medium` and `high` for recipe scans only; receipt
scans, ideas and cleanup are unchanged. The value is sent to OpenRouter as its `reasoning` field, and
an endpoint that rejects it is retried without it.

A response that contains only reasoning, or that is cut off at the token limit, is retried once with
reasoning disabled and the scan warns you. If the retry also fails, the locally parsed draft is kept
instead of showing an empty recipe. The AI call log records the finish reason, reasoning tokens and
the retry.

Measured one-photo OpenRouter observations (not a benchmark; see
[`docs/recipe-ocr-evaluation.md`](docs/recipe-ocr-evaluation.md)): Gemini 3 Flash Preview ($0.001557)
and Gemini 3.8 Flash ($0.002104) read the key quantities correctly, while Gemini 2.5 Flash ($0.00119)
and Flash Lite ($0.0001895) misread a `2` as `9`. Qwen3.6 35B needed reasoning disabled, and Qwen3.7
returned HTTP 429. Do not pick a recipe model on price alone: a wrong digit in a quantity is a worse
outcome than a slightly higher scan cost, and one photo does not establish accuracy.

### Recipe model fallback chain

Recipe scans try up to **four** models and move to the next only when one fails (provider error, empty
answer, any truncation, malformed JSON). A successful answer is never replaced by a later model just
because it might look more accurate: that would bill every scan twice. When every model truncates, a
usable partial recipe is kept with a warning. On OpenRouter the default order is Gemini 3 Flash
Preview → Qwen3.6 35B → Gemini 3.8 Flash, with reasoning disabled for Qwen3.6. **Settings → AI → Recipe
vision models** overrides the list (comma-separated, max four; one entry opts out). Other providers are
never sent these OpenRouter IDs — they keep their configured vision model unless you type an explicit
list; a deliberately configured vision model is always tried first. The scan warning names each failed
model, the AI call log records every attempt, and the reported cost covers all attempts.

To replace the defaults with evidence from your own photos, run the developer benchmark with your own
model IDs and a written ground truth (photos and key stay outside the manifest):

```sh
OPENAI_API_KEY=... node --import tsx scripts/recipe-vision-benchmark.mjs \
  data/recipe-vision/manifest.json --json data/recipe-vision/results.json
```

See [`docs/recipe-ocr-evaluation.md`](docs/recipe-ocr-evaluation.md) for the manifest format, scoring
weights and limitations.


What AI actually powers:

- **Recipe scan cleanup** — fixes OCR errors and structures ingredients/steps.
- **Recipe link import** — structures page copy when a site has no schema.org recipe data.
- **Improve recipe** — fills missing quantities, times and temperatures; notes what changed.
- **Food ideas** — suggestions from current stock and saved recipes, with missing essentials.

Stock, barcodes, price history, reminders and photo labelling never call AI.

## How the pieces work

### Stock, batches and prices

- Each item has a **base unit** (`g`, `l`, `pcs`…). Quantities and prices are normalised to it.
- Adding stock creates a **batch** with quantity, location, purchase date, expiry and unit price.
- Removing stock consumes **FIFO** (soonest expiry, then oldest purchase), so expired food goes first.
- "Count" sets an absolute quantity and records the difference as an adjustment.
- Moves transfer batches between places without changing the total.
- Every movement stores the balance after the change, so history reads like a ledger.
- Price history is derived from purchase movements; a 500 ml purchase for €0.80 shows as €1.60/l.

### Barcodes

- Codes are unique per house. The item page can hold several barcodes.
- Scanning first checks your house, then (for unknown codes) queries OpenFoodFacts with a short
  timeout. Offline? You still get "create item" with the code attached.
- The scanner uses the rear camera via `@zxing/browser`, with a manual code entry fallback.

### Recipes: OCR + AI

1. The photo is compressed in the browser and uploaded as the recipe's source image.
2. Tesseract OCR runs **in the browser** using assets served from `/tesseract` (vendored at build
   time, ~12 MB, cached by the service worker). Text is editable before continuing.
3. `POST /recipes/scan` cleans the text:
   - with an AI provider: JSON-structured ingredients/steps, OCR fixes, inferences noted;
   - without one: a tolerant local parser (sections, quantities, fractions, timers, titles).
4. Save, then edit anything, or press **Improve with AI** to fill missing quantities/timings.
5. Ingredient availability is matched loosely against stock ("eggs" ↔ "Free-range eggs").
6. Paste a link on **Import link**: `POST /recipes/import` reads schema.org JSON-LD exactly, falls back
   to page text, and uses the AI provider to structure it when one is configured.
7. The recipe page estimates nutrition (linked panels plus a built-in reference table) and weight in
   grams. **Cook mode** scales portions, shows every ingredient in grams, and keeps a tick-off list.

### Food ideas

The prompt + current stock + saved recipes go to the AI (or the local matcher). Local suggestions
rank saved recipes by ingredient coverage, then add practical inventory-only ideas. Saving an idea
turns it into a normal recipe you can edit.

### Photo library and vision datasets

- Photos live in **folders** (collections) per house.
- Drag on a photo to draw a bounding box and name it; labels without a box work as classification tags.
- Every photo has a split (`train` / `val` / `test` / `unassigned`).
- Export produces a zip with:
  - `images/<split>/…` and `labels/<split>/…` (normalised YOLO boxes)
  - `classes.txt`, `data.yaml`, `manifest.csv`
  - `annotations.coco.json` (absolute COCO boxes + categories)
- Photos without boxes still export as classification samples (`manifest.csv`).

### Reminders

- Low-stock: fires when quantity ≤ reorder point, re-opens automatically if it happens again, and
  resolves itself when restocked. Disable per house in *Settings → Reminders*.
- Expiry: warns `expiryDays` ahead (default 7) for every batch with quantity left.
- Delivery: in-app bell + optional browser notifications by default. Add ntfy, Apprise or a webhook in
  *Settings → Reminders* for reminders while SVault is closed. Channel secrets are masked, deliveries
  retry three times with backoff, and webhooks can be signed with HMAC-SHA256. Nothing leaves your server
  unless you configure a channel.

## API sketch

All endpoints are JSON (except uploads/export) and cookie-authenticated.

```
POST /api/auth/register|login|logout         GET/PATCH /api/auth/me
GET  /api/houses                             POST /api/houses
GET  /api/houses/:id                         PATCH/DELETE /api/houses/:id
GET  /api/houses/:id/dashboard
GET  /api/houses/:id/items?q=&categoryId=&locationId=&low=1&expiring=1
POST /api/houses/:id/items                   POST /api/houses/:id/scan?code=
GET  /api/items/:id                          PATCH/DELETE /api/items/:id
POST /api/items/:id/stock                    (add | remove | waste | set | move)
GET  /api/items/:id/movements
GET  /api/houses/:id/recipes                 POST /api/houses/:id/recipes
POST /api/houses/:id/recipes/scan            POST /api/houses/:id/recipes/upload
POST /api/houses/:id/recipes/import          POST /api/recipes/:id/ai
GET  /api/houses/:id/ideas                   POST /api/houses/:id/ideas
GET  /api/houses/:id/shopping                POST /api/houses/:id/shopping/from-recipe
POST /api/houses/:id/shopping/from-low-stock POST /api/houses/:id/shopping/:entryId/check
GET  /api/houses/:id/plan?week=              POST /api/houses/:id/plan
POST /api/houses/:id/plan/shopping-list
POST /api/houses/:id/intake/parse            POST /api/houses/:id/intake/commit
POST /api/houses/:id/import/csv/preview      POST /api/houses/:id/import/csv/commit
GET  /api/houses/:id/photos                  POST /api/houses/:id/photos
POST /api/photos/:id/labels                  PUT  /api/photos/:id/labels
GET  /api/houses/:id/photos/export?format=yolo|coco
GET  /api/houses/:id/notifications           POST /api/houses/:id/notifications/scan
POST /api/houses/:id/notifications/test      GET  /api/houses/:id/reminder-deliveries
POST /api/houses/:id/members/:userId/transfer-ownership
GET  /api/houses/:id/espresso-shots          GET  /api/items/:id/espresso-shots
POST /api/items/:id/espresso-shots           PATCH/DELETE /api/items/:id/espresso-shots/:shotId
```

## Screens

- **Home** – stock summary, running low, expiring, recent activity, today's plan, cooking shortcuts.
- **Inventory** – search, category/location/low-stock/expiry filters, inline ±1, sort by value.
- **Item** – batch list with expiry, price chart, movement history, barcodes, dynamic attributes.
- **Espresso log** – roast, grind, dose, yield, extraction time and TDS history with ratings and averages per bean.
- **Scan** – camera + manual entry, quick ±1, create-from-barcode.
- **Shopping list** – grouped, unit-aware lines from recipes, low stock and the plan; check into stock.
- **Meal plan** – seven-day grid per house with scaled servings and one-click shopping list.
- **Bulk intake** – receipt text/photo or barcode queue, editable review table, atomic commit.
- **Kitchen** – recipes with stock coverage, calories and portion weight, full recipe view, link import, scan, cook mode, favourites.
- **Ideas** – prompt chips, AI/local meal cards, save as recipe.
- **Photo library** – folders, upload, box labelling, splits, dataset export.
- **Reminders** – low stock & expiry, browser opt-in, ntfy/Apprise/webhook channels.
- **Settings** – general, places, categories, attributes, members/ownership, AI, reminders, CSV import/export.
- **More/Profile** – theme, install, account, password.

Dark mode follows the system and can be toggled in the sidebar/more menu.

## Project layout

```
client/        React 19 + Vite + Tailwind v4 PWA
  components/  UI primitives, shell, scanner, charts, photo labeller
  pages/       one file per screen
server/        Express 5 + node:sqlite API
  routes/      auth, houses, inventory, recipes, ideas, photos, notifications
  services/    stock math, reminders, recipe parsing, house defaults
  lib/png.ts   tiny PNG encoder used by the demo seeder
shared/        domain types shared by client and server
public/        manifest, service worker, icons, vendored OCR assets (generated)
scripts/       OCR vendoring, icon/recipe-card generation, smoke + visual checks
```

## Testing

```bash
npm test                     # API integration + parser + unit tests (temp DB per run)
node scripts/smoke.mjs URL   # black-box smoke test against a running server
node scripts/visual-check.mjs URL   # Playwright screenshots + console/API error scan
node scripts/functional-check.mjs URL  # click-through UI checks on a throwaway copy
```

The browser scripts need `npm i --no-save playwright-core` and a local Edge/Chrome install
(the paths are set at the top of each script).

The test suite covers unit conversion, OCR-noise parsing, auth, per-house isolation, membership
roles, item creation, barcode conflicts and lookup, FIFO consumption, absolute counts, moves, low
stock reminders, recipe matching, local idea generation, photo export and SPA routing.

## Operational notes & limitations

- **Single node by design.** SQLite in WAL mode + a local uploads folder. Great for a home server;
  not a clustered deployment.
- **Invites are links.** There is no email sending (nothing to configure, nothing to leak). Create
  an invite, copy the link and share it. Revoked links stop working; invites do not expire on their
  own, so revoke them in Settings when they are no longer needed.
- **No password-reset email.** If you lose the password, use the API/DB directly (or re-seed on a
  fresh volume).
- **AI keys are stored in the house settings table** (plaintext) because the app is self-hosted and
  single-tenant. Prefer the environment variable if you prefer keys outside the DB.
- **Browser camera requires HTTPS** (or localhost). HEIC photos display if the browser supports
  decoding them; uploads are stored unchanged.
- **Uploads are served from `/uploads` without auth.** Filenames are random; still, treat the URL
  as the secret or put the whole app behind your reverse proxy.
- The demo seeder adds fictional content only when the database has no demo user.

Built with TypeScript, Express, React, Tailwind and `node:sqlite` — no external services required.

## Contributing

Bug reports, feature requests and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
for the setup, test and review workflow. Security issues should follow [SECURITY.md](SECURITY.md)
instead of a public issue.

Good starting points are issues labelled
[`good first issue`](https://github.com/AtaKon/svault/labels/good%20first%20issue) or the
[roadmap](docs/roadmap.md).

## License

[MIT](LICENSE) © 2026 AtaKon.
