# Development

SVault is a TypeScript monorepo in a single package: a React client, an Express server and shared
domain types. No workspace tooling, no bundler config beyond Vite, no test framework beyond
`node:test`.

## Prerequisites

- **Node.js 22.13 or newer** (the server uses `node:sqlite`; `pdfjs-dist` requires 22.13+).
- npm 10+.
- Optional: Docker for testing the production image.
- Optional: a local Chrome/Edge install for the browser check scripts.

Windows, macOS and Linux are all supported. The project uses ESM (`"type": "module"`), so server
imports end in `.js` even in TypeScript source.

## First run

```bash
git clone https://github.com/AtaKon/svault.git
cd svault
npm install
cp .env.example .env      # optional
npm run dev
```

- Web: http://localhost:5173 (Vite proxies `/api` and `/uploads` to `:4000`)
- API: http://localhost:4000/api/health
- Data: `./data` unless `DATA_DIR` overrides it

`predev` copies OCR assets from `node_modules` into `public/tesseract`. If that step is skipped, the
recipe scanner falls back to loading Tesseract from a CDN. Receipt OCR prints the full-image, grayscale
crop and binary crop scores to the browser console in development (`[ocr] product candidates`), which
is the quickest way to see whether a layout change helped.

Bill scans read a PDF text layer with `pdfjs-dist` first, because e-bills are more accurate and much
faster to parse than a rendered scan. Only PDFs without usable text (and bill photos) are rendered and
sent through Tesseract with the `bill` OCR mode, which uses Greek first and no receipt product crop.
Phone camera rolls hand over HEIC/HEIF, AVIF, GIF, BMP or TIFF photos; `client/bill-image.ts`
re-encodes the ones the browser can decode to JPEG in the browser once, so the preview, upload and
later re-read share the same bytes. HEIC decoding is Safari-only (iOS/macOS); other browsers show a
clear message and offer the camera button, which captures JPEG. The bill parser itself lives in
`shared/bill-parser.ts` and is covered by the normal `npm test` run.

Seed demo data (only if the database is empty):

```bash
npm run seed
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API with `tsx watch` + Vite dev server, concurrently |
| `npm run dev:api` | API only, port 4000 |
| `npm run dev:web` | Vite only, port 5173 |
| `npm run build` | Vendors OCR assets, builds the client to `dist/client`, compiles the server to `dist/server` |
| `npm start` | Runs the built server (`NODE_ENV` should be `production` in real deployments) |
| `npm test` | API integration, parser, stock and dataset tests with a temporary database |
| `npm run typecheck` | `tsc --noEmit` over client, shared and server |
| `npm run seed` | Demo seeder against `DATA_DIR` |
| `npm run icons` | Regenerates PWA icons from `assets/icon.svg` |
| `node scripts/smoke.mjs URL` | Black-box smoke test against a running server |
| `node scripts/visual-check.mjs URL` | Playwright screenshots and console/API error scan |
| `node scripts/functional-check.mjs URL` | Click-through checks on a throwaway copy |

The browser scripts need `npm i --no-save playwright-core` and a local Edge/Chrome path configured at
the top of each script. The smoke script starts from a clean account and exercises the main flows.

### Tests

```bash
npm test
```

The suite uses `node:test` and starts the real Express app on a random port with a temporary
`DATA_DIR`. It currently covers 42 tests across 11 suites:

- unit conversion, price normalisation and rounding,
- OCR-noise recipe parsing, ingredient lines, timers and local ideas,
- auth, registration, invites, per-house isolation and role rules,
- item creation, barcode conflicts and OpenFoodFacts fallback (mocked),
- FIFO consumption, absolute counts, moves and low-stock reminders,
- recipe matching and AI-mock cleanup,
- photo labels and YOLO/COCO export,
- SPA routing and 404 behaviour.

There is no separate lint step. `npm run typecheck` and the tests are the gate used by CI
(`.github/workflows/ci.yml`).

## Project layout

```
client/                 React 19 app (Vite root)
  components/           App shell, UI primitives, scanner, stock dialog, charts
  pages/                One file per screen
  api.ts                Typed fetch wrapper (cookie credentials, ApiError)
  state.tsx             Auth, house, theme and install context
  format.ts             Money, quantity, dates, relative time
  units.ts              Unit labels and location icons
  styles.css            Tailwind 4 theme and base styles
server/
  index.ts              Express app, static serving, startup and reminder timer
  config.ts             Paths, ports, upload limit, AI environment
  db.ts                 node:sqlite connection, schema, query helpers, transactions
  auth.ts               Password hashing, sessions, roles, membership helpers
  http.ts               ApiError, validation, requireHouse, async handler
  serialize.ts          Row -> API shape mappers
  upload.ts             Multer storage and limits
  units.ts              Unit conversion tables and price helpers
  routes/               auth, houses, inventory, recipes, ideas, photos, notifications, dashboard
  services/             Stock engine, reminders, house defaults, local recipe parser
  tests/api.test.ts     Integration and unit tests
shared/types.ts         Domain types imported by both sides
public/                 Manifest, service worker, icons, generated OCR assets
scripts/                OCR vendoring, icons, seed helpers, smoke/visual checks
docs/                   This documentation
deploy/dockge/          TrueNAS/Dockge compose stack and guide
```

Path aliases: `@/` points at `client/`, `@shared/` points at `shared/`.

## Conventions

- **TypeScript everywhere.** Avoid `any` in new public shapes; use the types in `shared/types.ts`.
- **Server code is synchronous.** `node:sqlite` is synchronous; do not wrap simple queries in
  promises. Express 5 handles rejected async handlers.
- **Validate input with Zod** through `parseBody`. Never interpolate user input into SQL; use `?`
  parameters.
- **Authorize with `requireHouse`** (or the item/photo access helpers) even when the UI hides the
  action.
- **Stock changes belong in `server/services/stock.ts`.** Routes call `addStock`, `removeStock`,
  `setStock` or `moveStock`, then `afterStockChange`.
- **Transactions:** use `tx()` for multi-statement writes. It nests with savepoints.
- **Serialization:** return shapes from `server/serialize.ts`, not raw database rows. Keep
  `shared/types.ts` in sync.
- **Client data fetching:** use the `api()` helper. It sends cookies, converts non-2xx responses to
  `ApiError` and dispatches `sv:unauthorized` on 401.
- **Styling:** Tailwind utility classes with the theme tokens in `client/styles.css`. Match the
  existing compact, mobile-first layout. No CSS modules or styled-components.
- **Accessibility:** buttons need labels, sheets trap focus, and keyboard paths should exist for
  actions that are drag-only.
- **No new runtime dependency without a reason.** Prefer the standard library and what is already
  installed. AI, barcode and OCR dependencies are the deliberate exceptions.

### Adding an API endpoint

1. Add the route to the relevant router in `server/routes/`.
2. Use `requireAuth` (already applied per router) and `requireHouse(req, minRole)`.
3. Validate with a Zod schema and `parseBody`.
4. Reuse the services and serializers.
5. Add a test in `server/tests/api.test.ts`.
6. Document it in [api.md](api.md).

### Adding a page

1. Create `client/pages/YourPage.tsx`.
2. Register the route in `client/App.tsx`.
3. Add navigation in `client/components/AppShell.tsx` if it is a primary screen.
4. Use `useHouse()`, `useAuth()` and the UI primitives from `client/components/ui.tsx`.
5. Check mobile width (360px), keyboard focus and dark mode.

### Database changes

The schema is a single `CREATE TABLE IF NOT EXISTS` block in `server/db.ts`. It runs on every start.

- Adding a table or index is safe: it is created on the next boot.
- Adding a column to an existing table requires an explicit migration (check `PRAGMA table_info` and
  `ALTER TABLE ... ADD COLUMN`). There is no migration framework yet; keep changes additive and
  document them.
- Test with an existing database, not only a fresh one.

Inspect a local database:

```bash
node --disable-warning=ExperimentalWarning -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('./data/svault.db');
  console.log(db.prepare('select name from sqlite_master where type=\'table\'').all());
"
```

Reset local data (destroys it):

```bash
rm -rf data
# Windows PowerShell: Remove-Item -Recurse -Force data
npm run seed
```

## Testing the production build

```bash
npm run build
NODE_ENV=production PORT=4100 DATA_DIR=./data-prod npm start
```

On Windows PowerShell:

```powershell
$env:NODE_ENV="production"; $env:PORT="4100"; $env:DATA_DIR="./data-prod"; npm start
```

Then run the smoke test:

```bash
node scripts/smoke.mjs http://localhost:4100
```

## Docker build

```bash
docker build -t svault:dev .
docker run --rm -p 8080:4000 -v svault-data:/data -e COOKIE_SECURE=false svault:dev
```

The Dockerfile is multi-stage: dependencies, build, then a slim runtime as the non-root `svault`
user. It copies `dist`, `public` and `assets`. `docs`, `.github`, `data` and `node_modules` are
excluded by `.dockerignore`.

## Commit and PR workflow

1. Open an issue for anything larger than a bug fix or typo.
2. Branch from `main`/`master` (`feat/shopping-list`, `fix/fifo-expiry`).
3. Keep commits focused. A conventional-ish prefix is welcome (`feat:`, `fix:`, `docs:`, `test:`).
4. Run `npm run typecheck && npm test` before pushing.
5. Open a PR using the template and link the issue (`Closes #12`).
6. Describe behaviour changes, not only files changed. Add screenshots for UI work.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full checklist.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | Node is older than 22. `node -v`. |
| Tests hang or use the wrong data | A previous run left `DATA_DIR` set. Tests override it themselves; check your shell env. |
| Type errors only in the server build | `tsconfig.server.json` is stricter about output. Run `npm run build:api`. |
| OCR assets missing | `npm run predev` or `node scripts/vendor-ocr.mjs`; verify `public/tesseract/worker.min.js` exists. |
| Vite cannot reach the API | The API must be on 4000 or update the proxy in `vite.config.ts`. |
| Camera works on desktop but not phone | Use HTTPS; see [deployment.md](deployment.md#https-and-reverse-proxies). |
| Windows path errors in `sendFile` | The server already passes a relative name with an explicit root for this reason; keep that pattern. |
