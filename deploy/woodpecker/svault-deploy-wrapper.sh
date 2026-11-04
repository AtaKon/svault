#!/bin/sh
# Forced SSH command for the `svault-deploy` user.
#
# Install as /mnt/Storage/apps/woodpecker/bin/svault-deploy-wrapper, owned by
# root and mode 0755. The matching authorized_keys line is:
#
#   restrict,command="/mnt/Storage/apps/woodpecker/bin/svault-deploy-wrapper" ssh-ed25519 AAAA...
#
# It accepts exactly one command shape: `deploy <40 lowercase hex chars>`.
# Anything else is rejected before sudo is invoked.

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
