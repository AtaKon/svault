#!/bin/sh
set -e

# Optionally seed the demo vault the first time the container starts.
if [ "${SEED_DEMO:-false}" = "true" ] && [ ! -f "${DATA_DIR:-/data}/svault.db" ]; then
  echo "Seeding demo data…"
  node --disable-warning=ExperimentalWarning dist/server/seed.js || echo "Seed failed (continuing)"
fi

exec "$@"
