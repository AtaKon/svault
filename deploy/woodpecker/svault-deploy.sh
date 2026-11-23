#!/bin/sh
# Deploy one SVault commit from the private Woodpecker registry.
#
# Install as /mnt/Storage/apps/woodpecker/bin/svault-deploy, owned by root and
# mode 0755. It is invoked through sudo by svault-deploy-wrapper.
#
# Guarantees:
#   - only a 40-character lowercase hex commit SHA is accepted;
#   - only the `svault` service in /mnt/Storage/stacks/svault is recreated;
#   - the image is pulled from the private registry and tagged locally;
#   - a failed health check restores the previous SVAULT_IMAGE.

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

# Every deploy pulls a new image under two names. Keep only the current and
# the previous commit (the rollback target) and drop the rest, so the NAS disk
# does not slowly fill up. A failed removal never fails the deploy: Docker
# refuses to remove an image a container still uses, which is fine.
prune_old_images() {
  KEEP_PREV=${PREV##*:}
  docker images --format '{{.Repository}} {{.Tag}}' \
    | awk -v a="$REGISTRY/svault" -v b="$IMAGE_NAME" '$1 == a || $1 == b' \
    | while read -r repo tag; do
        ref="$repo:$tag"
        [ "$tag" = "$SHA" ] && continue
        [ "$tag" = "$KEEP_PREV" ] && continue
        docker rmi "$ref" >/dev/null 2>&1 || true
      done
  docker image prune -f >/dev/null 2>&1 || true
  logger -t svault-deploy "pruned old svault images, kept $SHA and $KEEP_PREV"
}

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
    prune_old_images
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
