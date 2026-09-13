# Get paid privately — zBase for x402 sellers

**The pitch:** Veil.cash makes the *buyer* private. zBase makes the *seller* get
paid privately. If you run an x402 service (an API, a data feed, an agent tool),
zBase is the payout rail that settles your payments through a ZK privacy pool so
there's **no on-chain link between the payer and you** — and each payment lands at
a fresh stealth address.

This is the side Veil explicitly does not serve (their docs: "not an x402
facilitator… operates exclusively on the payer side"), and the side Coinbase's
free facilitator can't differentiate on (it settles, but everyone sees who paid
whom). Your differentiator as a seller: **private revenue.**

## Why a seller pays for this

x402 settlement is a commodity (Coinbase does it free). Privacy isn't. The take is
the price of unlinkable revenue — your competitors' payment graphs are public;
yours isn't. Pricing:

| Tier | Take | What you get |
|---|---|---|
| standard | **5%** per settle | ZK-unlinkable payout to a fresh stealth address, compliant by default (OFAC/ASP screening runs on every settle) |
| enterprise | flat $2,500–$25,000/mo | + a self-sovereign data product: a viewing-key-gated dataset of your own agents' transactions, for your AML screening / reporting |

(At BlockRun.ai's 5% ceiling, but compliant-by-default + no-token + payee-side —
you're not competing on being cheapest, you're the private-receiving rail.
Justified by
privacy. Rates are env-tunable; not enforced until the anonymity set is dense —
`FEE_REQUIRED=false` today, so you integrate and test for free now.)

## 3-step integration

### 1. Register your payout meta-address
You need an ERC-5564 stealth meta-address (`st:base:0x<132 hex>`). Generate one
with `@zbase-protocol/core` (`generateMetaAddress`), then:

```bash
curl -s -X POST $ZBASE_API_URL/api/providers/register \
  -H "Content-Type: application/json" \
  -d '{
    "providerName": "Your Service",
    "metaAddress": "st:base:0x...",
    "contactEmail": "you@example.com",
    "tier": "standard",
    "payToAuthorized": "0x<optional payout-binding address>"
  }'
```
Returns `{ id, tier, ... }`. `tier` is what's charged on each settle to you.

### 2. Advertise your meta-address as the x402 `payTo`
When your service returns HTTP 402, set the payment `payTo` to your registered
meta-address. Any buyer settling through zBase (`/api/facilitator/settle`) to that
`payTo` triggers private routing.

### 3. Claim your funds
Each settle to your meta-address derives a **fresh stealth address** and emits an
`ephemeralPubkey` + `viewTag` in the settle response / on-chain event. Scan these
with your viewing key (`@zbase-protocol/core` stealth helpers) to find and spend
the funds. No address reuse across payments → no linkable revenue graph.

## How the take is charged (honest mechanics)
- The fee is resolved **server-side** from your registered provider tier (with
  precedence over the payer's tier) — a caller cannot downgrade it.
- It's deducted on-chain in the same settle tx via the pool's relay split
  (`feeRecipient` + `relayFeeBPS`): you receive `amount − take`, treasury receives
  the take. Verify on BaseScan: the `WithdrawalRelayed` event shows both shares.
- Today the fee resolution is off-chain (server-resolved); pinning it as a
  contract invariant lands with the post-ceremony UTXO redesign. Until
  `FEE_REQUIRED=true`, no fee is taken (free integration/testing).

## What this is and isn't (don't oversell to your users)
- ✅ Payer↔payee unlinkability; fresh stealth address per payment; compliance-gated
  (ASP), not a mixer.
- ❌ Not amount-hiding today (values are on-chain in plaintext; only the link is
  broken). UTXO notes (amount hiding) are roadmap, pre-ceremony.
- Status: live on Base Sepolia; mainnet on first signed pilot (ceremony-free for
  the single-value pool — reuses 0xbow's audited verifiers).

## Reference
- Register API: `src/app/api/providers/register/route.ts`
- Settle (where routing happens): `src/app/api/facilitator/settle/route.ts`
- Stealth helpers: `@zbase-protocol/core`
- Agent skill (buyer + seller): `GET /api/skill`
- Revenue model: `docs/strategy/revenue-model-recommendation-2026-06-18.md`
- Competitive context: `docs/strategy/competitive-revenue-comparison-2026-06-22.md`
