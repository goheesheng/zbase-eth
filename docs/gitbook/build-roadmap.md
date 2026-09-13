# Roadmap

Where zBase is today, and the updates we have in mind next. The "future" items are
intentions, not promises — timing depends on demand, funding, and audit timelines. The
[CHANGELOG](../../CHANGELOG.md) is the record of what has actually shipped.

## Live today — Base mainnet (open pilot)

- **Private x402 payments, end to end.** Gasless deposit → Groth16 ZK withdrawal → private
  pay, proven against real Coinbase-CDP sellers (BlockRun, Nansen, MetaLend).
- **Privacy Pool + ASP compliance gate.** Single-value 0xbow pool; the ASP membership check is
  enforced in the ZK circuit. Every deposit is screened against the OFAC SDN list + a curated
  Tornado/hack overlay and flagged deposits are excluded — deeper graph-taint KYT is a future
  update below.
- **Money-safe settlement.** Idempotent on the note (no double-pay on a lost response);
  change notes are seed-recoverable.
- **Per-provider stealth recipients** (ERC-5564) so two payments to the same seller never
  share an on-chain address.
- **`@zbase-protocol/core` SDK** on npm, plus an interactive API playground.

Open pilot = the anonymity set is still filling toward its 30-depositor privacy floor, so
payments settle and deliver but aren't yet crowd-anonymous. The floor is necessary but not
sufficient — amount and timing can still narrow the set (see the [Threat model](threat-model.md)).

## Future updates in mind

| Update | What it gives you | Where it stands |
|---|---|---|
| **Grow the anonymity set past 30** | Flips the pilot to crowd-private — withdrawals become unlinkable in a real crowd, automatically. | Immediate next milestone |
| **Decentralize the postman (3-of-5 threshold ASP)** | No single party can push a bad ASP root; the compliance gate becomes a quorum. | Contract + tests done; recruiting signers |
| **Graph-taint / KYT screening** | Today's screen blocks a depositor whose address is directly on the OFAC SDN or hack list; graph-taint also blocks funds a few hops from a flagged source. | Researching |
| **External audit** | Independent review before scaling TVL on mainnet. | Planned precondition to scale |
| **Network-layer privacy (Tor / Nym)** | Closes the IP / TLS-fingerprint leak that on-chain privacy can't touch. | Researching |
| **Amount privacy** | Hide the payment amount on-chain, not just the payer→provider link. | Exploring (encrypted-note redesign) |
| **Client-side proving** | Generate the ZK proof on your own machine, so the facilitator never sees your spend secrets. | Roadmap |
| **Open-source the repo** | Publish the facilitator + MCP so anyone can self-host and audit. | Planned |
| **Solana (on hold)** | Re-enable the paused Solana devnet mirror (an Anchor program + `groth16-solana` verifier). **Not production-ready** and not a near-term deliverable — gated on SVM audit fixes, re-enabling the disabled root scripts, and a mainnet-beta proof run. | On hold |
| **More EVM chains** | Arbitrum / Optimism / Polygon. | Demand-led |

## Pricing direction

A small percentage per private payment today, with an enterprise compliance-data product
(self-custodied, viewing-key-gated) planned alongside amount privacy. The live rate is always
returned by `GET /api/facilitator/supported`. See [Enterprise](pricing.md).

Next → [FAQ](faq.md)
