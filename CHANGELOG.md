# Changelog

All notable changes to SVault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Inventory item photos open in a full-size viewer from the inventory list, dashboard and item page.
  The image keeps its aspect ratio, and the viewer closes with its close button, Escape or a tap
  outside the image.
- Sign in with a username as well as an email. Existing accounts get a username derived from their
  email automatically; usernames can be changed from the profile page.
- A notification when you are added to a new house, shown in the cross-house reminder feed and bell.
- Receipt scanning: photograph a shopping receipt, correct the OCR lines, and add the whole basket to
  inventory in one step. Existing items get a new batch; unknown products become new items.
- Shops and suppliers are recorded per house, attached to stock batches, movements and receipts, so you
  can always see where a product came from. Manage them under **Purchases**, and pick one inline when
  adding stock or an initial batch.
- The shop printed on a receipt is detected automatically. A country-based catalogue (Greece first)
  suggests common supermarkets, delis, kiosks and online shops, with one-tap add and alias matching for
  names like `LIDL HELLAS` or `SKLAVENITIS`.
- Receipt photos can be taken with the camera or uploaded from the photo library.
- Receipt photos are straightened automatically: the paper is found in the frame, cropped away from the
  table or hand around it, and perspective-corrected before OCR and storage. When no page can be found
  confidently the photo is kept as-is, and the scan footer shows when a background was trimmed.
- Receipts now store net subtotal, tax/VAT and the per-rate VAT split. **Purchases → Insights** shows
  total spend, net and tax, average basket, monthly spend, spend per shop, VAT rates and spend by
  category, with 3/6/12-month and all-time ranges.
- Item price history is vendor-aware: filter the chart by shop and see every purchase with date, shop,
  quantity, entered price and normalised per-unit price.
- A built-in **Lidl Greece** receipt template is selected by a layout classifier. It handles quantity
  and weight lines, Lidl Plus discounts and carrier-bag/packaging fee lines, and reports which template
  parsed each receipt.
- A built-in **Sklavenitis Greece** receipt template handles the chain's product names on one line and
  quantity/weight follow-ups on the next, keeps the printed barcode for stock matching, and folds
  `ΕΚΠΤΩΣΗ` discounts into the line total.
- Receipts record whether they were read by **AI**, a layout **template** or the **local** parser, and
  show that indicator in the receipt list and detail view.
- Discount lines from Sklavenitis and other shops are never turned into products. Product discounts are
  applied to their line, while receipt-level discount summaries are summed into a **money saved** total
  shown on the scan, receipt detail and purchases insights.
- Receipt line corrections teach SVault product aliases (per shop), so abbreviated Lidl names map to the
  right item on the next receipt. The raw receipt name is stored alongside the corrected one.
- A **Receipt templates** builder lets admins clone the built-in Lidl or Sklavenitis template or define
  another shop's layout with regex rules, test it against sample text, and save/version/disable it.
- Scan drafts suggest products using learned aliases, item names and local vector similarity; item pages
  list and manage multiple **Receipt names** per product.
- OpenFoodFacts is now a first-class product link. Barcode scans fetch the full product, receipt
  imports can carry an OFF code per line, and any item can be linked later from its page. Linking only
  fills blank fields (name, description, brand, image, matching category), attaches the OFF code as a
  barcode, and never overwrites a value you set. The item page shows the OFF image, Nutri-Score, NOVA
  group, labels, allergens and ingredients, plus a **Fill empty fields** action.
- A shared receipt-name → OpenFoodFacts catalogue ships in `assets/catalog/off-mappings.json`. Mappings
  learned on an instance are local and can be exported, imported or synced from `SV_CATALOG_URL` under
  **Settings → Data → Product catalogue**; local rows are never overwritten by a bundled or imported
  file.
- OCR now loads **English and Greek** Tesseract language data, so Greek recipes and receipts are read
  on-device too. The assets are vendored locally; nothing is fetched from a CDN. The local parsers also
  understand common Greek recipe headings, units and receipt total/payment lines.
- Items track a nutrition panel — energy in kcal and kJ, fat, saturates, carbohydrate, sugars, fibre,
  protein, salt and sodium — normalised per 100 g or 100 ml. Linking an OpenFoodFacts product fills a
  blank panel automatically, and the values can also be entered from the label in the item editor.
  Optional serving size and serving weight let count-based products be estimated later.
- Recipes now estimate nutrition from the items their ingredients match. The recipe page shows the
  whole-recipe total and calories and macros per portion, with the number of contributing ingredients;
  recipe cards show a `kcal / portion` badge.
- Shopping list and a weekly meal planner are still proposed in the [roadmap](docs/roadmap.md); no code
  has landed for them yet.

### Changed

- Repository documentation split into a user guide, architecture, API reference, deployment,
  development and roadmap.

### Fixed

- Dashboard side panels stay inside their column when a recipe or item name has a long unbroken word.
  Recipe titles wrap, other names truncate, and the two columns can no longer widen the page.
- Wide desktop windows no longer scroll sideways or push page content past the right edge. The page
  area now takes exactly the space beside the sidebar, so its content stays centred from 1024px up.
- Greek receipt scans are more reliable. Receipt OCR now uses Greek-first language data, reads the
  product section as a separate upscaled crop, and compares grayscale and binary candidates before
  merging the best one back into the full receipt. VAT rates are optional when a line loses its tax
  column, and common OCR confusions in Greek numeric columns (`Ο`/`Θ`/`Β`, missing decimals) are
  repaired without changing product names or prices.
- Receipt imports no longer fail with **Invalid request** when OCR produces an oversized product name
  or an out-of-range quantity, price, discount or VAT rate. Values are bounded before import, and the
  toast now names the rejected field if validation still fails.
- Items no longer show duplicate attributes such as **Brand** twice. Built-in item fields are reserved
  and cannot be re-created as custom attributes; existing brand values are folded back into the item's
  brand field on startup.

## [1.0.0] - 2026-11-02

First public release.

### Added

- Multi-house vaults with owner, admin, member and viewer roles, link invites and ownership transfer.
- Inventory items with per-house attributes, categories, places, tags and multiple barcodes.
- Batch-based stock with FIFO consumption, waste, moves, absolute counts and an immutable movement
  ledger.
- Unit conversion for mass, volume and countable units, with per-unit price history and value totals.
- Low-stock and expiry reminders, per-user read state and optional browser notifications.
- Barcode scanning with ZXing and an OpenFoodFacts fallback for unknown codes.
- Recipe OCR in the browser via Tesseract.js, AI or local recipe parsing, and "improve with AI".
- Food ideas generated from current stock and saved recipes, with a fully local fallback.
- Photo library with folders, bounding boxes, classification labels, train/val/test splits and
  YOLO/COCO export.
- OpenAI-compatible AI configuration per house or from environment variables, with presets, a
  connection test and vision-model gating.
- Installable PWA with a cached app shell and an always-network API.
- Single-container Docker deployment, Docker Compose and a TrueNAS/Dockge stack with Nginx Proxy
  Manager guidance.
- Demo seeder with fictional houses, stock, recipes and photos.
- API integration, parser, stock and dataset tests, plus smoke and visual-check scripts.

[Unreleased]: https://github.com/AtaKon/svault/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AtaKon/svault/releases/tag/v1.0.0
