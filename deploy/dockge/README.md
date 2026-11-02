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

## 4. Network, HTTPS and the phone camera

- **LAN access:** `http://<truenas-ip>:8095`. TrueNAS does not block LAN ports by default; if you
  run a firewall, allow the port.
- **Camera scanning:** browsers only grant camera access on HTTPS. Behind plain HTTP, everything
  else works but barcode scanning falls back to typing the number.
- **Recommended:** put SVault behind your existing reverse proxy (Traefik/Caddy/nginx) with a trusted
  certificate, point it at `http://<truenas-ip>:8095`, and set `COOKIE_SECURE=true` in `.env`.
  Then use the HTTPS URL on the phone and the scanner works.
- Give the NAS a DHCP reservation or use its hostname instead of the IP.

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
