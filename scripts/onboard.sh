#!/usr/bin/env bash
# scripts/onboard.sh — thin wrapper around scripts/onboard.ts.
#
# Usage:
#   ./scripts/onboard.sh <provider-name> [flags]
#
# This wrapper exists so the one-line command in a Coinbase / OpenAI / Anthropic
# DM looks like a single bash invocation rather than "npx tsx scripts/onboard.ts".
# When @zx402/sdk is npm-published, this becomes `npx zbase onboard <name>`.

set -e
cd "$(dirname "$0")/.."
exec npx tsx scripts/onboard.ts "$@"
