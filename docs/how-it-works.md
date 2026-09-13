# How zBase works — user flow + the facilitator question

## Is zBase an x402 facilitator?

**Yes.** zBase implements the three endpoints the x402 spec uses to *define* a
facilitator:

| Endpoint | x402 role |
|---|---|
| `GET /api/facilitator/supported` | advertise accepted networks/tokens/schemes |
| `POST /api/facilitator/verify` | "is this payment valid/possible?" |
| `POST /api/facilitator/settle` | execute the payment on-chain |

That's the literal facilitator interface — the same surface Coinbase's CDP
facilitator and x402.org expose.

**What makes it different (the whole point):** a normal facilitator settles a
*public, direct* USDC transfer from the buyer's wallet to the seller — anyone can
see payer → payee on-chain. zBase settles the payment **through a ZK privacy
pool**: it pays the seller *from the pool* using a Groth16 proof and marks the
buyer's pre-deposited note spent, so there is **no on-chain link between the
buyer's wallet and the seller**.

- vs **Coinbase's facilitator** (free, but public): zBase adds privacy — the thing
  free settlement structurally can't offer.
- vs **Veil.cash** (their docs: "not an x402 facilitator… payer-side only"): Veil
  makes the *buyer* private; zBase is the *facilitator/seller* side they refuse to
  build. A seller cannot use Veil to get paid privately; they can use zBase.

So: **zBase is the x402 facilitator that settles privately.**

One mechanical nuance worth knowing: zBase's settlement is "prove-and-pay-from-
pool," not "transfer-from-buyer's-wallet." The buyer's wallet never signs the
payment; a relayer submits a ZK proof and the pool pays out. That indirection *is*
the privacy.

---

## The two users

There are two distinct actors, each with a one-time setup then a per-payment loop:

- **Buyer / paying agent** — deposits USDC once, then pays sellers privately, many
  times, from that deposit.
- **Seller / provider** — registers once, then receives private USDC at a fresh
  stealth address per payment.

---

## User flow (diagram)

```
                         ┌─────────────────────────────────────────┐
  BUYER (one-time)       │  SELLER (one-time)                       │
  ───────────────        │  ─────────────────                       │
  deposit USDC ──┐       │  POST /api/providers/register            │
  into the pool  │       │    {metaAddress, tier}                   │
                 ▼       │         │                                │
   gets deposit secrets  │         ▼                                │
   {nullifier, secret,   │   now payments to this seller route to   │
    value, label,        │   a FRESH stealth address each time      │
    commitment}          └─────────────────────────────────────────┘
        │
        │   (if fees on) POST /api/facilitator/authorize  ── unlock tier (one-time)
        ▼
  ════════════════ PER PAYMENT (the x402 loop) ════════════════
        │
   1. agent calls seller's paid endpoint
        └──────────────────────────────►  HTTP 402  (x402 challenge:
                                            payTo, amount, network)
        │
   2. POST /api/facilitator/verify  ──►  "valid? scheme=exact, network ok,
        {paymentDetails, zbaseDeposit}     pool non-empty?"  ◄── valid: true
        │
   3. POST /api/facilitator/settle  ──►  zBase facilitator:
        {paymentDetails.payTo,              • resolve fee tier (SELLER's wins)
         zbaseDeposit secrets}              • findProviderByPayTo → derive
                                              FRESH stealth address
                                            • forward to /api/withdraw:
                                              - generate Groth16 membership proof
                                              - build relay {recipient, feeRecipient,
                                                relayFeeBPS}
                                              - Entrypoint.relay(...) on-chain
        │
        ▼
   POOL pays out (one tx):
     • seller stealth addr ← amount − take
     • treasury           ← take (5%, single tier)
     • buyer's note marked spent; change note minted
        │
   4. seller scans ephemeralPubkey + viewTag ──► claims USDC at stealth addr
        │
        ▼
   RESULT: seller paid in clean USDC. No on-chain link buyer-wallet → seller.
```

---

## Step → code map

| Step | Route / function | File |
|---|---|---|
| Buyer deposit (get secrets) | frontend `/test` deposit flow → pool `deposit()` | `src/app/.../test`, pool contract |
| Buyer unlock tier (fees on) | `POST /api/facilitator/authorize` | `src/app/api/facilitator/authorize/route.ts` |
| Seller register | `POST /api/providers/register` | `src/app/api/providers/register/route.ts` |
| Discover what's accepted | `GET /api/facilitator/supported` | `src/app/api/facilitator/supported/route.ts` |
| Verify a payment | `POST /api/facilitator/verify` | `src/app/api/facilitator/verify/route.ts` |
| Settle (fee tier + stealth) | `POST /api/facilitator/settle` → `findProviderByPayTo`, `deriveStealthAddress` | `src/app/api/facilitator/settle/route.ts` |
| Proof + on-chain relay | `/api/withdraw` → Groth16 `fullProve` → `Entrypoint.relay(...)` | `src/app/api/withdraw/route.ts` |
| Fee resolution (seller tier wins) | `takeBpsFor`, `getAuthorizedTier`, provider `tier` | `src/lib/facilitator-authz.ts`, settle + withdraw |
| Seller claims funds | scan `ephemeralPubkey`/`viewTag`, stealth helpers | `@zbase-protocol/core` |
| Agent integration | `GET /api/skill` (buyer + seller sections), `@zbase-protocol/mcp` | `src/app/api/skill/route.ts` |
| User freemium upgrade | `POST /api/user/upgrade` (premium → instant withdraw) | `src/app/api/user/upgrade/route.ts` |

---

## Who pays what

- **Buyer / paying agent:** free to deposit + transact. (Free until fees are
  enforced; the access fee is the agent tier-unlock, not a human toll.)
- **Seller / provider:** pays the per-settle take to get paid privately — a single
  **5%** (compliant by default; screening runs on every settle, so there's no
  separate paid compliance tier). "Providers pay to get paid privately." Resolved
  server-side from the seller's registered tier.
- **Human user wallet:** free to transact; pays only for opt-in premium
  (`/api/user/upgrade` → instant withdraw). Not a deposit tax.
- **Enterprise:** flat $2,500–$25,000/mo (no per-settle take) + a self-sovereign
  data product: a viewing-key-gated dataset of the enterprise's own agents'
  transactions, for their AML screening / reporting.
- **No token.** Revenue is USDC to treasury. (Veil's revenue is its $VEIL token;
  zBase deliberately has none — the no-gate wedge.)

Today `FEE_REQUIRED=false` — nothing is charged yet (policy: don't tax the
anonymity set while bootstrapping it). Flip when the set is dense + a seller is
live.

---

## What it provides / doesn't (honest)

- ✅ **Provides:** payer↔payee unlinkability; fresh stealth address per payment;
  compliance-gated (ASP clean-subset), not a mixer; Base + Solana.
- ❌ **Not yet:** amount hiding (values are on-chain in plaintext; only the *link*
  is broken — UTXO notes fix this, pre-ceremony); strong timing-correlation
  defense (decoy scheduler exists in `scripts/` but not in prod).
- **Status:** live on Base Sepolia; single-value pool can go to Base mainnet
  ceremony-free (reuses 0xbow's audited verifiers). UTXO pool is pre-ceremony.

See also: `docs/strategy/revenue-model-recommendation-2026-06-18.md`,
`docs/integrate/private-payout-for-sellers.md`, threat model at
https://docs.zbase.app/threat-model/.

---

## Proven mainnet E2E (BlockRun + Nansen — successful examples, 2026-07-19)

The full private-payment loop ran on Base **mainnet** and **two** real third-party x402
sellers returned data — **BlockRun** (search) and **Nansen** (token screener), both
settling via Coinbase **CDP**. This is the reference for "it actually works."

**The loop:**

```
$1 USDC → [gasless sweep] → privacy pool → [Groth16 ZK withdrawal]
        → single-use payer EOA → [x402 exact payment] → BlockRun → HTTP 200 + data
```

**What was proven:**
- Gasless deposit: `$1 → $0.99` note, one atomic CDP userOp (deposit tx `0xf612e983…`).
- ZK withdrawal: indexer cache HIT (no chain scan), proof generated + verified, relay
  tx `0xe66abb30…` succeeded.
- Change-note recoverability: the `$0.989` change note rebuilt **from the seed alone**
  ("no local note file") — nothing to save.
- Delivery: BlockRun (settling via Coinbase **CDP**) returned `200` + Grok search
  results; the payer address was single-use and unlinkable to the funding wallet.

**Reproduce (from `packages/mcp/`):**

```bash
npx tsx run.ts address          # send $1 USDC (Base) here — no ETH needed
npx tsx run.ts sweep            # gasless deposit into the pool
# if any deposit/withdrawal happened since the last sync, refresh the indexer first:
#   ssh <box> 'bash /srv/zbase/app/deploy/cron-hit.sh mainnet indexer-sync'
npx tsx run.ts pay https://blockrun.ai/api/v1/search 0.05 --pilot \
  --body '{"query":"what is the x402 protocol","sources":["web"],"max_results":1}'
# → { "paid": true, "delivered": true, "status": 200, ... }
```

`--pilot` acknowledges the open-pilot NOT-private disclosure (the anonymity set is
below the k=30 minimum, so the payment settles but is not yet crowd-anonymous).

**Nansen example** (token screener, $0.01, delivered `200` + top-mover data):

```bash
npx tsx run.ts pay https://api.nansen.ai/api/v1/token-screener 0.05 --pilot \
  --body '{"chains":["base","ethereum","solana"],"timeframe":"24h"}'
```

**The fixes that made it work** (commits): `792df6c` atomic sweep · `9423fd8`
HyperSync hex block numbers · `5064521` deposits/events via HyperSync · `aca4b6c`
pilot flag + propagation retry · `e5412ad` **x402 v2 payload `accepted` field**
(CDP rejects a v2 payload without it — the key fix for standard-seller delivery).

**Seller compatibility:** the pay sends BOTH transport headers — `X-PAYMENT` (x402 v1,
e.g. BlockRun) and `Payment-Signature` (x402 v2 transport, e.g. Nansen, which *ignores*
`X-PAYMENT`) — so it works with either convention as long as the seller settles a
standard `exact` EIP-3009 payload via CDP.

It does **not** work with **Otto AI** (confirmed 2026-07-19): Otto ignores a standard
payload in *both* headers and requires its own **signed-offer** flow (reference the
eip712 signed offer from its 402's `offer-receipt` extension) plus SIWX sessions — a
bespoke, self-hosted facilitator, not CDP. Integrating Otto would need that offer/SIWX
flow, not the plain `exact` path.
