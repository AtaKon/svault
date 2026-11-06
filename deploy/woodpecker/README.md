# Self-hosted CI/CD with Woodpecker on TrueNAS

This stack runs [Woodpecker CI](https://woodpecker-ci.org/) next to SVault. Woodpecker watches the
GitHub repository, runs the test suite, builds the production image, pushes it to a private registry
on the NAS, and asks the NAS to deploy the exact commit.

```
GitHub push to main
        │
        ▼
Woodpecker test ──► Woodpecker publish ──► private registry ──► deploy forced command
        │                    │                                         │
        └── PR pipelines ────┘ (no secrets)                           ▼
                                                              svault container
```

## What gets installed

| Service | Purpose | Exposure |
| --- | --- | --- |
| `woodpecker-server` | UI, API and GitHub webhook receiver | HTTPS through Nginx Proxy Manager |
| `woodpecker-agent` | Runs pipeline steps in Docker containers | None |
| `woodpecker-registry` | Private image registry for `ghcr`-free, self-hosted images | `127.0.0.1:5000` and the internal CI network |

The Woodpecker server and agent share a private Docker network (`woodpecker-internal`). The agent is
not on the proxy network. Pipeline steps are attached to `woodpecker-registry` only.

## Before you start

You need:

1. A GitHub OAuth app for Woodpecker.
2. A DNS record for `ci.picklehouse.xyz`.
3. An Nginx Proxy Manager proxy host for that name.
4. SSH access to the NAS as root (only for the one-time setup below).

### 1. Create the DNS record (Cloudflare)

Create **one** record in the Cloudflare dashboard for `picklehouse.xyz`:

| Type | Name | Target | Proxy status |
| --- | --- | --- | --- |
| `CNAME` | `ci` | `picklehouse.xyz` | **DNS only** for the first certificate |

If you prefer, an `A` record to the same public IP as `svault.picklehouse.xyz` works too. Keep it
**DNS only** until Nginx Proxy Manager has issued the Let's Encrypt certificate. After the
certificate works you can switch it to **Proxied** (orange cloud), set Cloudflare SSL/TLS to
**Full (strict)**, and enable WebSockets. GitHub can then reach the webhook through Cloudflare.

> `ci.picklehouse.xyz` must point at the same public IP as `svault.picklehouse.xyz`. The NAS
> currently reports `188.117.226.224`, but use the address your router/DNS uses.

### 2. Create the GitHub OAuth app

Open <https://github.com/settings/applications/new> and use:

| Field | Value |
| --- | --- |
| Application name | `SVault Woodpecker CI` |
| Homepage URL | `https://ci.picklehouse.xyz` |
| Authorization callback URL | `https://ci.picklehouse.xyz/authorize` |

Register the app, then **Generate a new client secret**. Keep the **Client ID** and **Client
secret** for the next step. Do not use a GitHub App; Woodpecker needs an OAuth app.

### 3. Create the proxy host in Nginx Proxy Manager

NPM → **Hosts → Proxy Hosts → Add Proxy Host**:

| Field | Value |
| --- | --- |
| Domain Names | `ci.picklehouse.xyz` |
| Scheme | `http` |
| Forward Hostname / IP | `woodpecker-server` |
| Forward Port | `8000` |
| Block Common Exploits | on |
| Websockets Support | on |

**SSL tab**

- Request a new SSL certificate (Let's Encrypt)
- Force SSL: on
- HTTP/2 Support: on
- HSTS: optional, only after you are sure the name stays HTTPS

**Advanced tab**

```nginx
client_max_body_size 10m;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
proxy_buffering off;
```

Save. NPM issues the certificate and reloads nginx. Do not turn on the Cloudflare proxy until this
works.

## Install the stack on the NAS

The stack lives in `/mnt/Storage/stacks/woodpecker` and its state in
`/mnt/Storage/apps/woodpecker`. Dockge detects stacks under `/mnt/Storage/stacks`.

```bash
# 1. Directories
sudo mkdir -p /mnt/Storage/stacks/woodpecker/secrets
sudo mkdir -p /mnt/Storage/apps/woodpecker/{server,agent,registry}
sudo chown -R 568:568 /mnt/Storage/apps/woodpecker
sudo chmod 700 /mnt/Storage/stacks/woodpecker/secrets

# 2. Copy compose.yaml and .env.example from this folder, then:
cd /mnt/Storage/stacks/woodpecker
cp .env.example .env

# 3. Generate the shared secrets
openssl rand -hex 32 | sudo tee secrets/agent_secret >/dev/null
openssl rand -hex 32 | sudo tee secrets/grpc_secret >/dev/null
sudo chmod 600 secrets/agent_secret secrets/grpc_secret

# 4. OAuth files (replace the placeholder text with the real values)
printf '%s' 'YOUR_CLIENT_ID' | sudo tee secrets/github_client >/dev/null
printf '%s' 'YOUR_CLIENT_SECRET' | sudo tee secrets/github_secret >/dev/null
sudo chmod 600 secrets/github_client secrets/github_secret

# 5. Registry credentials
REGISTRY_PASSWORD="$(openssl rand -base64 32 | tr -d '\n')"
printf '%s' "$REGISTRY_PASSWORD" | sudo tee secrets/registry_password >/dev/null
sudo docker run --rm httpd:2.4-alpine htpasswd -Bbn ci "$REGISTRY_PASSWORD" \
  | sudo tee secrets/registry.htpasswd >/dev/null
sudo chmod 600 secrets/registry_password secrets/registry.htpasswd
# The registry process runs as UID 568, so it must own its htpasswd file.
sudo chown 568:568 secrets/registry.htpasswd

# 6. Start
sudo docker compose up -d
```

The first start runs the Woodpecker database migration. It is safe to restart the stack later; the
SQLite database and registry layers are on the ZFS dataset.

Check the local health before DNS is ready:

```bash
sudo docker ps --filter name=woodpecker
sudo docker run --rm --network woodpecker-internal curlimages/curl -fsS \
  http://woodpecker-server:8000/healthz
sudo docker run --rm --network woodpecker-registry \
  curlimages/curl -fsS -u "ci:$(sudo cat secrets/registry_password)" \
  http://woodpecker-registry:5000/v2/_catalog
```

The second command should return `{"repositories":[]}` before the first build.

## Install the deploy key on the NAS

The pipeline must not hold a root SSH key. Create a dedicated `svault-deploy` user whose key can
only run one forced command. The command accepts a 40-character commit SHA, pulls that image from
the private registry, updates `SVAULT_IMAGE`, recreates only the `svault` service, and rolls back if
the health check fails.

The two scripts are also in this folder as [`svault-deploy-wrapper.sh`](./svault-deploy-wrapper.sh) and
[`svault-deploy.sh`](./svault-deploy.sh). Install them as root-owned, mode `0755`.

Create `/mnt/Storage/apps/woodpecker/bin/svault-deploy-wrapper`:

```sh
#!/bin/sh
set -eu

CMD=${SSH_ORIGINAL_COMMAND:-}
case "$CMD" in
  deploy\ *) SHA=${CMD#deploy } ;;
  *) echo "denied" >&2; exit 64 ;;
esac

case "$SHA" in
  *[!0-9a-f]*|'') echo "invalid commit" >&2; exit 64 ;;
esac
[ "${#SHA}" -eq 40 ] || { echo "invalid commit" >&2; exit 64; }

exec sudo -n /mnt/Storage/apps/woodpecker/bin/svault-deploy "$SHA"
```

Create `/mnt/Storage/apps/woodpecker/bin/svault-deploy`:

```sh
#!/bin/sh
set -eu
umask 077

SHA=${1:?missing commit}
case "$SHA" in
  *[!0-9a-f]*|'') echo "invalid commit" >&2; exit 64 ;;
esac
[ "${#SHA}" -eq 40 ] || { echo "invalid commit" >&2; exit 64; }

STACK_DIR=/mnt/Storage/stacks/svault
ENV_FILE=$STACK_DIR/.env
COMPOSE_FILE=$STACK_DIR/compose.yaml
REGISTRY=127.0.0.1:5000
IMAGE_NAME=registry:5000/svault
PASSWORD_FILE=/mnt/Storage/stacks/woodpecker/secrets/registry_password

exec 9>/var/lock/svault-deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 75; }

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
export DOCKER_CONFIG=$TMPD/docker
mkdir -p "$DOCKER_CONFIG"

PREV=$(sed -n 's/^SVAULT_IMAGE=//p' "$ENV_FILE" | tail -1)
[ -n "$PREV" ] || PREV=svault:1.1.10

docker login "$REGISTRY" -u ci --password-stdin < "$PASSWORD_FILE" >/dev/null
docker pull "$REGISTRY/svault:$SHA"
docker tag "$REGISTRY/svault:$SHA" "$IMAGE_NAME:$SHA"

TMP_ENV=$(mktemp "$STACK_DIR/.env.XXXXXX")
sed "s|^SVAULT_IMAGE=.*|SVAULT_IMAGE=$IMAGE_NAME:$SHA|" "$ENV_FILE" > "$TMP_ENV"
chmod 660 "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"

cd "$STACK_DIR"
if ! docker compose -f "$COMPOSE_FILE" up -d --no-deps svault; then
  echo "compose failed, rolling back to $PREV" >&2
  sed "s|^SVAULT_IMAGE=.*|SVAULT_IMAGE=$PREV|" "$ENV_FILE" > "$TMP_ENV"
  chmod 660 "$TMP_ENV"
  mv "$TMP_ENV" "$ENV_FILE"
  docker compose -f "$COMPOSE_FILE" up -d --no-deps svault || true
  exit 1
fi

for _ in $(seq 1 45); do
  STATUS=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' svault 2>/dev/null || echo missing)
  if [ "$STATUS" = healthy ]; then
    logger -t svault-deploy "deployed $IMAGE_NAME:$SHA"
    echo "deployed $IMAGE_NAME:$SHA"
    exit 0
  fi
  [ "$STATUS" = exited ] && break
  sleep 2
done

echo "health check failed, rolling back to $PREV" >&2
sed "s|^SVAULT_IMAGE=.*|SVAULT_IMAGE=$PREV|" "$ENV_FILE" > "$TMP_ENV"
chmod 660 "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"
docker compose -f "$COMPOSE_FILE" up -d --no-deps svault || true
logger -t svault-deploy "deploy failed for $IMAGE_NAME:$SHA, rolled back to $PREV"
exit 1
```

Then:

```bash
# TrueNAS mounts /usr/local read-only, so keep the scripts on the data pool.
sudo install -d -m 755 -o root -g root /mnt/Storage/apps/woodpecker/bin
sudo install -o root -g root -m 755 svault-deploy-wrapper.sh \
  /mnt/Storage/apps/woodpecker/bin/svault-deploy-wrapper
sudo install -o root -g root -m 755 svault-deploy.sh \
  /mnt/Storage/apps/woodpecker/bin/svault-deploy
sudo useradd --system --create-home --shell /bin/sh svault-deploy
sudo passwd -l svault-deploy

sudo install -d -m 700 -o svault-deploy -g svault-deploy /home/svault-deploy/.ssh

# Generate a key on your workstation (no passphrase; it is a CI key):
ssh-keygen -t ed25519 -N "" -C "svault-ci-deploy" -f ./svault-ci-deploy

# Install the public key with the forced command:
sudo tee /home/svault-deploy/.ssh/authorized_keys >/dev/null <<'EOF'
restrict,command="/mnt/Storage/apps/woodpecker/bin/svault-deploy-wrapper" ssh-ed25519 AAAA... svault-ci-deploy
EOF
sudo chown -R svault-deploy:svault-deploy /home/svault-deploy/.ssh
sudo chmod 600 /home/svault-deploy/.ssh/authorized_keys

echo 'svault-deploy ALL=(root) NOPASSWD: /mnt/Storage/apps/woodpecker/bin/svault-deploy' | \
  sudo tee /etc/sudoers.d/svault-deploy >/dev/null
sudo chmod 440 /etc/sudoers.d/svault-deploy

# TrueNAS does not include /etc/sudoers.d by default. Add the include once:
grep -q '^#includedir /etc/sudoers.d' /etc/sudoers || \
  echo '#includedir /etc/sudoers.d' | sudo tee -a /etc/sudoers

sudo visudo -cf /etc/sudoers
sudo -n -l -U svault-deploy
```

Test it from the NAS or your workstation:

```bash
ssh -i ./svault-ci-deploy -o IdentitiesOnly=yes svault-deploy@192.168.0.76 \
  "deploy 0123456789abcdef0123456789abcdef01234567"
```

It should fail at `docker pull` because that image does not exist, and that is the correct failure.
A command like `ssh ... "id"` must be rejected by the forced command.

Keep `./svault-ci-deploy` private. Paste its contents into the Woodpecker repository secret
`svault_deploy_ssh_key` and delete the local copy.

## Activate the repository in Woodpecker

1. Open `https://ci.picklehouse.xyz` and sign in with GitHub. `AtaKon` is the admin because of
   `WOODPECKER_ADMIN`.
2. **Repositories → Add repository → svault**.
3. Open the repository settings and add two secrets:

| Secret | Value | Events |
| --- | --- | --- |
| `registry_password` | contents of `/mnt/Storage/stacks/woodpecker/secrets/registry_password` | push, tag |
| `svault_deploy_ssh_key` | private key generated above | push, tag |

Do **not** enable `pull_request` for either secret. Woodpecker injects secrets only into the events
you tick, and the pipeline only references them in `publish`/`deploy` steps that run on `main`.

4. Push a commit to `main`. Woodpecker should run `test → publish → deploy`. The deploy step
   updates the `svault` stack image and waits for the health check.

The first build takes a few minutes. Later builds reuse Docker layer cache only if you enable the
Kaniko cache; the default pipeline is intentionally cache-free and reproducible.

## How the live app is updated

The deploy script writes `SVAULT_IMAGE=registry:5000/svault:<full-sha>` to the existing SVault stack
and runs:

```bash
docker compose -f /mnt/Storage/stacks/svault/compose.yaml up -d --no-deps svault
```

The `svault` container keeps its existing `/mnt/Storage/apps/svault/data` bind mount, so the database
and uploads are untouched. On a failed health check the script restores the previous image and
recreates the container again.

Roll back manually by setting `SVAULT_IMAGE` in `/mnt/Storage/stacks/svault/.env` to an older
`registry:5000/svault:<sha>` and pressing **Deploy** in Dockge.

## The issue/PR review bot

`.github/workflows/ai-review.yml` runs on GitHub Actions (not on the NAS). It uses an
OpenAI-compatible chat endpoint to triage new issues and review pull request diffs. It never checks
out or executes pull request code, and it only runs for the repository owner, members and
collaborators.

Add these repository secrets/variables in **GitHub → Settings → Secrets and variables → Actions**:

| Name | Kind | Required | Meaning |
| --- | --- | --- | --- |
| `AI_REVIEW_API_KEY` | secret | yes | API key for the review model |
| `AI_REVIEW_BASE_URL` | variable | no | Defaults to `https://api.openai.com/v1` |
| `AI_REVIEW_MODEL` | variable | no | Defaults to `gpt-4o-mini` |
| `AI_REVIEW_MAX_TOKENS` | variable | no | Answer budget, defaults to `4000`. Reasoning models spend part of it thinking; an empty answer is retried once with a shorter diff and twice the budget |
| `AI_REVIEW_REASONING` | variable | no | OpenRouter only: `off` (default) turns model thinking off so the budget goes to the review; `low` asks for short thinking; `default` leaves the model's own setting. If a model cannot turn thinking off, the bot falls back to `low` |

If `AI_REVIEW_API_KEY` is missing the workflow exits successfully without commenting. The bot
updates its own previous comment instead of posting a new one on every push. Treat its output as a
review aid, not an approval.

## Security notes

- **No public port is opened by this stack.** NPM is the only ingress, and only for
  `ci.picklehouse.xyz`.
- **Closed registration.** Only `AtaKon` can sign in. The agent registration API is disabled.
- **Fork PRs require approval.** Until you approve a fork PR, it does not run. Only owner pushes run
  automatically.
- **Deploy key is not root.** The `svault-deploy` key is restricted to one forced command, validates
  a full 40-character SHA, and only touches the `svault` stack.
- **Pipeline steps cannot reach the Woodpecker server or NPM network.** They join only the
  `woodpecker-registry` network.
- **No GHCR token.** Images stay in the private local registry. There is no long-lived write token
  for a public registry.
- **Registry auth.** The registry is HTTP-only but isolated; it is bound to `127.0.0.1` for the host
  and reachable as `registry:5000` only from the CI network. It is not internet-facing.
- **Secrets are files, not env vars.** OAuth, agent and gRPC secrets are Docker secrets with
  `0400` permissions. The deploy key and registry password are Woodpecker repo secrets, limited to
  `push`/`tag`.
- **Resource limits.** The agent is capped at 2 GiB / 1024 PIDs, each step at 2 GiB / 2 CPUs, the
  server at 512 MiB, and the registry at 256 MiB.
- **Read-only root filesystems** and `no-new-privileges` where the images allow it.

### What the agent can still do

The Docker agent needs `/var/run/docker.sock` to start step containers. That is root-equivalent on
the host, so only approve pull requests you trust, and do not enable `pull_request` for deploy
secrets. If you need to run untrusted PR code, add a second agent with a disposable/rootless Docker
daemon and route only PR workflows to it.

## Backups

Woodpecker state and the registry live under `/mnt/Storage/apps/woodpecker`:

| Path | Contents |
| --- | --- |
| `server/woodpecker.sqlite` | users, repositories, pipelines, secrets (encrypted at rest by Woodpecker) |
| `agent/agent.conf` | agent identity |
| `registry/` | image layers for every deployed commit |

Snapshot `/mnt/Storage/apps/woodpecker` and `/mnt/Storage/apps/svault` together. The registry layers
are disposable if you keep the source; the Woodpecker database is not.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ci.picklehouse.xyz` shows 502 | Check the NPM forward host is `woodpecker-server`, port `8000`, and the server is on the `proxy` network. |
| OAuth redirects to an error | The callback URL must be exactly `https://ci.picklehouse.xyz/authorize`; the homepage must be `https://ci.picklehouse.xyz`. |
| `WOODPECKER_ADMIN` does not apply | The login is case-sensitive (`AtaKon`). Restart the server after changing it. |
| Pipeline stuck at `pending` | The agent is not connected. Check `docker logs woodpecker-agent` and that both use the same `secrets/agent_secret`. |
| `publish` gets `401` from the registry | The `registry_password` repo secret must equal `secrets/registry_password`; the htpasswd file must be regenerated if you rotate it. |
| `deploy` permission denied | Check the forced command and `/etc/sudoers.d/svault-deploy`; `visudo -cf` must pass. |
| Deploy rolls back | The new image is unhealthy. Inspect `docker logs svault`; the previous image is restored automatically. |
| Certificate fails while Cloudflare is proxied | Set the record to **DNS only**, issue the certificate, then switch back to **Proxied**. |
| Agent cannot pull images | The Docker daemon pulls images, not the agent; check the Docker daemon logs and disk space. |

## Rotating secrets

- **Agent/gRPC secrets:** replace both files, then `docker compose up -d --force-recreate`.
- **OAuth client secret:** generate a new secret in the GitHub OAuth app, update
  `secrets/github_secret`, then recreate the server.
- **Registry password:** generate a new password and htpasswd, update
  `secrets/registry_password`, recreate the registry, and update the Woodpecker repo secret.
- **Deploy key:** generate a new key, replace `authorized_keys`, update the Woodpecker secret, and
  delete the old key.
