# Developer Guides

Everything you need to integrate zBase, by role. Each guide is task-oriented and assumes you can
read TypeScript and use a terminal. If you just want to see a payment work first, start with
[Pay privately in 5 minutes](pay-privately-quickstart.md).

## Pick your path

| You are... | Read | You get |
|---|---|---|
| An **agent / buyer** paying APIs | [Pay privately from an agent (SDK)](sdk-overview.md) | One call: probe → 402 → settle privately → deliver. |
| A **facilitator / integrator** | [Integrate zBase as your facilitator](use-zbase-as-facilitator.md) | Swap your x402 facilitator URL; keep standard sellers. |
| A **provider / seller** receiving pay | [Receive payments (stealth)](stealth-recipients.md) | Get paid to a fresh address with no customer link. |
| Building your **own note logic** | [Privacy Pool notes](sdk-privacy-pool-notes.md) · [Merkle tree & proofs](sdk-merkle-tree-proofs.md) | Note encoding, proofs, state tree. |
| Running a **backend** (no local note state) | [Wallet backend API](wallet-backend-api.md) | Hosted facilitator endpoints. |

## 60-second technical quickstart (buyer)

```bash
npm install @zbase-protocol/core
```

```ts
import { createFacilitatorClient } from "@zbase-protocol/core";

const zbase = createFacilitatorClient({
  baseUrl: "https://zbase.app",     // pin the facilitator you trust (it sees spend secrets)
  network: "eip155:8453",           // Base mainnet
});

// One call runs the whole loop: free-probe → 402 → private settle → retry w/ payment header → data.
const res = await zbase.payAndFetch(
  "https://api.seller.com/endpoint",
  { method: "GET" },
  {
    deposit: myNote,                        // a pool note (see Privacy Pool notes)
    onNoteRotate: (next) => db.save(next),  // persist the change note
    acceptNotPrivate: true,                 // open pilot: settle even though set < 30
  },
);

console.log(res.status, res.response);      // seller's data
console.log(res.fundingTxHash);             // public pool withdrawal that funded the payer
```

## The result contract you must handle (money-safety)

The note is spent **only** on a settled payment, and settlement is **idempotent on the note**, so a
lost or ambiguous response can never charge you twice. `payAndFetch` returns a **tri-state**, not a
boolean — handle all three:

| Outcome | Shape | What it means | What to do |
|---|---|---|---|
| **Delivered** | `res.paid === true`, `res.status` 2xx | Paid and the seller returned data. | Use `res.response`; persist `res.nextDeposit`. |
| **Proven unspent** | `payAndFetch` **throws** | The withdrawal did not happen (e.g. 402 rejected pre-spend). Note untouched. | Safe to retry with the same note. |
| **Uncertain** | `res.paid === false`, `res.uncertain === true` | The note **may** be spent (dropped/ambiguous settle). | Retry the **same** call (idempotent). **Never** pay from a different note. |

!!! danger "The one mistake that double-pays"
    Never treat "no clear success" as "unspent." The SDK enforces this — it only throws
    `note unspent` when the note is *provably* unspent. Full detail:
    [Handling failures safely](pay-privately-quickstart.md#handling-failures-safely-money-safety).

## What the facilitator can see, and what it cannot do

Today the facilitator does **server-side proving**, so it sees your note's spend secrets
(`nullifier` + `secret`) at settle time. Pin `baseUrl` to a host you trust. What it **cannot** do:

- **It cannot redirect your payment.** The recipient is bound into the Groth16 proof's public
  signals; a facilitator that rewrites the recipient invalidates the proof, so a valid relay cannot
  be redirected. (See [Trust model](trust-model.md).)
- **It cannot forge a withdrawal.** The verifier is on-chain; without the trusted-setup toxic waste
  a forged proof is infeasible.

**Client-side proving** — generating the proof on your machine so the facilitator never sees the
secrets — is on the [roadmap](build-roadmap.md).

## Seller compatibility

zBase sends **both** x402 transport headers — `X-PAYMENT` (x402 v1) and `Payment-Signature`
(x402 v2 transport). Precisely: **any seller whose facilitator verifies a standard `exact`
EIP-3009 payload** — the Coinbase-CDP default — delivers unchanged and never learns zBase was
involved. Sellers on a **bespoke** facilitator (a proprietary signed-offer / SIWX handshake instead
of the standard payload) are **not** supported; the SDK **free-probes** and refuses those for $0
before spending. See [How zBase compares](how-zbase-compares.md).

## Test the public API live

The read-only facilitator endpoints (capabilities, live anonymity set, health, exposure preview)
are firable from the [Live API playground](api.md). The money endpoints are documented there too,
as reference — build those calls with the SDK above, not by hand.
