# Use zBase as your x402 facilitator

zBase is a **privacy-routing x402 facilitator** live on **Base mainnet** (Base Sepolia is
available for development). If you build agents that pay providers via x402, swapping your
facilitator URL to zBase makes every settle unlinkable on-chain.

This guide shows you the three-step integration.

## What changes when you switch

| Stock x402 (Coinbase or x402.org) | zBase facilitator |
|---|---|
| Buyer signs payment with their wallet | Buyer's wallet never appears on-chain |
| Settle: buyer wallet → provider wallet | Settle: pool → fresh stealth address |
| Chain analyst can correlate buyer's full spend | Each settle is a new, unlinkable address |
| Free | A per-deposit access fee + a small per-settle percentage take (deposits screened vs OFAC + hack list) |

The fee model is **a per-deposit access fee + a small per-settle percentage take**. The
facilitator computes the tier and bps in `facilitator-authz.ts`; the pool relay call applies the
split through `feeRecipient` + `relayFeeBPS`. `FEE_REQUIRED=false` today, so the access-fee gate is
not enforced during testnet development. After paying the access fee once, your buyer makes unlimited
settles against that deposit. The **exact current rate, floor, and access fee are returned live by
`GET /api/facilitator/supported` → `pricing`** — that endpoint is the source of truth for what your
integration pays.

**Testnet is free for development.** Base Sepolia uses Sepolia USDC (faucet-funded),
so all per-deposit + per-settle fees are paid in play money. The same on-chain
mechanism that runs on mainnet runs here, so you can size your agent economics
before flipping to production.

## Pricing

- **Standard** — a per-deposit access fee (one-time, then unlimited settles from that note) + a
  small per-settle percentage take. The ASP compliance gate is enforced in the ZK circuit; every
  deposit is screened against the OFAC SDN list + a curated hack/mixer overlay and flagged deposits
  are excluded, with deeper graph-taint KYT on the roadmap.
- **Enterprise** — a flat subscription with no per-settle take, plus the self-sovereign compliance
  data product (your own agents' transactions for AML/reporting). [Contact us](mailto:hello@zbase.app).
- **Testnet** — free.

**Live pricing is authoritative.** `GET https://zbase.app/api/facilitator/supported` → `pricing`
returns the exact current rate, floor, and access fee for your integration — read it programmatically
rather than hardcoding. A settle below the per-tier minimum is rejected at `/settle` with HTTP 400
explaining the math, so you never under-pay the floor.

## The integration

!!! note "Examples use Base Sepolia for safe testing"
    The code below uses **Base Sepolia** (`eip155:84532`) so you can integrate against play-money.
    For production, use **Base mainnet** (`eip155:8453`) and the mainnet addresses on
    [Contract addresses](contract-addresses.md). The access-fee gate is off during the open pilot
    (`FEE_REQUIRED=false`), so authorization is not yet enforced on testnet.

### Step 1 — Switch your facilitator URL

```ts
// Before:
const facilitator = "https://x402.org/facilitator";

// After:
const facilitator = "https://zbase.app/api/facilitator";
```

That swaps the facilitator. Going private also needs a one-time **deposit** and
**nullifier authorization** per deposit (Steps 2–3 below) — after that, settles route
through zBase unchanged.

### Step 2 — Buyer deposits USDC into the pool

Each buyer deposits USDC once. This creates their privacy-spendable balance.
Use `@zbase-protocol/core`'s `FacilitatorClient` to prepare the deposit
(generates the precommitment + the secrets to keep); you send the on-chain
deposit tx yourself.

> ✅ Published on npm: `npm install @zbase-protocol/core`

```ts
import { createFacilitatorClient } from "@zbase-protocol/core";

const zbase = createFacilitatorClient({
  baseUrl: "https://zbase.app",
  network: "eip155:84532", // Base Sepolia
});

// Prepares the precommitment + the secrets to KEEP (nullifier + secret).
const prep = zbase.prepareDeposit(1_000_000n); // 1 USDC, atomic
// You then send the on-chain deposit tx with prep.precommitment, and persist
// prep.secrets — these are the "private keys" of this shielded balance. Lose
// them and the USDC becomes unwithdrawable.
saveToStorage(prep.secrets);
```

See [Pay privately in 5 minutes](pay-privately-quickstart.md) for the full
prepare → verify → settle flow. (The live pool is a plain 0xbow PrivacyPool —
use the pool's standard `deposit`/`relay` ABI.)

### Step 3 — Pay the access-token fee, register, settle

One-time per deposit:

```ts
// 3a. Send the access fee.
const accessTokenTx = await buyerWallet.writeContract({
  address: USDC_BASE_SEPOLIA,
  abi: erc20Abi,
  functionName: "transfer",
  args: [
    "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21", // zBase treasury
    1000n, // 0.001 USDC in atomic units
  ],
});

// 3b. Authorize this deposit's nullifier with the facilitator.
const auth = await fetch("https://zbase.app/api/facilitator/authorize", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    network: "eip155:84532",
    accessTokenTxHash: accessTokenTx,
    nullifierHash: deposit.nullifier,
  }),
}).then((r) => r.json());

if (!auth.authorized) throw new Error(auth.error);
```

Now you can settle unlimited times against this deposit:

```ts
const settle = await fetch("https://zbase.app/api/facilitator/settle", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    paymentDetails: {
      payTo: providerAddress,
      // 700000 atomic = 0.700 USDC. Each settle deducts the per-settle take (read the
      // live rate + floor from /api/facilitator/supported); the recipient gets the rest.
      // Settles below the per-tier minimum are rejected at /settle with a 400 explaining it.
      maxAmountRequired: "700000",
    },
    zbaseDeposit: deposit,
  }),
}).then((r) => r.json());

console.log(settle.txHash); // ← on-chain unlinkable settle
console.log(settle.privacy); // ← Groth16 proof metadata
```

When the deposit balance runs out (or the buyer wants a fresh anonymity
set), repeat from Step 2.

## What happens if you don't pay the access fee

```bash
$ curl -X POST https://zbase.app/api/facilitator/settle \
    -d '{"paymentDetails":{"payTo":"0x...","maxAmountRequired":"5000"},"zbaseDeposit":{...}}'
```

```json
{
  "settled": false,
  "error": "Nullifier not authorized for this facilitator. POST to /api/facilitator/authorize first.",
  "authorization": {
    "network": "eip155:84532",
    "treasury": "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21",
    "requiredFeeAtomic": "1000",
    "instructions": "1. Send a USDC Transfer of >= requiredFeeAtomic to treasury on the matching network. 2. POST { network, accessTokenTxHash, nullifierHash: <your nullifier> } to /api/facilitator/authorize. 3. Retry this settle."
  }
}
```

HTTP 402 with self-describing instructions. Designed so a downstream agent
SDK can auto-handle the authorization step.

## Discoverability

Listed in `/api/facilitator/supported` and (soon) the x402 bazaar. Agents
querying for privacy-routing facilitators on Base Sepolia find zBase first.

