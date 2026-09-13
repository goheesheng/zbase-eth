# zBase Governance — Threshold ASP Postman

**Status:** v0 scaffold landed (Shipment B.2). Ceremony, signer recruitment, and audit
pending. **Until the ceremony completes, the single-key postman at
`src/app/api/asp-update/route.ts` remains the live production path.**

That live single-operator route now performs real screening before publishing a
root: deposits are checked against the OFAC SDN list (**L1**, fetched + cached, with
a vendored fallback) plus a curated mixer/hack risk overlay (**L2**,
`src/lib/risk-overlay.json`). Flagged depositors are excluded from the approved set;
`GET /api/asp-update/rejected` reports what and why. The threshold quorum below adds
*who you have to trust* (3 independent parties vs one key) on top of this same
screening logic — it shares the `risk-pipeline.ts` → `ofac-screening.ts` provider.
Automated graph-taint (**L3**, paid KYT) remains a deferred follow-up via the
existing `CounterpartyResolver` seam.

This document is the operational contract for the 3-of-5 threshold-signed
Association Set Provider (ASP) root updates. It exists alongside the
`ThresholdEntrypoint.sol` contract (which encodes the rules in immutable code)
and the `scripts/threshold-postman/` daemon set (which executes them off-chain).

## 1. Why threshold signing

The 0xbow Privacy Pools fork has a single `POSTMAN` role responsible for
publishing the ASP root — the on-chain attestation that says *"these depositor
labels have been screened and may be privately withdrawn."* Whoever holds the
POSTMAN key can:

- **Censor approvals** — refuse to publish a clean root after a user deposits,
  freezing their funds in the pool.
- **Inject bad labels** — push a sanctioned address into the approved set,
  silently turning zBase into a laundering surface.

Either failure mode is fatal to the compliance pitch in
[trust-model.md](./gitbook/trust-model.md). A 3-of-5 quorum reduces both risks
to a collusion problem (3 independent parties must agree to misbehave)
rather than a key-compromise problem.

## 2. The five signer slots

All slots are **TBD** until the recruitment governance task lands. The intent is
that each slot represents a distinct trust constituency so that collusion
requires crossing organizational boundaries.

| # | Slot                          | Proposed party                          | Rationale                                  |
|---|-------------------------------|------------------------------------------|--------------------------------------------|
| 1 | zBase Founder                 | TBD (current: project lead)              | Operator interest                          |
| 2 | Base Ecosystem partner        | TBD (Base ecosystem rep)                 | Aligns with the chain we deploy on         |
| 3 | 0xbow team representative     | TBD (we forked their code)               | Upstream technical custody                 |
| 4 | Kohaku contributor            | TBD (EF privacy-pool maintainers)        | Independent EF-aligned reviewer            |
| 5 | Independent security auditor  | TBD (Spearbit / Zellic / TrailOfBits)    | Adversarial outside party                  |

**No party may hold more than one slot.** Slots are not transferable mid-term;
see §4 for rotation.

## 3. Message bus & coordination

v0 ships a filesystem-based message bus (`scripts/threshold-postman/coordinator.ts:FileBus`).
This is intentional — it lets a quorum dry-run on a single host before we commit
to production infrastructure. **Before mainnet ceremony**, switch to either:

- Redis Streams hosted by a neutral fourth party, OR
- libp2p PubSub mesh (no central infra), OR
- An off-the-shelf threshold-signing coordinator (Frost-FROST, Drand, etc.).

Picking the production bus is a separate governance decision and must precede
any real signer recruitment.

## 4. Joining and leaving the signer set

The signer set is **immutable for the lifetime of a `ThresholdEntrypoint` deployment**.
This is a deliberate v0 simplification — adding on-chain rotation now would
require a meta-governance contract whose security would itself need an audit.

To rotate, retire, or replace any signer:

1. Draft the new `address[5]` set and announce in a public governance forum (HackMD).
2. Hold a 14-day comment period.
3. Deploy a fresh `ThresholdEntrypoint` with the updated set.
4. Run the cutover ceremony:
   - The *old* threshold submits one final root from the old contract.
   - On-chain `POSTMAN_ROLE` on the 0xbow Entrypoint is revoked from the old
     ThresholdEntrypoint and granted to the new one.
   - All five new signers run a smoke-test root update on the new contract.
5. Decommission the old deployment in `CLAUDE.md` and the deck.

A future on-chain governance module (Series A scope) can compress this to a
single proposal vote, but is explicitly out of scope here.

## 5. SLA

| Metric                                  | Target          | Escalation                              |
|-----------------------------------------|-----------------|------------------------------------------|
| Root update latency after deposit       | ≤ 5 min p95     | PagerDuty if > 30 min                    |
| Signer reachability                     | 4-of-5 always   | If only 3 reachable for > 1h, page rest  |
| Stuck quorum (3 signed, no submission)  | 0               | Any signer may submit; alert if > 10 min |
| Divergent risk-pipeline output          | 0               | Halt all submissions; ceremony review    |

A "stuck quorum" is when three signatures sit in the bus but the on-chain `nonce`
has not advanced. By contract design, **any signer can submit once quorum is reached** —
the `coordinator.ts` lowest-index leader election is an optimization, not a
gate. If the leader is offline, the next-lowest signer must manually invoke
`updateRoot`. The runbook for this lives in `docs/runbooks/threshold-postman-stuck-quorum.md`
(to be authored before launch).

## 6. Audit log

Every signer MUST emit a structured log line per `tick()` that includes:

- `signerIndex`, `signerAddress`, ISO-8601 timestamp.
- `proposalNonce`, `newRoot`, `decisionDigest`.
- Decision counts: `approved`, `pending`, `rejected`.
- Outcome: `signed` / `submitted` / `diverged` / `error`.

Logs land in two places:

1. The signer's own write-only S3 bucket (hash-chained, append-only) for
   accountability against later disputes.
2. A daily aggregator that publishes the diff between any two signers' digests
   to a public GitHub gist — divergence is observable to anyone within 24h.

**Slashing is out of scope for v0.** A divergent signer is publicly named and
recruitment §2 may rotate them out via §4. On-chain economic slashing requires
a staked deposit per signer and is a Series-A workstream.

## 7. Disclosure obligations

The following statements MUST appear verbatim in any external-facing privacy /
compliance write-up while the v0 scaffold is live:

> "ASP root updates are 3-of-5 threshold-signed by independent operators
> (zBase, Base ecosystem partner, 0xbow, Kohaku, independent auditor). Quorum
> determinism is verified per-update by digest comparison; a divergent operator
> abstains rather than risking a censored or polluted root.
>
> The transition from the legacy single-key postman to the threshold contract
> is gated on signer recruitment and a third-party audit of
> `ThresholdEntrypoint.sol`. Until that transition completes, ASP root updates
> are signed by a single key controlled by the zBase team. This is disclosed at
> [docs/gitbook/trust-model.md](./gitbook/trust-model.md)."

## 8. Cross-references

- Contract: [`zbase-protocol/pkg/contracts/src/contracts/ThresholdEntrypoint.sol`](../zbase-protocol/pkg/contracts/src/contracts/ThresholdEntrypoint.sol)
- Orchestration: [`scripts/threshold-postman/coordinator.ts`](../scripts/threshold-postman/coordinator.ts)
- Risk pipeline: [`scripts/threshold-postman/risk-pipeline.ts`](../scripts/threshold-postman/risk-pipeline.ts)
- Tests: [`contracts/test/ThresholdEntrypoint.t.sol`](../contracts/test/ThresholdEntrypoint.t.sol)
- Current single-key path (fallback): [`src/app/api/asp-update/route.ts`](../src/app/api/asp-update/route.ts)
- Plan source-of-truth: `/Users/eesheng_eth/.claude/plans/i-want-production-grade-enchanted-scone.md` (Shipment B.2)
