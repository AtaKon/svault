# Shared OpenFoodFacts catalogue

`off-mappings.json` ships with SVault and is loaded on boot into the
`catalog_mappings` table. It maps the text printed on a receipt to an
OpenFoodFacts product, so every install can enrich new items without guessing.

## Rules

- `rawText` is matched after the same normalisation used for receipt aliases
  (case, accents, punctuation and trailing article codes are ignored).
- `vendor` is optional. A shop-specific mapping wins over a generic one.
- `country` is the two-letter purchase country. An empty string means "all
  countries".
- `offCode` must be the GTIN/EAN printed on the product. `name`, `brand`, `unit`
  and `category` are fallbacks used when OpenFoodFacts is unreachable.
- Rows learned on an instance are stored as `local` and are **never**
  overwritten by this file. Only `seed` rows are refreshed on upgrade.

## Contributing

1. Link products locally from **Item → OpenFoodFacts**, or correct receipt lines
   while importing a shop.
2. Open **Settings → Data → Product catalogue → Export**.
3. Add the new mappings to this file (keeping `version` and `generatedAt`) and
   open a pull request.

Nothing is uploaded automatically: exporting is an explicit admin action.
