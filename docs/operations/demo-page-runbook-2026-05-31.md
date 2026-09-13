# Demo page operator runbook

> **Note (2026-06-02):** The standalone `/demo` page route was folded into
> `/app#try` and deleted. A 308 redirect from `/demo` is configured in
> `next.config.ts`, so external links keep working. The **API at
> `/api/demo/run` is unchanged** — same response shape, same rate limits,
> same demo wallet env var (`DEMO_WALLET_PRIVATE_KEY`). Everything in this
> runbook still applies; just substitute "/app#try" wherever you see "/demo"
> as the user-facing entry point.

**TL;DR:** `/demo` is a public unauthenticated page that lets anyone trigger a
**real** Base Sepolia settle paid from a small float wallet. As of 2026-05-31,
the route is **live**: deposit → ASP update → ZK proof → settle, end-to-end,
in 8–15s happy path (60s hard timeout). All four safety gates are still in
front. The Phase 1 stub is documented at the bottom for historical reference.

## Safety architecture

| Gate | Limit | Where enforced |
|---|---|---|
| Env-configured | `DEMO_WALLET_PRIVATE_KEY` required | route line ~70 |
| Per-IP rate limit | 1 run / 60s | in-memory `ipLastRunAt` map |
| Daily run budget | 50 runs / UTC day | in-memory `dailyRunCount` |
| Wallet balance floor | refuses if < $1 USDC | line ~110 |
| Per-run deposit | hardcoded $0.10 USDC | line ~33, NOT from request body |

**Single-instance only.** Rate limit + daily counter are in-process. If you
scale to multiple Vercel functions, replace with Redis or KV.

## How to fund the demo wallet

```bash
# Generate a wallet for the demo float (NOT the same as TREASURY or POSTMAN)
cast wallet new
# → 0xDEMO... + 0xKEY...

# Fund with USDC + ETH (Base Sepolia)
# - 20 USDC = ~200 demo runs at $0.10 each
# - 0.1 ETH = enough gas for ~500 runs

# Add to .env.local
echo "DEMO_WALLET_PRIVATE_KEY=0xKEY..." >> .env.local
```

**Cost ceiling:** at 50 runs/day × $0.10 = $5/day max. Even sustained abuse
caps at $35/week. The wallet balance floor will pause the demo automatically
before zeroing out.

## How to disable

```bash
# Option A — remove the env var
sed -i.bak '/^DEMO_WALLET_PRIVATE_KEY=/d' .env.local

# Option B — empty the env var
echo "DEMO_WALLET_PRIVATE_KEY=" >> .env.local  # later definition wins

# The route returns 503 with status "disabled" when the key is unset.
```

The `/demo` page handles the disabled state gracefully — shows "Demo paused"
+ a DM link.

**Important now that Phase 2 is live:** unsetting `DEMO_WALLET_PRIVATE_KEY`
now disables a **real spend pipeline**, not a stub. If you suspect abuse,
unset the env var first; that's the kill switch. Rate-limit / budget reset
on process restart, so a restart after unset is the cleanest hard stop.

## Monitoring

The route emits no logs by design (privacy posture). To monitor:

```bash
# Watch the wallet balance
watch -n 60 'cast balance --erc20 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
    $DEMO_WALLET_ADDRESS --rpc-url $BASE_SEPOLIA_RPC | xargs -I {} \
    echo "Demo wallet: {} (atomic USDC)"'

# Or in the browser: hit /api/demo/run yourself and check the gatesChecked.dailyBudget field
```

## Failure modes catalog

| Status | HTTP | What it means | Fix |
|---|---|---|---|
| `ok` | 200 | Full settle succeeded — `depositTxHash` + `settleTxHash` are real BaseScan-linkable txs | n/a |
| `disabled` | 503 | `DEMO_WALLET_PRIVATE_KEY` not set | set it in `.env.local`, restart |
| `rate_limited` | 429 | Same IP hit within 60s | wait or use different IP |
| `budget_exhausted` | 503 | 50 runs already today | wait until 00:00 UTC |
| `wallet_empty` | 503 | Float wallet < $1 USDC | refill |
| `rpc_down` | 503 | Couldn't reach Base Sepolia RPC during balance check | check Infura/Alchemy key, RPC status |
| `settle_failed` | 503 | Pipeline error after gates: deposit revert, ASP update fail, proof fail, or relay revert | inspect server logs; error message includes first 300 chars of the root cause |
| `timeout` | 503 | Total flow exceeded 60s | Base Sepolia RPC degraded; try later |

**Failed-run accounting:** the rate-limit + daily-budget counters are
incremented BEFORE the settle pipeline runs, so any `settle_failed` or
`timeout` still consumes one of the day's 50 slots and the IP's 60s window.
This is intentional — it stops a retry-storm attacker from draining the
daily budget on failed attempts.

## Live pipeline

The route performs the full settle end-to-end. Each call:

1. **Approve USDC if needed.** Checks `allowance(demoWallet, entrypoint)`; if
   below $0.10, approves `MAX_UINT256` once. First run on a fresh wallet pays
   one extra tx; subsequent runs skip this.
2. **Deposit $0.10 USDC.** Generates fresh `nullifier` + `secret`, computes
   `precommitment = poseidon2(nullifier, secret)`, calls
   `entrypoint.deposit(USDC, 100000, precommitment)` with `gas: 1_000_000n`,
   waits for confirmation.
3. **Parse `Deposited` event** from the pool log to recover the on-chain
   `commitment`, `label`, and POST-FEE `value` (per `CLAUDE.md`: the vetting
   fee is deducted on-chain, so a 100000 deposit becomes a 99000 commitment).
4. **POST `/api/asp-update`.** Refreshes the on-chain ASP root to include
   the new label. Per `CLAUDE.md` gotcha: the ASP root goes stale after every
   deposit; this call is idempotent and waits for confirmation.
5. **Generate a fresh ephemeral recipient** via `generatePrivateKey()` +
   `privateKeyToAccount(...).address`. The key is thrown away — only the
   address is used as the withdraw destination so the demo wallet → recipient
   link is unobservable on-chain.
6. **POST `/api/withdraw`** with the deposit secrets + commitment + the
   ephemeral recipient. The withdraw route does the ZK proof generation
   (snarkjs Groth16) + relay submission. Returns `settleTxHash`.
7. **Read `currentTreeSize()`** for the response's `anonymitySetSize`
   (best-effort; non-fatal if the read fails).

The response shape consumed by `src/app/demo/page.tsx`:

```ts
{
  status: "ok",
  depositTxHash: "0x...",
  settleTxHash: "0x...",
  ephemeralRecipient: "0x...",
  totalWallClockMs: 9_823,
  anonymitySetSize: 78,
  baseScanLinks: {
    deposit: "https://sepolia.basescan.org/tx/0x...",
    settle:  "https://sepolia.basescan.org/tx/0x...",
  },
  gatesChecked: { ... },
  demoDepositAmountUsdc: 0.1,
}
```

## Earlier (Phase 1 stub)

Before 2026-05-31 the route returned a `demo_gates_ok` stub: all four safety
gates were verified but no on-chain settle happened. The stub returned
`{ status: "demo_gates_ok", gatesChecked: {...}, elapsedMs }`. This shipped
first so the safety rails could be tested in production before opening the
door to a real public spend. The Phase 2 wiring kept the gate code byte-for-
byte identical and only replaced the stub return.

## Security notes

- The demo wallet is a **hot wallet with public exposure**. Keep float < $50
  at all times. Refill manually as needed.
- **Never deploy `/demo` to mainnet.** Sepolia-only. The middleware does not
  short-circuit by network — that's the operator's job in deploy config.
- The route does not strip IP headers (it needs them for rate limiting). If
  this becomes a privacy concern, hash the IP with a per-day salt before
  storing it in the map.
- `DEMO_WALLET_PRIVATE_KEY` is read once at request time, never logged,
  never returned in responses.

## Cross-references

- Route: `src/app/api/demo/run/route.ts`
- Page: `src/app/demo/page.tsx`
- Env template: `.env.local.example` (DEMO WALLET section)
- Phase 2 settle reference: `src/app/api/facilitator/settle/route.ts`
- Sales context: this page is the "show, don't tell" artifact for trophy
  customer DMs (`docs/bd/`).
