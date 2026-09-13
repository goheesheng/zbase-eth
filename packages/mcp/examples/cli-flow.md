# Example: the private-pay flow (no secrets)

The same five tools the MCP exposes, driven from the repo's CLI harness (`run.ts`) so you can see the
flow without an MCP client. **No seed material or secrets appear here** — every note derives from the
local seed automatically.

```bash
cd packages/mcp

# 1. Get your deposit address (read-only). Send USDC to it from any wallet — no ETH needed.
npx tsx run.ts address

# 2. Move the funded USDC into the privacy pool (gasless). Omit the amount to sweep everything.
npx tsx run.ts sweep

# 3. Check spendable balance. Each payment spends ONE note (see largestNoteUSDC).
npx tsx run.ts balance

# 4. Pay + fetch an x402 URL privately. --pilot acknowledges the open-pilot not-private disclosure;
#    --body switches to POST. This spends REAL USDC on mainnet.
npx tsx run.ts pay https://api.seller.com/endpoint 0.05 --pilot
```

## Money-safety

Read each `pay` result's `outcome`. `refused` or a clean pre-settlement error means the note is
untouched (safe to retry). `uncertain`, or `delivered` with no 2xx, means the note may be or is spent —
and `pay` re-selects a DIFFERENT note next time, so run `balance` and confirm you were not charged
before paying again. Never start a fresh payment for the same purchase without checking `balance` first.
