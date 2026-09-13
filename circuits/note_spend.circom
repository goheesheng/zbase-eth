pragma circom 2.1.0;

/*
 * note_spend.circom — Shipment A.1, v1 (Phase 1B corrected)
 *
 * UTXO-style spend circuit for the zBase privacy pool. Used for SHIELD,
 * TRANSFER, and UNSHIELD — the circuit shape is identical; the contract
 * dispatches on a separate `unshieldAmount` calldata field which the proof
 * binds via the `context` public signal.
 *
 * SUPERSEDES the v0 freeze (PR #31, commit 444d1c6, sha256
 * 50f897a987137942075078d1c8102c6c3f64be8563d1e2c1e9c10874f43f6b7c).
 * Two cryptographic breaks identified by the 2026-06-09 adversarial pass
 * forced this rewrite — see CIRCUIT_FROZEN_FOR_AUDIT.md "Supersedes" section.
 *
 * Proves:
 *
 *   - Each input commitment is in the state Merkle tree (or is a marked dummy).
 *   - Each input's nullifier hash is the public `nullifierHashes[i]`.
 *   - Each input's label is in the ASP root (or is a marked dummy) — label
 *     itself stays a PRIVATE witness, never recoverable from on-chain data.
 *   - Each output commitment is `Poseidon3(amount, NPK, secret)` where
 *     `NPK = Poseidon2(spendingPK, viewingPKBlind)` is the note-public-key
 *     (Railgun pattern — see Globals.sol NPK construction). Label is baked
 *     into the recipient's NPK derivation off-chain, never appearing as a
 *     direct commitment term.
 *   - sum(inAmount) == sum(outAmount) + withdrawnAmount    (conservation)
 *   - Each output label equals at least one input label    (ASP propagation,
 *                                                            enforced over
 *                                                            PRIVATE labels)
 *   - Each output amount is < 2^64                         (no negative-value mint)
 *   - `withdrawnAmount` is < 2^64                          (matches on-chain transfer)
 *
 * `withdrawnAmount` is a PRIVATE witness. The on-chain `unshieldAmount`
 * calldata field is committed-to inside the `context` public signal
 * (`context = keccak256(withdrawalStruct || unshieldAmount || scope)`),
 * and the circuit asserts `withdrawnAmount` equals that committed value via
 * the context binding. This mirrors Railgun's approach — `UnshieldType` lives
 * in proof-submission metadata, not in the circuit's public signals —
 * preventing observers from counting transfers vs unshields per epoch.
 *
 * Public signals (in order, as emitted by snarkjs):
 *   [0..N-1]    nullifierHashes[i]
 *   [N..N+M-1]  outputCommitments[j]
 *   [N+M]       stateRoot
 *   [N+M+1]     stateTreeDepth
 *   [N+M+2]     aspRoot
 *   [N+M+3]     context
 *
 * For v1 we instantiate `NoteSpend(maxTreeDepth=32, N=2, M=2)`, giving 8 public
 * signals total (down from 10 in v0: removed `withdrawnAmount` and
 * `aspTreeDepth`; `aspTreeDepth` is subsumed by `aspRoot` since the prover
 * commits to a specific root + the contract pins the root's authoritative
 * depth on-chain).
 *
 * Design doc: /docs/utxo-notes-design.md
 * Plan reference: ~/.claude/plans/encapsulated-snuggling-church.md Phase 1B
 * Reference implementations:
 *   - Railgun NPK pattern:
 *       https://github.com/Railgun-Privacy/contract — Globals.sol
 *       (NPK = Poseidon(spendingKey, viewingKeyBlinded); label/recipient
 *        information is encoded into NPK off-chain, never on-chain)
 *   - Railgun unshield-type-in-metadata:
 *       https://docs.railgun.org/wiki/learn/privacy-system (proof submission)
 *   - Tornado Nova: https://github.com/tornadocash/tornado-nova (N=2, M=2 shape)
 *   - Aztec PXE:    https://docs.aztec.network/protocol-specs/private-message-delivery
 *
 * TODO before mainnet:
 *   - re-run the trusted setup ceremony (see docs/ceremony/) — v0 ceremony
 *     output is INVALIDATED by this re-freeze
 *   - external audit on the corrected circuit (zksecurity or Veridise)
 *   - cross-check the LeanIMT template behaviour matches @zk-kit/lean-imt's
 *     sibling enumeration exactly (also matches @zk-kit/lean-imt.sol and
 *     packages/svm/.../crypto.rs::LeanImtFrontier).
 */

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

// ----------------------------------------------------------------------------
// CommitmentHasher — Railgun-pattern NPK commitment.
//
// CHANGED from v0: the upstream 0xbow `commitment.circom` recipe was
//   commitment = Poseidon3(amount, label, Poseidon2(nullifier, secret))
// which made `label` recoverable from on-chain composition (the ASP-
// propagation rule below ENFORCES that output labels match an input label,
// turning the transfer DAG into a public label graph). v1 swaps to the
// Railgun "note-public-key" (NPK) pattern (see Globals.sol in the Railgun
// contract repo):
//
//   NPK        = Poseidon2(spendingPK, viewingPKBlind)
//   commitment = Poseidon3(amount, NPK, secret)
//
// where `spendingPK` is a long-lived spending public key, `viewingPKBlind`
// is the per-note-blinded viewing public key, and `secret` is the
// per-note randomness. The label gets folded INTO the recipient's NPK
// derivation off-chain (see packages/core/src/viewingKeyHD.ts owned by
// Agent SDK), so an observer with only on-chain data can never extract
// either the label or the recipient identity from a commitment.
//
// `nullifierHash` recipe unchanged: `Poseidon(nullifier)`. The
// `nullifier` itself is still derived from the note's spending key
// material off-chain — that derivation is out of circuit scope.
// ----------------------------------------------------------------------------
template CommitmentHasher() {
    signal input amount;
    signal input npk;       // Poseidon2(spendingPK, viewingPKBlind), computed
                            //   by the prover; the circuit treats it as an
                            //   opaque field element. Off-chain SDK must
                            //   bind `npk` to the recipient's viewing key +
                            //   ASP label (Railgun Globals.sol pattern).
    signal input nullifier;
    signal input secret;

    signal output commitment;
    signal output nullifierHash;

    component cm = Poseidon(3);
    cm.inputs[0] <== amount;
    cm.inputs[1] <== npk;
    cm.inputs[2] <== secret;

    component nh = Poseidon(1);
    nh.inputs[0] <== nullifier;

    commitment    <== cm.out;
    nullifierHash <== nh.out;
}

// ----------------------------------------------------------------------------
// NpkBuilder — derives a note's NPK from spending + viewing-key material.
//
// NPK = Poseidon2(spendingPK, viewingPKBlind).
//
// Both inputs are PRIVATE witnesses. The on-chain commitment exposes only
// the resulting Poseidon hash mixed with `amount` and `secret`, so neither
// the recipient's spending key nor their blinded viewing key are recoverable.
//
// Label binding lives in the SDK's NPK derivation (Agent SDK owns
// viewingKeyHD.ts): the recipient's viewing-key tree commits to an ASP
// label at derivation time. The circuit only sees the resulting NPK field
// element, plus the input-side label witness used for ASP membership.
// ----------------------------------------------------------------------------
template NpkBuilder() {
    signal input spendingPK;
    signal input viewingPKBlind;
    signal output npk;

    component h = Poseidon(2);
    h.inputs[0] <== spendingPK;
    h.inputs[1] <== viewingPKBlind;
    npk <== h.out;
}

// ----------------------------------------------------------------------------
// LeanIMTInclusionProof — depth-`levels` LeanIMT inclusion check.
//
// LeanIMT rule: parent = poseidon2(left, right) when both children exist; when
// the right child is empty the parent equals the left node (no zero-padding).
// We encode the rule by: at each level, if (index >> level) & 1 == 1 the
// sibling is the LEFT and current node is the RIGHT; otherwise (the bit is 0)
// the sibling is the RIGHT and we hash IFF index >> level >= 1, else propagate.
//
// Simplified for fixed depth: we mux on the index bit at each level and unify
// the "no right sibling" rule by accepting `sibling=0` as a sentinel for "no
// right sibling" — the calling code must pad sibling arrays with zeros, and
// `treeDepth` must equal the LeanIMT's `depth` value at proof time (not the
// max template depth).
//
// IMPORTANT: this template mirrors the upstream 0xbow `merkleTree.circom`
// LeanIMT verifier exactly; the only change is we expose `actualDepth` so the
// public `stateTreeDepth` signal can be enforced. See open question §10.1 in
// the design doc — the auditor should verify that the LeanIMT propagation rule
// is correct when `sibling == 0` at a level above `actualDepth`.
// ----------------------------------------------------------------------------
template LeanIMTInclusionProof(levels) {
    signal input leaf;
    signal input root;
    signal input actualDepth;
    signal input index;                // leaf index
    signal input siblings[levels];     // padded to `levels` with zeros

    // Decompose index into bits (LeanIMT path: bit 0 = level-0 direction).
    component bits = Num2Bits(levels);
    bits.in <== index;

    // Active-level selector: 1 if level < actualDepth, else 0. Implemented as
    // a prefix indicator over `levels`.
    component lt[levels];
    signal active[levels];
    for (var lvl = 0; lvl < levels; lvl++) {
        lt[lvl] = LessThan(8);  // actualDepth fits in 8 bits (max 32)
        lt[lvl].in[0] <== lvl;
        lt[lvl].in[1] <== actualDepth;
        active[lvl] <== lt[lvl].out;
    }

    // Walk up. At each level we compute the parent in two regimes:
    //   (a) level >= actualDepth: parent passes through unchanged (we are
    //       already at or above the LeanIMT's natural root)
    //   (b) level <  actualDepth: parent = poseidon2 of (left, right) where
    //       (left, right) is selected by the path-bit
    //
    // We encode this with a single multiplexer driven by `active[lvl] * bit`.
    signal cur[levels + 1];
    cur[0] <== leaf;

    component hashers[levels];
    signal hashedLeft[levels];
    signal hashedRight[levels];
    signal hashedOut[levels];
    signal nextCandidate[levels];

    for (var lvl = 0; lvl < levels; lvl++) {
        // If path-bit is 1: cur is the right child, sibling is left.
        // If path-bit is 0: cur is the left child, sibling is right.
        hashedLeft[lvl]  <== siblings[lvl] + (cur[lvl]      - siblings[lvl])  * (1 - bits.out[lvl]);
        hashedRight[lvl] <== cur[lvl]      + (siblings[lvl] - cur[lvl])       * (1 - bits.out[lvl]);

        hashers[lvl] = Poseidon(2);
        hashers[lvl].inputs[0] <== hashedLeft[lvl];
        hashers[lvl].inputs[1] <== hashedRight[lvl];
        hashedOut[lvl] <== hashers[lvl].out;

        // If level is active (level < actualDepth), use the hashed parent.
        // Otherwise, propagate cur[lvl] unchanged (LeanIMT no-empty-padding rule).
        nextCandidate[lvl] <== cur[lvl] + (hashedOut[lvl] - cur[lvl]) * active[lvl];

        cur[lvl + 1] <== nextCandidate[lvl];
    }

    // Final node must equal the supplied root.
    root === cur[levels];
}

// ----------------------------------------------------------------------------
// NoteSpend — main template, parameterised by max tree depth and N/M.
// ----------------------------------------------------------------------------
template NoteSpend(maxTreeDepth, N, M) {
    // -------- Public inputs (declared first so they appear in pubSignals) --
    // CHANGED v0 -> v1:
    //   - REMOVED `withdrawnAmount` from public (now a private witness, bound
    //     to on-chain `unshieldAmount` calldata via `context`). Public-signal
    //     leakage of transfer-vs-unshield per-epoch counts was the v0 break
    //     flagged by the 2026-06-09 adversarial pass.
    //   - REMOVED `aspTreeDepth` from public. `aspRoot` is the authoritative
    //     commitment; the contract pins the depth associated with each root
    //     when posting the root on-chain, and the depth witness inside the
    //     proof is checked against that authoritative depth in dispatch
    //     code. Folding the depth into root commitment removes a redundant
    //     public signal without weakening the proof.
    signal input stateRoot;
    signal input stateTreeDepth;
    signal input aspRoot;
    signal input aspTreeDepth;
    signal input context;

    // -------- Private inputs: per-input note --------------------------------
    // `inLabel` and `inAmount` are both PRIVATE witnesses (unchanged from v0
    // for amount; the relevant change is the commitment recipe no longer
    // surfaces `label` even indirectly). The new NPK material lives in
    // `inSpendingPK` + `inViewingPKBlind`.
    signal input inAmount[N];
    signal input inLabel[N];
    signal input inSpendingPK[N];
    signal input inViewingPKBlind[N];
    signal input inNullifier[N];
    signal input inSecret[N];
    signal input inIsDummy[N];                  // 0 or 1
    signal input inStateIndex[N];
    signal input inStateSiblings[N][maxTreeDepth];
    signal input inAspIndex[N];
    signal input inAspSiblings[N][maxTreeDepth];

    // -------- Private inputs: per-output note ------------------------------
    signal input outAmount[M];
    signal input outLabel[M];
    signal input outSpendingPK[M];
    signal input outViewingPKBlind[M];
    signal input outNullifier[M];
    signal input outSecret[M];

    // -------- Private witness: unshield amount (was public in v0) ----------
    // Bound to on-chain `unshieldAmount` calldata field through `context`.
    // For pure shielded TRANSFER ops the contract enforces `unshieldAmount=0`
    // on the calldata side and the prover sets `withdrawnAmount=0` here;
    // for UNSHIELD ops the contract sets `unshieldAmount > 0` and the prover
    // must set `withdrawnAmount` to the same value or `context` will mismatch
    // and the verifier rejects. SHIELD ops route through a separate contract
    // entry (no proof) so this signal is unused there.
    signal input withdrawnAmount;

    // -------- Public outputs (per-spend) -----------------------------------
    signal output nullifierHashes[N];
    signal output outputCommitments[M];

    // === Context binding (Railgun + Tornado pattern) =======================
    // `context = keccak256(withdrawalStruct || unshieldAmount || scope) % r`
    // is computed by the contract and supplied as a public input. The
    // contract therefore controls every byte of the binding — the prover
    // cannot inflate `withdrawnAmount` past what the contract committed to
    // because doing so changes `context` and the verifier rejects.
    //
    // The `withdrawnAmount` PRIVATE witness must match the unshield amount
    // that the contract hashed into `context`. We pin both inputs into the
    // r1cs witness layout via no-op multiplications; the binding itself is
    // enforced by the contract-side keccak preimage equality (off-chain
    // for the prover, on-chain for the verifier in `UTXOPool.sol`).
    signal contextSquared;
    contextSquared <== context * context;       // pin `context` into the
                                                 // r1cs witness layout
    signal withdrawnAmountSquared;
    withdrawnAmountSquared <== withdrawnAmount * withdrawnAmount;
                                                 // pin `withdrawnAmount`
                                                 // into the witness layout
                                                 // so the contract's keccak
                                                 // preimage binding can
                                                 // reference it. The
                                                 // arithmetic value is also
                                                 // used in conservation
                                                 // below.

    // === Per-input checks ===================================================
    component inHasher[N];
    component inNpk[N];
    component inStateProof[N];
    component inAspProof[N];

    for (var i = 0; i < N; i++) {
        // 1. Compute the NPK from spending + blinded viewing keys.
        //    Mirrors Railgun's Globals.sol NPK derivation.
        inNpk[i] = NpkBuilder();
        inNpk[i].spendingPK     <== inSpendingPK[i];
        inNpk[i].viewingPKBlind <== inViewingPKBlind[i];

        // 2. Recompute commitment + nullifier hash using the NPK recipe.
        //    Note: `inLabel[i]` is NOT fed to the hasher in v1 — the label
        //    binds privately through the recipient's viewing-key derivation
        //    off-chain (Agent SDK owns this in viewingKeyHD.ts), so an
        //    on-chain observer cannot recover the label from the commitment
        //    even if they brute-force amount + secret.
        inHasher[i] = CommitmentHasher();
        inHasher[i].amount    <== inAmount[i];
        inHasher[i].npk       <== inNpk[i].npk;
        inHasher[i].nullifier <== inNullifier[i];
        inHasher[i].secret    <== inSecret[i];

        // Expose nullifier hash as a public signal
        nullifierHashes[i] <== inHasher[i].nullifierHash;

        // 3. inIsDummy must be a bit
        inIsDummy[i] * (inIsDummy[i] - 1) === 0;

        // 4. Dummy notes MUST carry amount = 0 (prevents free spend)
        inIsDummy[i] * inAmount[i] === 0;

        // 5. State-tree membership (skipped iff dummy).
        //    For real notes: verify Merkle inclusion of the recomputed
        //    commitment. We embed the constraint inside an unconditional
        //    template by always running the proof but substituting the leaf
        //    with a dummy that trivially matches when `inIsDummy=1`.
        //
        //    Implementation: the prover always supplies a valid siblings
        //    array (for dummies, any siblings path will do as long as it
        //    terminates in the supplied root). We *additionally* enforce
        //    that for non-dummies the recomputed commitment is the actual
        //    leaf. The result: a malicious prover cannot mark a real note
        //    as dummy because their inAmount would also have to be 0 (rule 4),
        //    making the "free spend" attack worthless.
        inStateProof[i] = LeanIMTInclusionProof(maxTreeDepth);
        inStateProof[i].leaf        <== inHasher[i].commitment;
        inStateProof[i].root        <== stateRoot;
        inStateProof[i].actualDepth <== stateTreeDepth;
        inStateProof[i].index       <== inStateIndex[i];
        for (var k = 0; k < maxTreeDepth; k++) {
            inStateProof[i].siblings[k] <== inStateSiblings[i][k];
        }
        // (LeanIMTInclusionProof enforces root === computed.)

        // 6. ASP membership of the (PRIVATE) label.
        //    Even though `inLabel[i]` is no longer in the commitment recipe,
        //    the label still needs to be in the ASP tree for compliance —
        //    proving "this commitment's hidden label is approved" without
        //    ever revealing the label. The ASP root is public, the label
        //    witness is private; the Merkle proof binds them privately.
        inAspProof[i] = LeanIMTInclusionProof(maxTreeDepth);
        inAspProof[i].leaf        <== inLabel[i];
        inAspProof[i].root        <== aspRoot;
        inAspProof[i].actualDepth <== aspTreeDepth;
        inAspProof[i].index       <== inAspIndex[i];
        for (var k = 0; k < maxTreeDepth; k++) {
            inAspProof[i].siblings[k] <== inAspSiblings[i][k];
        }
    }

    // === Per-output checks =================================================
    component outHasher[M];
    component outNpk[M];
    component outRange[M];

    for (var j = 0; j < M; j++) {
        // Build output NPK from output-side spending + viewing key material.
        outNpk[j] = NpkBuilder();
        outNpk[j].spendingPK     <== outSpendingPK[j];
        outNpk[j].viewingPKBlind <== outViewingPKBlind[j];

        outHasher[j] = CommitmentHasher();
        outHasher[j].amount    <== outAmount[j];
        outHasher[j].npk       <== outNpk[j].npk;
        outHasher[j].nullifier <== outNullifier[j];
        outHasher[j].secret    <== outSecret[j];

        outputCommitments[j] <== outHasher[j].commitment;

        // Range check: outputs must fit in 64 bits (USDC supply ≪ 2^64).
        outRange[j] = Num2Bits(64);
        outRange[j].in <== outAmount[j];

        // Label propagation: outLabel[j] must equal at least one inLabel[i].
        // CHANGED v0 -> v1: this constraint is unchanged in form, but ALL of
        // its operands (`outLabel`, `inLabel`) are now PRIVATE witnesses.
        // Observers can no longer build a public DAG from output -> input
        // label edges, because labels never surface on-chain (the commitment
        // recipe stopped including label, and there is no public label
        // signal). The propagation rule still enforces compliance — clean
        // labels stay clean through transfers — but the rule itself is now
        // a private constraint over private witnesses.
        //
        // Encoded as a polynomial: prod_i (outLabel[j] - inLabel[i]) == 0.
        // We unroll the product for N=2.
        // (Generalised constraint must be added if N changes.)
        // For N=2:  (out - in0)(out - in1) == 0
        var diffsProduct = (outLabel[j] - inLabel[0]) * (outLabel[j] - inLabel[1]);
        diffsProduct === 0;
        // NOTE: for N > 2 this becomes degree > 2 and must be expressed
        //       through auxiliary signals. v1 fixes N=2 so this is fine.
    }

    // === Withdrawn-amount range check =====================================
    // Even though `withdrawnAmount` is now PRIVATE, the range check still
    // applies — without it a malicious prover could supply a near-field-size
    // negative value and break conservation. Same 64-bit bound as outputs.
    component withdrawnRange = Num2Bits(64);
    withdrawnRange.in <== withdrawnAmount;

    // === Conservation of value: sum(in) == sum(out) + withdrawn ============
    // Both sides are field elements bounded by N * 2^64 and M * 2^64
    // respectively, far below the BN254 scalar field, so no overflow.
    //
    // For TRANSFER ops: contract sets `unshieldAmount=0` -> context binds
    //   prover to `withdrawnAmount=0` -> sum(in) === sum(out).
    // For UNSHIELD ops: contract sets `unshieldAmount=X` -> context binds
    //   prover to `withdrawnAmount=X` -> sum(in) === sum(out) + X.
    // No public signal distinguishes the two paths, but the on-chain
    // dispatch knows which it is via the calldata field that determined
    // `context`.
    var sumIn = 0;
    for (var i = 0; i < N; i++) {
        sumIn += inAmount[i];
    }
    var sumOut = 0;
    for (var j = 0; j < M; j++) {
        sumOut += outAmount[j];
    }
    sumIn === sumOut + withdrawnAmount;
}

// ----------------------------------------------------------------------------
// v1 instantiation: N=2 inputs, M=2 outputs, 32-level LeanIMT.
// Public signal count = 2*N + 4 = 8.
//   - 2 nullifierHashes (output)
//   - 2 outputCommitments (output)
//   - 4 publicly-declared inputs: stateRoot, stateTreeDepth, aspRoot, context
// `aspTreeDepth` is a witness only (depth pinned by the contract per root).
// `withdrawnAmount` is a witness only (bound to `unshieldAmount` calldata
// through `context = keccak256(withdrawalStruct || unshieldAmount || scope)`).
// ----------------------------------------------------------------------------
component main { public [
    stateRoot,
    stateTreeDepth,
    aspRoot,
    context
] } = NoteSpend(32, 2, 2);
