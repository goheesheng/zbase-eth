# Quickstart — @zbase-protocol/core (v0.5.0)

Private x402 payments for AI agents: pay any x402 API so the on-chain payment does not name your
wallet. Funded from a shared privacy pool via a Groth16 ZK withdrawal, paid by a fresh single-use
address. Live on **Base mainnet** (`eip155:8453`).

## Install

```bash
npm install @zbase-protocol/core
```

## One call: probe → 402 → private settle → deliver

```ts
import { createFacilitatorClient } from "@zbase-protocol/core";

const zbase = createFacilitatorClient({
  baseUrl: "https://zbase.app",   // pin the facilitator you trust (it sees spend secrets)
  network: "eip155:8453",         // Base mainnet
});

const res = await zbase.payAndFetch(
  "https://api.seller.com/endpoint",
  { method: "GET" },
  {
    deposit: myNote,                        // a pool note (DepositSecrets)
    onNoteRotate: (next) => db.save(next),  // persist the change note
    maxAmountAtomic: "50000",               // ceiling vs a hostile 402 (0.05 USDC)
    acceptNotPrivate: true,                 // open pilot: settle even though the set < 30
  },
);

if (res.outcome === "delivered") {
  console.log(res.status, res.response);    // the seller's data
  console.log(res.fundingTxHash);           // public pool withdrawal that funded the payer
}
```

## Before you write payment code

Read `./result-contract.md`. `payAndFetch` returns a tri-state (`res.outcome`) and throws on a
provably-unspent note. Handling it wrong double-pays. The correct pattern is
`../examples/handle-tri-state.ts`.

## Getting a note

A `deposit` (`DepositSecrets`) comes from depositing USDC into the pool once. Use
`generateDepositSecrets` / the wallet helpers (`@zbase-protocol/core/wallet`) to create and persist
notes. See `./api.md`.

## Open pilot

The anonymity set is still filling toward its 30-depositor privacy floor, so payments settle and
deliver but are not yet crowd-anonymous. Check `res.privacy?.private` on every payment.
