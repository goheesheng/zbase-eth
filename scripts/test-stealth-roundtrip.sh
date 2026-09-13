#!/usr/bin/env bash
# scripts/test-stealth-roundtrip.sh — B.1 integration test.
#
# Boots a fresh `npm run dev -- -p <PORT>` in the background, waits for it to
# answer health checks, runs scripts/register-stealth-provider.ts against it,
# then verifies the new provider lands in GET /api/providers/register. Finally
# tears the dev server down cleanly.
#
# Distinct from:
#   - scripts/test-stealth.ts          (offline SDK invariants, no server)
#   - scripts/test-providers-route.ts  (in-process route handler smoke, no
#                                       running server — uses temp registry)
#
# Exit codes:
#   0   register + GET both passed
#   non-zero on any failure (server didn't start, register failed, listing
#                            missed the provider, etc).
#
# Compatible with macOS bash 3.2 (no associative arrays, no mapfile).
#
# Usage:
#   bash scripts/test-stealth-roundtrip.sh
#   PORT=3019 bash scripts/test-stealth-roundtrip.sh    # custom port
#   KEEP_LOG=1 bash scripts/test-stealth-roundtrip.sh   # don't delete log on success

set -u

# ─── config ──────────────────────────────────────────────────────────────────

PORT="${PORT:-3019}"
HEALTH_URL="http://localhost:${PORT}/api/health"
REGISTRY_URL="http://localhost:${PORT}/api/providers/register"
BOOT_TIMEOUT_SECS="${BOOT_TIMEOUT_SECS:-60}"
LOG_FILE="/tmp/zbase-dev-server-$$.log"

# Use a recognizable provider name so we can grep for it in the listing.
TS=$(date +%s)
PROVIDER_NAME="roundtrip-${TS}-$$"
PROVIDER_EMAIL="roundtrip+${TS}@example.test"

# Find the repo root (script lives in <repo>/scripts/).
SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"

DEV_PID=""
EXIT_CODE=0

# ─── helpers ─────────────────────────────────────────────────────────────────

say() {
  printf '[stealth-roundtrip] %s\n' "$*"
}

bail() {
  EXIT_CODE="$1"
  shift
  printf '[stealth-roundtrip] FAIL — %s\n' "$*" >&2
  cleanup
  exit "${EXIT_CODE}"
}

cleanup() {
  if [ -n "${DEV_PID}" ]; then
    say "tearing down dev server (pid=${DEV_PID})"
    # Kill the whole process group; Next.js spawns workers.
    kill -TERM "-${DEV_PID}" 2>/dev/null || kill -TERM "${DEV_PID}" 2>/dev/null || true
    # Give it up to 10s to exit; then SIGKILL.
    i=0
    while kill -0 "${DEV_PID}" 2>/dev/null; do
      i=$((i + 1))
      if [ "${i}" -ge 20 ]; then
        say "SIGKILL on ${DEV_PID}"
        kill -KILL "-${DEV_PID}" 2>/dev/null || kill -KILL "${DEV_PID}" 2>/dev/null || true
        break
      fi
      sleep 0.5
    done
  fi

  # Best-effort: confirm port is free. Doesn't fail the run if lsof is missing.
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      printf '[stealth-roundtrip] WARN — port %s still in use after teardown\n' "${PORT}" >&2
    fi
  fi

  if [ "${EXIT_CODE}" -eq 0 ] && [ -z "${KEEP_LOG:-}" ]; then
    rm -f "${LOG_FILE}"
  else
    printf '[stealth-roundtrip] dev-server log preserved at %s\n' "${LOG_FILE}" >&2
  fi
}

trap 'EXIT_CODE=$?; cleanup; exit ${EXIT_CODE}' INT TERM

# ─── 1. preflight ────────────────────────────────────────────────────────────

cd "${REPO_ROOT}" || bail 1 "could not cd into repo root: ${REPO_ROOT}"

if ! command -v npm >/dev/null 2>&1; then
  bail 1 "npm not on PATH"
fi
if ! command -v npx >/dev/null 2>&1; then
  bail 1 "npx not on PATH"
fi
if ! command -v curl >/dev/null 2>&1; then
  bail 1 "curl not on PATH"
fi

# Port must be free before we try to boot.
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    bail 1 "port ${PORT} already in use (set PORT=<free port> and retry)"
  fi
fi

say "repo  : ${REPO_ROOT}"
say "port  : ${PORT}"
say "log   : ${LOG_FILE}"
say "name  : ${PROVIDER_NAME}"

# ─── 2. boot dev server in background ───────────────────────────────────────

say "starting dev server: npm run dev -- -p ${PORT}"
# `setsid`-style group: bash creates a new process group via `set -m` + &.
set -m
( npm run dev -- -p "${PORT}" >"${LOG_FILE}" 2>&1 ) &
DEV_PID=$!
set +m

say "dev server pid=${DEV_PID}; waiting up to ${BOOT_TIMEOUT_SECS}s for health"

# Poll /api/health FIRST. The health endpoint is a deterministic 200/503:
#   - 200 = Next.js is up + all required env present
#   - 503 = Next.js is up but env is incomplete (still fine for this test —
#          stealth registration doesn't require POSTMAN_PRIVATE_KEY etc)
# Both are "compiled and serving", so we proceed.
#
# Only if /api/health is genuinely missing (404, or curl can't reach the
# server yet — code 000) do we fall back to polling /api/providers/register.
# This keeps the noise down on the common path while preserving the older
# fallback for older branches without the health route.
i=0
ready=""
while [ "${i}" -lt "${BOOT_TIMEOUT_SECS}" ]; do
  # Dev server died before becoming ready?
  if ! kill -0 "${DEV_PID}" 2>/dev/null; then
    say "dev server process exited prematurely; tail of log:"
    tail -n 40 "${LOG_FILE}" >&2 || true
    bail 1 "dev server died during boot"
  fi

  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "${HEALTH_URL}" || echo "000")
  if [ "${code}" = "200" ] || [ "${code}" = "503" ]; then
    ready="health"
    break
  fi

  # Only fall back if /api/health truly isn't there (404) or unreachable.
  if [ "${code}" = "404" ] || [ "${code}" = "000" ]; then
    code2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "${REGISTRY_URL}" || echo "000")
    if [ "${code2}" = "200" ]; then
      ready="registry"
      break
    fi
  fi

  sleep 1
  i=$((i + 1))
done

if [ -z "${ready}" ]; then
  say "tail of dev-server log:"
  tail -n 60 "${LOG_FILE}" >&2 || true
  bail 1 "dev server never answered within ${BOOT_TIMEOUT_SECS}s"
fi

say "dev server is up (ready via: ${ready})"

# ─── 3. run the registration script ─────────────────────────────────────────

say "running register-stealth-provider.ts against http://localhost:${PORT}"

REG_OUTPUT_FILE="/tmp/zbase-stealth-register-$$.out"
PROVIDER_NAME="${PROVIDER_NAME}" \
  PROVIDER_EMAIL="${PROVIDER_EMAIL}" \
  ZBASE_API="http://localhost:${PORT}" \
  npx tsx scripts/register-stealth-provider.ts >"${REG_OUTPUT_FILE}" 2>&1
REG_STATUS=$?

# Always echo the script output so failures are debuggable.
cat "${REG_OUTPUT_FILE}"

if [ "${REG_STATUS}" -ne 0 ]; then
  rm -f "${REG_OUTPUT_FILE}"
  bail 1 "register-stealth-provider.ts exited ${REG_STATUS}"
fi
rm -f "${REG_OUTPUT_FILE}"

# ─── 4. independent verification via GET ────────────────────────────────────

say "verifying provider is in GET listing"

LIST_BODY=$(curl -s --max-time 10 "${REGISTRY_URL}" || echo "")
if [ -z "${LIST_BODY}" ]; then
  bail 1 "GET ${REGISTRY_URL} returned empty body"
fi

# Plain grep so we don't depend on jq. The PROVIDER_NAME is unique-per-run
# so a substring match is sufficient and doesn't false-positive across runs.
echo "${LIST_BODY}" | grep -q "${PROVIDER_NAME}"
if [ $? -ne 0 ]; then
  say "GET listing body:"
  echo "${LIST_BODY}" >&2
  bail 1 "provider name '${PROVIDER_NAME}' not found in listing"
fi

say "PASS — provider '${PROVIDER_NAME}' registered and visible in listing"

# ─── 5. teardown ────────────────────────────────────────────────────────────

cleanup
exit 0
