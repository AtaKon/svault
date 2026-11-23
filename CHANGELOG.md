# Changelog

All notable changes to SVault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Notes on how these features fit together

- A stocktake expects the **shelf** quantity: on-hand minus units that are lent out. Counting what is on the
  shelf is no variance, and a lent unit is no longer booked as a shortage. In a place count this applies when
  all of the item's stock sits in that place.
- Merging items also moves their loans, per-batch undo effects and closed stocktake lines (scaled to the
  target's unit); an open count drops the merged-away item's line.
- Undoing a take-out from a frozen batch gives the batch its portions back.
- Stocktake, freeze, thaw and undo changes are announced to open pages like any other stock change.
- The valuation report needs member access or above; viewers are refused.

### Fixed

- **Barcode scanning on Samsung Galaxy phones.** Chrome on Galaxy phones often opened the ultra-wide or telephoto lens, which cannot focus at barcode distance, so nothing scanned. The scanner now opens the main rear lens on Android, asks for continuous autofocus, uses the browser's native barcode detector when it has one (with ZXing tuned to product formats as the fallback), and releases the camera when the app goes to the background so the preview is not black on return. New **Light** and **Switch lens** buttons appear when the camera supports them, and a manually chosen lens is remembered on the device.
- **Receipt QR on thermal prints.** A photographed receipt now offers its untouched pixels to the browser's native barcode detector before the ZXing software ladder (the live camera scanner already did this), so faint thermal-printed codes — a white print row through the finder patterns, slight warp — import their digital receipt on Chrome Android instead of falling back to OCR. When even the platform detector reads nothing from the whole photo, it is retried on a grid of overlapping, doubled crops (the lower half of the photo first, where receipt QRs sit) within a reserved share of the soft time budget, which recovers codes too small for the detector's view of a full phone frame; the software ladder always keeps the rest of the budget, so a slow native miss on a photo without a readable QR can no longer spend the whole budget and disable the software fallback. A native code that is not a receipt link counts as a miss — the software ladder still runs and may find the receipt link elsewhere in the same photo.
- **Entersoft receipt links with shorter tokens.** Entersoft (e-invoicing.gr) digital-receipt QRs carry a 6-12 character token — a real Lidl receipt printed 7 — but only exactly 8 was accepted, so such scans were rejected as an unsupported issuer and fell back to OCR. The token length rule now follows the issuer's own route shape; the host allowlist and every other validation are unchanged.
- **Offline queue.** A queued change the server can never accept (deleted item, lowered role, invalid data) no longer blocks the queue in a tight retry loop: it is shown with a Discard option, and transient failures retry with backoff up to 30 seconds. Several queued changes to the same item no longer conflict with each other on sync. **Discard** now asks for confirmation, and **View** lists queued changes so one can be dropped on its own.
- **Item page offline.** A background refresh that cannot reach the server keeps the item on screen instead of replacing it with "Item not found". Moving from one item to another no longer shows the previous item while the next one loads.
- **Forms during live updates.** A housemate's change no longer resets the "Bought" sheet on the shopping list or the add/move meal sheets on the plan, and the week no longer flashes skeletons on each refresh. Slower, older responses on the inventory list, receipt analytics and plan week can no longer overwrite newer ones.
- **Sheets and dialogs.** Focus moves into an open sheet, Tab stays inside it, focus returns to where it was on close, and the dialog is labelled by its title. Escape closes only the topmost dialog.
- **Shopping list errors.** Unchecking or removing a line that fails now shows an error instead of failing silently.
- **Malformed cookies.** A cookie with invalid percent-encoding set by another app on the same host no longer makes every request fail with 500.
- **Recipe link import.** Links that members paste are always refused when they point to loopback, private or link-local addresses, whatever `SV_OUTBOUND_ALLOW_PRIVATE` says. That setting now applies only to URLs that admins configure.
- **Stock changes on PostgreSQL.** The item stock route takes the household ledger lock and checks the idempotency key inside the same transaction, so a retried request cannot apply twice and concurrent removals cannot lose an update.
- **Reminders.** An invalid `notifications.expiryDays` is rejected when saved, stored bad values fall back to the default, and a failure in one house no longer stops the reminder scan for every house after it.
- **Password re-checks.** Changing the password, disabling two-factor sign-in, regenerating backup codes and profile updates that check the current password are now rate limited.
- **AI budget.** House-level AI token prices apply only when the house uses its own key or endpoint, so calls on the server's key are always costed at the server's prices.
- **Inventory paging.** A fractional or huge `offset` no longer returns 500.

- **PostgreSQL upgrade.** The release that added item merging failed to start on an existing PostgreSQL database (`column "merged_into" does not exist`): an index on the new column was created before the migration that adds it, and the startup transaction aborted. The index is now created after the column. A test fails if the base schema ever indexes a column that existing databases only get from a migration.
- **Offline reload.** Reloading SVault without a network no longer lands on the sign-in page. The last signed-in session is kept on the device and used only while the server cannot be reached; a 401 or signing out clears it. Requests that cannot reach the server now say "You are offline" instead of "Failed to fetch".
- **PostgreSQL: replacing a bill document.** Uploading a new PDF for an existing bill failed with 500 on PostgreSQL ("could not determine data type of parameter").
- **PostgreSQL test suite.** `npm run test:postgres` passes in full. Four tests used SQLite-only SQL (`PRAGMA`, trigger syntax, text in a numeric column, a hard-coded database name) and now run, or skip only the SQLite-specific part, on PostgreSQL. CI runs the PostgreSQL suite on every pull request.
- **Sign-in after a deep link.** Opening a protected page while signed out returned to Home after signing in. It now returns to the page and query string that was requested, which is what printable labels and filtered inventory links rely on.

### Added

- **Shortfalls to the shopping list.** After cooking, members can add the missing amounts to the shopping list in one tap. Items already on the open list are skipped.
- **Digital receipt scans.** SVault checks photos for a receipt QR before running OCR. Supported
  Entersoft links fill the review screen with the issuer's product lines, quantities, prices,
  discounts and VAT. IMPACT eInvoicing links also fill the review screen with the issuer's product
  lines, prices, VAT, merchant and issue date. For Epsilon Digital links that require browser
  verification, open the issuer's viewer and import the downloaded receipt PDF, or continue
  with photo OCR. Bulk intake follows the same order: a receipt photo with a usable digital receipt
  fills the review table without any OCR, and a QR that is unreadable or unsupported leaves a note
  and falls back to reading the photo.
- **PosoKanei retailer and product matching.** Offers are now filtered by receipt shops an admin marks as
  accessible, so a shopping line only shows shops the house can reach. PosoKanei retailer labels are
  discovered from offers, matched automatically to a house shop when the name is unambiguous, and can be
  mapped or unmapped in price settings; unmatched labels are reported instead of guessed. Inventory items
  without an Open Food Facts link can now be matched to a PosoKanei product directly. Existing shared
  Open Food Facts matches keep working, an item-specific match takes precedence, and a house with no
  accessible shops keeps the previous unfiltered behavior. When merging two items with direct matches,
  the surviving item's match is kept and the other match is discarded.
- Undo for the last stock action: a short toast with an **Undo** button after any successful add, use,
  waste, count or move, plus an **Undo** action on the newest rows of an item's history. Undo appends a
  compensating movement to the ledger (nothing is edited or deleted), restores the exact batches a FIFO
  consume or a move touched, reverses both parts of a cross-batch action in one transaction, and refuses
  with a clear message when a later change has made it unsafe. Members undo their own changes, admins
  and owners undo anyone's, and a change still waiting in the offline queue is removed from the queue
  instead of being sent.
- **Stocktake mode.** A guided physical count per place or category. Starting a session snapshots the expected quantity per item; counting autosaves per line, supports barcode jump-to-item and works on a phone. Review shows variances and value impact, and commit applies every selected variance in one transaction as `count` movements (FIFO shortage, new batch for surplus). Lines whose stock moved during the session must be confirmed and the variance is applied to the current quantity; a second commit is refused. History lists past sessions with line and variance counts.
- Category budgets, optional bill spending, month-end projections, budget history and threshold reminders.
- Consumption-based run-out forecasts on items and the dashboard, with an optional shopping-list fill.
- Printable QR labels for items and places: multi-select with search, three label sizes (including a 3 × 8 A4 sheet), live preview and a print stylesheet. Scanning a label with the in-app scanner opens the item or place, also after signing in; foreign or script QR payloads are ignored.
- Cost per recipe and portion, from recorded purchase prices or the batches in stock, with an honest
  coverage note and a per-ingredient breakdown. The recipe list can sort and filter by cost per portion.
- Saved inventory views: name the current filters, keep personal views, let house admins share one with everyone, and apply a view from a linkable URL. Views whose category or place was deleted stay visible with a warning.
- Global search in the app header (`/` or `Ctrl`/`Cmd`+`K`) across items, recipes, receipts, bills and shops, with Greek accent-insensitive matching, grouped ranked results and recent searches kept on the device.
- **Valuation and insurance report.** **More → Valuation report** builds a dated record of what the house owns, with per-item values from the latest purchase price, the average purchase price or the stock cost. Filter by category, place, tag, minimum value, active warranty and archived items; see the grand total, category and place subtotals and the items with no recorded value. Download the report as CSV (formula-injection safe, UTF-8 BOM) or print it from the browser with optional photos and attribute columns and an optional list of attached warranty documents. Unpriced items are listed but never counted as zero.
- House activity feed: a read-only, newest-first timeline at **More → Activity** (`GET /api/houses/:houseId/activity`) that merges stock movements, saved receipts, new items, shopping checkoffs and bills, with cursor pagination and member, kind, item, place and date filters.
- Optional Web Push reminders. With VAPID keys configured, an installed PWA receives low-stock, expiry
  and budget reminders while SVault is closed; each device is enabled separately under
  **Settings → Reminders**.
- Lending tracker: record who borrowed a tool, book or piece of gear, see "x on loan" on items and the
  dashboard, return loans fully or in parts, and get one overdue reminder per loan per day. Lending
  never changes stock; consuming below the lent quantity is refused.
- **Freezer and meal-prep batches.** Freeze all or part of a batch (or cook-mode leftovers) with portions, a frozen date and a freezer place. View everything frozen under **More → Freezer**, grouped by place and ordered by eat-by, with a use-first strip, filters, one-tap portion take-out and a thaw action. Items can set a freezer shelf life (90 days by default) and a thaw window (2 days by default), and frozen or thawed batches feed the existing expiry reminders and dashboard.
- Duplicate item finder: deterministic groups with reason chips, a side-by-side comparison, a dry-run
  merge summary and a merge that moves every reference, converts compatible units, archives the
  sources with `merged_into` and remembers dismissed pairs. A **Merge into…** action on the item page
  uses the same flow.

### Security

- Web Push endpoints are always public HTTPS hosts. A signed-in user supplies the endpoint and the
  server posts to it, so private, loopback and link-local addresses are refused when subscribing and
  again when sending (and re-checked at connect time), regardless of `SV_OUTBOUND_ALLOW_PRIVATE`.
- Writing an Open Food Facts folksonomy property now needs accepted OFF consent and member access to
  at least one household. A named `houseId`/`itemId` must belong to a house the caller is a member of,
  so a signed-in user can no longer write through the instance token or name another house's item.
- Answering Robotoff questions now needs accepted OFF consent and member access to at least one
  household, instead of any signed-in session.
- Open Food Facts contribution lists return an item's name only while the contributor is still a member
  of that contribution's household. The rest of the row is unchanged, but leaving the house no longer
  keeps showing what it contained.
- Deleting a recipe removes only upload files its own household owns. An old recipe that points at
  another household's upload no longer deletes that file.
- The development request log and the AI provider label no longer print query strings, which can
  carry OIDC `code`/`state`, invite codes or search terms.
- Recipe ingredients can link only to items of the recipe's household, and the meal-plan shopping
  list only reads categories from the plan's own household.
- Open Food Facts contributions refuse an item from another household (price contributions accepted
  one unchecked and returned its name).
- Open Food Facts contribution retries, and queued sends, now re-check that the contributor is still a
  member of the household. Someone removed from a house or demoted to viewer could retry a failed
  contribution and send that house's item data or receipt photo to Open Food Facts.
- Recipe link imports keep the page's cover image only when it is an http(s) link of at most 2000
  characters. A hostile page could store a `javascript:` or `data:` value (of any size) as the recipe
  image, bypassing the image check that recipe create and edit apply.
- Uploaded files under `/uploads` now need a signed-in session and are cached privately; a leaked
  link alone no longer opens a receipt photo.
- Uploads are bound to the household that made them (new file names carry a house tag). Receipt and
  recipe scans, receipt intake, saved receipts, recipe photos and item pictures refuse another
  household's upload, so one household can no longer send another's photo to its AI provider, attach
  it, or delete it. Recipe and item image fields accept only the house's own uploads or http(s) links.

- House-wide notification scans now require member access.

- Dataset imports read archive entries with a size cap per entry, a total inflate budget and an entry
  limit, so a small zip can no longer expand into gigabytes in server memory.

- Validate location and category parents and attribute categories against their household.

- Instance backups now require a signed-in session, preventing API tokens from downloading or listing full-instance archives.

- Item categories, stock locations, and photo folder and item links are now validated against the
  owning household to prevent cross-household references.

- Account-wide passkeys can be deleted only by their owner or an instance administrator. A household
  owner can no longer delete another member's passkeys.

- Dataset imports accept only the known split names (`unassigned`, `train`, `val`, `test`) as a
  split override, and exports fall back to `unassigned` for any other stored value. A member could
  previously store `../` paths that became entry names in a later dataset zip export.
- Dataset exports quote class names in `data.yaml` and flatten line breaks in label text. A label
  with a line break could add top-level keys (for example a training tool's `download:` command)
  to the YAML that another household member later trains with.
- Saving a food idea from another household now answers `404 Idea not found`, the same as an unknown
  id, instead of `403`, which confirmed that the idea id existed.

### Added

- Item warranty dates and notes, reminders, and private PDF or image documents.
- Private subscribable calendar feeds for meal plans and bill due dates.
- Optional household member allergy and diet profiles with local recipe and meal warnings.
- Track when a batch was opened and an item’s shelf life after opening, with effective expiry dates in reminders and inventory views.
- **Home Assistant integration.** `GET /api/houses/:houseId/summary` returns a compact snapshot for
  sensors — item, low-stock, expiring-soon, expired, open shopping-list and unread-reminder counts plus
  the house name and last change — in two small queries. It accepts a read-only API token, so Home
  Assistant can poll it without a session. The new [Home Assistant guide](docs/home-assistant.md)
  covers token creation, one REST sensor with several `value_template` sensors at `scan_interval: 300`,
  a low-stock notification and HTTPS/secret handling.
- **Cooking stock and leftovers.** Review scaled linked ingredients when finishing a recipe, deduct available stock, see shortfalls, and save leftover portions with a use-by date.

- **Recipe portion, weight and calorie estimates.** Recipes now estimate the total prepared weight and
  the weight of one portion in grams alongside the existing calorie and macro panel. Volume uses a
  typical density per ingredient and countable units a typical piece weight, with coverage reported so
  the estimate is honest about what it could convert. Calories fall back to a built-in per-100 g
  reference table for ingredients that are not tracked in the inventory, so imported recipes are not
  blank. The shared helpers live in `shared/recipe-grams.ts` and are used by both the API and the web
  client.
- **Cook mode.** A dedicated screen at `/recipes/:id/cook` scales a recipe to any number of portions
  (add, remove, ×2, ÷2), converts every ingredient to grams while keeping the original measure
  underneath, and shows per-portion and total weight and calories. Ingredients and steps can be ticked
  off, and the screen stays awake where the browser supports the Wake Lock API. The saved recipe is
  not modified.
- **Import a recipe from a link.** Paste a public recipe URL on **Kitchen -> Import link**. The server
  reads schema.org `Recipe` JSON-LD when the site publishes it, falls back to a tolerant page-text
  read, and structures the copy through the configured AI provider when available. Imported recipes
  keep their `sourceUrl` and may use the page's cover image. The new endpoint is
  `POST /api/houses/:houseId/recipes/import`; recipe `source` gains the value `import` and the
  `recipes` table gains `source_url` on both SQLite and PostgreSQL. Imports follow redirects one hop
  at a time so every target is checked by the outbound guard, and a stored `sourceUrl` is validated
  the same way before it is saved.
- **Handwritten notebook pages.** Recipe scanning handles photographs of handwritten notebook and
  diary pages. On-device Tesseract remains the privacy-first default for printed cards, but a measured
  evaluation on three real handwritten pages recovered **2 of 54 ingredient words**, both accidental (see
  [`docs/recipe-ocr-evaluation.md`](docs/recipe-ocr-evaluation.md)), so the photo is now sent to the
  configured AI model first and the recognised text is treated as a hint. The browser still
  straightens the page, crops it to the bright paper sheet and picks between a grayscale and a blue-ink
  reading, capped at 5.5 Mpx because larger pages abort the Tesseract worker. The local parser and the
  AI prompt strip the printed planner frame (hour gutter, weekday and month headings, week numbers,
  printer codes) and understand Greek abbreviations (`γραμμ.`, `φλιτζ.`, `κουτ.`, `κ.γ.`), quantities
  written as words (`μισό`, `δύο`), mixed fractions, two ingredients on one ruled row and ditto marks
  that repeat the unit above. Recognition always loads Greek and English together, since the page
  language is not the interface language. Cleanup only removes planner furniture and immediately
  repeated rows, reports what it removed, and keeps the raw reading available. A page that holds more
  than one recipe is split into separate drafts instead of being merged. The shared helpers live in
  `shared/notebook-scan.ts`.
- **Recipe vision model fallback chain.** Recipe scans now try up to four models in order and move to
  the next one only after a failure — a provider error, rate limit, empty answer, truncation or
  malformed JSON. A successful complete answer is never replaced because another model looks more
  accurate, so a normal scan still costs one call; if every model truncates, the last usable partial
  recipe is kept with a warning. **Settings → AI → Recipe vision models** (or
  `OPENAI_RECIPE_VISION_MODELS`) overrides the list; one entry opts out. On OpenRouter the default chain
  follows the one-photo observations in [`docs/recipe-ocr-evaluation.md`](docs/recipe-ocr-evaluation.md)
  — Gemini 3 Flash Preview, Qwen3.6 35B (reasoning automatically off) and Gemini 3.8 Flash — while
  OpenAI, Ollama, LM Studio and every other endpoint keep their configured vision model, so OpenRouter
  IDs are never imposed on another provider. A deliberately chosen vision model is always tried first.
  Every attempt is visible: the scan warning names the failed models, the review card shows the winning
  model, `aiCost` and the AI call log include all attempts (with `visionChain`/`visionIndex` metadata),
  and the locally parsed draft survives when every model fails. The shared helpers live in
  `shared/recipe-vision.ts`.
- **Developer recipe-vision benchmark.** `npm run recipe-vision:benchmark -- <manifest.json>` compares
  user-supplied model IDs on real photos with the production prompt and output budget, and scores every
  answer against a written ground truth or an explicitly named reference model, reporting cost, tokens
  and failures. The manifest may only reference photos by path; API keys, tokens, passwords and inline
  image data are rejected, and the report never contains image bytes. See
  [`docs/recipe-ocr-evaluation.md`](docs/recipe-ocr-evaluation.md).
- **Recipe-scan reasoning control.** **Settings → AI → Recipe reasoning** chooses `auto` (default),
  `off`, `low`, `medium` or `high` for recipe scans only; receipt scans, ideas and recipe cleanup are
  unchanged. The value is sent to OpenRouter as its `reasoning` field, and an endpoint that rejects
  the field is retried without it. A response that contains only hidden reasoning, or that hits the
  token limit before writing an answer, is retried once with reasoning disabled and reported in the
  scan warning; a truncated answer that still parses is kept with a warning. If the retry fails, the
  locally parsed draft is kept rather than showing an empty recipe. The AI call log now records the
  finish reason, reasoning tokens and retry notes. One-photo OpenRouter observations (not a
  benchmark) are in [`docs/recipe-ocr-evaluation.md`](docs/recipe-ocr-evaluation.md): two Gemini 3
  models read the key quantities correctly, the two cheaper Gemini 2.5 models misread `2` as `9`,
  Qwen3.6 35B needed reasoning disabled and Qwen3.7 was rate limited.
- Open Food Facts lookups now cover all four databases: Open Food Facts, Open Beauty Facts, Open Pet
  Food Facts and Open Products Facts. A universal barcode lookup reports which project owns the
  product, the shared cache is keyed by project, and product cards show a Food/Beauty/Pet food/Products
  badge. Name search remains full-text for food; the other projects search the local cache and say so.
- Opt-in contributions back to Open Food Facts. Signed-in users can connect an OFF account (or use an
  instance account), review which local fields are missing from the product, and queue a safe additive
  edit or front photo. A dedicated **Contribute** page ranks eligible items, shows blockers, and keeps
  a history with retry/cancel. Passwords are never stored; session cookies are encrypted at rest and
  writes are disabled unless `SV_OFF_WRITE_ENABLED=true`.
- Contributions now cover all four product databases, with separate account links for beauty, pet food
  and general products. The same page shares receipt prices through **Open Prices** (with the receipt
  as proof), files wrong-project reports through **NutriPatrol**, and offers optional **Robotoff**
  verification questions. Several ready items can be shared in one batch.
- Open Prices and Folksonomy bearer tokens are stored encrypted per user; the instance account can be
  used as a fallback. A Folksonomy property endpoint is available for advanced automation.
- **Bill OCR.** Drop a utility-bill PDF or photo on **Bills & splitting** and SVault fills the supplier,
  amount and due date, then extracts the breakdown: individual charges, every tax line (VAT, municipal
  fees, stamp duty) and consumption prices per kWh or m³. PDFs with a text layer are read directly;
  scanned PDFs and photos use the same on-device Tesseract OCR as receipts, so nothing is uploaded.
  The breakdown is reviewable before saving, stored with the bill, and can be re-read later. Bill
  attachments now accept photos as well as PDFs. A **Take a photo** button opens the phone camera and
  always produces a JPEG; camera-roll photos the browser can decode (HEIC on Safari, plus AVIF, GIF,
  BMP and TIFF) are converted to JPEG before upload, and other browsers ask for the camera button or
  a JPEG instead of uploading a file nothing can read.
- **Espresso log.** Mark a bag of coffee beans as espresso and keep a tasting history with 1-5 star
  ratings, roast level, grind setting and time, dose, yield, extraction time, water temperature,
  pressure, TDS, grinder, machine, flavour tags and notes. SVault computes the brew ratio and extraction
  yield, summarises averages per bean, and adds a house-wide **Espresso log** screen for comparing
  shots. Everyone can read the log; members edit their own shots and admins can edit any.
- Espresso shots accept decimal grams and seconds, with either a dot or a decimal comma. Machines and
  grinders can be saved once and picked from a dropdown when logging a shot, with inline creation from
  the shot form and a **Machines & grinders** manager on the Espresso log screen. Renaming or deleting
  saved equipment keeps the name recorded on past shots.
- House admins can enable PosoKanei price lookups on the shopping list. Members explicitly check a
  linked item's exact barcode; SVault caches results and applies per-user and instance-wide request
  limits. External offers remain separate from recorded purchase prices.
- A new **Insights** page brings spending together: monthly budget and progress, spend by month, shop
  and category, waste value, price alerts, a use-it-up view with matching recipes, cheapest-shop hints
  for open shopping-list lines, and a household split with settle-up suggestions. Each house stores its
  own monthly budget, price-alert threshold and use-it-up horizon.
- Price alerts compare each purchased unit price with the item's average and create one in-app reminder
  per item and month when it is above the house threshold. They run after a receipt import and on
  demand.
- Receipts now record who paid and who shares the cost. The Insights page edits the payer or shares a
  receipt with everyone, and shows per-member balances and transfers.
- E-receipt import: paste the text of an emailed receipt or PDF, or an e-invoice JSON payload, into
  **Purchases -> E-receipt**. It is parsed into the usual reviewable draft and saved through the normal
  import, so duplicates, units and stock rules still apply.
- An instance **Admin** console for the administrator: people (including developer and admin flags),
  registration mode (open, invite-only or closed) without a restart, active sessions with revoke,
  orphaned-upload cleanup, and AI spend by house with a monthly instance budget that pauses AI calls
  when it is reached.
- Read-only API tokens for Home Assistant, Grafana and scripts, managed on the profile page. Tokens are
  shown once, stored hashed, limited to GET requests, and can be revoked at any time.
- Waste movements now keep the weighted price of the batches they came from, so waste analytics can
  report its cost.
- A detailed AI call log now records every request sent to the configured provider: receipt scans,
  bulk intake, recipe scans, recipe completion, food ideas and connection tests. Each entry keeps the
  operation, house, user, model, provider host, HTTP status, retry count, duration, token counts, cost,
  image count, request/response sizes, truncated prompt and answer previews, error text and operation
  metadata. Failed calls are logged too, and the same records are mirrored to stdout as structured
  `[ai] {...}` JSON lines for Docker, Loki, Grafana or another log collector.
- Developer mode on the profile page. Turning it on reveals a **Developer → AI call log** page with
  filters for operation, result and member scope, live totals for calls, errors, tokens and spend,
  auto-refresh, JSON export and a clear action for admins. API keys never appear in the log.
- AI receipt scans and recipe scans now record what the AI call cost. The price is taken from the
  provider when it reports one, or estimated from optional prompt/completion prices in
  **Settings → AI**, and is shown next to the scan and on the saved receipt or recipe.
- Photos open in a full-size viewer wherever they appear, not only for inventory items: recipe
  photos and original scans, receipt photos, scan previews and OpenFoodFacts product images all open
  on click or tap. The image keeps its aspect ratio, and the viewer closes with its close button,
  Escape or a tap outside the image.
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
- A long receipt can be scanned from several overlapping photos. Each page is straightened and OCR'd
  on its own, the repeated lines where two shots overlap are dropped before parsing, and the pages are
  stitched into one image for the stored scan. Pages can be reordered, removed or OCR'd again before
  reading the receipt.
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
- **Live updates between members.** Inventory, item details, the shopping list, the meal plan,
  purchases and the reminder bell now refresh when another member changes them, delivered as minimal
  Server-Sent Events that carry no household data. The stream has a heartbeat, backed-off reconnection,
  pauses while the tab is hidden and falls back to 90-second polling when it is unavailable. Removing a
  member closes their stream. `LIVE_UPDATES=off` disables it, and reverse-proxy notes are in
  [docs/deployment.md](docs/deployment.md#live-updates-and-streaming-proxies).

### Changed

- Repository documentation split into a user guide, architecture, API reference, deployment,
  development and roadmap.

### Fixed

- Recipe edits preserve ingredient links and notes and step timers. Replacing a recipe scan no longer
  reuses a previous photo or OCR result; the espresso form and photo filters also work on small screens.

- Archive upload cleanup now covers Multer errors while keeping deletion inside the temporary destination. PDF.js 6 is smoke-tested in CI, and the Docker runtime enforces its Node.js engine floor.
- Bill photo resizing now treats a positive-infinite edge limit as “do not downscale”; invalid nonpositive or NaN limits still produce a valid minimum canvas.
- Deleting an item now removes its low-stock and expiry reminders, and the reminder scan
  cleans up orphaned reminders left behind by earlier deletions or restores.
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
