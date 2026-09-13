# Circuit freeze attestation — A.1 UTXO note-spend (v1, Phase 1B corrected)

**Frozen on:** 2026-06-10
**Frozen by:** Eesheng Goh (zBase CEO)
**Purpose:** lock the source artifact under external audit (zksecurity / Veridise) and Phase 2 trusted-setup ceremony (per `docs/ceremony/ceremony-runbook-2026-05-31.md`). The output of the ceremony binds bit-for-bit to the artifact below — any edit invalidates the ceremony and forces a re-run.

## Supersedes

This attestation **supersedes** the v0 freeze:
- Prior freeze date: 2026-06-09
- Prior freeze commit: `444d1c6` (PR #31, `chore(circuits): freeze note_spend.circom for audit + zero-liquidity docs`)
- Prior frozen sha256: `50f897a987137942075078d1c8102c6c3f64be8563d1e2c1e9c10874f43f6b7c`
- Prior public signal count: **10**

The v0 freeze remains in git history as the "v0 attempt" record. **Do not use the v0 artifact for ceremony or audit** — its public-signal layout leaked transfer-vs-unshield activity per epoch and its commitment recipe made ASP labels recoverable through the transfer graph. Both breaks were surfaced by the 2026-06-09 adversarial cryptography pass against Railgun production patterns; this v1 freeze corrects them.

This is a **DIFFERENT CIRCUIT** than the v0 freeze, not a patch. **Full re-audit required** — do not rely on any partial review that was performed against `50f897a9…`. The constraint count, public-signal layout, commitment recipe, and witness shape have all changed.

## Frozen artifact

| Artifact | Path | sha256 |
|---|---|---|
| Circuit source | `circuits/note_spend.circom` (484 lines) | `1211d4971de6e1b157e78565275ed8f0d8e7f68304b8b1b69696014b4a352266` |

The `.r1cs` and `.sym` hashes will be added once `circom` is installed and the circuit is compiled. The freeze is on the source — any byte change to `note_spend.circom` between now and ceremony completion invalidates the ceremony output. Compilation is deterministic given a pinned `circom` version + `circomlib` (per `docs/ceremony/ceremony-runbook-2026-05-31.md` §1).

To regenerate the source sha256 yourself:
```
shasum -a 256 circuits/note_spend.circom
```

Expected output:
```
1211d4971de6e1b157e78565275ed8f0d8e7f68304b8b1b69696014b4a352266  circuits/note_spend.circom
```

## Circuit surface (public signals)

`NoteSpend(maxTreeDepth=32, N=2, M=2)` — N=2 inputs, M=2 outputs, 32-level LeanIMT.

Public signal count: **8** (`2*N + 4`, down from 10 in v0). Ordered as emitted by snarkjs (outputs first, then declared public inputs):
1. `nullifierHash[0]`
2. `nullifierHash[1]`
3. `outputCommitment[0]`
4. `outputCommitment[1]`
5. `stateRoot`
6. `stateTreeDepth`
7. `aspRoot`
8. `context`

See `circuits/note_spend.circom` `component main { public [...] }` at the bottom of the file.

### Removed from public (now PRIVATE witnesses)

- **`withdrawnAmount`** — was public signal 1 in v0. Surfacing it let observers distinguish transfer (= 0) from unshield (> 0) per epoch, leaking activity volume. v1 keeps it as a private witness whose value is bound to the contract-side `unshieldAmount` calldata field through `context = keccak256(withdrawalStruct || unshieldAmount || scope)`. The on-chain dispatch knows which op is happening from calldata; the proof's public signals do not betray it.
- **`aspTreeDepth`** — was public signal in v0. `aspRoot` alone is the authoritative commitment; the contract pins the depth associated with each root when posting the root on-chain, so the depth witness inside the proof is checked against that authoritative depth in dispatch code rather than exposed as a redundant public signal.

### Label handling change (commitment recipe)

The v0 commitment recipe `Poseidon3(amount, label, Poseidon2(nullifier, secret))` made the ASP label recoverable from on-chain composition: combined with the ASP-propagation constraint (`(out − in0)(out − in1) === 0`), an observer could trace label edges through the transfer DAG and recover sender→recipient linkage.

v1 swaps to the **Railgun NPK pattern** (see Railgun `Globals.sol` — NPK = note-public-key):
```
NPK        = Poseidon2(spendingPK, viewingPKBlind)
commitment = Poseidon3(amount, NPK, secret)
```
Label binds INTO the recipient's NPK derivation off-chain (Agent SDK owns `packages/core/src/viewingKeyHD.ts`), never appearing in the commitment hash directly. The ASP-membership Merkle proof for `label` still runs, but operates entirely over **private witnesses** — no public label signal exists, and `label` cannot be reconstructed from the on-chain commitment even with full amount + secret brute force.

The ASP-propagation rule (`(outLabel[j] − inLabel[0])(outLabel[j] − inLabel[1]) === 0`) is preserved in form, but now constrains private witnesses only — observers cannot build a label DAG from public data.

## What this freeze means

- **No commits modify `circuits/note_spend.circom` until ceremony output is published + audit report is delivered.** Any PR that touches this file is automatically blocked at review; refer reviewers to this attestation.
- The audit scope is **`note_spend.circom` + `zbase-protocol/pkg/contracts/src/contracts/UTXOPool.sol`** (the contract that verifies proofs from this circuit). Both must be co-audited; auditing one without the other leaves an integration gap. With the v1 changes the contract surface grows materially: `UTXOPool.sol` now owns the `unshieldAmount` calldata field, the `context` keccak preimage construction, and the per-root authoritative `aspTreeDepth` pin. The auditor must verify the calldata-to-circuit binding end to end.
- The ceremony output (proving key + verifying key + `Verifier_NoteSpend.sol`) will be published per `docs/ceremony/ceremony-runbook-2026-05-31.md` §5 once contributions complete. **The v0 ceremony (if any contributions had landed against `50f897a9…`) is INVALIDATED — restart from `powersOfTau_18.ptau` against this new artifact.**

## Audit-relevant invariants that changed since v0

An auditor familiar with the v0 freeze MUST re-verify each of these — they did NOT exist in the v0 artifact, or existed in a fundamentally different form:

1. **Context binding now covers `withdrawnAmount`.** v0 had context binding as a no-op witness anchor (`context * context`). v1 adds the parallel `withdrawnAmount * withdrawnAmount` anchor, and the contract-side keccak preimage must include `unshieldAmount` so that the proof's private `withdrawnAmount` is forced equal to the contract's calldata field. Auditor must trace this end-to-end from `UTXOPool.sol` calldata to circuit witness.
2. **Commitment recipe changed.** New recipe: `Poseidon3(amount, Poseidon2(spendingPK, viewingPKBlind), secret)`. Auditor must verify (a) NPK construction matches Railgun's `Globals.sol`, (b) the SDK's off-chain NPK derivation correctly binds the recipient's viewing key + ASP label, (c) no collision path exists between distinct (label, recipient) pairs producing the same NPK.
3. **ASP membership now over private label.** v0 audit may have assumed labels were publicly observable; v1 forbids this. Auditor must verify the LeanIMT inclusion proof for `inLabel[i]` remains sound when the leaf value is never disclosed (it is — soundness of Merkle inclusion does not require leaf publicity — but the integration must be checked for any place where the contract would have needed to know the label).
4. **Public signal count dropped 10 → 8.** Verifier contract Solidity output from the ceremony will have a different `Verifier.verifyProof()` signature (`uint[8]` not `uint[10]`). Auditor must verify the new `Verifier_NoteSpend.sol` is wired into `UTXOPool.sol` with the correct ordering — silent ordering bug here is a soundness break.
5. **Per-input NPK material added to witness.** N=2 inputs × 2 new private signals (spendingPK + viewingPKBlind) = 4 new private witnesses on the input side, 4 on the output side. Constraint count grows by 2 × (N + M) Poseidon2 invocations. Auditor must verify this fits within the ceremony's `_18.ptau` constraint budget (≤262K).

Invariants the v0 audit already verified that REMAIN unchanged:
- LeanIMT inclusion proof correctness (`LeanIMTInclusionProof` template untouched)
- Dummy-note handling (`inIsDummy * inAmount === 0`)
- Conservation law (`sumIn === sumOut + withdrawnAmount`) — same equation, but `withdrawnAmount` is now private
- 64-bit range check on outputs and `withdrawnAmount`

## Pre-ceremony to-do (before kickoff)

Per the ceremony runbook §0 pre-flight checklist, these must all be green:

- [x] Circuit source frozen with sha256 attestation (this file, v1)
- [ ] `snarkjs r1cs info note_spend.r1cs` confirms constraint count fits `_18.ptau` (≤262K) — requires `circom` install; v1 adds 2*(N+M) Poseidon2 instances vs v0
- [ ] External circuit reviewer (independent of zBase team) sign-off **on the v1 artifact** (any v0 review is invalidated)
- [ ] Solidity contract internal first-pass audit on `UTXOPool.sol` covering the new calldata `unshieldAmount` field + `context` preimage construction + per-root `aspTreeDepth` pin
- [ ] CEO double-confirm in writing that ceremony is mainnet-blocking
- [ ] Budget approved (audit + ceremony infra + honoraria) — note Phase 2B budget bumped to $40–65K to cover the expanded scope
- [ ] DNS pointed for ceremony coordinator host

## Unfreezing

The only valid path to modifying `note_spend.circom` after this attestation:
1. The external audit returns a finding that requires a circuit change
2. A new freeze attestation is filed superseding this one (different sha256)
3. The ceremony is re-run from scratch — no partial ceremonies

This is the cryptographic equivalent of "no shortcuts here ever." A trusted-setup ceremony is a one-shot artifact bound to a specific circuit bytecode. Half-fixing is worse than not fixing.

## Related documents

- `docs/ceremony/ceremony-runbook-2026-05-31.md` — full Phase 2 ceremony plan (PSE DefinitelySetup, 15 contributors target)
- `docs/ceremony/anchor-verification-2026-05-31.md` — anchor contributor list
- `docs/ceremony/ceremony-outreach-drafts.md` — staged DM templates for anchors
- `docs/ceremony/circuit-spec-for-contributors-2026-05-31.md` — what contributors will see during the ceremony (NEEDS UPDATE for v1)
- `docs/trusted-setup-ceremony-options-2026-05-31.md` — Option A/B/C strategic analysis (Option C selected)
- `docs/gitbook/utxo-notes.md` — design doc + integrator guidance (NEEDS UPDATE for v1 NPK recipe)
- `~/.claude/plans/encapsulated-snuggling-church.md` — Phase 1B corrected spec
