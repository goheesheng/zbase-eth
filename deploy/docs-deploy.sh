#!/usr/bin/env bash
# zBase docs deploy — build the MkDocs Material site and publish it to docs.zbase.app.
#
#   ./deploy/docs-deploy.sh
#
# Static site → rsync to the box's /srv/zbase/docs → served by the shared Caddy (file_server).
# Content-only updates need NO Caddy restart (file_server reads the volume live).
#
# ONE-TIME setup (before the first run of this script):
#   1. DNS: add an A record  docs.zbase.app -> 43.156.119.46  (80/443 already open).
#   2. Recreate the edge Caddy so the /srv/docs volume + the docs.zbase.app block load:
#        ./deploy/deploy.sh edge
set -euo pipefail

VPS="${ZBASE_VPS:-ubuntu@43.156.119.46}"
DOCS_DIR=/srv/zbase/docs
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Prefer the repo-local venv (reproducible); fall back to a mkdocs on PATH.
if [ -x ".venv-docs/bin/mkdocs" ]; then
  MKDOCS=".venv-docs/bin/mkdocs"
elif command -v mkdocs >/dev/null 2>&1; then
  MKDOCS="mkdocs"
else
  echo "mkdocs not found. Create the venv: python3 -m venv .venv-docs && .venv-docs/bin/pip install -r docs-requirements.txt" >&2
  exit 1
fi

echo "==> build (mkdocs) -> ./site"
"$MKDOCS" build --clean

echo "==> ensure $VPS:$DOCS_DIR exists"
ssh "$VPS" "sudo mkdir -p $DOCS_DIR && sudo chown \$(id -u):\$(id -g) $DOCS_DIR"

echo "==> rsync ./site/ -> $VPS:$DOCS_DIR"
rsync -az --delete site/ "$VPS:$DOCS_DIR/"

# file_server serves the new files immediately; a reload is only needed the first time the
# docs.zbase.app block is added. Harmless to run every time; ignore if the block is unchanged.
echo "==> reload Caddy (picks up the docs.zbase.app block on first publish)"
ssh "$VPS" "cd /srv/zbase/app && (docker compose -p zbase-edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true)"

echo "==> done: https://docs.zbase.app"
