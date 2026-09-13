# C4 — UTXO unshield amount binding: design options for external audit

**Status:** OPEN — decision required before the `note_spend.circom` re-freeze + trusted-setup
ceremony. **Do not run the real ceremony until this is resolved** (it forces a circuit change =
re-freeze, per `CIRCUIT_FROZEN_FOR_AUDIT.md`).

**Author:** engineering (pre-audit prep, 2026-07-04). **Audience:** external circuit auditor
(zksecurity / Veridise) + zBase CEO (freeze authority).

**This doc does NOT modify the frozen circuit.** It specifies the problem and three candidate
fixes precisely so the binding can be chosen with review, not guessed. The contract-side plumbing
(an `unshieldAmount` field, ready-but-gated) is implemented separately and is inert until a sound
binding lands.

---

## 1. The bug (C4), stated exactly

Source: `docs/security/internal-audit-2026-06-11.md` §C4; sites: `note_spend.circom:310-317, 466`,
`UTXOPool.sol:435-464, 470-488`.

- v1 made `withdrawnAmount` a **private witness** (removed from public signals) to stop
  transfer-vs-unshield activity leaking per epoch (`CIRCUIT_FROZEN_FOR_AUDIT.md` §"Removed from
  public"). Good privacy goal.
- The circuit *claims* `withdrawnAmount` is bound to an on-chain `unshieldAmount` via
  `context = keccak256(withdrawalStruct ‖ unshieldAmount ‖ scope)`. **This binding does not exist:**
  - **Circuit:** the only lines referencing it are `contextSquared <== context*context` and
    `withdrawnAmountSquared <== withdrawnAmount*withdrawnAmount` — dead signals, unused, unconstrained;
    snarkjs deletes them. No constraint relates `withdrawnAmount` to `context`.
  - **Contract:** `context = keccak256(abi.encode(withdrawal, SCOPE))` where
    `withdrawal = {recipient, feeRecipient, relayFeeBPS}` — **there is no amount field in the preimage
    at all.** And even if there were, the contract cannot compare it to a *private* witness it never sees.
- **Conservation** (`note_spend.circom:466`, `sumIn === sumOut + withdrawnAmount`) constrains
  `withdrawnAmount` *internally* to the notes, but nothing ties that internal value to any on-chain
  payout amount.

**Consequence:** there is no sound source for a USDC payout. A prover could satisfy the proof with
one internal `withdrawnAmount` while the contract, if it paid a calldata amount, paid a *different*
one — an unconstrained payout (fund-loss). This is why `UTXOPool.spend()` currently **parks the
payout** (`emit Spent(…, 0, …)`; no `transfer`). The pool is transfer-only until this is fixed.

## 2. Why the two "obvious" fixes are each wrong

**Option A — re-expose `withdrawnAmount` as a public signal (suggested in the C4 finding + the
`UTXOPool.sol:457` TODO).** Sound (contract reads `pubSignals[k]`, transfers exactly that), but it
**re-introduces the exact v0 privacy leak** the v1 freeze existed to remove: a public amount lets an
observer read the unshield value and distinguish transfer (0) from unshield (>0) per epoch. This
regresses the headline property of the whole UTXO effort (amount-hiding). **Reject** unless
amount-hiding is explicitly abandoned.

**Option B — keep it private, "bind via context" as the current comments describe.** This is what
the freeze doc intends, but the C4 finding proves it is **unimplementable as written**: the contract
cannot check a private witness equals a calldata field, and the circuit has no constraint doing it.
As-is, it is a no-op. **Reject** (it is the current broken state).

## 3. Option C (recommended) — private amount, soundly bound by an in-circuit hash

Bind `withdrawnAmount` into `context` with a **real constraint the circuit enforces and the contract
independently recomputes from calldata** — so the amount stays private *and* the proof cannot lie
about it.

**Mechanism (Poseidon variant, cheap in-circuit):**
1. Add `unshieldAmount` to the on-chain `Withdrawal` struct (calldata), so it is part of the
   keccak preimage: `context = keccak256(abi.encode(withdrawal_with_unshieldAmount, SCOPE)) % r`.
   *(contract-side; implemented ready-but-gated — see §5.)*
2. In the circuit, take `unshieldAmount` as a **private input** and **constrain it equal to the
   internal `withdrawnAmount`**: `withdrawnAmount === unshieldAmount`. (One constraint. Replaces the
   two dead squares.)
3. Bind `unshieldAmount` into `context` *inside the circuit* so the proof is only valid for the
   exact `context` the contract computed. Two sub-approaches for the auditor to choose:
   - **C-keccak (faithful):** the circuit recomputes `keccak256(abi.encode(withdrawal, SCOPE)) % r`
     over the same preimage and constrains it `=== context`. Bit-exact to the contract, zero new
     trust surface — but keccak-in-circom is ~150k constraints/instance and may blow the `_18.ptau`
     ≤262K budget. Auditor must confirm the budget.
   - **C-poseidon (cheap, recommended):** split the binding. Keep the contract's outer
     `context = keccak256(abi.encode(withdrawal, SCOPE))` for recipient/fee integrity (unchanged),
     AND add a second, Poseidon-based public input `amountCommit = Poseidon2(unshieldAmount, scope)`
     that the contract also computes from calldata. The circuit constrains
     `amountCommit === Poseidon2(withdrawnAmount, scope)`. Poseidon is native/cheap in-circom
     (~250 constraints). This adds ONE public signal (`amountCommit`, 8→9) but that signal reveals
     nothing (it is a hiding-ish commitment; note `scope` is public and per-pool constant, so an
     observer with a guessed amount *could* grind it — see §4 leak analysis; mitigate by salting
     with a per-op nonce that is also in the keccak preimage).

**Net effect:** the contract reads `unshieldAmount` from its own calldata (sound — it is calldata,
not a private witness), the circuit *proves* its internal `withdrawnAmount` equals that same
calldata value (via the shared commitment), conservation ties it to the notes, and the amount never
appears as a plaintext public signal. Payout becomes: `IERC20(TOKEN).safeTransfer(recipient,
unshieldAmount_from_calldata)`.

## 4. Leak analysis the auditor must sign off

- **C-poseidon `amountCommit` grindability:** `amountCommit = Poseidon2(unshieldAmount, scope)` with
  public `scope` and a small amount domain (USDC values, bucketed) is **brute-forceable** — an
  observer tries candidate amounts. This would re-leak the amount. **Required mitigation:** include a
  per-operation random `amountNonce` (private witness) in the commitment:
  `amountCommit = Poseidon3(unshieldAmount, amountNonce, scope)`, and bind `amountNonce` into the
  keccak `context` preimage (so the contract commits to the same nonce it can't see the amount for).
  Auditor must verify the nonce has ≥128 bits of entropy and is single-use. Without this, C-poseidon
  is no better than Option A.
- **C-keccak** has no grindability issue (keccak preimage includes the full withdrawal struct) but
  the constraint-budget risk is real.
- **Transfer vs unshield distinguishability:** in all options the *contract entrypoint* differs
  (`spend` vs `transfer`), which is itself observable on-chain regardless of the circuit. The circuit
  privacy goal only concerns not leaking the *amount*; the op-type is already visible via which
  function was called. The auditor should confirm this is acceptable (it matches Railgun, where
  unshield vs transfer is a different call).

## 5. What is implemented now (contract-side, ready-but-gated)

To keep the circuit frozen while making the payout path *ready*, the contract plumbing for
`unshieldAmount` is added but **inert**:
- `Withdrawal` gains an `unshieldAmount` field (so it enters the `context` preimage). For all
  existing (transfer-only) flows `unshieldAmount == 0`, so `context` is unchanged for them.
- `spend()` keeps the payout **parked behind an explicit `C4_BINDING_SOUND` guard** (a constant that
  stays `false` until a sound binding per §3 ships + is audited). While `false`, `spend()` behaves
  exactly as today (transfer-only, pays 0). This lets the calldata shape, event, and recipient
  decode be reviewed now without enabling an unsound payout.

**No circuit file is modified. No re-freeze is triggered by this doc or the contract plumbing.** The
re-freeze happens only when the chosen Option-C constraint is written into `note_spend.circom` — a
separate, audited step.

## 6. Decision requested

1. **Auditor:** confirm Option C (which sub-variant) is sound; specify the exact in-circuit
   constraint + the contract-side preimage bytes; confirm constraint budget vs `_18.ptau`.
2. **CEO / freeze authority:** approve the resulting circuit edit + new freeze attestation
   (superseding `1211d497…`), then schedule the real ceremony against the new artifact.

Until 1 + 2, `spend()` stays transfer-only (pays 0 USDC) and mainnet UTXO stays blocked. This is the
correct safe state — a parked payout is not a vulnerability; an unsound one is.

## Appendix — B3-residual (also circuit-gated; grouped here for the same re-freeze)

Investigated 2026-07-04. **The off-chain half of B3 is already fixed** (`packages/core/src/merkle.ts`
now feeds the circuit the compacted `proof.index` + `actualDepth` + `pathIndices` faithfully, per
its own header). **The residual is a circuit-design limit and needs a circuit change** — flagged, NOT
patched.

**The limit:** `LeanIMTInclusionProof(levels)` (`note_spend.circom:177-228`) takes a SINGLE shared
`actualDepth` and uses an `active[lvl] = (lvl < actualDepth)` selector — correct for ONE leaf. But
`NoteSpend` has N=2 inputs, and in a real (non-perfect) LeanIMT two leaves can sit at **different
compacted depths**. A single shared `actualDepth` cannot represent both. The witness fixture
(`scripts/build-note-spend-witness.ts:167-200`) sidesteps this by using a **perfect 4-leaf tree**
where `proof.index == leafIndex` and all inputs share one depth — so `wtns calculate` "passes by
luck" and masks the limit (exactly the audit's warning).

**Fix (circuit change → re-freeze, auditor-scoped):** give the inclusion check a **per-input
`actualDepth[N]`** (and per-input `index[N]`), or a promotion-aware inclusion check that tolerates
mixed depths. The witness builder already returns per-proof `actualDepth`, so the SDK side is ready;
only the circuit's shared-depth assumption blocks it. Auditor must also confirm the ASP-membership
proof has the same per-input treatment.

**Bundle with C4:** since both C4 (amount binding) and B3-residual (per-input depth) require editing
`note_spend.circom` + a new freeze attestation, they should be resolved in ONE circuit revision and
ONE ceremony — not two. This doc requests the auditor address both in the same pass.

## References
- `docs/security/internal-audit-2026-06-11.md` §C4 (the finding)
- `CIRCUIT_FROZEN_FOR_AUDIT.md` (freeze attestation, v1, sha256 `1211d497…`)
- `circuits/note_spend.circom:284-322, 440-466, 479-484` (private amount, dead binding, conservation)
- `zbase-protocol/pkg/contracts/src/contracts/UTXOPool.sol:435-464, 470-488` (parked payout, context recompute)
- Railgun `Globals.sol` (NPK + commitment recipe the v1 circuit follows)
