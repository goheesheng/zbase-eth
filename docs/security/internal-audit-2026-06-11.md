# zBase Internal Security Audit — 2026-06-11

**Method:** 3 parallel review agents (contracts / circuits+SDK / API), then a
human verification pass over every finding. Agents are reliable at *surfacing*
candidates but **unreliable at verdicts on ZK/crypto** — several agent "CRITICAL"
circuit findings were misreads and are marked FALSE POSITIVE below.

**Scope note:** `circuits/note_spend.circom` is frozen for the external audit and is
NOT edited here. Circuit-level findings are documented for the external auditor
(zksecurity / Veridise). **This internal sweep does not replace the external circuit
audit, which remains required before any mainnet / real-money launch.**

Status legend: ✅ FIXED · 📝 DOCUMENTED (no code change) · 🔬 VERIFY-ONLY (auditor) ·
❌ FALSE POSITIVE.

---

## Phase 0 — Circuit + recipe verification (read-only)

### C1 — Dummy-note membership path 🔬 VERIFY-ONLY (auditor)
`note_spend.circom:358-378`. For `inIsDummy[i]=1`, the comment states "any siblings
path will do as long as it terminates in the supplied root," and the
`LeanIMTInclusionProof` is still instantiated for dummies (not short-circuited). The
real-note constraint relies on rule 4 (`inIsDummy*inAmount===0`) to make a
free-spend "worthless," but whether a dummy can smuggle a *fake membership* that
later affects conservation/label propagation needs a ZK professional to confirm.
**Frozen — do not patch. Flagged for the external auditor.**

### C2 — Output/input NPK "under-constrained" ❌ FALSE POSITIVE
Agent claimed the NPK isn't bound to the commitment. **Incorrect.** The circuit wires
the computed NPK into the hasher with constraints (`<==`), not assignments:
`inHasher[i].npk <== inNpk[i].npk` (`:345`), and the resulting commitment is forced to
be the Merkle leaf: `inStateProof[i].leaf <== inHasher[i].commitment` (`:372`). A
prover cannot substitute a different key pair. Same on the output side (`:404-414`).
No action; recorded so the auditor isn't sent on a false trail.

### C3 — SDK↔circuit commitment recipe mismatch ⚙️ PARTIALLY FIXED (recipe aligned; key-derivation still auditor-scoped)

**Update (PR follow-up, branch `fix/c3-utxo-commitment-recipe`):** the commitment
HASH STRUCTURE is now aligned to the circuit. `Note` gained `spendingPK` +
`viewingPKBlind`; `commitmentOf` is now
`Poseidon3(amount, Poseidon2(spendingPK, viewingPKBlind), secret)` — byte-for-byte
the circuit's `CommitmentHasher`/`NpkBuilder`. `label` is no longer in the
commitment (kept on the note for ASP membership). split/merge propagate NPK;
serialize round-trips it; a recipe-pinning test asserts the match and guards
against v0 regression. **Still auditor-scoped (NOT done):** how `spendingPK` /
`viewingPKBlind` are DERIVED from a recipient's viewing key, and how the ASP label
folds into that derivation — the NPK inputs are caller-supplied placeholders today.
That derivation is the soundness-sensitive part and is intentionally left for the
external circuit audit + post-ceremony integration. So the SDK is now structurally
consistent with the circuit, but the UTXO pool still cannot go live until the
key-derivation lands + ceremony + audit.

---

### C3 (original analysis) — SDK↔circuit commitment recipe mismatch ✅ CONFIRMED REAL (UTXO pool blocker)
**Real, and important — but NOT live-exploitable today.**
- Circuit v1 (`:106-128`, `:145-154`): `commitment = Poseidon3(amount, npk, secret)`,
  `npk = Poseidon2(spendingPK, viewingPKBlind)`.
- SDK `notes.ts:139-141` (still v0): `commitment = Poseidon3(amount, label,
  Poseidon2(nullifier, secret))`. The `notes.ts` header (`:12-13`) still documents the
  v0 recipe.

These are different recipes → **any proof the SDK builds for the UTXO pool would fail
verification.** Why it is not a live risk: the UTXO pool is not deployed/runnable
(needs the trusted-setup ceremony first), and the **live single-value pool uses the v0
recipe correctly via `account.ts` `computeCommitment`** — which is the right recipe
for *that* pool. So this is a "won't-work-until-fixed" correctness bug confined to the
not-yet-live UTXO path, not an exploit on anything running.

**Disposition:** documented as a **pre-mainnet blocker for the UTXO pool**, scoped
below. NOT half-fixed now, because the correct fix requires extending the `Note` model
with NPK key material (`spendingPK`, `viewingPKBlind` — absent from the current `Note`
interface, `notes.ts:42-51`) and threading it through the scanner + transfer-encrypt +
proof-input paths. Doing that blind risks a subtly-wrong NPK derivation (the same
soundness-adjacent risk we avoid on the circuit). It belongs with the post-ceremony
circuit-integration work, alongside the external audit.

**Required fix (scoped, for the UTXO-integration milestone):**
1. Extend `Note` (or a `UtxoNote`) with `spendingPK`, `viewingPKBlind`.
2. `commitmentOf` → `Poseidon3(amount, Poseidon2(spendingPK, viewingPKBlind), secret)`.
3. Update `notes.ts` header recipe doc, the scanner decode, and the proof-input builder
   to carry NPK material. Cross-check byte-for-byte against the circuit + the on-chain
   verifier's expected public-signal order.

---

### C4 — `withdrawnAmount`↔`context` binding is a NO-OP (unconstrained payout) 🔬 VERIFY-ONLY (auditor) — found 2026-06-13

**Found while doing the v1 signal-index fix in `UTXOPool.sol`. This is a real soundness
gap in the FROZEN circuit and must NOT be patched in the circuit (re-breaks the freeze +
invalidates the ceremony). Flagged for the external auditor; tracked here.**

v1 moved `withdrawnAmount` from a public signal to a private witness. The circuit header
(`note_spend.circom:34-38`) and the inline comment (`:298-319`) claim it is bound to the
on-chain `unshieldAmount` via `context = keccak256(withdrawalStruct ‖ unshieldAmount ‖ scope)`.
**But the binding is not implemented in either layer:**

- **Circuit (`:310-317`):** the "binding" is two dead signals —
  `contextSquared <== context * context` and
  `withdrawnAmountSquared <== withdrawnAmount * withdrawnAmount`. Neither result is
  used or constrained against anything. snarkjs optimizes them away. There is NO
  constraint tying `withdrawnAmount` to `context`. The prover may set `withdrawnAmount`
  to any value that satisfies conservation (`sum(in)==sum(out)+withdrawnAmount`).
- **Contract:** cannot enforce the equality the comment promises, because
  `withdrawnAmount` is a PRIVATE witness the contract never receives. The contract only
  sees `context` (a hash) and the calldata `unshieldAmount`; it cannot check the private
  witness equals the calldata value.

**Impact:** the circuit's internal `withdrawnAmount` is decoupled from the contract's
actual payout. A malicious prover could balance the circuit with one `withdrawnAmount`
while the contract pays out a different calldata amount — conservation-of-value inside the
proof says nothing about what leaves the pool on-chain. Combined with the fact that
`unshieldAmount` is not even in today's `withdrawal.data` shape (it is
`{recipient, feeRecipient, relayFeeBPS}` — no amount field), the v1 unshield path is not
soundly wired end-to-end.

**Required fix (auditor + post-freeze, NOT in this session):** the circuit must actually
constrain the link — e.g. expose `withdrawnAmount` as a public signal again (simplest), OR
have the circuit recompute/commit the same value the contract hashes into `context` and
add a real `=== ` constraint (not a dead square). Then thread `unshieldAmount` into
`withdrawal.data` and `context` across circuit ↔ contract ↔ `/api/withdraw` route so all
three hash the identical preimage. Until then the UTXO unshield path cannot go to mainnet.

**Status: BLOCKS the v1 signal-index/contract work** — the contract cannot be made
correctly v1-faithful while the circuit's binding is a no-op, because there is no honest
amount source for the contract to pay out. The signal-INDEX remap (stateRoot/aspRoot/
context positions, `[8]` array size) is still valid and stands; the `withdrawnAmount`
PAYOUT mechanism is parked pending this circuit decision.

---

## Phase 1-3 — Code fixes

_(populated as each fix lands — see the per-finding sections below.)_

| # | Sev | Status | Summary |
|---|---|---|---|
| F1 | CRIT | ✅ FIXED | OFAC screening fail-open → fail-closed. `createScreeningProvider` now throws `ScreeningUnavailableError` if the combined set is empty; `screenDeposits`/ASP route propagate it → 500, no root published, no approvals. Test added (empty set ⇒ throws). |
| F2 | CRIT | ✅ FIXED | Vault auth signature now time-boxed: `vaultAuthMessage(address, issuedAt)` + `isVaultAuthTimestampFresh` (10-min TTL, 1-min skew). Client sends `X-Vault-Auth-Timestamp`; server rejects stale/future/missing. Key message stays deterministic. Tests: stale bearer ⇒ 401, missing-timestamp ⇒ 401. |
| F3 | CRIT | ✅ FIXED | UTXOPool `spend()` + `transfer()` now `verifyProof` BEFORE `_consumeNullifiers`, so an invalid proof can't burn a valid nullifier. Foundry test `test_InvalidProofDoesNotConsumeNullifier`: bad proof reverts + nullifier stays unspent + same nullifier spends after. 13/13 suite green. |
| F4 | HIGH | ✅ FIXED | `/api/asp-update` POST: optional `ASP_UPDATE_SECRET`/`CRON_SECRET` bearer gate + 10/min rate limit. Existing no-op-if-root-unchanged guard already prevents redundant on-chain txs. |
| F5 | HIGH | ✅ FIXED | Demo IP limiter now trusts `x-real-ip` first, falls back to the LAST x-forwarded-for hop (not the client-spoofable first), and normalizes IPv6 aliases → one bucket. (Daily global cap already bounded total drain.) |
| F6 | HIGH | ✅ FIXED | `/authorize` now requires `ownershipSignature` from the access-token payer (Transfer.from), binding (txHash, nullifierHash). Enforced on mainnet (eip155:8453) or when `ZBASE_REQUIRE_AUTHORIZE_OWNERSHIP=true`; optional on Sepolia for back-compat. |
| F7 | HIGH | ✅ FIXED | `randomFieldElement` → rejection sampling (unbiased), single shared impl in `account.ts`, `notes.ts` imports it. CSPRNG only. |
| F8 | HIGH | ✅ FIXED | `deriveStealthAddress` (sender side) now detects the degenerate/unspendable (k≡0) case BEFORE returning anything to announce — redraws on random nonce, throws on supplied nonce. 100-payment stealth invariants still pass. |
| F9 | MED | ✅ FIXED | UTXOPool constructor now `require(_verifier.code.length > 0)` — blocks deploying with address(0)/EOA. Mock verifier (has code) still works for tests; mainnet checklist must confirm it's the ceremony verifier. |
| F10 | MED | ✅ FIXED | X25519 viewing-key derivation now domain-separated (`zBase/viewing-key/x25519/v1` prefix before SHA-512). Tag must freeze before any mainnet viewing key is derived. |
| F11 | MED | ✅ FIXED | `planSpend` validates payAmount + every note amount within `[0, 2^64)` (`MAX_NOTE_AMOUNT`), matching the circuit's 64-bit range check. |
| F12 | MED | ✅ FIXED | `generateMerkleProof` rejects proofs deeper than TREE_DEPTH and zero-pads siblings to exactly TREE_DEPTH (circuit-shape correctness). |
| F13 | MED | ✅ FIXED | PrivacyPoolMorpho `_push` decrements principal by the share-proportional slice (`principal*sharesToRedeem/totalShares`), not the requested value, so remaining principal stays backed across partial withdrawals. Suite green. |
| F14 | LOW | ✅ FIXED | ThresholdEntrypoint `_bubble` only string-decodes genuine `Error(string)` payloads (selector + length checks); custom-error/Panic reverts return a generic message instead of panicking inside the error path. |
| F15 | LOW | ✅ FIXED | withdraw route logs the full stack only outside production; prod keeps a one-line message (response already generic). |

---

## Verification run (all green)

- `forge build` OK. Suites: **UTXOPool 13/13** (incl. new F3 regression test),
  **PrivacyPoolMorphoYield 5/5**, **ThresholdEntrypoint 20/20**, **StealthPay 18/18**.
- `npx tsc --noEmit` clean (app + packages + scripts).
- core unit tests pass: account, notes (planSpend/consolidate), noteScanner, viewingKeyHD.
- `scripts/test-ofac-screening.ts` — **7/7** incl. F1 fail-closed (empty set ⇒ refuses).
- `scripts/test-vault-route.ts` — all invariants incl. F2 stale-bearer ⇒ 401, missing-timestamp ⇒ 401.
- Live F4 check: secret set ⇒ no-auth/wrong-secret POST ⇒ 401, right secret ⇒ 200.
- `npm run build` (production) succeeds; all routes registered.
- `npm run test:e2e` (Sepolia deposit → ASP update → ZK proof → withdraw) **passes** —
  clean depositor still flows through the changed screening/RNG/auth paths.
- Pre-existing deploy-SCRIPT test failures (duplicate-signer / fee-recipient) are
  env-driven and unrelated — no deploy scripts were touched.

15/15 confirmed findings fixed (F1–F15). C2 = false positive; C1 = auditor; C3 =
confirmed-real but deferred (UTXO pool not live; fix belongs with post-ceremony
integration). Branch: `fix/internal-security-audit` (not merged to main).

## Standing conclusion

The internal sweep found existential-class issues across compliance (fail-open
screening), custody-adjacent auth (replayable vault bearer), and a confirmed
SDK↔circuit recipe mismatch on the UTXO path — plus an unresolved circuit dummy-note
question only a ZK professional should sign off. **This is direct evidence that the
external circuit audit + trusted-setup ceremony remain mandatory before real money.**
Internal fixes reduce risk; they do not substitute for the professional sign-off.
