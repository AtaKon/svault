# Deployment

SVault ships as one container that serves the API and the built web app. Everything persistent lives
in a single directory: `svault.db` (SQLite, WAL mode) and `uploads/`. That makes deployment and backup
simple, but it also means SVault is a single-node application by design.

- [Quick start with Docker Compose](#quick-start-with-docker-compose)
- [Configuration](#configuration)
- [HTTPS and reverse proxies](#https-and-reverse-proxies)
- [LAN and phone access](#lan-and-phone-access)
- [TrueNAS and Dockge](#truenas-and-dockge)
- [Backups](#backups)
- [Upgrades](#upgrades)
- [Operations](#operations)
- [Security checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

## Requirements

- Docker Engine 24+ with the Compose plugin, or Docker Desktop on Windows/macOS.
- About 200 MB of RAM and 500 MB of disk for the image plus data. Photo datasets grow with uploads.
- No GPU and no external database.
- Node.js 22+ only if you run it outside Docker.

## Quick start with Docker Compose

```bash
git clone https://github.com/AtaKon/svault.git
cd svault
cp .env.example .env        # optional; defaults work
docker compose up -d
```

Open `http://localhost:8080` and create the first account.

The default compose file pulls the published `ghcr.io/atakon/svault:latest`
image (multi-arch `amd64` + `arm64`). To build from the checkout instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Check status:

```bash
docker compose ps
docker compose logs -f svault
curl http://localhost:8080/api/health
```

Stop without losing data:

```bash
docker compose down          # keeps the named volume
```

Do **not** use `docker compose down -v` unless you intend to delete the database and uploads.

### Demo data

Set `SEED_DEMO=true` in `.env` **before the first start**, or run the seeder manually:

```bash
docker compose exec svault node --disable-warning=ExperimentalWarning dist/server/seed.js
```

Demo accounts:

```
demo@svault.local / demo1234
sofia@svault.local / demo1234
```

Seeding only happens when the database is empty. It is safe to leave `SEED_DEMO=false` afterwards.

## Configuration

Docker Compose reads `.env` next to `docker-compose.yml`.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `SVAULT_PORT` | `8080` | Compose | Host port published for the app. |
| `COOKIE_SECURE` | `false` in the example, `true` in production unless explicitly false | Server | Adds `Secure` to the session cookie. Set `true` once HTTPS works. |
| `SEED_DEMO` | `false` | Entrypoint | Seed the demo vault on first start (empty DB only). |
| `OPENAI_API_KEY` | empty | Server | Optional global AI key. Per-house settings win. Only ever sent to `OPENAI_BASE_URL`: a house that sets its own base URL must supply its own key (or use a keyless local endpoint). |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Server | Any OpenAI-compatible endpoint. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Server | Text model. |
| `OPENAI_VISION_MODEL` | falls back to text model | Server | Vision model for recipe photos. |
| `SV_AI_LOG_RETENTION_DAYS` | `90` | Server | Days to keep rows in the AI call log; `0` keeps them forever. |
| `SV_AI_LOG_PREVIEW_CHARS` | `4000` | Server | Maximum prompt/response characters stored per AI call (200–20000). |
| `SV_CATALOG_URL` | empty | Server | Optional shared OpenFoodFacts receipt-name catalogue (JSON) for **Settings → Data → Sync catalogue**. |
| `RP_ID` | request host | Server | WebAuthn relying-party domain, e.g. `svault.example.com`. |
| `ORIGIN` | request origin | Server | Public HTTPS origin for passkeys, e.g. `https://svault.example.com`. |
| `OIDC_ISSUER` | empty | Server | OpenID Connect issuer URL; empty disables SSO. |
| `OIDC_CLIENT_ID` | empty | Server | OIDC client id. |
| `OIDC_CLIENT_SECRET` | empty | Server | OIDC client secret (never sent to the browser). |
| `OIDC_REDIRECT_URI` | `<origin>/api/auth/oidc/callback` | Server | Must match the provider registration. |
| `OIDC_ALLOWED_DOMAINS` | empty | Server | Comma-separated verified email domains; empty allows any. |
| `OIDC_AUTO_PROVISION` | `true` | Server | Create a user for unknown verified identities. Only applies while `SV_REGISTRATION` is `open`. |
| `OIDC_DEFAULT_HOUSE_ID` | empty | Server | Join new SSO users to this house instead of creating one. |
| `OFF_API_BASE` | `https://world.openfoodfacts.org` | Server | Product endpoint, overridable for a proxy. |
| `OFF_SEARCH_BASE` | `https://search.openfoodfacts.org` | Server | Name-search endpoint. |
| `OFF_TIMEOUT_MS` | `6000` | Server | Per-request OpenFoodFacts timeout. |
| `OFF_CACHE_DAYS` | `30` | Server | How long a product stays fresh in the shared cache. |
| `PORT` | `4000` | Server | Internal listen port. Keep it at 4000 inside the container. |
| `DATA_DIR` | `./data` locally, `/data` in Docker | Server | Database and uploads directory. |
| `SV_PRE_RESTORE_KEEP` | `3` | Server, `npm run restore` | Safety copies kept in `DATA_DIR/backups/pre-restore` (minimum 1). Add it to the compose `environment` block if you change it. |
| `DATABASE_URL` | empty | Server | PostgreSQL connection string. Empty keeps the bundled SQLite file. |
| `SV_DATABASE_KIND` | inferred | Server | Force `postgres` or `sqlite`. |
| `PG_POOL_SIZE` | `10` | Server | PostgreSQL connection pool size. |
| `PGSSLMODE` | off | Server | PostgreSQL TLS mode (`require`, `prefer`, `no-verify`, `verify-full`). |
| `MAX_UPLOAD_MB` | `20` | Server | Per-file upload limit. Add it to the compose `environment` block if you change it. |
| `SV_RESTORE_MAX_MB` | `512` | Server | Largest backup zip the in-app restore accepts (instance admin only). |
| `SV_DATASET_MAX_MB` | `256` | Server | Largest YOLO/COCO zip the dataset import accepts. |
| `SV_REGISTRATION` | `open` until the first account exists, then `invite` | Server | `open`: anyone can sign up. `invite`: sign-up only with a valid house invite. `closed`: no self sign-up. The first account (the instance admin) can always be created. |
| `SV_INVITE_DAYS` | `14` | Server | Lifetime of new house invites. Older invites without an expiry count from their creation date. |
| `SV_OUTBOUND_ALLOW_PRIVATE` | `true` | Server | Set `false` to refuse house-configured AI base URLs and reminder channel URLs that resolve to loopback, private or link-local addresses (and to stop following redirects for them). Keep `true` if houses use a LAN Ollama, LM Studio or ntfy server. |
| `SV_RATE_LIMIT` | on | Server | `off` disables the built-in rate limits (for example when the proxy already limits). |
| `SV_RATE_LIMIT_<NAME>` | see [Rate limits](#rate-limits) | Server | Override one limit as `<max>/<seconds>`, e.g. `SV_RATE_LIMIT_LOGIN=30/600`. |
| `SV_CSP` | on | Server | `off` disables the Content-Security-Policy header (only for debugging a custom build). |
| `NODE_ENV` | `production` in Docker | Server | Enables production caching, disables request logs. |

See [Bring your own database](database.md) for PostgreSQL setup, migration and the example Compose
override (`docker-compose.postgres.yml`).

`SVAI_*` aliases exist for `OPENAI_*` (`SVAI_API_KEY`, `SVAI_BASE_URL`, `SVAI_MODEL`,
`SVAI_VISION_MODEL`).

### AI providers

Any endpoint that implements `POST /chat/completions` works.

| Provider | Base URL | Text model example |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| Ollama (Docker Desktop host) | `http://host.docker.internal:11434/v1` | `llama3.2` |
| Ollama (Linux host) | `http://<host-lan-ip>:11434/v1` | `llama3.2` |
| LM Studio | `http://host.docker.internal:1234/v1` | the loaded model id |

On Linux, `host.docker.internal` usually does not resolve. Use the Docker bridge gateway
(`172.17.0.1`) or the host's LAN IP, and make Ollama listen on `0.0.0.0`
(`OLLAMA_HOST=0.0.0.0`).

AI is optional. Without a provider, OCR still runs locally, recipes are parsed by the local parser and
meal ideas come from stock and saved recipes.

The server-wide `OPENAI_API_KEY` is only used for houses that keep the default base URL (empty or the
same as `OPENAI_BASE_URL`). A house that points SVault at another endpoint must enter that endpoint's
key, or enable AI without a key for a keyless local server such as Ollama or LM Studio. This stops a
house admin from pointing the base URL at their own server and receiving the instance key.

### Rate limits

SVault limits credential, invite and AI endpoints in memory (counters reset on restart). A limited
request gets `429 Too Many Requests` with a `Retry-After` header.

| Name | Default | Applies to |
| --- | --- | --- |
| `LOGIN` | `30/600` per IP | `POST /api/auth/login` |
| `LOGIN_ACCOUNT` | `10/900` failed attempts per email/username | `POST /api/auth/login`; once reached even the right password waits |
| `REGISTER` | `10/3600` per IP | `POST /api/auth/register` |
| `TWO_FACTOR` | `20/600` per IP | `POST /api/auth/2fa/verify` (each challenge also allows only 5 wrong codes) |
| `PASSKEY` | `30/600` per IP | passkey sign-in options and verification |
| `INVITE` | `30/600` per IP | invite lookup and accept |
| `AI` | `60/600` per user | receipt and recipe scans, intake parse, ideas, recipe completion, AI connection test |

Override with `SV_RATE_LIMIT_<NAME>=<max>/<seconds>`. Limits are keyed by `req.ip`, which honours one
reverse-proxy hop (`X-Forwarded-For`); make sure your proxy sets it, otherwise every client shares the
proxy's address.

### Registration

By default anyone can create the first account (it becomes the instance admin); after that, sign-up
needs an invite link from a house admin (`SV_REGISTRATION=invite`). Set `SV_REGISTRATION=open` to let
anyone who can reach the server sign up, or `closed` to stop self sign-up entirely. OIDC
auto-provisioning creates accounts too, so it only runs while registration is `open`; existing
accounts with a matching verified email still link. `GET /api/auth/registration` reports the mode.

## HTTPS and reverse proxies

Browsers only expose the camera on secure origins. Barcode scanning therefore requires HTTPS (or
`localhost`). Everything else works over plain HTTP on a trusted LAN.

Set these after the proxy works:

```ini
COOKIE_SECURE=true
```

If you keep browsing over plain HTTP with `COOKIE_SECURE=true`, login appears to succeed and the next
request is signed out. That is the expected cookie behaviour.

### Caddy

```caddyfile
svault.example.com {
    encode zstd gzip
    request_body {
        max_size 25MB
    }
    reverse_proxy 127.0.0.1:8080 {
        transport http {
            read_timeout 180s
            write_timeout 180s
        }
    }
}
```

Caddy obtains and renews the certificate automatically. Point an A/AAAA record at the host and make
sure ports 80 and 443 are reachable for the ACME challenge.

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name svault.example.com;

    ssl_certificate     /etc/letsencrypt/live/svault.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/svault.example.com/privkey.pem;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }
}
```

The server sets `trust proxy` to 1, so `X-Forwarded-*` headers are respected. Do not chain multiple
proxies without adjusting that value.

### Nginx Proxy Manager

The TrueNAS guide has a complete NPM walkthrough, including the network setup and the IPv4 resolver
workaround: [deploy/dockge/README.md](../deploy/dockge/README.md#4-https-with-nginx-proxy-manager).

Key values:

| Field | Value |
| --- | --- |
| Forward host | `svault` (same Docker network) or the host IP |
| Forward port | `4000` (or the published host port) |
| Advanced | `client_max_body_size 25m; proxy_read_timeout 180s; proxy_send_timeout 180s;` |

### Tailscale

Tailscale Serve/Funnel gives you a trusted HTTPS origin without opening ports to the internet:

```bash
tailscale serve --bg 8080
# or, for access outside the tailnet:
tailscale funnel --bg 8080
```

Use the HTTPS URL Tailscale prints and set `COOKIE_SECURE=true`. Funnel exposes the app publicly;
protect it with strong passwords and consider Tailscale ACLs instead of Funnel if you only need family
access.

## LAN and phone access

1. Find the host's LAN IP (`ipconfig` on Windows, `ip addr` on Linux).
2. Open `http://<ip>:8080` from the phone.
3. Allow inbound TCP `8080` (or `SVAULT_PORT`) in the host firewall.

Windows PowerShell example:

```powershell
New-NetFirewallRule -DisplayName "SVault (TCP 8080)" -Direction Inbound -Protocol TCP `
  -LocalPort 8080 -Action Allow -Profile Any
```

Notes:

- Give the host a DHCP reservation so the address survives reboots.
- On Docker Desktop, make sure it starts at login.
- Camera scanning needs HTTPS. Without it, the scanner offers manual code entry.
- Guest Wi-Fi isolation and VLANs can block the phone even when the firewall is open.

## TrueNAS and Dockge

The complete guide lives in [`deploy/dockge`](../deploy/dockge/README.md). It covers:

- transferring or building the image on the NAS,
- UID/GID 568 permissions for the `apps` user,
- a host-path volume inside a ZFS dataset,
- joining Nginx Proxy Manager's Docker network,
- HTTPS cutover and `COOKIE_SECURE`,
- ZFS snapshots and updates.

The stack file is [`deploy/dockge/compose.yaml`](../deploy/dockge/compose.yaml).

## Backups

Everything is in `DATA_DIR`:

```
/data/svault.db          SQLite database (plus -wal and -shm while running)
/data/uploads/           item, recipe and photo images
```

With PostgreSQL (`DATABASE_URL`), the relational data lives in the database server and only
`/data/uploads/` stays in `DATA_DIR`. The in-app backup then contains a logical `database.json`
dump instead of `svault.db`; both formats include the same `manifest.json` and upload checksums.

Choose one of these:

### In-app backup (recommended)

Open **Settings → Data → Backup & restore** as the instance administrator (the first account; backups
cover every house and account, so house owners cannot download them) and press **Download backup**. The zip
contains a consistent `svault.db`, `uploads/`, and `manifest.json` with the app/schema version and
SHA-256 checksums. The last five copies stay in `DATA_DIR/backups`.

The archive is streamed to disk while it is built: uploads are hashed and then copied into the zip one
file at a time, and the download is served from the finished file. Memory use therefore stays flat
however large the photo library is, but `DATA_DIR` needs free space for roughly one more copy of the
database and uploads (compressed photos barely shrink). A PostgreSQL logical dump (`database.json`) is
still built in memory; uploads are streamed either way. Backups only ever contain the database and
`uploads/`, never the `backups/` folder itself.

The same operations are available without the UI:

```bash
npm run backup -- --out svault-backup.zip
npm run restore -- --in svault-backup.zip   # stop the server first
```

`npm run backup` writes only to `--out`; it does not add a copy to `DATA_DIR/backups` or rotate it.

Restore validates paths, checksums and schema, saves a **pre-restore safety copy** of the current data,
stages the archive and restarts the server. During the swap API requests return `503`.

Safety copies are full backup zips named `pre-restore-<timestamp>.zip` in
`DATA_DIR/backups/pre-restore` (`/data/backups/pre-restore` in Docker). They rotate separately from
regular backups (newest three, `SV_PRE_RESTORE_KEEP`), so downloading or scheduling more backups never
deletes the copy you need to roll back. Settings lists them under **Safety copies taken before a
restore**. To roll back, restore that zip like any other backup. `npm run restore` takes the same safety
copy (skip it with `--no-safety-copy`, e.g. when the current database cannot be opened); SQLite
additionally keeps a raw `pre-restore-<ms>.db` of the replaced file in the same folder, rotated the same
way.

### Stop and copy (simplest, consistent)

```bash
docker compose stop svault
docker run --rm -v svault_svault-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/svault-data-$(date +%F).tar.gz -C /data .
docker compose start svault
```

On Windows PowerShell, replace `"$PWD"` with `${PWD}` and use a fixed filename if your shell does not
expand `$(date)`. Find the exact volume name with:

```bash
docker volume ls | grep svault     # Linux/macOS
docker volume ls | findstr svault  # Windows
```

The Compose project name prefixes the volume, so a folder named `svault` normally creates
`svault_svault-data`.

### Online SQLite backup

If you cannot stop the container, back up the database with SQLite's backup API and copy uploads
separately:

```bash
docker compose exec svault node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/data/svault.db');
  db.exec(\"VACUUM INTO '/data/backup.db'\");
  db.close();
"
docker cp svault:/data/backup.db ./svault.db
docker cp svault:/data/uploads ./uploads
```

`VACUUM INTO` produces a consistent snapshot while the app is running. Copying only `svault.db` with
`cp` while WAL is active can miss recent commits.

### Restore

Stop the app, replace the contents, start it again:

```bash
docker compose down
docker run --rm -v svault_svault-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/svault-data-2026-11-02.tar.gz -C /data"
docker compose up -d
```

Restoring is destructive. Keep the old volume or a second archive until the new instance is verified.
The in-app restore and `npm run restore` keep timestamped safety copies under
`DATA_DIR/backups/pre-restore`.

### What to back up

| Item | Included in `DATA_DIR`? |
| --- | --- |
| Users, sessions, houses, roles | Yes (`svault.db`) |
| Items, stock, prices, reminders | Yes |
| Recipes and OCR text | Yes |
| Photo records and labels | Yes |
| Uploaded images | Yes (`uploads/`) |
| AI keys stored in house settings | Yes (plaintext in the database) |
| `.env` / compose file | No - keep these with your deployment notes |

## Upgrades

1. Take a backup.
2. Pull the latest image:
3. Restart:

```bash
docker pull ghcr.io/atakon/svault:latest
docker compose up -d
```

If you build locally, use `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build` instead.

4. Check `docker compose logs -f svault` and `/api/health`.

The schema is created idempotently and only adds tables/indexes. There is no migration runner yet, so
downgrading across a schema change can break the old binary. Restore the backup if you need to go
back.

For TrueNAS, set `SVAULT_IMAGE=ghcr.io/atakon/svault:<version>` in the Dockge `.env` and press **Deploy**.

### Automated deploys with Woodpecker

The repository includes a self-hosted Woodpecker CI stack in [`deploy/woodpecker`](../deploy/woodpecker/README.md).
After the one-time setup, a push to `main` runs the test suite, builds the image, pushes it to a
private registry on the NAS, and recreates the `svault` container with the exact commit image. The
deploy command rolls back automatically when the new container fails its health check.

## Operations

### Health check

```bash
curl -fsS http://localhost:8080/api/health
```

The container has a matching `HEALTHCHECK` every 30 seconds. Docker marks it unhealthy after three
failures.

### Logs

```bash
docker compose logs -f --tail=200 svault
```

Production logs unexpected errors only. Development mode logs every API request with status and
duration.

### Resource use

- Memory: roughly 100-250 MB for a family-sized vault, plus AI request buffers.
- CPU: negligible except during photo upload and zip export.
- Disk: the database is small; photos dominate. A 20 MB per-file limit applies by default.

### Reverse proxy body size

If uploads fail with `413`, raise the proxy limit. NPM defaults to 1 MB, which is far too low for
phone photos:

```nginx
client_max_body_size 25m;
```

## Security checklist

- [ ] Serve over HTTPS and set `COOKIE_SECURE=true`.
- [ ] Use strong, unique passwords; do not expose the app to the internet with demo data enabled.
- [ ] Keep the host, Docker and the SVault image updated.
- [ ] Restrict the app port to the proxy or LAN; do not publish it directly to the internet.
- [ ] Make sure the proxy sets `X-Forwarded-For` so the built-in [rate limits](#rate-limits) see real
      client addresses. Add proxy-level limits too if the instance is internet-facing.
- [ ] Keep `SV_REGISTRATION` at its default (`invite`) or `closed` unless you want open sign-up.
- [ ] Set `ORIGIN` to the public URL; it is used for passkeys and for the cross-site request check.
- [ ] On a shared instance where house admins are not fully trusted, set `SV_OUTBOUND_ALLOW_PRIVATE=false`
      so house settings cannot make the server call your internal network.
- [ ] Remember that `/uploads/*` is unauthenticated. Treat upload URLs as secrets and keep the whole
      site behind your proxy. Uploads are checked to be real images and served with `nosniff` and a
      sandboxing CSP; files of deleted items, recipes and houses are removed, and unreferenced files
      are swept after a day.
- [ ] Prefer AI keys in environment variables if you do not want them stored in the database.
- [ ] Back up regularly and test a restore.
- [ ] Review the [security policy](../SECURITY.md) for reporting vulnerabilities.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `permission denied` creating the database | The data directory is not writable by the container user. On TrueNAS, chown to 568:568 or fix the dataset ACL. |
| Container restarts in a loop | Check `docker logs svault`; usually permissions, a bad `DATA_DIR`, or a port conflict. |
| Port already allocated | Change `SVAULT_PORT` in `.env`. |
| Login works but immediately signs out | `COOKIE_SECURE=true` over plain HTTP. Use HTTPS or set it to `false` for LAN-only use. |
| Camera unavailable | The origin is not secure. Use HTTPS/localhost. Manual entry still works. |
| 413 on upload | Proxy body limit. Raise `client_max_body_size` and restart the proxy. |
| AI test times out | Wrong base URL, proxy timeout, or Ollama not listening on `0.0.0.0`. Increase `proxy_read_timeout` to 180s. |
| AI returns 502 | Provider rejected the request. Check the key, model name and base URL; the error text is shown in the app. |
| 502 from the reverse proxy | The proxy cannot reach the container. Check the network, container name and port. In NPM, force IPv4 with `resolver 127.0.0.11 valid=10s ipv6=off;`. |
| Data missing after recreating the stack | The volume changed. `docker compose down -v` deletes it; check the host path or named volume. |
| Demo login fails | Demo data was not seeded (it requires an empty database) or `SEED_DEMO` was set after first start. Run the seed command. |
| High disk use | Photo uploads. Check `DATA_DIR/uploads`; deleting a photo in the UI also deletes its file, deleting a house does not. |

Still stuck? Open an issue with the bug report template and include the output of
`docker compose logs --tail=200 svault`, the image tag and the host OS.
