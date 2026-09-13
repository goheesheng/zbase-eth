# UTXO Notes — design for Shipment A.1

**Status:** v0 design + scaffold (not production). Pre-ceremony. Reviewers wanted.
**Author:** zBase eng, 2026-05-29.
**Replaces:** nothing yet. UTXO ships *alongside* the existing single-value pool — same contracts stay deployed, withdraw circuit stays intact, the new circuit slots in via a new `UTXOPool.sol` and a new verifier.

This document is the gate before we sink 6 weeks into a fresh trusted setup + EVM/SVM verifier swap. If an auditor finds a soundness gap in here, we fix it on paper — not after the ceremony has already pinned the proving key.

---

## 1 · Why this change

The current live pool (0xbow's plain `PrivacyPoolComplex`, `withdraw.circom` — NOT
`PrivacyPoolMorpho.sol`, which is an on-disk, never-deployed yield variant) encodes
a deposit as a **single Poseidon-3 commitment over a single value**:

```
commitment = Poseidon3(value, label, Poseidon2(nullifier, secret))
```

When the depositor withdraws, the entire `value` is consumed in one shot. A partial-withdraw is supported (the existing circuit emits a "change commitment" with `remainingValue = existingValue − withdrawnValue`), but `existingValue` is *itself* a public signal of the next spend — so anyone watching can chain spends back to the originating deposit by matching residual amounts.

That is the **whale-correlation leak** called out in the roadmap (`docs/i-want-production-grade-enchanted-scone.md` §1):

> If 10 users deposit $10 and 1 deposits $10K, any settlement >$10 reveals the whale.

Frequency-by-amount also breaks the anonymity set whenever a deposit is uncommon (Kappos et al. 2018 found **31.5%** of Zcash shielded sends de-anonymizable by value pattern alone). Suggesting denominations in the UI helps but does not fix it; the protocol-level fix is to make value cryptographically hidden in the commitment.

The UTXO note is the standard answer. Railgun, Aztec, Zcash Sapling, and Tornado Nova all use it.

---

## 2 · Prior art we are copying

| System | Note encoding | Spend circuit | What we borrow |
|---|---|---|---|
| **Zcash Sapling** | `note = (d, pk_d, v, rcm)`, commitment = Pedersen | JoinSplit / Spend+Output (~groth16) | The split between *spend description* (nullifier, anchor) and *output description* (new commitment). |
| **Railgun** ([docs.railgun.org/wiki/learn/privacy-system](https://docs.railgun.org/wiki/learn/privacy-system)) | `note = (npk, token, value, random)` under viewing key, commitment = `Poseidon(npk, token, value)` | `Transaction` circuit, N-in × M-out, currently 1..13 in × 0..13 out | The Poseidon-only commitment (no Pedersen — we want one hash family to keep the on-chain verifier small) and the **viewing key** pattern (per-account keypair, recipient encrypts the note to recipient's `viewingPubKey`). |
| **Aztec (PXE / Noir)** | UTXO notes per token, app-specific note encodings under per-account incoming/outgoing viewing keys | Per-app `notes_circuit` joined into a transaction kernel | The clean separation of **note** (data) from **commitment** (hash) — we model `Note` as a pure-data struct and `Commitment` as a hash of it. Also: the "every note carries its own nullifier-secret" rule so you can sweep notes without a parent secret. |
| **Tornado Nova** | `note = (amount, blinding, pubkey)`, commitment = MiMC | 2-in × 2-out fixed | The fixed N=2, M=2 shape for v0 (proven safe, minimum-viable for "split or merge" operations). |
| **0xbow Privacy Pools (current zBase fork)** | `commitment = Poseidon3(value, label, Poseidon2(nullifier, secret))` | Single-spend with change | We keep `label` in the commitment (needed by ASP), keep `Poseidon3` arity, and keep the LeanIMT depth-32 state tree. |

**Why N=2, M=2 in v0.** Same shape Tornado Nova shipped with for two years on Ethereum mainnet without a single soundness incident. It is sufficient to express:

- *spend & forward* (1 real input note + 1 zero note → 1 paid output + 1 change note),
- *merge* (2 real input notes → 1 output note + 1 zero output),
- *split* (1 real input note + 1 zero → 2 real output notes).

N>2 and M>2 are mechanically straightforward (just more loops in the circuit) but blow up the constraint count quadratically in the Merkle path checks. We defer to a B-shipment if real usage demands it.

---

## 3 · Note encoding

A **note** is the off-chain object the user (or facilitator) holds. A **commitment** is the on-chain hash of it.

### 3.1 Plaintext note (off-chain only)

```ts
interface Note {
  amount: bigint;        // USDC atomic units (6dp). 0 = "dummy / zero note".
  label: bigint;         // ASP label of the originating deposit. Carries forward
                         // unchanged on every split/merge so the same ASP root
                         // attestation covers all descendant notes.
  nullifier: bigint;     // random field element; reveal via nullifierHash on spend.
  secret: bigint;        // random field element; binds the commitment.
}
```

Field element constraints: every value lives in the BN254 scalar field `r ≈ 2^254`. `amount` fits in a u64 (USDC supply will never exceed `2^64`). `nullifier` and `secret` are sampled uniformly from `[0, r)` via `crypto.getRandomValues`.

### 3.2 Commitment (on-chain leaf)

```
precommitment = Poseidon2([nullifier, secret])
commitment    = Poseidon3([amount, label, precommitment])
```

**This is identical to the current pool's commitment formula.** Deliberate: it means the same `crypto.rs` Poseidon helpers, the same LeanIMT frontier, the same `feToBE32` round-trip work without modification. The change is in *what kind of object* the commitment represents (a UTXO note vs. a deposit) and *which circuit* gets to consume it.

### 3.3 Nullifier hash

```
nullifierHash = Poseidon1([nullifier])
```

Same one-arity Poseidon as today. Each input note in a spend emits its own `nullifierHash` as a public signal. Replay protection is per-note: the contract stores `nullifierHash → spent` in a mapping and reverts on double-spend.

### 3.4 Why include `label` in the note (not just at deposit)

The 0xbow ASP design requires the spend to prove that the spent commitment's label is in a clean-set Merkle root. If `label` lived only at deposit and the UTXO spend used a fresh label per output, the ASP would need to re-attest every spend output — impossibly slow.

We propagate `label` unchanged through every split/merge. Consequence: **all change notes from a deposit inherit the deposit's ASP attestation forever**. This matches Railgun's `randomness` field (which is per-note) but differs from the `viewing key` field (which is per-recipient). It's the right tradeoff: ASP is at-deposit policy, not at-spend policy.

The label does leak that two notes share an origin if an observer somehow learns both labels. But labels are only ever revealed in zero knowledge inside the circuit — never on-chain. The state tree carries commitments, not labels.

---

## 4 · Viewing key

We need a way for the facilitator (and only the facilitator + the user) to find and decrypt notes from chain data. Railgun calls this a "viewing key"; Aztec calls it an "incoming viewing key". We adopt the **simpler Railgun model**: one keypair per user, used for both incoming and outgoing scans.

### 4.1 Keypair

```ts
viewingKeyPair = {
  privateKey: 32 bytes, randomly generated, stored client-side;
  publicKey:  x25519(privateKey).toPublicKey();  // 32 bytes
};
```

We use **X25519 + XChaCha20-Poly1305** (via `@noble/curves/ed25519` for the X25519 conversion and `@noble/ciphers/chacha`). Both libraries are already in `node_modules` (used by viem) — no new dependency surface. NaCl `crypto_box`-compatible.

**Why not libsodium.js?** It works but pulls in 200KB of WASM and a 100ms init cost on cold start. Our facilitator's hot-path budget is ≤6s end-to-end including a 2-4s proof; adding 100ms for libsodium init on first request is annoying. `@noble/*` is pure-JS, tree-shakes, and is already loaded.

### 4.2 Encrypting a note

For each output note, the *sender* (the spend-circuit caller — the user, or in agent flows the facilitator) does:

```
1. Generate ephemeral keypair (epk_priv, epk_pub).
2. shared = x25519(epk_priv, recipient.viewingPublicKey)
3. nonce = first 24 bytes of Poseidon2(commitment, blockNumber)
4. ciphertext = xchacha20poly1305(shared).encrypt(nonce, JSON.stringify(note))
5. Post on-chain as (commitment, epk_pub, ciphertext) in the spend event log.
```

Total per note: 32 bytes (epk) + ~100 bytes (ciphertext with 16-byte AEAD tag + JSON overhead) ≈ **132 bytes per note**. At Base Sepolia calldata pricing (16 gas/byte non-zero), that's ~2,100 gas per note encryption written to logs. Negligible vs. the ~250K gas for Groth16 verification.

### 4.3 Scanning

A recipient scans by iterating `NoteCommitted` events, attempting decryption with each `epk_pub` against their own viewing key. Most attempts fail (the AEAD tag rejects), so this is cheap. Railgun does this in the wallet today; we'll do it in the facilitator for agent-owned notes.

**Performance:** at 1M notes (year-2 target), naive scan is 1M × ~50µs/AEAD-trial = ~50s. We add a 2-byte **view-tag** (Railgun pattern: `firstTwoBytes(Poseidon(shared))`) prepended to each ciphertext; mismatches reject in <1µs. Effective scan rate drops to ~1M × 1µs = 1s. Same trick ERC-5564 uses.

### 4.4 What the viewing key does *not* see

The viewing key reads notes addressed to its owner. It cannot:

- Spend notes (that requires the **spending key**, which we conflate into `(nullifier, secret)` per-note — there is no separate spending key, similar to Tornado Nova).
- See *which* notes were merged into a given spend (the circuit hides the input commitments).
- See change-note amounts of other users.

The viewing key gives **read-only privacy to the holder** without exposing spend authority. Required for compliance disclosures: a user can hand a regulator the viewing key for a single label and prove "I deposited this amount, here are all the descendant notes" without giving the regulator the ability to move funds.

---

## 5 · Spend circuit — `note_spend.circom`

### 5.1 Public signals

| Signal | Source | Notes |
|---|---|---|
| `nullifierHash[0..N]` | output | Per-input nullifier hash, mapped to `spent` on-chain. |
| `outputCommitment[0..M]` | output | Per-output commitment, inserted into the state tree on-chain. |
| `withdrawnAmount` | public input | USDC paid out to the recipient (can be 0 for pure split/merge). |
| `stateRoot` | public input | Pool's current state Merkle root. |
| `stateTreeDepth` | public input | LeanIMT depth. |
| `aspRoot` | public input | ASP root the spend attests to. |
| `aspTreeDepth` | public input | ASP LeanIMT depth. |
| `context` | public input | `keccak256(withdrawal, scope) % r`, identical to the current circuit at `src/app/api/withdraw/route.ts:315-323`. Binds the recipient + relay fee into the proof. |

Public signal count: `2*N + 6` = `10` for N=M=2. Compare current withdraw circuit: `8`. Cost delta: ~2 extra `uint256` slots in the calldata of `relay()` — negligible.

### 5.2 Private signals

Per input note `i ∈ [0, N)`:
- `inAmount[i]`, `inLabel[i]`, `inNullifier[i]`, `inSecret[i]`,
- `inStateIndex[i]`, `inStateSiblings[i][32]`,
- `inAspIndex[i]`, `inAspSiblings[i][32]`,
- `inIsDummy[i]` (1 if this input is a zero-note placeholder, 0 otherwise).

Per output note `j ∈ [0, M)`:
- `outAmount[j]`, `outLabel[j]`, `outNullifier[j]`, `outSecret[j]`.

### 5.3 Constraints

```
For each input i:
  // 1. Commitment recomputation
  let pre_i  = Poseidon2(inNullifier[i], inSecret[i])
  let cm_i   = Poseidon3(inAmount[i], inLabel[i], pre_i)

  // 2. Nullifier hash
  let nh_i   = Poseidon1(inNullifier[i])
  assert nh_i == nullifierHash[i]

  // 3. State membership (skipped iff dummy)
  let stateMember = LeanIMTInclusionProof(
    leaf=cm_i, root=stateRoot, depth=stateTreeDepth,
    siblings=inStateSiblings[i], index=inStateIndex[i]
  )
  // dummy notes have amount==0 AND are NOT required to be in the tree
  enforce: (1 - inIsDummy[i]) * (1 - stateMember) == 0
  enforce: inIsDummy[i] * inAmount[i] == 0

  // 4. ASP membership of the label
  let aspMember = LeanIMTInclusionProof(
    leaf=inLabel[i], root=aspRoot, depth=aspTreeDepth,
    siblings=inAspSiblings[i], index=inAspIndex[i]
  )
  enforce: (1 - inIsDummy[i]) * (1 - aspMember) == 0

For each output j:
  // 5. Output commitment computation
  let pre_j  = Poseidon2(outNullifier[j], outSecret[j])
  let cm_j   = Poseidon3(outAmount[j], outLabel[j], pre_j)
  assert cm_j == outputCommitment[j]

  // 6. Output amounts are non-negative (range-check 64 bits)
  Num2Bits(64)(outAmount[j])

// 7. Conservation of value
sum(inAmount[i]) === sum(outAmount[j]) + withdrawnAmount

// 8. Label propagation: outputs inherit one of the input labels
// (Constraint: each outLabel[j] must equal at least one inLabel[i].)
// Encoded as: (outLabel[j] - inLabel[0]) * (outLabel[j] - inLabel[1]) == 0
//             for N=2. Generalizes to product over i for arbitrary N.
for each j:
  prod_over_i (outLabel[j] - inLabel[i]) == 0
```

### 5.4 Soundness notes for the auditor

1. **Dummy-note semantics.** `inIsDummy[i]=1 ∧ inAmount[i]=0` means "I am providing a placeholder input." Forcing `inAmount==0` prevents a malicious prover from claiming a dummy worth $10K. Forcing the state-membership check to be conditional on `inIsDummy` lets the prover skip the Merkle proof for dummies (otherwise they'd need to invent a fake commitment that happens to be in the tree).
2. **Label propagation.** Constraint 8 enforces that every output label matches some input label. Without it, a malicious prover could mint output notes with arbitrary labels — bypassing ASP entirely. With it, every output inherits *some* input's already-attested label.
3. **Range checks on outputs.** Constraint 6 prevents underflow in the conservation check. Without it, `outAmount[0] = -100` and `outAmount[1] = 200` would conserve `100` correctly but mint negative value. We range-check 64 bits because USDC's max supply is ≪ 2^64.
4. **Range check on `withdrawnAmount`.** Same reasoning — must be 64-bit, must equal exactly the amount transferred on-chain. Enforced both in-circuit and on-chain (the contract sees `withdrawnAmount` as a public signal and uses it as the `transfer()` argument).
5. **Recipient binding via `context`.** Identical to the existing circuit. The relayer can re-pack the calldata but cannot redirect the funds: `context = keccak256(withdrawal_struct, scope) % r` is a public input, and the `withdrawal_struct` contains the recipient address. Any swap of recipient changes `context`, which invalidates the proof.

### 5.5 Constraint count estimate

Per-note:
- `Poseidon3` (commitment): ~213 constraints (3-input, 8 partial + 57 full rounds, standard circomlib)
- `Poseidon2` (precommitment + 32 LeanIMT levels): ~152 × 33 = ~5,016 constraints
- `Poseidon1` (nullifier hash): ~140 constraints

So per input note: ~5,370 constraints. Per output note: ~360 constraints (commitment only).

N=2, M=2 total: `2 × 5,370 + 2 × 360 + conservation/range/label ≈ 11,700 constraints`.

The current `withdraw` circuit clocks in at ~10,200 constraints (1-in × 1-out). The new circuit is ~15% bigger; proof generation will scale roughly linearly. Current proof time: 2-4s wall. UTXO proof time projection: **2.5-5s wall**. Still fits the 6s end-to-end SLA.

Verifier on-chain cost: Groth16 is constant in circuit size. ~250K gas on EVM, ~148K CU on SVM. **No change.**

---

## 6 · Change-note pattern (how UI works)

UI-side, the user always has at least one note in their wallet. A "deposit" mints a new note. A "spend" produces 0-2 new notes (the change). A "withdraw to my own wallet" is just a spend with `withdrawnAmount = noteValue` and both outputs being dummies.

```
Deposit:
  user deposits $X → mint note N₁ = (amount=X, label=L, ...)

Pay $Y to provider (Y ≤ X):
  spend(inputs=[N₁, dummy], outputs=[N₂, dummy], withdrawn=Y, recipient=provider)
  where N₂ = (amount=X-Y, label=L, fresh nullifier/secret)
  user loses N₁, gains N₂

Pay $Y when no single note covers Y (need to merge first):
  spend(inputs=[N₁, N₂], outputs=[N₃, dummy], withdrawn=Y)
  where N₃ = (amount=N₁.amount+N₂.amount-Y, label=L, ...)
  user loses N₁, N₂; gains N₃

Split for parallel spends:
  spend(inputs=[N₁, dummy], outputs=[N₃, N₄], withdrawn=0)
  where N₃.amount + N₄.amount = N₁.amount, same label
  user loses N₁, gains N₃ and N₄
```

The **UI suggested denominations** (`$1 / $10 / $100 / $1K` from the roadmap) work at *deposit* time: when the user funds the wallet, they make N deposits at suggested amounts instead of one giant deposit. Then split/merge happens cheaply within the UTXO layer without any new deposit (no on-chain USDC transfer, just a spend proof). This is the key UX win.

---

## 7 · Contract surface — `UTXOPool.sol`

Minimal viable contract (scaffolded in `zbase-protocol/pkg/contracts/src/contracts/UTXOPool.sol`). API:

```solidity
function spend(
    uint256[2]   calldata nullifierHashes,
    uint256[2]   calldata outputCommitments,
    uint256      withdrawnAmount,
    uint256      stateRoot,
    uint256      stateTreeDepth,
    uint256      aspRoot,
    uint256      aspTreeDepth,
    uint256      context,
    Groth16Proof calldata proof,
    Withdrawal   calldata withdrawal,
    bytes[2]     calldata encryptedOutputNotes  // off-chain note ciphertexts
) external;
```

The contract:
1. Recomputes `context` from `withdrawal` + `scope`; reverts on mismatch.
2. Asserts `stateRoot` is a known root (rolling buffer of last N roots, same as 0xbow).
3. Asserts `aspRoot == latestAspRoot` (or in a recent window — TBD with B.2 threshold-postman work).
4. Asserts neither `nullifierHashes[i]` has been spent; marks both spent.
5. Calls the Groth16 verifier (`IVerifier(VERIFIER_KEY).verify(...)`).
6. Inserts both `outputCommitments` into the LeanIMT (emits `LeafInserted` twice).
7. Emits `NoteCommitted(commitment, ciphertext)` per output.
8. If `withdrawnAmount > 0`, transfers USDC from the pool to `withdrawal.recipient`.

**Reuses the Groth16 verifier interface.** The verifying key is swapped (different circuit → different vkey) but the contract surface is the same `function verify(uint[2] a, uint[2][2] b, uint[2] c, uint[10] pubSignals) returns (bool)`. Marked `// TODO: ceremony` in the scaffold where the vkey gets generated.

**Note on yield integration.** The active product is a plain USDC pool with no
Morpho/yield leg. UTXOPool should be treated as a separate future pool design;
do not assume the historical `PrivacyPoolMorpho.sol` path is part of the launch
architecture.

---

## 8 · How this diffs from the current circuit

| Aspect | Current `withdraw.circom` | New `note_spend.circom` |
|---|---|---|
| Inputs per spend | 1 commitment | N (=2 in v0) commitments |
| Outputs per spend | 1 change commitment (often zero) | M (=2 in v0) output commitments |
| Public `existingValue` signal | yes — leaks the source note value | **removed** — sums hidden inside circuit |
| `withdrawnAmount` public | yes | yes (still needed for on-chain transfer) |
| Recipient binding via `context` | yes (line 315-323 of `route.ts`) | yes — identical pattern |
| Per-spend public signals | 8 | 10 (= 2 nullifier + 2 commitment + 6 shared) |
| Constraint count | ~10,200 | ~11,700 (15% larger) |
| Trusted setup | 0xbow ceremony (Vitalik-witnessed, 2024) | **new ceremony required** (see `circuits/CEREMONY.md`) |
| On-chain verifier gas | ~250K | ~250K (no change) |
| ASP root use | exactly the same | exactly the same |
| Backwards compat | n/a | runs in parallel to existing pool |

---

## 9 · Migration & coexistence

The new pool deploys as a **separate contract** at a new address. The existing
plain 0xbow pool at `0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a` stays live
with its existing nullifier set. Why:

1. Migrating commitments across circuits would require re-proving each (impossible without the original secrets).
2. The deployed verifier vkey is permanent; we can't swap it.
3. Different circuits = different `SCOPE` = naturally separate anonymity sets, which is *fine*. Eventually UTXO pool grows the bigger set and old pool is sunset.

Frontend treats them as two pools. Users get a banner: "Old single-value pool — recommended to withdraw and re-deposit into UTXO pool for stronger amount privacy." A migration helper in the UI automates the round-trip.

---

## 10 · Open questions for auditors (the v0 → v1 list)

1. **Label propagation soundness.** Constraint 8 uses a `product == 0` form. Is there a simpler / cheaper encoding (e.g., merklized "allowed labels" check)? Or does `product == 0` open a polynomial-degree attack at high N?
2. **Dummy-note hiding.** `inIsDummy[i]` is a *private* signal. A malicious prover could mark a real input as dummy to skip the membership check, then claim its amount=0 → free spend? Counter: the conservation constraint requires `sum(out)+withdrawn == sum(in)`, so claiming amount=0 means you cannot output anything either. Confirm this is airtight.
3. **View-tag length.** Railgun uses 2 bytes (1/65536 false-positive rate). At 10K spends/day that's still 0.6 trial decryptions per scan. Acceptable, but maybe 3-4 bytes is better for the agent-facilitator scanning many users.
4. **Ceremony participants.** We propose coordinating with 0xbow + Kohaku + EF on shared MPC. Risk: their ceremonies are sized for different vkeys. Fallback: ZK-SaaS ceremony.org pattern with 6+ contributors of our own.
5. **Backwards-compat with existing ASP.** Today the ASP root is updated per deposit. In UTXO, the *deposit* is still the labeling event (split/merge inherits). Confirm the existing `/api/asp-update` cron is unchanged.
6. **N=2 / M=2 limit on bulk-pay.** If an agent wants to fan out one note to 10 providers, they need 5 sequential spends. Acceptable for v0? The B-shipment "recursive proof aggregation" line in the roadmap would fix this.
7. **Withdraw to user's own wallet at end of life.** "Burn the last note" requires a spend with `outputs = [dummy, dummy]` and `withdrawn = noteValue`. Confirm the circuit accepts this — looks fine to me but worth a test vector.
8. **Conservation in BN254 arithmetic.** Sums are computed mod `r ≈ 2^254`. With 64-bit amounts this can never overflow, but spelling it out for the audit report.

---

## 11 · Out of scope for this ship

Explicitly **not** in v0:

- N>2 or M>2 (Tornado Nova ran on N=M=2 successfully for 2 years; we follow).
- Multi-asset notes (every note is USDC in v0; per-token notes is a B-shipment after Solana mainnet).
- Stealth recipients (B.1).
- Threshold-postman ASP (B.2).
- Decoy spends / delay window (A.2 — separate shipment).
- Cross-chain note transfer (Series A roadmap).
- Recursive proof aggregation (Series A).
- The actual ceremony (see `circuits/CEREMONY.md` — needs ~2 weeks of coordination + 6+ contributors).
- The actual `note_spend` circuit *compilation*. The `.circom` source ships here so it can be reviewed before we commit to ceremony cost.

---

## 12 · References

- Vitalik Buterin, Ameen Soleimani, Matthew Di Ferrante, Chih-Cheng Liang. **"Blockchain Privacy and Regulatory Compliance: Towards a Practical Equilibrium"** (2023). The ASP paper our compliance layer is built on. <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4563364>
- **Railgun protocol overview** — note commitments, viewing keys, prover circuits. <https://docs.railgun.org/wiki/learn/privacy-system>
- **Aztec PXE & note encryption** — incoming viewing keys, per-app notes. <https://docs.aztec.network/protocol-specs/private-message-delivery/private-msg-delivery>
- **Zcash Sapling spec** — original Spend/Output description model. <https://zips.z.cash/protocol/protocol.pdf> §4.7
- **Tornado Nova whitepaper** — 2-in × 2-out shielded transactions on Ethereum. <https://github.com/tornadocash/tornado-nova>
- **George Kappos et al., "An Empirical Analysis of Anonymity in Zcash"** (USENIX 2018). The 31.5% value-pattern de-anon number. <https://www.usenix.org/system/files/conference/usenixsecurity18/sec18-kappos.pdf>
- **arXiv 2510.09433**, "FIFO Matching in Tornado Cash" (2025). 15-22pp re-linkage by timing alone — informs A.2, not A.1, but referenced in roadmap.
- **0xbow Privacy Pools — `withdraw.circom` reference circuit.** Our diff baseline. <https://github.com/0xbow-io/privacy-pools-core/blob/main/packages/circuits/circuits/withdraw.circom>
- **ERC-5564 stealth address standard.** View-tag pattern reused here. <https://eips.ethereum.org/EIPS/eip-5564>
- **EF Kohaku SDK** — `@kohaku-eth/railgun` v0.0.1-alpha.21. Reference implementation for the viewing-key + note-scanning UX we'd want to expose to wallets.
- **`@noble/ciphers` and `@noble/curves`** — pure-JS X25519 + XChaCha20-Poly1305 chosen over libsodium for cold-start performance. <https://github.com/paulmillr/noble-ciphers>
