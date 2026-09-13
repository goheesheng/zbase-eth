# Trust model — what zBase trusts, what it does not

Last updated: **2026-07-20**

TL;DR — zBase is a privacy product. This page separates what the protocol
cryptographically defeats from what it leaves to the operator, the network, or
the user. If marketing copy ever conflicts with this page, this page wins.

## 1. What zBase defeats

The private x402 flow, proven on Base mainnet, removes four concrete on-chain leaks
that would otherwise tie a payer to a provider.

- **Payer-provider edge in single payments.** Vanilla x402 settles
  `payer wallet -> provider wallet`. zBase replaces that with
  `payer wallet -> pool -> provider wallet`. The provider-payment transaction
  no longer names the payer.
- **Provider correlation** (post-stealth). The facilitator
  derives a fresh ERC-5564 stealth address per call from the provider's
  registered meta-address, so two payments to the same provider never share an
  on-chain recipient.
- **Intra-batch timing** (post-decoy+delay). Decoy withdrawals
  and an opt-in `ZBASE_MIN_DEPOSIT_DELAY_SECONDS` window break the FIFO heuristic that
  re-links 15-22pp of Tornado withdrawals (arXiv 2510.09433).
- **Relayer redirect.** Today, already. The withdrawal recipient is hashed into
  the Groth16 public signals via
  `context = keccak256(withdrawal, scope) % SNARK_FIELD`. A postman that
  rewrites the recipient invalidates the proof, so a valid relay cannot be
  redirected.

## 2. Trust assumptions

!!! note

    zBase is honest about what is centralized today and what is on the roadmap.
    The audit surface is intentionally small and is documented file-by-file.

- **Postman: single-key today.** A single operator key
  (`0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843`) signs ASP root updates.
  A roadmap 3-of-5 threshold (FROST or BLS) replaces this, shared
  across zBase, a Base ecosystem partner, 0xbow, a Kohaku contributor, and an
  independent auditor.
- **Screening depth: exact-address match today.** Live screening blocks a
  depositor whose address is on the OFAC SDN list or the curated hack/mixer
  overlay. Deeper graph-taint screening (blocking funds *N hops* from a flagged
  source) is on the roadmap — so today's gate catches a flagged address
  directly, not one removed by intermediary hops.
- **ASP curator can censor but cannot redirect.** The curator picks which
  deposit labels enter the approved set. A label withheld means a deposit
  cannot privately withdraw. The curator cannot reroute funds to a different
  recipient, because the recipient is bound into the proof's public signals;
  any rewrite breaks verification.
- **Indexer/RPC honesty.** The state tree is rebuilt from `LeafInserted`
  events. A malicious indexer can withhold events (denial of service) but
  cannot forge a proof, because state roots must match the on-chain root.
- **Upgrade keys.** Contract admin remains a single operator key on testnet.
  Mainnet release requires a published upgrade policy and multi-sig.

## 3. vs Zcash / Tornado

The architectural difference is the **Association Set Provider (ASP)**, not
the ZK math.

- **Tornado Cash** has no ASP. Any address can deposit, any address can
  privately withdraw. OFAC sanctioned the contract in August 2022 precisely
  because sanctioned funds could not be distinguished from clean funds at
  withdraw time.
- **Zcash** is encrypted-by-default with no compliance layer. Major exchanges
  delisted shielded Zcash withdrawals in multiple jurisdictions for the same
  reason.
- **zBase implements the Privacy Pools design** (Buterin, Sun, Hu, Illum, Mahmoody 2023).
  Deposits enter the pool freely, but the ASP root names a compliant subset.
  Withdrawals must prove membership in **both** the state tree and the ASP
  approved subset (Groth16 inputs `stateRoot`
  and `ASPRoot`). Sanctioned wallets can deposit but cannot privately
  withdraw. This is why Privacy Pools is legal on Ethereum mainnet today and
  why the US Treasury's March 2026 mixer report names the ASP design as a
  legitimate-use example.

!!! warning

    **Important: the ASP is enforced inside the ZK circuit, not as an off-chain
    filter.** The 0xbow withdrawal proof requires label membership in the
    ASP-approved tree, and the relayer rejects any proof whose label is not
    present in the approved set. The state-root + ASP-root pair is
    built off the same on-chain entrypoint root.

    The consequence is structural: **effective anonymity = state tree ∩ ASP
    tree.** Screening is **live today**: `/api/asp-update` → `refreshAspRoot()`
    builds the ASP tree from approved labels only, and `screenDeposits()`
    excludes any depositor flagged by the OFAC SDN list ∪ a curated Tornado/hack
    overlay (fail-closed on an empty list). A flagged deposit's label never enters the
    tree, so it can never satisfy the withdrawal association proof. Because the
    approved subset can be smaller than the full state tree, ASP curation is both
    a compliance lever and a privacy lever, and must be governed accordingly.
    See [Threat model — Effective vs nominal anonymity set](threat-model.md).

## 4. Two parties protected against

zBase defends against two distinct adversaries. Each needs a different
mechanism; one mechanism alone is insufficient.

- **The prosecutor** (regulator asking "did you handle sanctioned funds?"):
  defeated by the **ASP**. The compliant subset is provably disjoint from
  sanctioned addresses.
- **The attacker** (competitor or chain analyst watching the network):
  defeated by the **stealth address**. Per-call recipient rotation breaks the
  pattern "wallet X pays Nansen $0.50 every 60s."

Four-quadrant truth table:

|  | No ASP | With ASP |
|---|---|---|
| **No stealth** | Blind mixer -> sanctioned | Compliance-only pool -> leaks recipient |
| **With stealth** | Stealth-only mix -> regulator delists | **zBase** -> both gates, defensible |

ASP cannot move to payment time (would require knowing payer identity, which
destroys privacy). Stealth cannot move to deposit time (recipient is unknown
at deposit). They sit at different lifecycle points by necessity. Privacy
alone gets zBase delisted; compliance alone gets zBase out-competed. Both
are required.

Next → [Threat model](threat-model.md)
