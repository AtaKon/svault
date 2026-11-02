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
docker compose up -d --build
```

Open `http://localhost:8080` and create the first account.

The compose file builds `svault:latest` locally. A published multi-arch image is planned in
[issue #12](https://github.com/AtaKon/svault/issues/12); until then, build on the machine that will
run it (or build and transfer the image, as described in the
[TrueNAS guide](../deploy/dockge/README.md)).

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
| `OPENAI_API_KEY` | empty | Server | Optional global AI key. Per-house settings win. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Server | Any OpenAI-compatible endpoint. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Server | Text model. |
| `OPENAI_VISION_MODEL` | falls back to text model | Server | Vision model for recipe photos. |
| `PORT` | `4000` | Server | Internal listen port. Keep it at 4000 inside the container. |
| `DATA_DIR` | `./data` locally, `/data` in Docker | Server | Database and uploads directory. |
| `MAX_UPLOAD_MB` | `20` | Server | Per-file upload limit. Add it to the compose `environment` block if you change it. |
| `NODE_ENV` | `production` in Docker | Server | Enables production caching, disables request logs. |

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

Choose one of these:

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
In-app backup/restore is planned in [issue #3](https://github.com/AtaKon/svault/issues/3).

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
2. Pull the new code (or load/pull the new image).
3. Rebuild and restart:

```bash
git pull
docker compose up -d --build
```

4. Check `docker compose logs -f svault` and `/api/health`.

The schema is created idempotently and only adds tables/indexes. There is no migration runner yet, so
downgrading across a schema change can break the old binary. Restore the backup if you need to go
back.

For TrueNAS, build/save the image on a development machine, `docker load` it on the NAS, bump
`SVAULT_IMAGE`, and press **Deploy** in Dockge.

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
- [ ] Add rate limiting at the proxy if the instance is internet-facing.
- [ ] Remember that `/uploads/*` is unauthenticated. Treat upload URLs as secrets and keep the whole
      site behind your proxy.
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
