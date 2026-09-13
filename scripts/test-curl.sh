#!/bin/bash
# ══════════════════════════════════════════════════════════
# zBase API Test Suite — curl commands against live server
#
# Tests all 3 integration methods:
#   1. x402 Facilitator endpoints
#   2. Direct API endpoints
#   3. ASP update endpoint
#
# Usage:
#   npm run test:curl
#   # or
#   bash scripts/test-curl.sh
#
# Prerequisites:
#   - zBase dev server running on port 3009
# ══════════════════════════════════════════════════════════

API="http://localhost:3009"
PASS=0
FAIL=0

green() { echo -e "\033[32m$1\033[0m"; }
red() { echo -e "\033[31m$1\033[0m"; }
bold() { echo -e "\033[1m$1\033[0m"; }

check() {
  local name="$1"
  local response="$2"
  local expected="$3"

  if echo "$response" | grep -q "$expected"; then
    green "  PASS: $name"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $name"
    echo "  Expected to contain: $expected"
    echo "  Got: $(echo "$response" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
bold "╔══════════════════════════════════════════════════════╗"
bold "║          zBase API Test Suite (curl)                 ║"
bold "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Check server is running ──
bold "[0] Checking server..."
SERVER_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "$API" 2>/dev/null)
if [ "$SERVER_CHECK" != "200" ]; then
  red "  Server not running at $API"
  echo "  Start it with: npm run dev -- -p 3009"
  exit 1
fi
green "  Server running at $API"

# ══════════════════════════════════════════════════════════
# TEST 1: x402 Facilitator — GET /api/facilitator/supported
# ══════════════════════════════════════════════════════════
echo ""
bold "[1] GET /api/facilitator/supported (Discovery)"
echo "  curl $API/api/facilitator/supported"
echo ""

RES=$(curl -s "$API/api/facilitator/supported")

check "Returns facilitator name" "$RES" "zBase Privacy Facilitator"
check "Supports USDC" "$RES" "USDC"
check "Supports Base Sepolia" "$RES" "eip155:84532"
check "Privacy enabled" "$RES" "Groth16 ZK-SNARK"
check "Yield via Morpho" "$RES" "Morpho Blue"
check "Has entrypoint address" "$RES" "0x598ffaac79ae29b1aae571fd91899d4492183688"
check "Has pool address" "$RES" "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a"

# ══════════════════════════════════════════════════════════
# TEST 2: x402 Facilitator — POST /api/facilitator/verify
# ══════════════════════════════════════════════════════════
echo ""
bold "[2] POST /api/facilitator/verify (Validation)"

# 2a: Missing scheme
echo "  2a: Missing scheme (should fail)"
RES=$(curl -s -X POST "$API/api/facilitator/verify" \
  -H "Content-Type: application/json" \
  -d '{"paymentDetails":{"payTo":"0x1234567890abcdef1234567890abcdef12345678"}}')
check "Rejects missing scheme" "$RES" "Unsupported scheme"

# 2b: Wrong network
echo "  2b: Wrong network (should fail)"
RES=$(curl -s -X POST "$API/api/facilitator/verify" \
  -H "Content-Type: application/json" \
  -d '{"paymentDetails":{"scheme":"exact","payTo":"0x1234567890abcdef1234567890abcdef12345678","networkId":"eip155:1","maxAmountRequired":"1000000"}}')
check "Rejects wrong network" "$RES" "Unsupported network"

# 2c: Insufficient amount
echo "  2c: Insufficient deposit amount (should fail)"
RES=$(curl -s -X POST "$API/api/facilitator/verify" \
  -H "Content-Type: application/json" \
  -d '{"paymentDetails":{"scheme":"exact","payTo":"0x1234567890abcdef1234567890abcdef12345678","networkId":"eip155:84532","maxAmountRequired":"999999999"},"zbaseDeposit":{"nullifier":"123","secret":"456","value":"990000","label":"789","commitment":"101112"}}')
check "Rejects insufficient amount" "$RES" "Insufficient deposit"

# 2d: Valid verification
echo "  2d: Valid deposit data (should pass)"
RES=$(curl -s -X POST "$API/api/facilitator/verify" \
  -H "Content-Type: application/json" \
  -d '{"paymentDetails":{"scheme":"exact","payTo":"0x1234567890abcdef1234567890abcdef12345678","networkId":"eip155:84532","maxAmountRequired":"100000"},"zbaseDeposit":{"nullifier":"123","secret":"456","value":"990000","label":"789","commitment":"101112"}}')
check "Accepts valid deposit" "$RES" '"valid":true'

# ══════════════════════════════════════════════════════════
# TEST 3: x402 Facilitator — POST /api/facilitator/settle
# ══════════════════════════════════════════════════════════
echo ""
bold "[3] POST /api/facilitator/settle (Settlement)"

# 3a: Missing payTo
echo "  3a: Missing payTo (should fail)"
RES=$(curl -s -X POST "$API/api/facilitator/settle" \
  -H "Content-Type: application/json" \
  -d '{"paymentDetails":{}}')
check "Rejects missing payTo" "$RES" "Missing paymentDetails.payTo"

# 3b: Missing deposit secrets
echo "  3b: Missing deposit data (should fail)"
RES=$(curl -s -X POST "$API/api/facilitator/settle" \
  -H "Content-Type: application/json" \
  -d '{"paymentDetails":{"payTo":"0x1234567890abcdef1234567890abcdef12345678"}}')
check "Rejects missing deposit" "$RES" "Missing zbaseDeposit"

# 3c: Invalid deposit (will fail at proof stage, but route should respond)
echo "  3c: Fake deposit data (should fail at proof stage)"
RES=$(curl -s --max-time 30 -X POST "$API/api/facilitator/settle" \
  -H "Content-Type: application/json" \
  -d '{"paymentDetails":{"payTo":"0x1234567890abcdef1234567890abcdef12345678","maxAmountRequired":"100000"},"zbaseDeposit":{"nullifier":"123","secret":"456","value":"990000","label":"789","commitment":"101112"}}')
check "Returns settlement error for fake data" "$RES" "settled.*false"

# ══════════════════════════════════════════════════════════
# TEST 4: Legacy API — POST /api/x402-pay
# ══════════════════════════════════════════════════════════
echo ""
bold "[4] POST /api/x402-pay (Disabled Legacy Payment)"

# 4a: Legacy route is disabled for the Base mainnet launch
echo "  4a: Legacy route disabled (should fail closed)"
RES=$(curl -s -X POST "$API/api/x402-pay" \
  -H "Content-Type: application/json" \
  -d '{"provider":"0x1234567890abcdef1234567890abcdef12345678"}')
check "Rejects legacy x402-pay" "$RES" "LEGACY_X402_PAY_DISABLED"

# ══════════════════════════════════════════════════════════
# TEST 5: Direct API — POST /api/withdraw
# ══════════════════════════════════════════════════════════
echo ""
bold "[5] POST /api/withdraw (Direct Withdrawal)"

# 5a: Invalid recipient
echo "  5a: Invalid recipient (should fail)"
RES=$(curl -s -X POST "$API/api/withdraw" \
  -H "Content-Type: application/json" \
  -d '{"nullifier":"123","secret":"456","value":"990000","label":"789","commitment":"101112","recipient":"not-an-address"}')
check "Rejects invalid recipient" "$RES" "Invalid recipient"

# 5b: Valid format but fake data
echo "  5b: Valid format, fake commitment (should fail at tree lookup)"
RES=$(curl -s --max-time 30 -X POST "$API/api/withdraw" \
  -H "Content-Type: application/json" \
  -d '{"nullifier":"123","secret":"456","value":"990000","label":"789","commitment":"101112","recipient":"0x1234567890abcdef1234567890abcdef12345678"}')
check "Returns commitment not found" "$RES" "Commitment not found"

# ══════════════════════════════════════════════════════════
# TEST 6: ASP Update — POST /api/asp-update
# ══════════════════════════════════════════════════════════
echo ""
bold "[6] POST /api/asp-update (Compliance Root Update)"

RES=$(curl -s --max-time 30 -X POST "$API/api/asp-update")
check "ASP update responds" "$RES" "root\|updated\|deposits"

# ══════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════
echo ""
bold "══════════════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  green "All $TOTAL tests passed!"
else
  echo "$(green "$PASS passed"), $(red "$FAIL failed") out of $TOTAL tests"
fi
bold "══════════════════════════════════════════════════════"
echo ""

# Print notes for real testing
echo "NOTE: Tests 3c and 5b intentionally fail because they use fake deposit data."
echo "To test with REAL data (actual on-chain deposit + withdrawal):"
echo "  npm run test:e2e"
echo ""

exit $FAIL
