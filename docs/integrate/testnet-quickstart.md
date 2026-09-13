# Testnet quickstart — try zBase private x402 settlement on Base Sepolia

**Goal:** integrate the zBase private-settlement SDK and run your first
ZK-unlinkable x402 payment on Base Sepolia (testnet, play money) in ~10 minutes.
No mainnet, no real funds, no fees (`FEE_REQUIRED=false` today — you integrate and
test for **free**). When you're ready for real revenue, your SDK call changes one
field, but the facilitator must also be backed by the deployed Base mainnet stack.

> What this proves: a payment to your service settled *through a ZK privacy pool*,
> so there's **no on-chain link between the payer's wallet and the payment**, and
> (if you register as a provider) the payout lands at a fresh stealth address.
> This is the seller side Veil refuses and Coinbase's free facilitator can't
> differentiate on. Pitch + pricing: `docs/integrate/private-payout-for-sellers.md`.

---

## What you need

- Node ≥ 18.
- A Base Sepolia wallet with a little test ETH (gas) + test USDC. Faucets:
  - ETH: a Base Sepolia faucet (e.g. the Coinbase/Alchemy Sepolia faucets).
  - USDC: `faucet.circle.com` (Base Sepolia USDC = `0x036CbD53842c5426634e7929541eC2318f3dCF7e`).
- The live zBase deployment URL (e.g. `https://zbase.app`) or a local dev server
  (`npm run dev -- -p 3009` → `http://localhost:3009`).

## Install

> ✅ **The core SDK is on npm.** `@zbase-protocol/core` is published (v0.1.2+).
> `@zbase-protocol/svm` and `@zbase-protocol/mcp` are not yet published.

```bash
npm install @zbase-protocol/core
```

## The three-call flow

The SDK mirrors the facilitator's HTTP API: **prepareDeposit → verifyPayment →
settlePrivately**. The payer deposits once, then settles many payments against
that deposit (each settle returns a `nextDeposit` change note for the next one).

```ts
import { createFacilitatorClient } from "@zbase-protocol/core";

const zbase = createFacilitatorClient({
  baseUrl: "https://zbase.app",   // or http://localhost:3009
  network: "eip155:84532",        // Base Sepolia (default). Mainnet = "eip155:8453"
});

// ── 1. Prepare a deposit (returns the precommitment + the secrets to KEEP) ──
const prep = zbase.prepareDeposit(1_000_000n);   // 1 USDC, atomic (6 decimals)
//   → prep.precommitment : pass this to the pool's on-chain deposit() call
//   → prep.secrets       : { nullifier, secret } — KEEP THESE LOCALLY
//   → prep.amountAtomic  : the on-chain amount to send

// You now make the on-chain deposit tx yourself (approve USDC + pool.deposit()),
// passing prep.precommitment. From the Deposited event you learn the post-fee
// `value` and the on-chain `label`. Assemble the full DepositSecrets:
const deposit = {
  nullifier: prep.secrets.nullifier,
  secret:    prep.secrets.secret,
  value:     "990000",          // from the Deposited event (post-vetting-fee)
  label:     "0x…",             // from the Deposited event (keccak(SCOPE,nonce))
  commitment:"0x…",             // from the Deposited event
};

// ── 2. Verify a payment is settleable (optional pre-check) ──
const check = await zbase.verifyPayment({
  payTo: "0xYourServiceAddress",
  amountAtomic: 700_000n,        // 0.70 USDC
  deposit,
});
// → { valid, reason?, privacy?: { method, pool, anonymitySet } }

// ── 3. Settle privately (the pool pays payTo from the anonymity set) ──
const result = await zbase.settlePrivately({
  payTo: "0xYourServiceAddress",
  amountAtomic: 700_000n,
  deposit,
});
// → { settled, txHash, network, pricing?, stealth?, nextDeposit? }
console.log("Settle tx:", result.txHash);     // view on sepolia.basescan.org
// result.nextDeposit → the change note; pass it as `deposit` to the NEXT settle.
```

That's the whole loop. On-chain, the `From` column of the settle tx shows every
USDC payout originating from the **pool** — the payer's wallet appears nowhere.
That absence is the privacy.

## To RECEIVE privately as a seller (stealth payout)

Register your `payTo` as a provider so payouts route to fresh stealth addresses
(ERC-5564) instead of your static address:

```bash
curl -X POST https://zbase.app/api/providers/register \
  -H "Content-Type: application/json" \
  -d '{ "name": "my-service", "stealthMetaAddress": "st:base:0x…", "tier": "standard" }'
```

Then every settle to your service derives a new one-time address — `result.stealth`
carries the `{ ephemeralPubkey, viewTag }` you scan with your viewing key. See
`docs/integrate/private-payout-for-sellers.md` for the full seller flow.

## Verify it worked

- `result.txHash` → open `https://sepolia.basescan.org/tx/<hash>`, look at
  "Tokens Transferred": the payout comes from the pool/entrypoint, not the payer.
- `check.privacy.anonymitySet` → the size of the set you're hiding in (bigger =
  stronger). The live Sepolia pool already has a real set, not an empty room.
- Discovery: `await zbase.supported()` → the networks/tokens/pricing the
  facilitator accepts.

## How long does a private payment take? (measured, not estimated)

These numbers are from a **real end-to-end run on Base Sepolia** (2026-07-11) —
a full deposit → ASP-update → private withdrawal against the live pool, via a
cold dev-server facilitator hitting Infura. The on-chain transactions are public
and verifiable:

- Deposit: [`0xb5c24df9…`](https://sepolia.basescan.org/tx/0xb5c24df99202cc807e5f07c5e8065aab463e5fd5d7c26a9d91d1fafeb921e058)
- Private withdrawal: [`0xf324fc66…`](https://sepolia.basescan.org/tx/0xf324fc667b342e4e5f4cf995ebd7e0aa6cece0e955b6971f547719d1b687d7ba)

| What you're timing | Measured | Notes |
|---|---|---|
| **ZK proof generation alone** | **~0.7s** | `snarkjs.groth16.fullProve` on the withdraw circuit (~10.2K constraints), median of 6 warm runs. The cryptography is **not** the bottleneck. |
| **A private payment (withdrawal), cold** | **~21s** | Proof + fetch fresh Merkle/ASP state over `eth_getLogs` (chunked, rate-limited) + relay tx + Sepolia confirmation. Self-reported by the route as `SUCCESS (20660ms)`. |
| **First-time full onboarding** | **~37s** | Deposit tx + ASP root update + first withdrawal. Paid **once per deposit**, then amortized across every later payment. |

### Reading these numbers honestly

- **The proof is ~0.7s; the wait is the chain and the RPC.** ~20 of the ~21s is
  fetching pool state (log queries with mandatory inter-chunk delays to dodge
  RPC rate limits) plus waiting for Base to confirm the relay tx. Groth16 proving
  is a rounding error by comparison.
- **This was a cold single run.** No warm indexer cache, a public Infura
  endpoint, one payment in isolation. A production facilitator with a
  root-verified indexer cache (on the roadmap — see
  `docs/strategy/facilitator-infra-architecture-2026-06-24.md`) removes most of
  the state-fetch cost, which is why earlier warm-path measurements landed in the
  **~7–15s** range. Treat ~7–15s as the warm target and ~21s as the honest cold
  ceiling you'll see on a fresh dev setup.
- **Amortize the onboarding.** An agent deposits once (~37s including the deposit
  and ASP update) and then makes many payments. Payment N (N > 1) is the ~7–21s
  hot path, not the ~37s cold-start. Deposit once, pay many.
- **No yield, no skim.** The live pool is a plain 0xbow PrivacyPool — the
  recipient receives exactly `(amount − take)`. There is no Morpho/yield leg on
  the hot path (an older design had one; it was never deployed), so it adds no
  latency and no APY.

To reproduce locally: `npm run dev -- -p 3009` in one shell, then
`npm run test:e2e` in another (needs ≥1 test USDC + a little test ETH on the
`POSTMAN_PRIVATE_KEY` wallet). The script prints per-step timing and the two
BaseScan links so you can confirm there's no on-chain link between them.

## Going to mainnet later

The SDK is network-agnostic — the integration-side change is one field:

```ts
const zbase = createFacilitatorClient({
  baseUrl: "https://zbase.app",
  network: "eip155:8453",        // Base mainnet
});
```

> ⚠️ **Mainnet is not live yet.** The SDK supports `eip155:8453`, but the hosted
> facilitator must first run with the deployed Base mainnet pool, verifier
> addresses, deploy block, Upstash, ASP root, and launch-ready postman signer.
> Those are wired through `BASE_MAINNET_*` / `NEXT_PUBLIC_BASE_MAINNET_*` env vars
> and checked by `npm run preflight:mainnet`. **Build and test on Sepolia
> (`eip155:84532`) today**; flip to mainnet only once the target facilitator
> passes that preflight.

On mainnet, fees turn on (a single 5% take — the price of unlinkable revenue,
compliant by default; pricing in the seller doc). Test everything free on Sepolia
first; flip to mainnet when you're ready to charge / be charged.

## Limits to know (honest)

- **Unlinkable, not amount-hiding.** The payer↔payee LINK is hidden; the *amounts*
  (0.70, 0.693, …) are public on-chain. Amount-hiding (UTXO notes) is a future,
  demand-gated feature — see `docs/strategy/utxo-moat-review-2026-06-25.md`.
- **Compliant by design.** Only ASP-approved (clean) deposits can settle — this is
  a Privacy-Pools fork (Vitalik-co-authored), not a mixer.
- **Server-side proving today.** `settlePrivately` currently sends the deposit
  secrets to the facilitator to generate the proof. A client-side-proving mode
  (secrets never leave your machine) is roadmap; the API surface won't change.
