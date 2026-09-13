# Private Funding-and-Settlement Rail (Forwarding Wallet) — Design

**Date:** 2026-07-09 (rev. 2026-07-09b — simplified to immediate/no-jitter)
**Status:** 🟡 DESIGNED — named user identified (founder-as-agent). Build AFTER v1 ships.
**Author:** brainstormed with Claude
**Supersedes:** nothing — additive to v1 zBase

> **Launch decision (2026-07-09):** Ship **v1 + SDK beta first**; validate demand with a
> real x402 provider / agent developer BEFORE perfecting this rail. zBase's verified
> bottleneck is *demand, not differentiation* (`[[project_differentiation_verdict]]`).
> The founder is the first named user (an agent wanting private+fast settlement), which
> is the build trigger — but the trigger is "build it *next*," not "block launch on it."
>
> **Rev-b simplification (the important change):** the deposit policy defaults to
> **`immediate` (no jitter, no decoy)** — see §5.1. The founder wants *privacy AND
> speed*; the jitter defends the TIMING channel, but on the single-value pool the
> **amount channel already leaks the same link**, so jittering is premature until UTXO
> hides amounts. Ship the fast, honest floor; add `jittered` later, coupled with UTXO.

---

## 1. Summary

A **private, compliant funding-and-settlement rail**: a watched receiving address plus a
bounded relayer that auto-deposits inbound funds into the existing zBase privacy pool on a
jittered, decoy-blended schedule, using deposit notes derived from the user's own HD
seed. The rail privately **funds a fresh wallet from the pool** (and privately **settles
proceeds back**) so that a downstream agent operates from capital that is unlinked from the
user's treasury or identity.

**One rail, two destination modes** (§8.1): *payment mode* withdraws to a recipient
(private compliant receiving); *trading mode* withdraws to a fresh trading wallet that then
trades on a public DEX or a **rented** Arcium confidential venue (private compliant funding
+ settlement). These are the same engine pointed at two destinations — **not** two products,
and neither requires a new smart contract of ours (execution privacy is rented, not built).

The novel property, versus every competitor and versus v1 zBase, is that the **payer can
be privacy-unaware**: they send an *ordinary* ERC-20 transfer to a normal-looking
address, and privatization happens *after arrival* via the relayer — no shield tx, no
conscious deposit, no knowledge of zBase required on the payer's side.

**This rail is a component, not the end product.** The end product people want is the
agentic trading tool (see `[[project_xochi_competitor]]` — contested, live demand). This
spec builds the rail first as a standalone, shippable sub-project, explicitly positioned
to plug under a trading agent built as the *next* sub-project.

**Customer (verified 2026-07-09, `[[project_trading_rail_verdict_2026-07]]`):** the rail's
real market is **not "agents that pay"** — it is **"agentic trading products that need
private, compliant funding and settlement."** Agent traders pay for *execution* privacy
(hiding trade sizes — Aster's Hidden Orders at >$28B/day proves it), which is a crowded,
from-scratch new-protocol lane (Renegade / Arcium / Xochi / Aster) we **rent, not build**.
Every one of those needs private compliant capital-in and capital-out around the trade,
and none of them focus on it. That plumbing is what this rail owns. See §8.1 for the
one-rail-two-modes model.

### What it is NOT (honesty gate)

- **Not new cryptography.** It forks 0xbow's pool like the rest of the stack. The novelty
  is orchestration/UX (payer-agnostic, x402-native, auto-on-arrival), not a primitive.
- **Not a technical moat.** Anyone could bolt a watched-address relayer onto 0xbow. What
  is defensible is being *first and x402-native on the payee/funding lane*
  (`[[project_differentiation_verdict]]`: position, not tech).
- **Not amount-hiding (v1).** The inbound public hop and its amount are on-chain forever.
  The rail hides *timing / whether-you-deposited* and *unlinks* the funded wallet from the
  treasury. Amount privacy ships with UTXO-P3 later.

---

## 2. Why this vs v1 zBase, and vs competitors

### vs v1 zBase

v1 is **user-initiated deposit**: the user connects a wallet and signs
`Entrypoint.deposit(...)` themselves. The person taking the action is the person who wants
the outcome. There is no third-party-funded, unattended path. The rail introduces three
things v1 does not have:

1. A **receiving address** a third party pays with an ordinary transfer.
2. A **relayer** that deposits without the user online.
3. An **arrival→deposit custody window** (the new, bounded trust surface).

### vs competitors (verified 2026-07-09)

Full-axis comparison. **The honest scoping: we WIN on placement + receive-ergonomics,
LOSE on amount-privacy, and DON'T CONTEST swaps.** Say "better" only scoped to the x402
payee lane — unscoped, Railgun and PrivacyCash beat us on privacy strength.

| | **This rail** | v1 zBase | 0xbow | Railgun | PrivacyCash | Base Ledgers |
|---|---|---|---|---|---|---|
| **Hides the amount on-chain** | ❌ No (single-value) | ❌ No | ❌ No | ✅ Yes (UTXO) | ✅ Yes (UTXO) | ✅ likely (unconfirmed) |
| **Auto-privatize an UNAWARE payer's ordinary transfer** | ✅ **only one** | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Payer → published private address** | ✅ | ❌ | ❌ | ✅ (privacy-aware payer) | ❌ | ❌ |
| **Withdraw to arbitrary fresh recipient (settlement)** | ✅ | ✅ | ✅ | ✅ | ✅ (`withdrawSPL`) | via Portal |
| **Swap** | public swap / private owner | ❌ | ❌ | ⚠️ in-pool | **same as ours** (unshield→Jupiter→reshield) | ❌ |
| **Timing defense (jitter + decoy)** | ✅ built-in | ⚠️ | ⚠️ | ⚠️ | ⚠️ (admits gap) | operator-internal |
| **Anonymous from the operator** | ✅ (pool) | ✅ | ✅ | ✅ | ✅ | ❌ (operator knows all) |
| **Permissionless / agent-usable today** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (KYC-gated, demo-only) |
| **Compliance (clean-funds)** | ✅ ASP | ✅ ASP | ✅ ASP | ⚠️ PoI | ✅ screening | ✅ operator KYC |
| **Lane** | **Base, x402 payee** | Base | ETH | ETH/L2 | Solana (Base claimed) | Base, institutional |

**The precise, defensible differentiator:** Railgun already supports receive-to-a-private-
address, so "private receiving" is not novel. The remaining distinction is that entry into
*every* competitor — 0xbow, Railgun, **and** PrivacyCash (all verified self-deposit,
sender-signed) — *requires the fund-owner to sign an explicit shield/deposit tx*. This rail
privatizes an **ordinary payer's ordinary transfer** — exactly the x402 case, where payers
are dumb clients paying normal addresses and will never build a shield. That "payer-
agnostic auto-privatize" is the one axis we own.

**Amount-hiding is our real gap.** Railgun and PrivacyCash hide amounts (UTXO); we don't
until the deferred ceremony. A trading user who needs to conceal position sizes picks them
over us *today* — this is the concrete demand-trigger for UTXO-P3 (§8), not a footnote.

**Swaps: tie / not-competing.** PrivacyCash's swap is verified as unshield→Jupiter→reshield
— identical in shape to our "public swap from an unlinkable wallet." Neither hides swap
amounts; **nobody in this set does in-pool private swaps** (that's Xochi/Arcium dark-pool
territory). Do not claim swap superiority — there isn't any.

**Base Ledgers (the platform-level entrant, 2026-06-17):** Coinbase/Base shipped *native*
private payments on Base. This **kills the "only/first privacy on Base" pitch** — strike it
everywhere. But it is **not a competitor for this lane**: it is permissioned, KYC-gated,
institutional (banks/treasuries), demo-request-only with no public SDK, and has **zero
agent/x402 support**. Architecturally it is the *opposite* of a pool — a per-enterprise
off-chain sovereign ledger + one on-chain Portal contract (no shared anonymity set,
trust-the-operator, operator knows every participant). It validates the category and leaves
the permissionless/agent-native/payer-agnostic floor uncontested. **Watch as first-class:**
a permissionless tier or x402/AgentKit wiring would make it direct.

### Garry/PG framing (the honest case)

- **Painkiller for one user, vitamin for the rest.** The rail earns its keep only when
  private receiving/funding is **high-frequency and unattended** — an agent funded by
  many inbound payments, or a trading agent whose funding hop must not de-anon its
  strategy. For a one-off, v1's manual deposit is fine.
- **It's a differentiation build in a demand-gated business** (`[[project_differentiation_verdict]]`:
  demand is the bottleneck). Justified here because it is the component that makes the
  *agentic-trading* thesis literally true (an agent can't consciously deposit; its funder
  is privacy-unaware), and because it is scoped narrow (B1 + P2, one lane) rather than
  built as a platform.

---

## 3. Architecture & trust model

**One engine, three pluggable seams**, so today's honest floor upgrades to the trustless
end-state without re-architecture:

- **`DepositAuthority`** — *who signs the pool deposit from the receiving EOA.*
  Ships **B1** (relayer holds a policy-scoped key: may only `approve(pool)` + `deposit`).
  **B2** (smart-account session key, on-chain-enforced policy) is an opt-in second
  implementation added later. Same interface.
- **`DepositPolicy`** — *when/how the deposit hits the pool.* Ships **P2** (Poisson jitter
  + blend into the existing decoy-deposit stream). **UTXO-P3** (real amount-hiding) drops
  in when the ceremony lands.
- **`NoteDelivery`** — fixed at **D3**: `(nullifier, secret)` derived from the *user's* HD
  seed. The relayer computes the *commitment* to deposit but never holds a spendable
  secret.

### Trust boundary (stated honestly)

The relayer is trusted **only** for the arrival→deposit window on inbound-but-not-yet-
deposited funds (it holds the B1 receiving-EOA key). It **cannot** touch deposited funds
(D3 — spend authority is the user's seed) and **cannot** redirect a withdrawal
(ZK-proof-constrained, same as today). This is a *bounded extension* of the trust already
disclosed at `src/lib/chain-context.tsx:52` ("pool is custodial (relayer is trusted) and
must NOT be advertised as trustless"), not a new custody assumption.

### Decision record

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Custody model | **B — per-user watched EOA**, relayer bounded to deposit-only | Preserves v1's non-custodial spirit; no new audited contract |
| 2 | Deposit authority | **B1 default, B2 opt-in**, behind one `DepositAuthority` interface | B1 matches existing postman-signer/decoy pattern; B2 needs audit, deferred |
| 3 | Sequencing | **Default B1, opt-in B2** | Ships without new audited contract; B2 is a pure additive later |
| 4 | Timing/amount policy | **P2 now (jitter + decoy-blend), UTXO-P3 drop-in later** | P3 on the current single-value pool re-leaks amount (count + remainder); real amount-hiding = parked UTXO ceremony (`[[project_utxo_testnet_state]]`) |
| 5 | Note delivery | **D3 — deterministic notes from user seed** | Relayer deposits a commitment it can compute but cannot spend; collapses trust to the pre-deposit window |

---

## 4. Components

Six units, one job each. The three seams above are the interfaces; the rest is the engine.

1. **`ForwardingWalletRegistry`** — `src/app/api/forwarding/register/route.ts`
   Mirrors `providers/register`. User registers a receiving wallet: derives the receiving
   EOA + D3 seed commitment client-side, POSTs the *public* half (receiving address,
   viewing pubkey, authority mode `b1|b2`). Server stores a `ForwardingRecord`. The
   "publish one address" surface.

2. **`InboundWatcher`** — engine module
   Watches each registered address for inbound USDC via HyperSync (same source
   `/api/withdraw` uses — no new infra). On a confirmed inbound transfer, enqueues
   `PendingDeposit{ receivingAddr, amount, arrivalBlock, txHash }`. Dedupes by tx hash.
   Only this unit reacts to arrival; it does not deposit.

3. **`DepositPolicy` (interface)** — impl `P2JitterBlend`
   `schedule(pending): FireTime`. Draws a Poisson delay (reusing `poissonDelaySeconds`
   from `scripts/decoy-scheduler.ts`) and schedules the deposit into the **same emission
   stream** as decoy deposits. **Fails closed**: if the decoy stream is empty/paused, holds
   the deposit rather than firing a lone (correlatable) real deposit.

4. **`DepositAuthority` (interface)** — impl `B1SessionKey` (ships), `B2SessionAccount` (later)
   `submitDeposit(receivingAddr, amount, precommitment): txHash`. `B1SessionKey` holds the
   policy-scoped receiving-EOA key; can *only* `approve(pool)` + `deposit`.
   `B2SessionAccount` submits through a smart-account session key with on-chain policy.

5. **`NoteDelivery` (fixed: D3)** — `src/lib/forwarding-notes.ts`, built on
   `packages/core/src/viewingKeyHD.ts` / `stealth.ts`
   Derives `(nullifier, secret)` from the user's HD seed at a per-deposit index →
   `precommitment = poseidon2(nullifier, secret)` for the authority to deposit. Relayer
   gets the commitment, never a spendable secret. User re-derives by scanning indices
   (`noteScanner.ts` pattern).

6. **`ForwardingEngine`** — `scripts/forwarding-engine.ts` (sibling to `decoy-scheduler.ts`)
   Daemon wiring: `InboundWatcher` → `DepositPolicy.schedule` → at fire time
   `NoteDelivery.derive` → `DepositAuthority.submitDeposit` → mark deposited, advance the
   D3 index (only after on-chain confirmation), blend into decoy stream. Owns the state
   file + budget cap (decoy-scheduler pattern).

**Boundary test:** each unit is testable in isolation — `P2JitterBlend` with a fake clock,
`B1SessionKey` against testnet, `NoteDelivery` as pure functions — without standing up the
whole engine. The engine is thin glue; B2 and UTXO-P3 slot into their seams with zero
changes to the other units.

---

## 5. Data flow (funding-rail)

**Fund a trading agent privately:**

1. User's treasury/EOA (privacy-*unaware* — could be an exchange withdrawal) sends an
   ordinary USDC transfer → the **watched receiving EOA**.
2. `InboundWatcher` sees it → `PendingDeposit`.
3. `P2JitterBlend` schedules it into the decoy stream (breaks timing link).
4. At fire time: `NoteDelivery` (D3) derives `(nullifier, secret)` from the user's HD seed
   → `B1SessionKey` deposits into the pool at that commitment. **Funds are now in the
   anonymity set, unlinked from the treasury.**
5. User/orchestrator calls existing `/api/withdraw` → pool pays out to a **freshly-derived
   trading wallet** with no on-chain link to the treasury. **The trading agent is funded
   from clean, unlinked capital.**

**Settle proceeds privately:** the trading wallet's profits flow back through the *same*
watched-address mechanism → pool → user's cold wallet. Symmetric.

The **outbound/fund side is composition of existing code** (`/api/withdraw` already
withdraws to an arbitrary recipient; the fresh trading wallet address is exactly what D3 +
the stealth flow produce). The **only new build is the inbound forwarding engine.**

**Honest privacy claim for the rail (rev-b, `immediate` default):** "funds the wallet
without linking it to your treasury or identity, at full speed. Does **not** hide the
inbound amount, and does **not** decorrelate deposit *timing* (opt-in `jittered` mode adds
that later, coupled with UTXO amount-hiding)." The unlinkability — the property that
actually matters for most agent use cases — comes from the **pool**, and it is *instant*.

### 5.1 Deposit-timing policy — a per-transaction dial (rev-b)

The `DepositPolicy` seam ships **two modes**; the agent picks per payment (reusing the
existing `expedited`/`premium` plumbing in `withdraw/route.ts`):

- **`immediate` (DEFAULT, fast):** deposit on arrival. Full speed. Gives payer↔payee
  **link** unlinkability (from the pool). Timing is correlatable and amount is public.
  This is the shipped floor and the right default for **privacy + speed**.
- **`jittered` (opt-in, DEFERRED):** Poisson delay + decoy-blend (the original P2). Adds
  **timing** decorrelation. Nobody in the competitive set does this on the entry side —
  it's a real differentiator — BUT it is **premature on the single-value pool**: the
  jitter defends the timing channel while the **amount channel leaks the same link**
  (public deposit amount ≈ inbound amount). Defending one channel while the other is open
  is theater. Therefore `jittered` is **coupled to UTXO** — build it only when UTXO hides
  amounts, so timing + amount are defended *together*.

**Why `immediate` is honest, not a cop-out:** the founder's stated need is *privacy AND
speed*. For an agent, the privacy that matters is usually **unlinkability** ("don't tie my
trading wallet to my treasury / don't dox which agent I am"), which the **pool** delivers
at full speed. Temporal correlation is a Tornado-scale-adversary threat that (a) most
agents don't face and (b) can't be meaningfully defended while amounts are public anyway.
So `immediate` gives the agent the privacy they actually need, fast; `jittered`+UTXO is the
upgrade for the narrow high-value case that genuinely faces a temporal analyst.

---

## 6. Error handling & failure modes

Dangerous failures are **fund-safety** (funds arrive but can't be spent) and
**privacy-leak** (a bug re-links what the rail should unlink).

- **Relayer down / crash mid-flight** → funds sit safely in the user's receiving EOA (B1 =
  user's own address; not lost). Engine resumes from its state file and re-picks-up the
  `PendingDeposit`. **Never** advance the D3 index until the deposit tx confirms — an index
  advanced without a confirmed commitment = an unspendable gap.
- **D3 index desync (top fund-loss risk)** → the derivation index is the source of truth
  for note recovery. Persisted atomically *after* on-chain confirmation. The user's scanner
  re-derives by scanning a window of indices, so small desyncs self-heal. Never deposit at
  an index the scanner can't reach.
- **Deposit reverts** (bad approval, gas, pool paused) → `PendingDeposit` stays queued,
  retried with backoff; funds remain in the receiving EOA. Reuse decoy scheduler's revert
  handling.
- **Amount too small to cover fees/gas** → hold and batch, or refund-in-place; never
  deposit dust that costs more than it's worth.
- **Privacy-leak guardrail** → if the decoy stream is empty/paused, the policy **must not**
  fire a lone real deposit (P1-theater — instantly correlatable). **Fail closed**: hold
  until the decoy stream is live.
- **Duplicate inbound / re-org** → `InboundWatcher` dedupes by tx hash (vault
  `depositIdentity` pattern) so a replay doesn't double-deposit.

---

## 7. Testing strategy

- **`NoteDelivery` (D3)** — pure-function unit tests: same seed+index → same commitment;
  relayer-derivable commitment is **not** spendable without the seed. Follows
  `notes.test.ts`.
- **`P2JitterBlend`** — fake-clock tests: Poisson distribution sane; **fails closed when
  decoy stream empty**; real deposits statistically indistinguishable from decoys (reuse
  `scripts/test-fifo-resistance.ts`).
- **`B1SessionKey`** — testnet: can `approve`+`deposit`; **provably cannot** call anything
  else (policy-scope test).
- **`ForwardingEngine`** — integration on Base Sepolia: ordinary inbound transfer →
  jittered deposit → user re-derives note → withdraws to fresh trading wallet. Extends
  `test:x402-agent`.
- **Correlation red-team** — plays the FIFO analyst (arXiv 2510.09433) against the combined
  stream; asserts it cannot link inbound-EOA → pool position above chance.

---

## 8. Scope boundaries (YAGNI)

**In scope (this sub-project):**
- The inbound forwarding engine (6 components), B1 + P2 + D3.
- Registry route + engine daemon + note-delivery lib + tests.

**Explicitly out of scope (later sub-projects):**
- **B2 smart-account authority** — additive behind the `DepositAuthority` seam; needs audit.
- **UTXO-P3 amount-hiding** — needs the trusted-setup ceremony, gated on C4+B3
  (`[[project_utxo_testnet_state]]`). Do NOT trigger the ceremony for this feature.
- **The agentic trading tool itself** — the next sub-project; this rail plugs under it.
- Multi-asset / multi-chain forwarding.

**Ceremony rule (do not violate):** this feature ships entirely on the existing
single-value pool. It introduces **no new audited contract** and **must not** cause the
UTXO ceremony to run early.

### 8.1 Trading add-on — one rail, two destination modes (verified 2026-07-09)

"Support both a private *payment* rail and a private *trading* rail" is **not two
products — it is this one rail pointed at two destinations.** Same engine, same pool, same
ASP compliance, same seams; the only difference is a `destination` seam:

- **Payment mode:** inbound → pool → `withdraw` to a **recipient/provider** wallet.
  (private compliant *receiving*)
- **Trading mode:** inbound → pool → `withdraw` to a **fresh trading wallet** →
  `execute()` (a **public DEX**, or **rented Arcium** confidential compute) → proceeds →
  pool → cold wallet. (private compliant *funding + settlement*)

**Three tiers, and what each costs (this is the "do we need new contracts?" answer):**

| Tier | What it adds | New contract / infra? |
|---|---|---|
| **1. Private-funded public trades** | rail → fresh wallet → public DEX (Jupiter/Uniswap) | ❌ **None** — pure composition of `withdraw` + any DEX |
| **2. Routing / MEV / agent SDK** | off-chain router, private relay, trading SDK | ❌ No contract; off-chain services only |
| **3. Execution privacy (hidden trade sizes)** | confidential DEX / encrypted matching | ✅ **New protocol OR a dependency on Arcium** — **rent, do NOT build** |

**Verdict:** adding trading needs **no new smart contract of ours.** Tier 1+2 is
composition + SDK. Tier 3 — the privacy agents actually *pay* for (execution privacy;
Aster's Hidden Orders live at >$28B/day) — is a crowded, from-scratch new-protocol lane
(Renegade / Arcium/Umbra / Xochi / Aster) we **rent via the `execute()` seam**, never
deploy ourselves. Our stack is a funding-privacy pool fork; it **cannot become a dark pool
by extension**, and building one is the exact anti-pattern in
`[[project_build_on_top_pivot]]` / `[[project_utxo_moat_verdict]]`. Full reasoning +
verified demand evidence: `[[project_trading_rail_verdict_2026-07]]`.

**Deploy-a-new-contract decision (applies to all of v2):**
- Rail core (B1) + both destination modes + Tier 1/2 trading → **no new contract, ever.**
- B2 trustless authority → new contract *only if* owned; opt-in, additive.
- Tier 3 execution privacy / UTXO-P3 amount-hiding → contract-heavy → **default is
  rent-not-deploy** (Arcium for execution; consider renting PrivacyCash's audited pool for
  amount-hiding per `[[project_build_on_top_pivot]]`). Deploy your own only if a named buyer
  forces ownership AND the C4/B3 prerequisites are cleared.

---

## 8.2 Direction & demand uncertainty (the honest section)

The founder's live question (2026-07-09): *"Am I in the right direction? Do agents / x402
providers even want privacy? I'm afraid customers go to Base Ledgers."* Recorded honestly
so the doc doesn't pretend more certainty than exists:

**On Base Ledgers — the fear is misplaced (verified).** Base Ledgers is KYC-gated,
institutional, demo-request-only, **zero agents / zero x402**. An AI agent or an indie x402
developer **cannot sign up for it.** Coinbase validated "private payments on Base" as a
market and then walked past the permissionless-agent customer to serve banks. Customers
*can't* defect to a door locked against them. Base Ledgers is a category-validator, not a
competitor for this lane. Strike the "first/only privacy on Base" pitch; do NOT strike the
strategy.

**On "do agents / providers want privacy?" — UNKNOWN, and that's the real risk.** Every
fact gathered in this design is a *competitor* fact. **Zero** are *customer* facts, because
there is no user yet. The tech direction is verified-sound (payee-side, x402-native,
compliant, permissionless = an empty defensible lane). The *validation* direction is not:
the product has been sharpened repeatedly without a single "yes, I'd pay for this" from a
real x402 provider or agent developer. **You cannot feature your way out of demand
uncertainty — only a user can resolve it.**

**Both-features-are-a-must — reframed.** Private x402 send AND private trade are both
**already built in manual form** (`/facilitator/settle` proven; executor on testnet). The
"must" the founder feels is the *auto/fast/polished* version of both. Perfecting two
features nobody has yet asked for is the infinite-sharpening trap. Discipline: **ship the
manual versions, put them in front of ONE real agent/provider, let their reaction decide
which feature to perfect.** "Both must be perfect before launch" = another six months
unlaunched.

**Direction verdict:** tech direction ✅ right; validation behavior ✅ needs to change from
*building* to *selling*. The single highest-leverage next action is not in this spec — it
is **one conversation with one x402 provider or agent developer.** This rail is worth
building *after* that conversation gives a signal, with the founder as first user.

---

## 9. Open questions for spec review

1. **State store for the engine** — reuse the decoy scheduler's JSON state file, or move to
   the Upstash backend the vault already uses? (Leaning: start with the file, match the
   sibling daemon.)
2. **Who runs the engine daemon** — same host as the decoy scheduler (systemd unit exists),
   or a Vercel cron? (Vercel Hobby is daily-cron-only per `[[learning_vercel_hobby_cron_daily]]`
   — a long-lived watcher wants the daemon host, not cron.)
3. **B1 key custody at rest** — where does the policy-scoped receiving-EOA key live, and how
   is it scoped/rotated? (This is the sharpest security question; may warrant a CSO pass.)
