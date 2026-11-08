# Open Food Facts staging runbook (manual)

This runbook validates the contribution paths **without letting SVault send anything**. Keep
`SV_OFF_WRITE_ENABLED=false` and `SV_OFF_DRY_RUN=true` until every step below passes.

> Do not run these write commands against production. Use the staging server
> `https://world.openfoodfacts.net` and a separate staging account. Production and staging have
> different account databases.

## 1. Read-only smoke check

```bash
node scripts/off-staging-check.mjs            # prints the manual commands, no network
node scripts/off-staging-check.mjs --check    # GET-only smoke test against staging
```

The script never performs a write. `--check` only reads one product per project and the universal
endpoint. Staging uses HTTP Basic `off:off` to bypass search-engine protection.

## 2. Create a staging account and session

1. Create an account on `https://world.openfoodfacts.net`.
2. Store the username in `OFF_USER` and keep the password in your shell history-free prompt.
3. Obtain a session cookie:

```bash
curl -i -X POST 'https://world.openfoodfacts.net/cgi/session.pl' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "user_id=$OFF_USER" \
  --data-urlencode "password=$OFF_PASSWORD"
```

Copy the `session=...` pair from `Set-Cookie`. Export it:

```bash
export OFF_COOKIE='session=...'
```

Sessions are IP-bound and limited per user. Use the same network for the whole check.

## 3. Product edit (manual)

Use a product you created on staging. Replace `CODE`, `LC` and the values.

```bash
curl -sS -X POST 'https://world.openfoodfacts.net/cgi/product_jqm2.pl' \
  -H "Cookie: $OFF_COOKIE" \
  -H 'User-Agent: SVault-staging-check/1.0 (you@example.com)' \
  -F "code=CODE" \
  -F 'app_name=SVault' \
  -F 'app_version=1.2.0' \
  -F 'app_uuid=manual-staging-check' \
  -F 'comment=SVault manual staging check' \
  -F 'lc=en' \
  -F 'cc=GR' \
  -F 'add_brands=Test brand' \
  -F 'add_categories=Test category'
```

Expected: JSON with a success status. Re-read the product with `GET /api/v3/product/CODE.json` and
confirm only the intended fields changed.

## 4. Front photo (manual)

```bash
curl -sS -X POST 'https://world.openfoodfacts.net/cgi/product_image_upload.pl' \
  -H "Cookie: $OFF_COOKIE" \
  -H 'User-Agent: SVault-staging-check/1.0 (you@example.com)' \
  -F 'code=CODE' \
  -F 'imagefield=front' \
  -F 'imgupload_front=@/path/to/front.jpg'
```

Expected: `status: "status ok"` and an `imgid`. Confirm the image is selected on the product page.
Only upload a photo you took yourself; it is published under CC-BY-SA.

## 5. Nutrition (manual, food only)

SVault sends `nutrition_data_per` plus `nutriment_*` fields. Verify one product where the panel is
missing:

```bash
curl -sS -X POST 'https://world.openfoodfacts.net/cgi/product_jqm2.pl' \
  -H "Cookie: $OFF_COOKIE" \
  -H 'User-Agent: SVault-staging-check/1.0 (you@example.com)' \
  -F 'code=CODE' \
  -F 'nutrition_data_per=100g' \
  -F 'nutriment_energy-kcal=250' \
  -F 'nutriment_fat=10' \
  -F 'nutriment_carbohydrates=30' \
  -F 'nutriment_proteins=5' \
  -F 'nutriment_salt=0.8'
```

If the field names differ, update `nutritionForm()` in `server/services/off/writer.ts` before
enabling writes.

## 6. Other projects

Repeat the product edit and photo steps on the owning domain:

- `https://world.openbeautyfacts.org`
- `https://world.openpetfoodfacts.org`
- `https://world.openproductsfacts.org`

Accounts are per project. Confirm that nutrition is rejected/ignored on beauty and general products.

## 7. Open Prices (manual)

Open Prices has no separate staging deployment. Use a real test product and delete the test price
afterwards.

1. Authenticate:

```bash
curl -sS -X POST 'https://prices.openfoodfacts.org/api/v1/auth' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "username=$OFF_USER" \
  --data-urlencode "password=$OFF_PASSWORD"
```

2. Upload the receipt as proof:

```bash
curl -sS -X POST 'https://prices.openfoodfacts.org/api/v1/proofs/upload' \
  -H "Authorization: Bearer $PRICE_TOKEN" \
  -F 'file=@/path/to/receipt.jpg' \
  -F 'type=RECEIPT'
```

3. Submit the price:

```bash
curl -sS -X POST 'https://prices.openfoodfacts.org/api/v1/prices' \
  -H "Authorization: Bearer $PRICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "product_code": "3017620422003",
    "product_name": "Test product",
    "price": 1.99,
    "price_per": "UNIT",
    "currency": "EUR",
    "date": "2026-11-08",
    "type": "PRODUCT",
    "proof_id": 123
  }'
```

4. Delete the test price with `DELETE /api/v1/prices/{id}`.

## 8. NutriPatrol (manual)

NutriPatrol accepts the OFF `session` cookie:

```bash
curl -sS -X POST 'https://nutripatrol.openfoodfacts.org/api/v1/flags' \
  -H "Cookie: $OFF_COOKIE" \
  -H 'Content-Type: application/json' \
  -d '{
    "barcode": "3017620422003",
    "type": "product",
    "url": "https://world.openfoodfacts.org/product/3017620422003",
    "user_id": "YOUR_OFF_USERNAME",
    "source": "web",
    "flavor": "off",
    "reason": "wrong_data",
    "comment": "Manual staging check"
  }'
```

Use a product you own or a deliberately wrong test product. Moderators see every flag.

## 9. Folksonomy (manual)

```bash
curl -sS -X POST 'https://api.folksonomy.openfoodfacts.org/auth' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "username=$OFF_USER" \
  --data-urlencode "password=$OFF_PASSWORD"
```

Use the returned `access_token`:

```bash
curl -sS -X POST 'https://api.folksonomy.openfoodfacts.org/product' \
  -H "Authorization: Bearer $FOLK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"product":"3017620422003","k":"test-property","v":"test-value","version":1}'
```

The API is experimental; do not use it for production data until it is stable.

## Review map

When reviewing the implementation, start with these files:

- `server/services/off/auth.ts`, `secrets.ts` — account link, encrypted sessions/tokens.
- `server/services/off/contributions.ts`, `writer.ts` — queue, retries, allow-listed payloads.
- `server/services/off/eligibility.ts`, `prices.ts`, `reports.ts`, `robotoff.ts`, `folksonomy.ts` — candidate detection and secondary services.
- `server/database/sqlite.ts`, `server/database/postgres-schema.ts` — `(project, code)` cache migration and contribution tables.
- `server/routes/off.ts` — API surface and consent gates.
- `client/pages/ContributionsPage.tsx` — contribution review, account links, bulk and errors.

## 10. Enable SVault writes
Only after the staging checks pass:

```bash
SV_OFF_WRITE_ENABLED=true
SV_OFF_DRY_RUN=false
SV_OFF_CONTACT=you@example.com
SV_OFF_CONTRIB_PROJECTS=off,obf,opff,opf
```

Start with one project (`SV_OFF_CONTRIB_PROJECTS=off`) and one test item. Watch the contribution
History for `sent`, then confirm the product on Open Food Facts. Increase the project list only after
each one passes.

## Rollback

- A wrong product edit is reversed with another explicit edit that restores the previous value.
- A wrong image can be unselected from the product's image editor.
- A test price can be deleted through the Open Prices API.
- A flag can be withdrawn by contacting the moderators; avoid filing test flags where possible.
