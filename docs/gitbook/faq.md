# FAQ

Common questions from buyers, builders, and reviewers. Pointers go to the
deeper docs.

## Why not an L3?

Short answer: every privacy L3 we have studied — including the canonical
Aztec Connect post-mortem — shows the same failure surface (centralized
sequencer, bridge UX, new-chain cold start, single-team maintenance burden).
zBase is an **application on Base** so it inherits Base's USDC liquidity,
wallets, and CEX integrations rather than asking users to bridge into a fresh
privacy chain.

See [Why a facilitator on Base](why-base-facilitator.md) for the full
failure-mode analysis.

## Why not an L3 like shh.gg or Aztec?

Same answer as "Why not an L3?" above — the canonical failure modes apply
identically whether the L3 is shh.gg, Aztec, or a hypothetical new privacy
rollup. zBase's choice to live on Base is a deliberate avoidance of
sequencer centralization, bridge UX tax, and cold-start anonymity sets. See
[Why a facilitator on Base](why-base-facilitator.md) for the full analysis.

## How do I integrate stealth recipients as a provider?

The SDK + registry walkthrough is in [Stealth addresses](stealth-recipients.md).

## What env vars do I need?

The canonical list is `.env.local.example` at the repo root. A few callouts:

- **`ZBASE_MIN_DEPOSIT_DELAY_SECONDS`** is the correct env var name for the
  minimum-deposit-delay window used by both the facilitator and the decoy
  scheduler. The codebase historically used `MIN_DELAY_SINCE_DEPOSIT` in
  prose (you'll see this in older runbooks) —
  treat that as a legacy alias for the same concept. The actual env var the
  code reads is `ZBASE_MIN_DEPOSIT_DELAY_SECONDS`.
- `POSTMAN_PRIVATE_KEY`, `HYPERSYNC_TOKEN`, RPC URL, and `MAX_DAILY_BUDGET_USD`
  are the other must-set values for a Sepolia push.

## Why not just KYC at deposit?

Pre-deposit KYC drops the anonymity set to "users who
passed our specific KYC vendor" and links a real identity to the deposit
address. The Privacy Pools design (Buterin, Sun, Hu, Illum, Mahmoody 2023)
trades a one-time **deposit-time label check** for **permanent payment-time
anonymity** without asking the depositor to identify themselves. See
[Why a facilitator on Base](why-base-facilitator.md).

## Is this Tornado Cash with extra steps?

No. Tornado Cash had no ASP — sanctioned and clean funds were
indistinguishable at withdraw time, which is why it was sanctioned in August
2022. zBase requires every withdrawal proof to show membership in **both** the
state tree (any deposit) and the ASP root (approved deposits). Sanctioned
wallets can still deposit but cannot privately withdraw. See
[Trust model](trust-model.md) §3.

## Why both ASP *and* stealth addresses?

ASP defeats the **prosecutor** ("did you handle sanctioned funds?"). Stealth
defeats the **attacker** ("which provider is wallet X paying?"). They sit at
different lifecycle points by necessity — ASP at deposit time, stealth at
payment time — and you cannot merge them without destroying privacy. See
[The two gates](two-gates.md).

## Why is the postman a single key today?

It is a known centralization. The 3-of-5 `ThresholdEntrypoint` is
written and tested, but the
contract bakes signer addresses as immutable constants — so external signers
must be committed before it can deploy. This is on the [Roadmap](build-roadmap.md).

## Is mainnet live?

**Yes.** Private x402 payments work end-to-end on Base mainnet today — deposit
gaslessly, settle from the pool via a ZK withdrawal, and the seller delivers (`200`).
Proven against real Coinbase-CDP sellers: BlockRun ($0.028), Nansen ($0.01), and
MetaLend ($0.001).

It's an **open pilot**: the anonymity set is still filling toward its 30-depositor
privacy floor, so payments settle and deliver but aren't yet crowd-anonymous
(`result.privacy.private` tells you on each payment). The 30-depositor floor is necessary but
not sufficient — a unique amount or timing can still narrow the set (see the
[Threat model](threat-model.md)). Remaining hardening — decentralizing the postman to a 3-of-5 threshold and an
external audit before scaling TVL — is roadmap, not a blocker to paying today.

## Does zBase claim complete anonymity?

No. The claim, proven on Base mainnet, is that the provider-payment transaction
no longer names the payer wallet. Network metadata without Tor, behavioral
fingerprinting, provider-side surveillance, and small anonymity sets all
remain open. The honest disclosure surface lives in
[Trust model](trust-model.md) and [Threat model](threat-model.md).

## How big is the anonymity set?

Dynamic. The 2026-07-11 Base Sepolia reference run is the current timing proof;
query `/api/anonymity-set` for the live count. The set grows with deposits and
does not shrink when funds are reclaimed (commitments stay in the Merkle
tree forever, by design).

## What protects me against zBase itself?

| Threat | Mitigation |
|---|---|
| zBase rewrites the recipient | Recipient is bound into the proof's `context` public signal. Any rewrite breaks verification. |
| zBase logs your IP | The metadata-hygiene middleware strips identifying headers before any handler sees them. |
| zBase forges proofs | Cannot — the Groth16 verifier is on chain. Without the trusted-setup toxic waste, a forged proof is computationally infeasible. |
| zBase censors your deposit | Today: possible (postman is single key). After the threshold deploys: requires 3-of-5 collusion. |

## Where do I see what just shipped?

See [`CHANGELOG.md`](../../CHANGELOG.md) — the canonical release history + current
state (fees).

## Where is the API surface?

[Wallet backend API](wallet-backend-api.md) is the modern entry; the legacy
[API reference](api-reference.md) lists every endpoint with full payloads.
