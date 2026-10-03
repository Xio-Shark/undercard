#!/usr/bin/env bash
# Deploys the current tree to the production VPS (systemd `undercard`, behind Cloudflare Tunnel).
# Builds a linux/amd64 image locally (OrbStack), ships only the standalone output, swaps it in
# atomically, keeps the previous build as /opt/undercard/app.prev for rollback, then health-checks.
# Usage: DEPLOY_HOST=user@host DEPLOY_SSH_KEY=/path/to/key [PUBLIC_URL=https://...] scripts/deploy-racknerd.sh
# Rollback: ssh in and run `mv app app.bad && mv app.prev app`.
# The host and key are never stored here: the origin sits behind a Cloudflare Tunnel and its address stays private.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:?set DEPLOY_HOST=user@host}"
KEY="${DEPLOY_SSH_KEY:?set DEPLOY_SSH_KEY=/path/to/private/key}"
PUBLIC_URL="${PUBLIC_URL:-https://undercard.wangbohan.biz}"
TAG="undercard:deploy-$(date +%Y%m%d%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; docker rm -f undercard-extract >/dev/null 2>&1 || true' EXIT
ssh_() { ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" "$HOST" "$@"; }

echo "== build $TAG"
docker buildx build --platform linux/amd64 -t "$TAG" --load . >/dev/null
docker create --platform linux/amd64 --name undercard-extract "$TAG" >/dev/null
docker cp undercard-extract:/app - | gzip -1 > "$TMP/app.tar.gz"
docker rm -f undercard-extract >/dev/null

echo "== upload $(du -h "$TMP/app.tar.gz" | cut -f1)"
scp -q -o IdentitiesOnly=yes -i "$KEY" "$TMP/app.tar.gz" "$HOST:/opt/undercard/app.tar.gz"

echo "== swap and restart"
ssh_ 'set -e
cd /opt/undercard
rm -rf app.new && mkdir app.new && tar -xzf app.tar.gz -C app.new --strip-components=1 && rm app.tar.gz
chown -R undercard:undercard app.new
rm -rf app.prev && mv app app.prev && mv app.new app
systemctl restart undercard
for i in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:3000/api/health && break; sleep 1; done
curl -s http://127.0.0.1:3000/api/health; echo'

echo "== public check"
curl -s -m 20 -o /dev/null -w "$PUBLIC_URL/ http=%{http_code}\n" "$PUBLIC_URL/"
docker image rm "$TAG" >/dev/null
