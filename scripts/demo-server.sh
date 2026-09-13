#!/usr/bin/env bash
# Start the zBase SVM x402 server in privacy-pool (V1) mode.
# Single-shot helper so the env vars can never get mangled by paste.
#
# Usage:
#   ./scripts/demo-server.sh
#
# Stop with Ctrl+C. The script kills any prior server on port 4020 first.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Kill anything on port 4020 (no-op if nothing's there).
EXISTING=$(lsof -ti :4020 || true)
if [ -n "$EXISTING" ]; then
  echo "Killing existing server on :4020 (PID $EXISTING)"
  kill -9 $EXISTING
  sleep 1
fi

# 2. Verify port is free.
if lsof -i :4020 >/dev/null 2>&1; then
  echo "ERROR: port 4020 still in use after kill" >&2
  exit 1
fi

# 3. Sanity-check the SDK dist is built.
if [ ! -f "$REPO/packages/svm/sdk/dist/index.js" ]; then
  echo "Building SDK first..."
  (cd "$REPO/packages/svm/sdk" && npm run build)
fi

# 4. Start the server. ZX402_SVM_READY defaults to true (V1 is live), so we
# only need to point SDK_PATH and CIRCUITS_URL at absolute paths so the
# server's `await import(...)` resolves outside this dir's node_modules.
echo "Starting zBase facilitator on :4020 (privacy mode, V1)..."
cd "$REPO/packages/svm/x402-server"
exec env \
  ZX402_SVM_SDK_PATH="$REPO/packages/svm/sdk/dist/index.js" \
  ZX402_CIRCUITS_URL="$REPO/public/circuits" \
  node index.js
