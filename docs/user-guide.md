# User guide

This guide walks through SVault from the first login to a populated vault. It assumes SVault is
already running; if not, follow the [quick start](../README.md#quick-start-docker) or the
[deployment guide](deployment.md).

![Desktop dashboard](screenshots/desktop-dashboard.png)

## 1. First login

Open the URL printed by your deployment (for example `http://localhost:8080`).

1. Create an account with your name, email and a password of at least 8 characters. You can pick a
   username (or let SVault derive one from your email) and sign in with either the username or the
   email from then on.
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

- A house has one owner. In **Settings -> Members** the owner can press **Make owner** on another member
  and confirm by typing the house name. The transfer is atomic, the target is notified, the former owner
  becomes an admin and can then leave. The owner cannot be demoted or removed without transferring first.
- Invites are links, not emails. Create an invite, copy `/join/<code>` and send it yourself. Only
  the email address you entered can accept it. This also applies to people who already have an
  account: they are not added silently, they join when they open the link and accept.
- After the first account, new people can only sign up through an invite link (unless the server
  administrator set `SV_REGISTRATION=open`).
- Invite links expire after 14 days by default. Revoked links stop working immediately; revoke or
  remove expired ones in **Settings -> Members**.
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
- Use the **All shops** selector on the price chart to compare one shop's prices, then switch back to
  all shops. Every purchase is listed underneath with date, shop, quantity, entered price and
  normalised per-unit price.
- Price history is derived from purchase movements. Editing or deleting movements later can change
  the chart.

## 4. Everyday inventory tasks

### Add an item

1. **Inventory -> New item** (or the `+` button).
2. Enter a name, choose a category and base unit.
3. Optionally set a reorder point, target stock, brand, attributes, tags and barcodes.
4. You can add an initial batch at the same time: quantity, price, place, purchase date, shop and expiry.
5. Add a photo to make the item easy to recognise.

Click or tap any photo in SVault — in the inventory list, on an item, recipe or receipt, or on a scan
preview — to open it full-size. Press Escape, tap outside the image or use the close button to return.

Attributes are defined per house in **Settings -> Attributes**. Supported types are text, number,
select, date, boolean and URL.

### Add a receipt and record the shop

1. **Inventory -> Receipt** (or **More -> Receipts & shops -> Scan receipt**).
2. Take a photo of the paper receipt or upload one or more from your photo library. Every page is found
   and straightened automatically — the table around it is trimmed and perspective is corrected — and
   OCR runs on each page separately in the browser. For a long receipt, photograph it in overlapping
   shots: the duplicate lines where two shots overlap are dropped, and the pages are stitched into one
   image for the stored scan. Each page photo can also be sent to an AI vision model when you request an
   AI re-read. Reorder or remove a page from the thumbnail strip, then correct any lines it misread
   before pressing **Read receipt**.
3. The shop printed on the receipt is detected automatically and matched to your existing shops. Known
   layouts are parsed with a shop-specific template — Lidl Greece, Sklavenitis Greece and My market Greece are built in,
   including weights, quantity lines, barcodes and store discounts. The receipt header shows whether it
   was read by **AI**, a **template** or the **local** parser. Alternative OCR passes are compared using
   template arithmetic when the OCR text has not been edited. AI is used only when you select **Re-read with AI**.
   A matching total does not guarantee every name or price is correct. Check the shop, purchase date, total,
   **net**, **tax/VAT** and **money saved**. When the receipt prints VAT rates they are read as a split;
   you can correct the total, net and tax before importing. Every product line can be excluded, renamed,
   given a quantity, unit and price, or pinned to an existing item with the search under each line.
   Lines without a match create new items; the header counts how many. Open a line's **⋯** details to
   put it in a different place than the rest of the receipt or to give it a best-before date.
4. Above the save button a bar compares the lines with the receipt total: green when they match, amber
   with the gap when something is missing or read twice. With AI configured, **Re-read with AI** asks AI
   to read the receipt again (it replaces the current lines).
5. Press **Add lines to inventory**. SVault checks every line first and marks the ones that cannot be
   imported — for example a line in pieces for an item stocked in litres — so you can fix them all at
   once. If the same shop, date and total were already saved, you are asked before the stock is added a
   second time, with a link to the saved receipt. Each line becomes a stock batch with the price,
   purchase date and shop attached. The receipt, its photo and the line details stay under **Receipts**.
   Click the photo there to open the original scan full-size.

The scan is saved on your device while you work, so a phone that reloads the page after taking a photo
does not lose it. When you come back you can **Resume** the unsaved receipt or **Discard** it. Saving
the receipt or pressing **Start over** removes the draft and the photos it uploaded.

**Delete record** on a receipt removes the receipt, its lines and its photo. The stock it added stays in
inventory unless you tick **Also remove the stock this receipt added** — useful after a receipt was
imported twice. Only what is still in stock is removed; anything already used is reported and left
alone.

Correcting a line — for example pinning `ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG` to your “Flour” item — teaches SVault that
shop's name for next time. Automatic matches by a similar name are not remembered: only items you chose
and new items created from a line are. The original receipt name is stored with the line, and the alias is reused on
future receipts from the same shop. Lines that are only carrier bags or packaging fees are skipped by
the Lidl template; Sklavenitis keeps the printed barcodes, so a line can match an item by barcode.
Separate discount lines are never imported as products: their amounts are applied to the relevant
product where possible and always summed into the receipt's **money saved** total.

The **Insights** tab adds up receipts: total spend, net and tax, average basket, spending by month,
spending by shop, the VAT split and spending by item category. Pick 3, 6, 12 months or all time. Tax
figures use what was recorded on each receipt; net falls back to total minus tax, or to total when no
tax was entered.

### Insights, budgets and the household split

**More -> Insights** is the money view across the whole house. It shows this month's spend against a
monthly budget, spending by month, shop and category, the value of stock written off as waste, price
alerts, what is about to expire and who owes whom. Open it from the main menu or **More**.

- **Budget**: a house admin sets a monthly budget and a price-alert threshold in **Insights**. The
  dashboard shows what is left; over 80% is amber and over 100% is red.
- **Price alerts**: after each receipt import, SVault compares the unit price you paid with the
  average of your previous purchases of that item. When it is above the threshold, an in-app reminder
  is created once per item and month. **Check prices** runs the comparison on demand.
- **Cheapest shops for your list**: each open shopping-list line shows the best unit price seen on a
  receipt in the last six months and the shop it came from.
- **Use it up**: stock expiring in the next days, grouped by item, with recipes that use those
  ingredients and how many other ingredients are still missing.
- **Household split**: the payer and the people sharing each receipt. Balances are money paid minus
  money owed, and SVault suggests the smallest set of transfers to settle up. Change the payer or
  share a receipt with everyone from the recent-receipt list. New receipts default to the person
  importing them, split across everyone in the house.
- **Waste**: the recorded value of stock removed with **Waste** (rather than eaten or used), by month
  and by item, using the weighted price of the batches it came from.

### Importing an e-receipt

**Purchases -> E-receipt** imports a receipt without a photo. Paste the text of an emailed receipt, the
text copied from a PDF, or an e-invoice JSON payload. SVault parses it into the same reviewable draft
as a scan — shop, date, total and product lines — and saves it through the normal import, so unit
checks, duplicate detection and stock movement rules still apply. Nothing is written until you press
**Save receipt**.

The **Shops** tab lists the places you buy from. A shop is created automatically the first time a
receipt uses a new name. You can also pick one under **Where from** when adding stock or an initial
batch, and it is shown on the item's batches and history.

**Suggested** opens a catalogue of common Greek supermarkets, delis, kiosks, markets and online shops.
Adding one creates a normal house shop; missing chains and local shops can still be added by hand. The
catalogue is keyed by country, so more countries can be added later.

### Receipt templates

**Purchases -> Templates** lists the built-in Lidl Greece and Sklavenitis Greece templates and any custom
templates. Templates control how a shop's layout is parsed: where products start and end, the product
line pattern, quantity and weight follow-ups, discount lines, receipt-level savings lines, the totals
line and the VAT table.

- **Clone** the Lidl or Sklavenitis template as a starting point, or create a new one.
- Detection keywords decide which template is used. Each matching keyword raises confidence; the
  template is only chosen above its threshold. Unknown layouts fall back to the generic parser or AI.
- Paste a real receipt's OCR text and press **Test rules** to see parsed products, totals, tax split and
  discounts before saving.
- Patterns are regular expressions with named groups such as `name`, `total`, `rate`, `qty`,
  `unitPrice`, `unit`, `amount`, `net`, `tax` and `gross`.
- Templates are versioned and can be deactivated without deleting them.

### Product names and aliases

Receipt names are often shortened or shop-specific. SVault handles this in two ways:

- Every correction or pinned line is remembered as a vendor-specific alias (`ΑΛΕΞ.ΛΕΥΚ.ΑΣΠ.1KG` →
  your flour item). The scan screen also suggests products using existing aliases and a local
  similarity search, showing a confidence percentage; tap **use** to accept a suggestion. Only
  suggestions from an alias or near-certain ones are picked for you.
- On an item page, **Receipt names** lists all aliases for that item. You can add a name manually and
  choose “Any shop” or a specific shop, or remove names that are wrong. One item can have many aliases.
- When a line resolves to an OpenFoodFacts product, the pair is also stored in a **shared product
  catalogue**. The catalogue is instance-wide, ships with bundled mappings, and can be exported,
  imported or synced by an instance admin under **Settings → Data → Product catalogue**. Local
  corrections always win over bundled or imported data.

### Change stock

Open an item and use the stock dialog. There are five actions:

| Action | What it does |
| --- | --- |
| **Add** | Creates a new batch. Optionally records unit price, place, shop, purchase date and expiry. |
| **Remove** | Consumes stock FIFO: soonest expiry first, then oldest purchase. |
| **Waste** | Same as remove, but records a `waste` movement so waste is visible separately. |
| **Set** | Absolute count. SVault records the difference as an adjustment; use this after a physical count. |
| **Move** | Transfers quantity between two places without changing the total. |

Removing more than is available is rejected. Wasting or removing with a `locationId` restricts FIFO to
that place.

### Shelf life after opening

Set **Keeps for N days after opening** on an item, then use **Mark opened** on a batch and select its opening date. SVault shows the opening date and use-by date. **Not opened** clears the date. The use-by date is the earlier of the printed expiry and the opening date plus the shelf life; it drives expiry reminders, the dashboard, expiring filter and Use it up. Moving stock preserves its opening date. Consuming stock does not automatically mark a batch opened.

### Barcodes and scanning

- Each item can hold several barcodes, unique per house.
- **Scan** opens the rear camera (ZXing). On plain HTTP or a browser without camera support, type the
  code instead.
- A known code opens the matching item.
- An unknown code is looked up on OpenFoodFacts. If found, the name, brand, description, quantity and
  image pre-fill the new-item form. The lookup is cached for 30 days and times out after six seconds,
  so offline use still works.

### OpenFoodFacts product links

- The item page has an **OpenFoodFacts** card. If the item is not linked, press **Link product** and
  search by name or paste a barcode. You can also link from a receipt line while scanning.
- Linking fills only empty fields: description, brand, image and a matching house category. It also
  attaches the product code as an item barcode. Values you already set are never overwritten.
- **Fill empty fields** re-applies the product after you have edited the item. **Change** picks another
  product; **Unlink** removes the link but keeps everything already filled.
- The card shows the product image, Nutri-Score, NOVA group, labels, allergens and ingredients. Click
  the product image to open it full-size. The complete OpenFoodFacts payload stays cached on the server.
- Linking also stores the nutrition panel from OpenFoodFacts: energy (kcal and kJ), fat, saturates,
  carbohydrate, sugars, fibre, protein, salt and sodium, normalised per 100 g or 100 ml. Existing
  nutrition values are never overwritten by a later sync.
- Nutrition can also be entered by hand in the item editor, for products OpenFoodFacts does not cover.
  Values are kept per 100 g or 100 ml, with an optional serving size and serving weight. The serving
  weight lets recipes estimate count-based ingredients such as eggs or yogurt cups.
- Receipt lines show an **OpenFoodFacts** badge when a cached product or shared mapping matched. Use
  **Find OpenFoodFacts** to confirm or change a line before importing; the chosen code is sent with the
  line.
- You can also scan from an item page to attach a code to an existing item.
- Barcode lookups cover Open Food Facts, Open Beauty Facts, Open Pet Food Facts and Open Products
  Facts. Product cards show a Food, Beauty, Pet food or Products badge.

### Contributing back to Open Food Facts

- Open **Contribute** in the sidebar. SVault ranks local items whose Open Food Facts product is
  missing a brand, category, nutrition panel or front photo, plus valid barcodes that are not in any
  database yet.
- Connect your own Open Food Facts account with your username (not email) and password. The password
  is used once to obtain a session and is never stored; SVault keeps an encrypted session cookie.
  Alternatively the administrator can configure a shared instance account.
- Accept the license once. Data is public under the Open Database License; photos are CC-BY-SA, so
  only upload photos you took yourself.
- Press **Review**, untick anything you do not want to share, then **Share**. The item is queued and
  sent in the background. The **History** section shows sent, queued and failed contributions with
  retry or cancel when relevant. Select several ready cards to share them in one pass.
- **Share receipt prices:** connect **Open Prices** with the same Open Food Facts account, then share a
  receipt line. The receipt photo is uploaded as proof and only that line's unit price is submitted.
  This is opt-in per line and is separate from product edits.
- **Report a product:** when a barcode lives on the wrong project (for example a beauty product in Open
  Food Facts), SVault offers a report instead of creating a duplicate. Reports go to the Open Food
  Facts moderators through NutriPatrol.
- **Help verify:** when Robotoff has a question, an optional card lets you answer yes/no/skip. It is
  never required and disappears if the service is unavailable.
- Connect separate accounts for Open Beauty Facts, Open Pet Food Facts and Open Products Facts if you
  want to contribute to those databases; the account card lists each connection and lets you remove it.
- Nothing is sent automatically. A successful write refreshes the local product cache. Administrators
  can enable a dry run that validates and queues contributions without sending them.

### Espresso log

Coffee beans can keep a tasting and dial-in history. Open the item, turn on **Espresso coffee** in the
editor (or enable **Track espresso shots** when creating it), and save. The item page then gets an
**Espresso log** card.

- Press **Log shot** and give the espresso a 1-5 star rating. Everything else is optional, so a quick
  rating is enough.
- Record the roast level, grind setting, grind time, grinder, machine, dose, yield, extraction time,
  water temperature, pressure and TDS. Grams and seconds take decimals, so `18.5` g or `28.4` s (and a
  decimal comma like `18,5`) are fine. SVault calculates the brew ratio (for example `1:2`) and the
  extraction yield from dose, yield and TDS as you type.
- Save your machines and grinders once with **Machines & grinders** on the **Espresso log** screen, then
  pick them from the dropdowns when logging a shot. You can also add one from the shot form with **New**.
  Renaming or deleting saved equipment does not change the name recorded on past shots.
- Add tasting notes, flavour tags and free notes. Each shot keeps who brewed it and when.
- The card shows the average rating, average ratio and average extraction time. Open **Espresso log**
  under **More** (or the sidebar) to compare every coffee, filter by bean and see the best shots.
- Everyone in the house can read the log. Members can edit or delete only their own shots; admins and
  the owner can edit or delete any shot. Deleting the coffee item deletes its shots. If you turn the
  espresso flag off later, new shots stop being accepted but the existing history stays in the
  house-wide log until you delete it.

### Low stock and expiry

- An item is low when its quantity is at or below its reorder point. Set the reorder point to `0` to
  disable the reminder for that item.
- Expiry reminders cover batches with quantity left whose expiry is within the configured number of
  days (7 by default). Expired batches are flagged separately.
- Reminders are recalculated after every stock change and by a scan at boot and every 30 minutes.
- **Reminders** shows the active list across every house you belong to. Being added to a new house
  creates a notification for you, even before you switch to it.
- Press the bell icon to enable browser notifications; they only arrive while SVault is open in a tab.
  Add ntfy, Apprise or a webhook under **Settings -> Reminders** to get reminders when SVault is closed.
  Secrets are masked, deliveries retry three times and failed attempts are visible in the same tab.

### Search, filters and bulk actions

The inventory page supports free-text search, category and place filters, low-stock and expiring
filters, sorting by value, and inline `+/-` one-unit adjustments. The dashboard repeats the most
useful slices: running low, use-it-up (expiring), places and recent activity.

## 5. Recipes

### Add a recipe manually

**Kitchen -> New recipe**. Ingredients have a name, optional quantity and unit, an optional link to an
inventory item, and an optional/required flag. Steps are free text; a timer can be attached to a step.

### Import a recipe from a link

1. **Kitchen -> Import link** (or open the importer from the recipe editor).
2. Paste the address of a public recipe page and press **Import**.
3. SVault reads the page. Most cooking sites publish schema.org recipe data, so ingredients, steps,
   yield and timings come through exactly. A page without that data is read as text, and when an AI
   provider is configured the copy is structured automatically. The badge on the preview says which
   path was used.
4. Review the title, ingredients and steps, then **Save recipe**.

The recipe keeps a link to the original page. Import only fetches the public page; sites that block
automated visits can still be used by opening the page yourself and pasting its text into the scanner.

### Scan a handwritten recipe

1. **Kitchen -> Scan recipe**.
2. Photograph the card. The image is compressed in the browser and uploaded as the source image. Click
   the preview or the original scan on the recipe page to view it full-size.
3. Tesseract OCR runs **in the browser** using assets served from `/tesseract`, with **English and
   Greek** language data loaded together. The language is decided by the page, not by the interface:
   a Greek notebook is read in Greek even on an English UI. Handwriting is a known limit of Tesseract;
   when the reading does not look like words, use **Read the photo with AI** so the configured vision
   model reads the photo itself. When an AI provider is configured, digitising sends the photo to it;
   without one, the photo never leaves your browser and only the OCR text is parsed locally.
4. Notebook and diary pages work too. The page is straightened, cropped to the sheet so the desk and
   the neighbouring page drop out, and read with the ink colour emphasised when the ink is blue, with
   a plain grayscale reading as the fallback. The printed planner frame (hour gutter, weekday and
   month headings, week numbers, printer codes) is removed from the recognised text before parsing.
   Cleanup never hides anything: **Raw OCR text (before cleanup)** shows the untouched reading and
   **Use the raw text** puts it back.
5. Correct the recognised text if needed and press **Digitise**.
6. The server cleans the text:
   - with an AI provider, it reads the photo directly and returns structured ingredients and steps,
     noting any inferences;
   - without one, a local parser handles sections, quantities, fractions, ranges and timers, plus
     handwritten Greek abbreviations (`γραμμ.`, `φλιτζ.`, `κουτ.`, `κ.γ.`), quantities written as
     words (`μισό`, `δύο`), mixed fractions and ditto marks (`»` repeats the unit above).
7. If more than one recipe is written on the page, each is listed separately. Pick one, review it and
   save it, then pick the next. Recipes are never merged into a single ingredient list.
8. Review the draft, edit anything, then save.

The recipe records which path was used (AI or local) and keeps the OCR text for reference. For the
measured accuracy of each path on real handwritten pages, see
[`docs/recipe-ocr-evaluation.md`](recipe-ocr-evaluation.md).

### Improve with AI

Open a saved recipe and press **Improve with AI**. The action fills missing quantities, times and
temperatures and rewrites unclear steps, noting what changed. It requires a configured provider and
member access.

### Calories per recipe and portion

Recipes estimate nutrition from their ingredients. Any ingredient whose name matches an inventory item
with a nutrition panel is scaled to the quantity and unit in the recipe. Ingredients you do not track
fall back to a small built-in table of typical values for common foods, so an imported recipe still
gets a sensible estimate. The recipe page shows the whole-recipe total and, when servings are set, the
calories and macros per portion. Recipe cards show a `kcal / portion` badge.

The page also estimates **weight**: the whole recipe in grams and the weight of one portion. Mass units
convert exactly, volume uses a typical density (a cup of flour is not a cup of water), and countable
units use a typical piece weight (an egg is about 50 g). The estimate reports how many ingredients
contributed; lines without a convertible unit keep their original measure.

The estimate is deliberately transparent. Add nutrition to the remaining items, or set a serving
weight on count-based products, to improve the number.

### Cook mode

Open a recipe and press **Cook mode**. Everything is scaled to the number of portions at the top:

- **−** removes a portion, **+** adds one, and **×2** / **÷2** multiply or halve the current amount.
- **Convert everything to grams** shows each ingredient as a weight. The original measure stays
  underneath, and lines that cannot be estimated stay in their own unit.
- The summary shows the weight and calories of one portion and of the whole scaled recipe.
- Tap ingredients and steps to tick them off while you cook. The screen stays awake where the browser
  allows it.

When you finish, press **Finish cooking** to review the scaled quantities for linked ingredients. Edit or untick any line; unlinked ingredients are marked as not tracked. Optionally save leftover portions with a location and use-by date (three days ahead by default). Confirm to deduct available stock, earliest expiry first. If stock is short, the confirmation shows the amount missing. Leftovers appear in inventory and expiry reminders. The saved recipe stays untouched.

### Cook from what you have

Every recipe shows ingredient availability against current stock. Matching is deliberately loose:
"eggs" matches "Free-range eggs". Missing ingredients are listed with quantities, which is the input
for the planned shopping list.

### Food ideas

**Food ideas** sends your prompt, current stock and saved recipes to the AI, or to the local matcher
when no provider is configured. Local suggestions rank saved recipes by ingredient coverage and add
inventory-only ideas. Saving an idea creates a normal recipe tagged `ai` and `idea`.

Nothing about stock, barcodes, prices or reminders is sent to an AI provider.

### Shopping list

**Shopping list** is shared by everyone in the house and survives restarts. Fill it from:

- a recipe: **Add missing to list** uses availability and stock, or **Add all (optional too)**;
- the dashboard or inventory **Add low stock** action, which adds each item up to `targetStock`;
- the meal plan: **Shopping list** merges the week's missing ingredients.

Lines merge by linked item first, then by name. Compatible units are summed; incompatible units stay on
separate lines. Grouping follows the item category. You can edit the quantity and note, add manual lines,
check an item off, or record the purchase: checking a line opens a compact quantity/price/place/expiry
form and creates a normal `in` movement. **Clear checked** removes bought lines.

Adding the same recipe or week twice is idempotent, so nothing is duplicated.

### Meal plan

**Meal plan** shows Monday to Sunday with breakfast, lunch, dinner and snacks. Add a saved recipe, a
saved food idea or a custom title to any slot. Each slot stores its own servings: changing them scales
the ingredient quantities without editing the recipe. Use the move and duplicate buttons (keyboard
accessible, no drag and drop) and **Shopping list** to build the week's missing ingredients.

### Bulk intake

**Bulk intake** accepts a receipt photo, pasted text, or a queue of scanned barcodes. Parsing only
suggests rows and never writes. In the review table you can edit every field, choose an existing item,
create a new one or skip the line. Commit validates everything first and applies the whole batch in one
transaction. Without an AI provider the local parser and manual editing still work.

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

### Import a dataset

**Photo library → Import dataset** accepts a zip with `images/` and `labels/` plus `classes.txt` or
`data.yaml` (YOLO), or `images/` plus `annotations.json` / `instances*.json` (COCO). The preview reports
the detected format, class list, train/val/test counts and per-file errors. Map each imported class to a
house label, or use `__skip` to drop it, then import. Files go into a new folder; boxes and splits are
preserved.

**Review** opens the review queue for unlabelled and classification-only photos. Use ←/→ to move, `S` to
cycle the split and `D` to delete (owner/admin). Bulk actions rename, merge or delete a label, reassign
splits and delete selected photos.

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
| Members | Invites, roles, removal, and explicit ownership transfer |
| AI | Provider preset, base URL, models, key, connection test |
| Reminders | Low-stock toggle, expiry window, ntfy/Apprise/webhook channels |
| Data | Inventory CSV import/export, backup/restore, dataset import/export, data location, house deletion |

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

When the AI provider is configured, the photo is sent to the vision model as the primary source and
the edited OCR text is attached only as a hint. Without a provider it sends only the edited OCR text,
and the scan is parsed locally. A text-only local model never receives images: if it rejects the photo,
SVault retries with the text alone and explains that handwriting needs a vision model.

### Recipe reasoning

Some models think before answering, and that can help or hurt a handwritten recipe scan. Under
**Settings -> AI -> Recipe reasoning** choose:

- **Use the model's default** (default) - SVault sends no reasoning setting.
- **Off - fastest** - ask the model not to think. Use this for hybrid models such as Qwen3 that
  otherwise spend the whole answer budget on reasoning.
- **Low / Medium / High** - ask for less or more thinking when the endpoint supports it.

The setting applies to recipe scans only; receipt scans, ideas and recipe cleanup are unchanged. It
is sent to OpenRouter as its `reasoning` field. Another OpenAI-compatible endpoint that rejects the
field is retried without it and the scan says so.

If a model returns only hidden reasoning, or the answer is cut off at the token limit, SVault retries
once with reasoning disabled on OpenRouter, which honours the field. This recovery only happens when
the setting is **Use the model's default** (`auto`): an explicit **Off / Low / Medium / High** is your
choice and is never overridden, so the failure is reported instead. Other endpoints may ignore or
reject the field, so they are not charged a second identical call. If an endpoint rejects the reasoning
field itself, the scan retries once without the field and the warning says the setting was rejected.
If the retry also fails, you keep the locally parsed draft instead of an empty recipe. The AI call log
shows the finish reason, reasoning tokens and the retry.

Model choice matters more than price. In one-photo OpenRouter tests, Gemini 3 Flash Preview
($0.001557) and Gemini 3.8 Flash ($0.002104) read the key quantities correctly, while the cheaper
Gemini 2.5 Flash ($0.00119) and Flash Lite ($0.0001895) misread a `2` as `9`. Qwen3.6 35B needed
reasoning disabled, and Qwen3.7 was rate limited (HTTP 429). These are single-photo observations, not
a benchmark: check the draft against the photo before saving.

### Recipe vision models and fallback

**Settings -> AI -> Recipe vision models** takes a comma-separated list of up to four model IDs. Recipe
scans try them in order and move to the next one only when an attempt fails: a provider error, a rate
limit, an empty answer, a truncation (even if the partial text parsed), or malformed JSON. A successful
complete answer is never replaced by a later model just because it might look more accurate, so a scan
costs one call unless something failed. If the chain ends without a complete answer but an earlier
model produced a usable partial recipe, that partial recipe is kept with a warning; a fragment with
only a title is not treated as a read. A partial recipe is never saved automatically: review it and
save it yourself.

The settings field accepts at most four model IDs. A longer list, or an entry that is not a model ID, is
rejected with an error instead of being cut down silently. The environment variable behaves
differently: if `OPENAI_RECIPE_VISION_MODELS` is longer than four, the extra models are dropped and the
scan warning says how many.

Leave the field empty for the provider default. On OpenRouter that is Gemini 3 Flash Preview, then
Qwen3.6 35B (reasoning is turned off for it automatically), then Gemini 3.8 Flash. On OpenAI, Ollama,
LM Studio and any other endpoint the list is not applied: only your configured vision model is used,
because the built-in IDs belong to OpenRouter. A vision model you chose yourself is always tried before
the defaults. To turn the extra fallbacks off, enter just your one preferred model.

Every attempt is counted: the AI call log includes the cost of a failed first attempt as well as the
model that finally answered, and the warning names each model that failed. When a page holds several
recipes, the review badge shows that recipe's share of the scan cost, so saving them all does not
multiply the same spend. When a provider reports no price for an attempt, the warning says so and the
shown cost may be lower than the actual spend. If all models fail, you keep the locally parsed draft and
the warning lists them. The review card shows the model
that produced the recipe.

To compare your own model IDs on your own photos, a developer can run the manual benchmark. It scores
answers against a written ground truth (or an explicitly named reference model) and reports cost; see
[`recipe-ocr-evaluation.md`](recipe-ocr-evaluation.md).


### AI call log and developer mode

Turn on **Profile → Developer mode → Show developer tools** to reveal **More → Developer**. The AI call
log shows every request sent to the provider: receipt scans, bulk intake, recipe scans, recipe
link imports, recipe cleanup, food ideas and connection tests. Each row expands into the model,
provider, HTTP status, duration, retries, token counts, cost, request/response sizes and truncated
prompt/answer previews.
Failed calls are included with their error, which makes a failing model or proxy easy to spot.

Use the filters to narrow by operation or result. Owners and admins can switch from **My calls** to
**Everyone in this house**, clear the log, or export the current view as JSON. API keys are never
stored in the log. The same records are printed to the server console as `[ai] {...}` JSON lines for
Docker, Loki, Grafana or another log collector.

## 9. Data, backup and moving house

- Everything is stored under `DATA_DIR`: `svault.db` (SQLite, WAL mode) plus `uploads/`.
- **Settings -> Data -> Inventory CSV** downloads the current inventory as CSV. It uses the API's
  1000-item page, so very large vaults should use the API or database directly.
- **Import inventory CSV** uploads a spreadsheet, maps its columns and shows a dry run before writing.
  Comma or semicolon files, quoted fields, a BOM, CRLF and decimal commas all work. `Create only` skips
  rows that already exist; `Update by barcode/name` matches barcode first and falls back to an exact
  name. Ambiguous names are skipped with a warning, and any bad row blocks the whole commit. Imported
  quantities become normal `in` movements.
- Dataset exports are generated on demand.
- For a full backup, copy the whole `DATA_DIR` (or the `svault-data` Docker volume). Stop the
  container first for the most consistent SQLite copy, or use `sqlite3 svault.db ".backup ..."`.
- **Settings → Data → Backup & restore** downloads a checksummed zip with a live SQLite snapshot and
  uploads. Because a backup holds every house and account on the server, only the instance
  administrator (the first account) sees this panel. The server keeps the last five backups in
  `DATA_DIR/backups`. Backups are written to disk as they are built, so large photo libraries do not
  need extra memory, only free disk space.
- Restore validates the archive, then saves a safety copy of your current data before anything is
  replaced, and returns 503 while it restarts. Safety copies live in `/data/backups/pre-restore`
  (`DATA_DIR/backups/pre-restore`), are listed separately as **Safety copies taken before a restore**
  and are never removed by new backups; the newest three are kept (`SV_PRE_RESTORE_KEEP`). To undo a
  restore, restore the matching `pre-restore-….zip`.
- The same operations are available as `npm run backup` / `npm run restore`; the CLI restore also
  takes a safety copy unless you pass `--no-safety-copy`.
- To move to another server, copy `DATA_DIR` to the new host and start the same image with the same
  `DATA_DIR`.

## 10. Security, language and offline use

### Two-factor authentication

Open **Profile → Two-factor authentication**, confirm your password, add the shown secret/otpauth URL to
an authenticator app and verify a 6-digit code. SVault shows eight backup codes once; store them safely.
Login then asks for the second step. A wrong code can be retried until the five-minute challenge expires.
Disable 2FA from the same card with your password and a current code.

### Passkeys

**Profile → Passkeys** registers one or more WebAuthn credentials after you are signed in. Name them
(e.g. "This phone"), remove them individually, and keep the password as a fallback. Passkeys require
HTTPS or localhost. The server stores only credential IDs, public keys, counters and transports.
Owners/instance admins can reset another user's passkeys.

### OIDC single sign-on

When `OIDC_ISSUER` and `OIDC_CLIENT_ID` are configured, the login page shows a single sign-on button.
Only verified email addresses are accepted; `OIDC_ALLOWED_DOMAINS` restricts them further. Existing
accounts are linked by email. Auto-provisioning is controlled by `OIDC_AUTO_PROVISION`. The first local
owner and password login remain available as a break-glass path.

### Language

Choose **English** or **Ελληνικά** in **Profile → Language**. The preference is stored on your account and
drives the dictionary plus locale-aware dates, numbers and currency. Greek receipt and recipe parsing
already works with either language.

### Offline stock queue

When the browser is offline, quick `+/-` and the stock dialog queue changes in IndexedDB instead of
losing the form. A banner shows pending changes, counts, sync progress and a discard action. They replay
in order on reconnect with idempotency keys. Absolute counts made against an older server version stop
with a conflict dialog where you can discard your count or retry on the new baseline. Closing the tab
warns while unsynced changes exist; reads are still network-only.

## 11. Troubleshooting

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

### Allergy and diet privacy

In Your profile, you can opt in to an allergy and diet profile for each household. Household members, including viewers, can see it; only you can edit or delete your own profile. It is removed when you leave or are removed from the household, or when your account is deleted. Profiles are health-related special-category data. They are stored in the vault and included in backups, so protect backup files accordingly. SVault does not send profiles to AI providers or Open Food Facts and does not log them.

Recipe, cook mode, food idea and meal plan warnings use linked inventory items and locally cached Open Food Facts information. Missing or incomplete product information can hide allergens, and unknown diet compatibility is not a safety confirmation. Check ingredient labels and suitability yourself.
### Category budgets and reminders

In Insights, house admins can set monthly budgets for individual categories and choose whether bills count toward household spending. Bills are excluded by default. Included bills count in their due month, or creation month if no due date is set; they do not count toward a category. Avoid entering the same expense as both a bill and a receipt. The projected month-end total assumes the current daily rate continues. The six-month history compares past totals with the current budget. Household and category reminders appear at 80% and 100% once per month and are delivered to enabled reminder channels.
### Run-out forecasts

Item details estimate when stock will run out based on consumption over the last 60 days (or the
item's shorter history, at least seven days). The
dashboard lists items expected to run out within seven days. Forecasts need at least two consumption
events seven days apart and a positive stock balance. Waste, stock corrections and moves do not count.
In the shopping list, turn on **Include items running out soon** and choose a horizon before using
**Add low stock** to include forecast items as well. Existing compatible shopping lines are merged.
