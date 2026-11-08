# Open Food Facts API spike

**Date:** 2026-11-08  
**Branch:** `feat/off-multiservice-contribution`  
**Purpose:** verify the assumptions in [openfoodfacts-platform.md](openfoodfacts-platform.md) against the
live services before building the adapter. No production writes were made.

## Method

Public reads were made with `curl` and the documented endpoints. Write endpoints were probed only with
empty bodies to confirm they exist; authentication and payload shape remain to be tested with a
dedicated staging account. One product per database was chosen from that database's own search API.

| Project | Sample barcode | Sample name |
| --- | --- | --- |
| Open Food Facts | `3017620422003` | Nutella |
| Open Beauty Facts | `3560070791460` | Carrefour anti-plaque dental solution |
| Open Pet Food Facts | `8057592732736` | Virtus chicken fillets with dandelion for cats |
| Open Products Facts | `5029053527574` | Huggies DryNites pyjama pants |

## Results

### Product reads

- `GET /api/v3/product/{code}` works on all four domains and returns `status: "success"`,
  `result.id: "product_found"` and a `product` object.
- `product_type` is present on the product: `food`, `beauty`, `petfood`, `product`.
- The universal lookup works exactly as documented:
  `GET https://world.openfoodfacts.org/api/v3/product/{code}?product_type=all`.
  - A beauty barcode returns `302` with `location: https://world.openbeautyfacts.org/...`.
  - A pet-food barcode redirects to `world.openpetfoodfacts.org`.
  - A general-product barcode redirects to `world.openproductsfacts.org`.
  - A food barcode returns `200` directly.
  - Following redirects with `fetch` gives the product and its `product_type`, which is enough to
    detect the owning project without parsing the URL.
- A missing/invalid barcode returns `errors` with `product_not_found` / `invalid_code` and no product.
- Project-specific data differs as expected:
  - OBF and OPF return `nutrition: {"input_sets": []}` and no nutriments.
  - OPFF returns `nutriments` and `nutrition_data_per` (the sample was per `1kg`).
  - No Nutri-Score/Green-Score fields were present on the non-food samples.

### Search

- `GET https://search.openfoodfacts.org/search?q=...&page_size=1&fields=...` returns `hits` and works.
- Structured v2 search works on the other projects:
  `GET https://world.openpetfoodfacts.org/api/v2/search?categories_tags=en:cat-food&page_size=2`.
- When `fields` is supplied, fields absent from a product are omitted rather than returned as `null`.
  The reader must not assume every requested field is present.
- Search-a-licious has no visible support for OBF/OPFF/OPF. The plan's "local cache + limited search"
  fallback for those projects stands.

### Taxonomy and attributes

- `GET /api/v3/taxonomy_suggestions?tagtype=categories&string=pet%20food&lc=en` returns
  `{"status":"success","suggestions":["Open Pet Food Facts"]}`.
- `GET /api/v3.4/attribute_groups?barcode=3017620422003&lc=en` returns attribute groups (for example
  Nutri-Score) and is suitable for presentation.
- Both endpoints are read-only and safe to cache.

### Writes and images

- `POST /api/v3/product/{code}` and `PATCH /api/v3/product/{code}` both exist: an empty body returns
  HTTP 400 with `empty_request_body`, not 404/405. The v3 write path is therefore available, but the
  exact body schema still needs a staging test.
- `POST /api/v3.3/product/{code}/images` exists (400 `empty_request_body`). The legacy
  `POST /cgi/product_image_upload.pl` still responds and returns `status not ok` when no barcode is
  supplied, which confirms the endpoint is live.
- `POST /cgi/session.pl` is documented as the login endpoint that returns the session cookie. Not
  exercised without credentials.
- **No production write has been attempted.**

### Contribution services

| Service | Probe | Result |
| --- | --- | --- |
| Open Prices | `GET /api/v1/status` | `{"status":"running"}` |
| Open Prices | `POST /api/v1/auth` with no body | `400` (endpoint exists, validation reached) |
| Open Prices | `GET /api/schema` | OpenAPI 3.0.3 with `/api/v1/prices`, `/proofs`, `/locations`, `/products`, `/receipts`, `/challenges`, `/badges` |
| Folksonomy | `GET /ping` | `{"ping":"pong @ ..."}` |
| Folksonomy | `POST /auth` with empty credentials | `401 Invalid authentication credentials` |
| Folksonomy | `/product` CRUD | Present in the OpenAPI (GET/PUT/POST/DELETE) |
| NutriPatrol | `GET /api/v1/reasons` | Public; returns reasons for product/image/search |
| NutriPatrol | `POST /api/v1/flags` with `{}` | `401 {"detail":"Missing session token"}` |
| Robotoff | `GET /api/v1/status` | `502 Bad Gateway` at probe time |

### Findings that change the plan

1. **NutriPatrol needs a session.** Reporting is not a public POST. The adapter must reuse the linked
   OFF session (or the instance account) and send the expected session token/cookie. Phase 4 should
   verify whether it accepts the `session` cookie from `/cgi/session.pl`, an `Authorization` header, or
   a query parameter. The capability is unavailable to anonymous users.
   - Follow-up: a fake `Cookie: session=...` returns `401 Invalid session token` (not
     `Missing session token`), so the OFF `session` cookie is the accepted transport. A bearer header
     returns `403 Invalid bearer token`. The implementation uses the cookie.
2. **Robotoff can be down.** The service returned `502` during the probe. The UI must treat Robotoff as
   optional and hide the card on failure, never block the rest of the feature.
3. **v3 writes exist but are not yet proven.** Phase 2 starts with the documented legacy
   `product_jqm2.pl` path or a staging v3 test, then standardizes on whichever round-trips correctly.
4. **Universal redirects are reliable.** The client should not try to guess the project from the
   barcode; it should let `product_type=all` redirect and read `product_type` from the payload.
5. **`fields=` omits absent values.** Normalization must tolerate missing keys and treat them as empty.
6. **Open Prices requires a proof first.** `POST /api/v1/prices` requires `proof_id`; the proof comes
   from `POST /api/v1/proofs/upload` with `file` and `type=RECEIPT`. The implementation uploads the
   receipt, then submits the line's unit price.
7. **Folksonomy uses its own bearer token.** `POST /auth` returns `access_token`; product properties
   use `POST /product` with `{ product, k, v, version }`.

## Still to verify with staging credentials

- Exact v3 product write body and auth requirements; whether `add_*` semantics are preserved in v3.
- Image upload field names and image selection (`front`, `ingredients`, `nutrition`, `packaging`) on
  v3.3 versus legacy.
- OFF session cookie lifetime and the 401 shape after expiry.
- Open Prices price/proof/location payload and whether a proof is mandatory for a price.
- Folksonomy property permissions and whether the same OFF session can be reused.
- NutriPatrol session token source and required flag fields (`reason`, `comment`, `flavor`).
- Robotoff annotation endpoint and whether it accepts anonymous answers.

Until these are verified, production writes stay disabled (`SV_OFF_WRITE_ENABLED=false`), and staging
is the only target allowed for write tests.

## Decision log (defaults proposed in the plan)

- Reads across all four projects: **go**, no blocker.
- Project-aware cache migration: **required**; universal lookup makes the project dimension necessary.
- Individual OFF accounts: **recommended**, with an instance account fallback.
- Open Prices: **opt-in**, per receipt, with proof redaction.
- NutriPatrol: **only for linked accounts** until the token mechanism is confirmed.
- Robotoff: **optional and failure-tolerant**.
- First non-food write target: **Open Pet Food Facts** (pending confirmation).
