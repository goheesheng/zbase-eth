# Threat model — explicit attacks defeated vs not

Last updated: **2026-07-11**

TL;DR — for each shipment this page lists the attack it defeats, the mechanism,
the residual risk that remains, and the test that proves the claim. Reviewers
(planned Spearbit / Zellic audit) should verify that this mapping matches the
withdrawal handler, the facilitator routes, and the
on-chain Groth16 verifier.

For the disclosure narrative behind these mappings, read
[Trust Model and Boundaries](trust-model.md).

## Shipment mapping

!!! note

    The first tranche of work targets the most urgent on-chain leaks (FIFO
    timing, facilitator metadata). A later tranche targets the operator-trust
    and provider-correlation gaps. Series A items (PoI, mixnet, recursive
    aggregation) are out of scope for this table.

| Item | Attack defeated | Defense mechanism | Residual risk |
|---|---|---|---|
| Delay (decoys roadmap) | FIFO timing matching (arXiv 2510.09433): re-links 15-22pp of withdrawals to their deposits by ordering alone. | Real withdrawals enforce `ZBASE_MIN_DEPOSIT_DELAY_SECONDS` (default 60s); `?fast=true` opts out with a `privacy.delayWaived` flag. The decoy scheduler (10-20 decoys/hr/pool) is **scaffolded but not running in production** — today only the delay is active. | With decoys off, a single-withdraw timing window can still uniquely identify the withdrawer; aggressive `fast=true` use re-exposes timing. |
| Metadata hygiene | Facilitator-log correlation: `x-forwarded-for`, `user-agent`, `accept-language` tie a payer wallet to a per-call IP / device fingerprint. | The facilitator middleware strips these headers before any handler sees them. Responses set `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Tor / Nym client routing is documented (not enforced). | The TCP layer below the middleware still sees the source IP at TLS termination; only client-side Tor/Nym fixes that. |
| ERC-5564 stealth recipients | Provider-side correlation: every call to the same x402 endpoint pays the same address; a chain analyst clusters payers by shared destination. | Provider registers one stealth meta-address. Facilitator derives a fresh stealth address per call; provider scans incoming funds via view-tag. | Provider's own backend still sees account identifiers / API keys / IPs at request time — out of scope (see below). |
| Threshold-signed postman | Single-key censorship / rogue-root: today's `POSTMAN_PRIVATE_KEY` can withhold approvals or publish a malicious ASP root unilaterally. | Replace single key with a 3-of-5 FROST or BLS threshold (roadmap). Root updates require quorum. | 3-of-5 collusion still possible; signer-set diversity is a governance assumption, not a cryptographic guarantee. |
| Anonymity-set bootstrap | Small-set linkability at mainnet launch: a 5-deposit pool gives 1-in-5 privacy at best. | Seed each pool with 50-100 treasury-funded dummy deposits before public mainnet launch (mirroring Vitalik's $113K personal seed of 0xbow). Funds are time-locked, reclaimable after 6 months; commitments stay in the set forever. | Sophisticated attackers may identify and exclude seed commitments via on-chain heuristics over time; transparent disclosure is the mitigation. |

**How each is verified:**

- **Delay / decoys** — simulate 100 deposits + 100 withdrawals over 24h with and without decoys; apply the FIFO heuristic; pass if temporal de-anon < 5%.
- **Metadata hygiene** — send a request with a spoofed `X-Forwarded-For` header; confirm it never reaches a handler or the logs.
- **Stealth recipients** — provider registers a meta-address; generate 100 stealth addresses for 100 calls; assert none repeat and the meta-address is not derivable from any single stealth address.
- **Threshold postman** — 3-of-5 signers sign an ASP root update successfully; a single-signer attempt is rejected.
- **Anonymity-set bootstrap** — deploy and seed 100 dummy notes; assert anonymity set size = 100 before public launch.

## What we currently leak (operational honesty)

The pool deployed on Base Sepolia today is single-value. Amounts
move in plaintext at every public surface. The table below enumerates each
leak so auditors do not have to grep for them. Treat amount-privacy as
**sender/receiver unlinkability only**, not amount-hiding.

| Surface | Citation | What an attacker reconstructs |
|---|---|---|
| `Deposited(_value)` event | Withdrawal-handler event decode; pool emit | Exact post-fee deposit value per commitment. Indexable. |
| Pool USDC transfer to recipient / fee recipient | active 0xbow pool relay path | Recipient address + exact payout. |
| Relay + protocol-fee transfers | active 0xbow pool relay path plus facilitator `relayFeeBPS` | Fee values and routing addresses; correlatable with the matching withdraw tx. |
| Withdraw API response | Withdrawal-handler response | Returns `amount` and full `publicSignals` array to the caller (including any monitoring middlebox). |
| Partial-withdraw change chain | Withdrawal-handler `nextDeposit` | Sequential change commitments allow chaining a partial-spend sequence back to the originating deposit. |

Unique or atypical amounts collapse the anonymity set to 1 regardless of pool
size. Round denominations (`1 / 10 / 100 / 1000 USDC`) are not a UI nicety —
they are the only mitigation in the current pool.

## Effective vs nominal anonymity set

Nominal anonymity set = number of commitments in the state tree. Effective
anonymity set = the subset that could plausibly fund **your** withdrawal
under the constraints the verifier and analyst both apply:

```
effective_set = state_tree ∩ asp_approved_tree ∩ {commitments with your amount}
              \ {publicly attributable seed commitments}
              \ {commitments outside your timing window when no decoys run}
```

- **State ∩ ASP.** The 0xbow withdrawal circuit requires label membership in the
  ASP-approved tree (relayer enforcement). The approved tree is built by
  screening every deposit against the OFAC SDN list ∪ a curated Tornado/hack
  overlay and excluding the flagged ones — so a
  flagged deposit sits in the state tree but not the ASP tree, i.e. effective
  set = approved subset. On a clean pilot pool the two are near-equal; the gap
  widens as flagged deposits arrive (or as deeper graph-taint KYT is enabled).
- **Amount bucket.** Plaintext `_value` lets an analyst restrict to
  commitments with the same value.
- **Seed attribution.** Seed commitments are publicly disclosed,
  so a chain analyst subtracts them when modeling organic privacy.
- **Timing window.** Without the decoy scheduler running, a withdrawal that
  is the only event in a 5-minute window is uniquely identifiable up to
  amount-bucket. See FIFO heuristic, arXiv 2510.09433.

Practical implication on integration-test (set size 126 with ~30 publicly
attributable seeds): the worst-case effective set for an early organic
1-USDC depositor is closer to 20-40, not 126.

### Liquidity is not the privacy substrate

The pool can run with **0 USDC TVL** and still grant anonymity to new
deposits. The privacy substrate is the commitment Merkle tree
(monotonically grows, never shrinks even after withdrawals —
the withdrawal handler reconstructs the state tree from
*all* `LeafInserted` events). USDC balance is a fee-revenue and
withdraw-capacity metric, not a privacy metric.

What 0 TVL blocks: **other** users withdrawing funds they never deposited
— correct behavior, not a bug. What 0 TVL does NOT block: a new depositor
landing into the pool gets 1-in-(N+1) anonymity where N is the historical
commitment count, regardless of current USDC balance.

The pool can launch with 0 USDC and seed only commitments — privacy works
from deposit 1.

## What we don't have on yet

| Defense | Status | What turning it on would buy |
|---|---|---|
| Decoy scheduler | **Not running in prod.** Code exists but the cron is not wired. | Breaks FIFO temporal de-anonymization (arXiv 2510.09433). Without it, single-withdraw timing windows uniquely identify the withdrawer regardless of pool size. |
| Threshold ASP | **Scaffolded.** The `ThresholdEntrypoint` contract and threshold-postman risk pipeline exist; single-key postman still authoritative on Base Sepolia. | Removes single-key censorship + single-key rogue-root risk. The moment threshold ASP starts rejecting labels, effective anonymity set shrinks to the approved subset (see section above). |

Two defenses listed in the shipment table at the top of this page are not
yet operative. The defense exists in source; the production deployment does
not run it. Audit against the running system, not the shipment list.

## Defenses already shipped (pre-A/B)

Two defenses are already live on Base Sepolia today and warrant explicit
mention in any audit:

- **Recipient binding in ZK proof** — the withdrawal handler
  hashes the withdrawal struct + scope into the proof's `context` public
  signal. A postman that swaps the recipient invalidates the proof.
- **Nullifier consumption** — the on-chain pool rejects any reuse of a spent
  note's nullifier, so a relayer cannot replay a withdrawal.

## Speed regression gate

Every shipment must keep the warm Base Sepolia x402 settle path near the
documented ~7-15s target. The 2026-07-11 cold reference run measured proof
generation at ~0.7s and a cold private withdrawal at ~21s, dominated by
`eth_getLogs` paging and chain confirmation rather than proving. `npm run
test:e2e` is the local live-flow gate. A defense that materially breaks the
speed claim breaks the product claim.

## Out of scope

!!! warning

    No protocol-layer privacy system can fix any of the following. zBase does
    not claim to and any marketing copy that implies otherwise is wrong.

- **Provider-side surveillance.** Once a paid endpoint receives your prompt,
  the provider sees the prompt, the IP that hit their TLS terminator, and
  any account identifier you presented. Stealth addresses hide the on-chain
  recipient, not the application-layer request.
- **Network metadata without Tor.** Direct HTTPS from the agent to the
  facilitator exposes source IP, TLS fingerprint, and request timing to
  passive observers and to the facilitator's hosting provider. zBase strips
  headers but cannot strip what TCP/TLS expose. Client-side Tor or
  Nym is the user's responsibility; the Series A roadmap bundles a Nym SDK.
- **Side channels.** Power, EM, cache, and microarchitectural side channels
  against the device running the proof or holding the viewing key are out
  of scope.
- **Behavioral fingerprinting.** Stable call rates, prompt patterns, or
  sequence-of-providers can re-identify an agent at the application layer
  even with perfect on-chain unlinkability.
- **Endpoint compromise.** Malware on the device running the SDK, a
  compromised browser extension, or a tampered SDK package can exfiltrate
  note secrets directly. Threshold custody and reproducible builds are
  outside the protocol layer.
- **Legal compulsion against the operator.** A court order to a single
  postman (today) or 3+ threshold members can compel censorship
  of specific labels. The ASP cannot redirect funds (recipient is bound in
  the proof) but it can refuse to add a label to the approved set.
- **Trusted-setup compromise.** Groth16 requires a per-circuit trusted setup; if
  every ceremony participant colluded, false proofs become possible. The live
  circuits are the vendored 0xbow Privacy Pool circuits, whose setup was performed
  and audited by 0xbow — zBase inherits it and does not run its own ceremony.

Next → [Roadmap](build-roadmap.md)
