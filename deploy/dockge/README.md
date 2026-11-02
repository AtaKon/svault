# Deploying SVault with Dockge on TrueNAS SCALE

SVault ships as a single container: Express API + built web app, SQLite and uploads in `/data`.
Dockge only manages the compose file — the image has to be present on the TrueNAS host first.

## 1. Put the image on the NAS

On the development PC (this Windows machine already has the image):

```powershell
docker tag svault:latest svault:1.0.0
docker save svault:1.0.0 -o svault-1.0.0-image.tar
```

Copy `svault-1.0.0-image.tar` (about 163 MB) to the NAS over SMB/SCP, then in the TrueNAS shell:

```bash
sudo docker load -i /tmp/svault-1.0.0-image.tar
sudo docker image ls svault
```

You should see `svault:1.0.0`. Dockge uses the host Docker daemon, so the image is immediately
available to stacks.

> **Alternative:** build on the NAS. Copy the repository into the Dockge stack folder and replace
> `image:` with `build: .` in `compose.yaml`. This needs ~1 GB RAM and network access for npm.

> **Alternative:** publish the image to a registry (GHCR/Docker Hub), `docker login` on the NAS, and
> set `SVAULT_IMAGE` in `.env` to that image. This is the nicest option for updates.

## 2. Create the data folder and fix permissions

Pick a dataset path, e.g. `/mnt/tank/apps/svault/data` (replace `tank` with your pool).

```bash
sudo mkdir -p /mnt/tank/apps/svault/data
sudo chown -R 568:568 /mnt/tank/apps/svault/data
```

The stack runs as UID/GID **568** (`apps` on TrueNAS SCALE). If the dataset uses ACLs, edit the
dataset ACL in the TrueNAS UI and give the `apps` user **Modify** (or Full Control) on that folder.

If you prefer the image's built-in UID instead, remove the `user:` line from `compose.yaml` and
`chown -R 999:999` the folder instead. Don't mix the two.

## 3. Create the Dockge stack

1. Dockge → **Compose** (or Stacks) → **New stack**, name it `svault`.
2. Paste [`compose.yaml`](./compose.yaml).
3. Optional: create a `.env` from [`.env.example`](./.env.example) and set:
   - `SVAULT_DATA_PATH` — your dataset path
   - `SVAULT_PORT` — a free host port (default `8095`)
   - `SEED_DEMO=true` if you want the demo vault on first start
4. Press **Deploy** and wait for the health check to go green.

Open `http://<truenas-ip>:8095` and create the first account — it becomes the owner.

If you enabled `SEED_DEMO`, the demo login is `demo@svault.local / demo1234`. It only seeds when the
database is empty. To seed later:

```bash
sudo docker exec svault node --disable-warning=ExperimentalWarning dist/server/seed.js
```

## 4. HTTPS with Nginx Proxy Manager

This stack is pre-wired for **Nginx Proxy Manager (NPM)** on TrueNAS:

- SVault joins NPM's Docker network (`ix-nginx-proxy-manager_default`) under the name `svault`.
- NPM forwards to `http://svault:4000` over that network — no host port or loopback tricks.
- The published `8095` port is only for setup/debugging and can be closed after cutover.

### 4.1 DNS and ports

1. Create an A (and optionally AAAA) record for the subdomain, e.g. `svault.example.com`, pointing at
   your public IP.
2. Ports **80** and **443** must reach the NAS (NPM already listens on them).
3. NPM uses the HTTP-01 challenge, so port 80 must be reachable during certificate issuance.

### 4.2 Create the proxy host in NPM

NPM UI → **Hosts → Proxy Hosts → Add Proxy Host**:

| Field | Value |
| --- | --- |
| Domain Names | `svault.example.com` |
| Scheme | `http` |
| Forward Hostname / IP | `svault` |
| Forward Port | `4000` |
| Block Common Exploits | on |
| Websockets Support | off (not used) |

**SSL tab**

- Request a new SSL certificate (Let's Encrypt)
- Force SSL: on
- HTTP/2 Support: on
- HSTS: optional (only enable if you are sure the subdomain will stay HTTPS)

**Advanced tab** — NPM's defaults block photo uploads over 1 MB and time out AI requests after 60 s:

```nginx
client_max_body_size 25m;
proxy_read_timeout 180s;
proxy_send_timeout 180s;
```

Save. NPM issues the certificate and starts proxying. Open `https://svault.example.com`.

### 4.3 Cutover (only after HTTPS works)
Edit the stack `.env` in Dockge:

```ini
COOKIE_SECURE=true
SVAULT_BIND=127.0.0.1
```

Press **Deploy**. From then on:

- Sessions are HTTPS-only (browsers will refuse to send the cookie over plain HTTP).
- The app port is reachable only from the NAS host; all traffic goes through NPM.
- Barcode scanning works on the phone because the origin is now secure.

If you keep `SVAULT_BIND=0.0.0.0` the app stays reachable at `http://<nas-ip>:8095`, but logins over
that URL will fail once `COOKIE_SECURE=true` — that is expected.

> If your NPM network has a different name, set `PROXY_NETWORK` in `.env` to the output of
> `docker inspect ix-nginx-proxy-manager-npm-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'`.

SVault's server binds IPv4. NPM normally resolves a container name to both A and AAAA and may try
IPv6 first, which shows up as `connect() failed ... [fdd0:...]:4000` and intermittent 502s. Add this
to the proxy host's **Advanced** tab to force IPv4 resolution:

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
```

### 4.4 Camera on the phone

Browsers only expose the camera on secure origins. With the NPM HTTPS URL, scanning works. On plain
HTTP, everything else works but the scanner falls back to typing the code.

Give the NAS a DHCP reservation or use its hostname instead of the IP.

## 5. AI (optional)

Configure in the app under **Settings → AI** (per house), or set the `OPENAI_*` variables in `.env`
globally. Presets for OpenAI, OpenRouter, Ollama and LM Studio are built in, plus a **Test saved
connection** button.

If Ollama runs on another machine: use `http://<that-ip>:11434/v1`. If it runs on the NAS host,
`host.docker.internal` usually does **not** resolve on Linux/TrueNAS — use the NAS LAN IP and make
Ollama listen on `0.0.0.0` (`OLLAMA_HOST=0.0.0.0`).

## 6. Backups and updates

**Backup:** the entire vault is the dataset folder (SQLite database + uploads). Create a ZFS
snapshot task in TrueNAS. For the most consistent SQLite backup, stop the container first:

```bash
sudo docker stop svault
# snapshot the dataset in the TrueNAS UI
sudo docker start svault
```

**Update:** build/save a new image on the dev machine, `docker load` it on the NAS, bump
`SVAULT_IMAGE` (e.g. `svault:1.0.1`), then press **Deploy** in Dockge. Data stays in the dataset.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `permission denied` creating the DB | The data folder isn't writable by UID 568. Redo step 2 / dataset ACL. |
| `image not found` / pull error | The image isn't loaded on the NAS or `SVAULT_IMAGE` doesn't match `docker image ls`. |
| Container restarts in a loop | Check `docker logs svault`; usually permissions or a port conflict. |
| Port already allocated | Change `SVAULT_PORT` (TrueNAS apps commonly use 8080/8090). |
| NPM shows 502 Bad Gateway | SVault and NPM aren't on the same network, or the forward host isn't `svault` port `4000`. Check `PROXY_NETWORK` and that `compose.yaml` still has the `networks:` block (re-creating the stack with an old compose removes it). |
| NPM logs IPv6 connection refused | Add `resolver 127.0.0.11 valid=10s ipv6=off;` to the proxy host's Advanced config. |
| Uploads fail with 413 | Add `client_max_body_size 25m;` to the NPM Advanced config. |
| AI/idea requests time out | Add `proxy_read_timeout 180s;` and `proxy_send_timeout 180s;` in NPM Advanced. |
| Phone can't open the page | Same VLAN? Guest Wi-Fi isolation? Firewall? Try the NAS IP and port. |
| Demo login fails | Demo data wasn't seeded (empty DB required). Run the seed command above. |
| Camera unavailable | Use HTTPS, or scan on a desktop via localhost. |

## Health and status

Dockge shows the stack as healthy when `/api/health` returns 200. Useful commands on the NAS:

```bash
sudo docker logs -f svault
sudo docker exec svault id
sudo docker exec svault ls -la /data
```
