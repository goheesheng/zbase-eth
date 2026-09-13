# zBase x402 integration — how the buyer and seller each plug in

> Grounded in the DEPLOYED system (Base mainnet, 2026-07-13): facilitator at
> `https://zbase.app/api/facilitator`, pool `0x46753C…`, entrypoint `0x275fAA…`,
> the `@zbase-protocol/core` SDK + `@zbase-protocol/mcp` server (tools: deposit,
> balance, pay). Sepolia twin at `https://testnet.zbase.app` for free testing.

## The one cryptographic fact that shapes everything

Privacy = the buyer's funds sit in a shared pool, mixed with others, BEFORE the
payment, and the payment comes OUT of the pool with no timing/amount link to any
deposit. This means: **a buyer cannot pay "normally, knowing nothing" and get
privacy** — a normal payment (buyer wallet → seller) IS the on-chain link. The
mixing step is the privacy, and only the buyer's funds can do it.

**What IS achievable (and is the product):** the buyer funds a private balance
ONCE (conscious), then pays MANY times obliviously — each payment silently draws
from the pre-mixed pool. Same as a "private wallet": top up once, spend without
thinking about privacy per-transaction. The change-note loop (`nextDeposit`)
already supports this in the deployed settle route.

---

## SELLER integration — genuinely one line (zero ongoing effort)

The seller (x402 resource server) points their facilitator at zBase. In x402 the
seller — not the buyer — chooses the facilitator, so THIS is the switch that
routes their payments through the privacy pool.

```ts
// x402 resource server (Express/Hono/etc.) — the ONLY change:
import { HTTPFacilitatorClient } from "@x402/core/server";

const facilitator = new HTTPFacilitatorClient({
  url: "https://zbase.app/api/facilitator",   // was: Coinbase CDP
});
// paymentMiddleware, payTo, pricing, scheme — all unchanged.
```

Result: payments to the seller settle FROM the pool. On-chain, the seller
receives USDC from the pool contract, not from any identifiable buyer. The
seller's revenue at their `payTo` is no longer a public buyer→seller trail.

**Optional — stealth receiving (deeper privacy for the seller's OWN address):**
register a meta-address so each payment lands at a fresh stealth address (revenue
not aggregated at one visible `payTo`):
```
POST https://zbase.app/api/providers/register   { providerName, metaAddress, ... }
```

**Seller does NOTHING per-payment.** They are oblivious after the one-line switch.
✅ This side is a true drop-in.

### The catch the seller must know
Their buyers must be zBase-aware (deposit into the pool + pay from it). A vanilla
x402 buyer that signs a normal EIP-3009 payment will be REJECTED by zBase settle
("Missing zbaseDeposit"). So a seller switching to zBase needs buyers using the
buyer flow below. Frame it to sellers as: "your privacy-conscious buyers pay you
through zBase; give them the zbase-pay skill."

---

## BUYER integration — fund once, pay obliviously

The buyer needs zBase-aware code (NOT necessarily the npm SDK — HTTP works — but
something that knows the deposit-then-pay flow). Best form: the MCP skill, so the
agent's existing wallet layer (e.g. Base MCP) handles it and the human never
touches secrets.

### Phase 1 — fund the private balance ONCE (conscious, ~30s)
The buyer's agent deposits USDC into the pool from its own wallet. This is the
one conscious act; it's the privacy.

```ts
import { createFacilitatorClient } from "@zbase-protocol/core";
const zbase = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453" });
const cfg  = zbase.getDepositConfig();
const prep = zbase.prepareDeposit("100000000");   // $100 private balance

// Signed by the agent's WALLET LAYER (Base MCP / CDP server wallet — key never
// in the agent's reasoning):
//   USDC.approve(cfg.entrypoint, 100000000)
//   Entrypoint.deposit(cfg.asset, 100000000, prep.precommitment)
// Read the Deposited event → { value, label, commitment }.
const note = { ...prep.secrets, value, label, commitment };  // the private balance
// Store `note` in the agent's trusted vault (NEVER chat/logs — it's spend authority).
```

### Phase 2 — pay providers OBLIVIOUSLY (every payment after)
When the agent hits any x402 seller whose facilitator is zBase (or pays any
Base-USDC payTo), it settles from the balance and gets CHANGE back:

```ts
const res = await zbase.settlePrivately({
  payTo: SELLER_PAYTO,          // from the seller's 402
  amountAtomic: SELLER_AMOUNT,
  deposit: note,                // the private balance
});
// res.txHash — paid from the pool, no link to the buyer's wallet.
// res.nextDeposit — the CHANGE note. Replace `note = res.nextDeposit` and keep paying.
```

The agent loops Phase 2 for every purchase, drawing down the balance. It only
returns to Phase 1 when the balance runs low ("top up"). **After the one-time
fund, privacy is invisible and automatic.**

### The frictionless form — the MCP skill (recommended for agents)
`@zbase-protocol/mcp` already ships `deposit` / `balance` / `pay` tools. An agent
with this MCP server calls:
- `zbase_deposit(amount)` — fund the private balance (once / on low balance)
- `zbase_balance()` — check remaining private balance
- `zbase_pay(payTo, amount)` — pay a provider privately (auto-uses the balance +
  keeps the change note)

The agent treats "top up private balance" like managing gas — an occasional
housekeeping op — and `zbase_pay` like any payment. The human may never think
about privacy per-transaction. Secrets stay in the MCP server's trusted context,
never in the LLM.

---

## End-to-end: what an observer sees

1. (Phase 1, earlier) buyer wallet → pool: a deposit. Public, but just "someone
   funded a privacy pool" — not tied to any future payment.
2. (Phase 2, later, unrelated timing) pool → seller: a payment. Public, but comes
   from the pool, not the buyer.
3. No transaction links buyer → seller. The mixing + timing gap is the privacy.
   Strength = the pool's anonymity set (`GET /api/health`). Bigger set = stronger.

---

## Honest limits (state these to both sides)
- Hides the payer↔payee LINK. Does NOT hide amounts (deposit + settle values are
  public) — use bucketed amounts (the MCP server warns on odd amounts) to avoid
  amount-fingerprinting.
- Privacy is weak on a near-empty pool (anonymity set of 1 = traceable). Seed +
  grow the set before relying on it. Check `/api/health` anonymitySet.
- Not externally audited yet.
- Buyer must fund the pool once — this cannot be removed; it IS the privacy.

## Rehearse free first
Point both integrations at `https://testnet.zbase.app` (`eip155:84532`, faucet
USDC) — 247-deposit pool, real privacy — before mainnet real USDC.
