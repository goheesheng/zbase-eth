# Pay privately in 5 minutes (Base mainnet)

Pay any standard x402 API from your agent **privately** — no on-chain link between your
wallet and what you pay for. You deposit USDC once, then every payment is funded from a
privacy pool through a fresh single-use wallet.

> **Early product — read this.** Privacy comes from a crowd: your withdrawal hides among
> other people's deposits. The pool is still filling toward **30 independent depositors**,
> so **payments settle but are not crowd-anonymous yet** (`result.privacy.private` says so
> on every payment). Reaching 30 is the floor, not a guarantee — a unique amount or timing can
> still narrow the set (see the [Threat model](threat-model.md)). You are what makes the crowd.

## 1. Install

**Agent (MCP)** — add the zBase MCP server to your agent client so it can pay, in-loop:

```json
{ "mcpServers": { "zbase": { "command": "npx", "args": ["-y", "@zbase-protocol/mcp"] } } }
```

**Code (SDK)** — for your own TypeScript:

```bash
npm install @zbase-protocol/core
```

No wallet plumbing, no gas, no contracts to deploy — the hosted facilitator does the rest.

## 2. Deposit once

Send **$1 USDC on Base** (no ETH needed) to a deposit address, then sweep it into the pool.
Easiest: the app at **https://zbase.app/app** runs the deposit and saves a seed-recoverable
note. Or use the MCP: `run.ts address` → send USDC → `run.ts sweep`.

## 3. Pay a seller

```ts
import { createFacilitatorClient } from "@zbase-protocol/core";

const zbase = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453" });
const buy = zbase.createPrivateFetch({
  deposit: myNote,
  onNoteRotate: (next) => db.save(next), // persist the change note
  acceptNotPrivate: true,                // early product: you accept it isn't private yet
});

const res = await buy("https://blockrun.ai/api/v1/search", {
  method: "POST",
  body: JSON.stringify({ query: "what is x402", sources: ["web"], max_results: 1 }),
});

console.log(res.response);        // the seller's data
console.log(res.privacy.private); // false until the pool reaches 30 depositors
```

The seller sees a fresh, single-use payer address with no link to your wallet, and returns
its data (`200`). Your change is a note re-derivable from your seed — nothing to save.

## What works today

- **Standard CDP-facilitated sellers.** zBase sends both x402 transport headers
  (`X-PAYMENT` v1 and `Payment-Signature` v2), so either convention works. Proven on
  mainnet against **BlockRun** ($0.028), **Nansen** ($0.01), and **MetaLend** ($0.001) —
  see the [full $0.001 walkthrough](proven-private-pay-full-flow.md).
- **Not** sellers running a bespoke facilitator (e.g. Otto AI's signed-offer/SIWX flow).
  The SDK **free-probes** a seller before spending and refuses an incompatible one for $0
  — you never waste a note. Check any seller yourself: `await zbase.probe(url, init)`.

## What comes back

A delivered payment returns the seller's data plus a settlement receipt:

```ts
res.paid          // true — a payment settled
res.status        // 200 — the seller delivered
res.response      // the seller's data
res.payer         // the single-use EOA the pool funded (no link to your wallet)
res.amount        // atomic USDC paid
res.fundingTxHash // the pool withdrawal that funded the payer (public on-chain)
res.nextDeposit   // the change note (seed-recoverable; persist via onNoteRotate)
res.privacy       // the privacy verdict for THIS payment
```

## Handling failures safely (money-safety)

The note is spent **only** on a settled payment, and settlement is **idempotent** on the
note — so a lost or ambiguous response can never charge you twice. The SDK gives you a
tri-state, not a boolean:

- **Delivered** — `res.paid === true`, `res.status` 2xx. Done.
- **Proven unspent** — `payAndFetch` *throws*. The withdrawal did not happen (e.g. the
  seller's 402 was rejected before spending). Your note is untouched; retry is safe.
- **Uncertain** — `res.paid === false` with `res.uncertain === true`. The note *may* be
  spent (a dropped response, or an ambiguous settlement). **Do NOT pay again from a
  different note.** Retry the *same* call — settlement is idempotent on the note, so it
  replays the same payment if it landed, or completes it if it didn't. The change note is
  always seed-recoverable, so nothing is stranded.

> Never treat "no clear success" as "unspent" — that is the one mistake that double-pays.
> The SDK enforces it: it only throws "note unspent" when the note is *provably* unspent.

## Two rules

1. **Keep your note recoverable.** After a partial payment you get a *change note*. The SDK
   refuses to spend unless that change can survive a crash — satisfy it by depositing from
   the app (seed-recoverable) or passing `onNoteRotate`.
2. **Check `result.privacy.private`** before relying on privacy. A not-private payment
   succeeds identically to a private one; the difference only shows there.

Full buyer guide: [Use zBase as your facilitator](use-zbase-as-facilitator.md) ·
[SDK overview](sdk-overview.md). Live depositor count + privacy status:
`GET https://zbase.app/api/facilitator/supported`.
