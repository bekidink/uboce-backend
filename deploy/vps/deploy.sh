#!/usr/bin/env bash
# Deploys (or updates) UBOCE on the server, from your machine:
#   deploy/vps/deploy.sh root@SERVER           # images tagged in site.env (TAG)
#   deploy/vps/deploy.sh root@SERVER <sha>     # pin a specific CI build
#   BUILD=1 deploy/vps/deploy.sh root@SERVER   # build images on the server instead of pulling
#
# Regenerates the Compose file and env files, copies them (with secrets) to
# /opt/uboce over SSH, then pulls/builds and restarts. Migrations run first.
set -euo pipefail
HOST="${1:?Usage: deploy/vps/deploy.sh user@server [tag]}"
TAG_OVERRIDE="${2:-}"
DIR=/opt/uboce
cd "$(dirname "$0")/../.."

pnpm --silent vps:generate
pnpm --silent vps:env

ssh "$HOST" "mkdir -p $DIR/env $DIR/secrets $DIR/web && chmod 700 $DIR/env $DIR/secrets"
scp -q deploy/vps/docker-compose.yml deploy/vps/Caddyfile deploy/vps/site.env "$HOST:$DIR/"
scp -q deploy/vps/env/*.env "$HOST:$DIR/env/"
if compgen -G "deploy/vps/secrets/*" >/dev/null; then scp -q deploy/vps/secrets/* "$HOST:$DIR/secrets/"; fi
if compgen -G "deploy/vps/web/*" >/dev/null; then scp -qr deploy/vps/web/. "$HOST:$DIR/web/"; fi
ssh "$HOST" "chmod 600 $DIR/env/*.env"

TAG_ENV=""
[ -n "$TAG_OVERRIDE" ] && TAG_ENV="TAG=$TAG_OVERRIDE"

if [ "${BUILD:-0}" = "1" ]; then
  # Building needs the source on the server too.
  git archive --format=tar HEAD | ssh "$HOST" "mkdir -p $DIR/src && tar -x -C $DIR/src"
  ssh "$HOST" "cd $DIR && cp -r docker-compose.yml Caddyfile site.env env secrets web src/deploy/vps/ && cd src/deploy/vps && $TAG_ENV docker compose --env-file site.env up -d --build --remove-orphans"
else
  ssh "$HOST" "cd $DIR && $TAG_ENV docker compose --env-file site.env pull --quiet && $TAG_ENV docker compose --env-file site.env up -d --remove-orphans && docker image prune -f >/dev/null"
fi

ssh "$HOST" "cd $DIR && docker compose --env-file site.env ps --format 'table {{.Service}}\t{{.Status}}'"
echo
echo "Check: https://$(grep ^API_DOMAIN= deploy/vps/site.env | cut -d= -f2)/health/ready"
