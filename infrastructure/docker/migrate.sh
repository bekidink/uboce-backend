#!/bin/sh
# Applies every service's migrations to its own database. Each service's URL
# comes from <NAME>_DATABASE_URL; services without one are skipped.
set -eu

for dir in /repo/services/*/; do
  name=$(basename "$dir")
  var="$(echo "$name" | tr '[:lower:]' '[:upper:]')_DATABASE_URL"
  url=$(printenv "$var" || true)
  if [ -z "$url" ]; then
    echo "skip $name ($var not set)"
    continue
  fi
  echo "migrating $name"
  (cd "$dir" && DATABASE_URL="$url" pnpm exec prisma migrate deploy)
done
