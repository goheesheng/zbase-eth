/**
 * build-note-spend-witness.ts — assemble a SATISFIABLE NoteSpend(32,2,2) input.
 *
 * Phase 4 of the mainnet code-blocker work. The dry-run proved the circuit
 * COMPILES (35,440 constraints, fits ptau-18) but never proved a real witness
 * satisfies it — there was no input fixture. This builder constructs a full,
 * conservation-respecting 2-input/2-output spend with valid LeanIMT state +ASP
 * membership proofs, writes it to `test/fixtures/note_spend_input.json`, and is
 * the input to `snarkjs wtns calculate` (see scripts/test-note-spend-witness.sh
 * / the npm verify step).
 *
 * What this CLOSES: the dry-run's "circuit compiles but was never satisfied with
 * real inputs" gap. `wtns calculate` succeeding proves the constraint system is
 * satisfiable with realistic notes (commitments, nullifiers, NPK derivation,
 * Merkle inclusion, value conservation).
 *
 * What this does NOT close (irreducible pre-ceremony): a full Groth16 PROVE +
 * on-chain verify needs the ceremony `groth16_pkey.zkey` + the deployed
 * verifier. That runs at the post-ceremony Sepolia smoke (the test the dry-run
 * couldn't do). This builder + `wtns calculate` is the strongest satisfiability
 * check available now.
 *
 * Spend shape (the simplest satisfiable case):
 *   inputs:  [ $10 real note, $0 dummy ]   (dummy carries inIsDummy=1)
 *   outputs: [ $7 to recipient, $3 change ]
 *   withdrawnAmount: 0  (pure shielded transfer)  → 10 == 7 + 3 + 0 ✓
 *
 * Both input commitments are inserted into the state tree so BOTH inclusion
 * proofs pass (the circuit runs the LeanIMT proof unconditionally for the dummy
 * too — `inIsDummy` only relaxes the amount, not the membership root equality).
 * Likewise both labels go into the ASP tree.
 *
 * Usage:  npx tsx scripts/build-note-spend-witness.ts
 *         (writes test/fixtures/note_spend_input.json; prints a summary)
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { LeanIMT } from "@zk-kit/lean-imt";
import { x25519 } from "@noble/curves/ed25519";
import { deriveRecipientNPK } from "../packages/core/src/npk.js";

const TREE_DEPTH = 32; // == circuit maxTreeDepth
const USDC = (n: number): bigint => BigInt(n) * 1_000_000n;

// Deterministic field samples for a REPRODUCIBLE fixture (NOT secure randomness —
// this is a committed test vector, not a live note). Distinct per field to avoid
// accidental collisions that could mask a bug. The fixture is byte-stable across
// runs so it doubles as a regression reference.
let seed = 1n;
const nextField = (): bigint => {
  seed = poseidon1([seed]);
  return seed;
};

// Fixed X25519 viewing keypairs (deterministic — a fixed private key yields a
// fixed public key) so the whole fixture is reproducible.
const fixedView = (fill: number): { privateKey: Uint8Array; publicKey: Uint8Array } => {
  const privateKey = new Uint8Array(32).fill(fill);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
};

// ── NPK material ──────────────────────────────────────────────────────────────
// Spender (input owner) + recipient (output0) get derived NPKs so the fixture
// exercises the real npk.ts derivation, not placeholder zeros.
const spenderView = fixedView(0x21);
const recipientView = fixedView(0x42);
const spenderSpendPK = nextField();
const recipientSpendPK = nextField();

// Fixed ephemeral keys → deterministic derivation.
const ephSpender = new Uint8Array(32).fill(3);
const ephRecipient = new Uint8Array(32).fill(5);
const ephChange = new Uint8Array(32).fill(11);

const spenderNpk = deriveRecipientNPK({
  recipientViewingPubKey: spenderView.publicKey,
  recipientSpendingPubKey: spenderSpendPK,
  ephemeralPrivateKey: ephSpender,
});
const recipientNpk = deriveRecipientNPK({
  recipientViewingPubKey: recipientView.publicKey,
  recipientSpendingPubKey: recipientSpendPK,
  ephemeralPrivateKey: ephRecipient,
});
const changeNpk = deriveRecipientNPK({
  recipientViewingPubKey: spenderView.publicKey,
  recipientSpendingPubKey: spenderSpendPK,
  ephemeralPrivateKey: ephChange,
});

// ── Helpers mirroring the circuit recipe (CommitmentHasher / NpkBuilder) ───────
const npkOf = (spendingPK: bigint, viewingPKBlind: bigint): bigint =>
  poseidon2([spendingPK, viewingPKBlind]);
const commitmentOf = (amount: bigint, npk: bigint, secret: bigint): bigint =>
  poseidon3([amount, npk, secret]);

// ── Input notes ───────────────────────────────────────────────────────────────
const LABEL = nextField(); // single ASP label shared by all notes (clean subset)

// Input 0: the real $10 note owned by the spender.
const in0 = {
  amount: USDC(10),
  label: LABEL,
  spendingPK: spenderNpk.spendingPK,
  viewingPKBlind: spenderNpk.viewingPKBlind,
  nullifier: nextField(),
  secret: nextField(),
  isDummy: 0n,
};
// Input 1: a dummy (amount=0, isDummy=1). Still needs a valid commitment in the
// tree because the circuit runs its inclusion proof unconditionally.
const in1 = {
  amount: 0n,
  label: LABEL,
  spendingPK: spenderNpk.spendingPK,
  viewingPKBlind: spenderNpk.viewingPKBlind,
  nullifier: nextField(),
  secret: nextField(),
  isDummy: 1n,
};

const in0Commit = commitmentOf(in0.amount, npkOf(in0.spendingPK, in0.viewingPKBlind), in0.secret);
const in1Commit = commitmentOf(in1.amount, npkOf(in1.spendingPK, in1.viewingPKBlind), in1.secret);

// ── Output notes ──────────────────────────────────────────────────────────────
// out0: $7 to recipient. out1: $3 change back to spender. 10 == 7 + 3 + 0.
const out0 = {
  amount: USDC(7),
  label: LABEL, // propagation rule: outLabel ∈ {inLabel[0], inLabel[1]}
  spendingPK: recipientNpk.spendingPK,
  viewingPKBlind: recipientNpk.viewingPKBlind,
  nullifier: nextField(),
  secret: nextField(),
};
const out1 = {
  amount: USDC(3),
  label: LABEL,
  spendingPK: changeNpk.spendingPK,
  viewingPKBlind: changeNpk.viewingPKBlind,
  nullifier: nextField(),
  secret: nextField(),
};

const withdrawnAmount = 0n; // pure transfer
// Conservation sanity (the circuit asserts this; fail fast here with a message).
if (in0.amount + in1.amount !== out0.amount + out1.amount + withdrawnAmount) {
  throw new Error("fixture conservation violated: sum(in) != sum(out) + withdrawn");
}

// ── State tree: TWO decoys then BOTH input commitments ────────────────────────
// B3 fix (audit-sweep-2026-06-17): the previous fixture put the inputs at indices
// 0 and 1 of a 2-leaf tree — the left spine, where every leaf's compacted proof
// equals its raw index and no sibling level is dropped. That masked the
// witness-gen bug entirely (`wtns calculate` passed by luck). We now seed two
// decoy leaves first so the real inputs sit at indices 2 and 3 of a 4-leaf
// PERFECT tree (depth 2). At those indices both proofs genuinely hash up two
// levels (not just the spine), so the fixture exercises the index↔siblings
// pairing that the bug broke.
//
// Why a 4-leaf PERFECT tree specifically (not, say, 3 or 5 leaves): the frozen
// circuit feeds ONE shared `stateTreeDepth` to all N inputs' inclusion proofs
// (note_spend.circom:374) and HASHES every level below it. zk-kit's compacted
// proof depth VARIES per leaf (a leaf with a missing right sibling has fewer
// siblings, e.g. leaf 2 in a 3-leaf tree has compacted depth 1 while leaf 0 has
// 2). A single shared `actualDepth` therefore cannot serve two inputs at
// different compacted depths, AND the circuit's hash-every-active-level rule
// cannot reproduce LeanIMT's "promote, don't hash" at a missing-sibling level.
// In a perfect (2^k-leaf) tree every leaf has the SAME compacted depth and
// proof.index == leafIndex, so the shared-depth circuit verifies all of them.
//
// ⚠️ RESIDUAL CIRCUIT-DESIGN LIMITATION (auditor-scoped, NOT fixed here): for a
// NON-perfect state tree, a spend whose input sits at a missing-right-sibling
// index cannot produce a satisfying witness against this circuit's shared
// `stateTreeDepth` design. Fixing the general case needs a CIRCUIT change
// (per-input actualDepth, or a promotion-aware inclusion check) → re-freeze +
// re-ceremony. Flagged in docs/security/audit-sweep-2026-06-17.md (B3). This
// fixture proves the witness-gen pairing is now correct AND that the circuit is
// satisfiable for the perfect-tree case; it does NOT claim the circuit handles
// arbitrary tree shapes.
const hash = (a: bigint, b: bigint) => poseidon2([a, b]);
const stateTree = new LeanIMT(hash);
const decoy0 = nextField();
const decoy1 = nextField();
stateTree.insert(decoy0); // index 0 (decoy)
stateTree.insert(decoy1); // index 1 (decoy)
stateTree.insert(in0Commit); // index 2 (real input 0)
stateTree.insert(in1Commit); // index 3 (real input 1)
const stateRoot = stateTree.root;
const stateDepth = stateTree.depth; // 2 (perfect 4-leaf tree)

// ── ASP tree: TWO decoys then the shared label ───────────────────────────────
// Same reasoning: put the label at a non-spine index of a perfect tree so the
// ASP inclusion proof also exercises real hashing, not just the root==leaf path.
const aspTree = new LeanIMT(hash);
aspTree.insert(nextField()); // index 0 (decoy label)
aspTree.insert(nextField()); // index 1 (decoy label)
aspTree.insert(LABEL); // index 2 (the real, shared label)
aspTree.insert(nextField()); // index 3 (decoy label) → perfect 4-leaf tree
const aspRoot = aspTree.root;
const aspDepth = aspTree.depth; // 2
const LABEL_INDEX = 2;

/**
 * Build a depth-`TREE_DEPTH` padded inclusion proof matching the circuit's
 * LeanIMTInclusionProof inputs. B3: the circuit's `index` is zk-kit's COMPACTED
 * `proof.index` (NOT the raw leafIndex) and `actualDepth` is the compacted
 * `siblings.length`; siblings are zero-padded to TREE_DEPTH. See merkle.ts for
 * the full rationale — feeding the raw leafIndex here was the masked bug.
 */
function paddedProof(tree: LeanIMT, leafIndex: number): {
  siblings: bigint[];
  index: number;
  actualDepth: number;
} {
  const proof = tree.generateProof(leafIndex);
  const sibs = proof.siblings.map((s: bigint | bigint[]) =>
    Array.isArray(s) ? s[0] : s,
  ) as bigint[];
  if (sibs.length > TREE_DEPTH) {
    throw new Error(`proof depth ${sibs.length} exceeds TREE_DEPTH ${TREE_DEPTH}`);
  }
  const padded = sibs.slice();
  while (padded.length < TREE_DEPTH) padded.push(0n);
  return { siblings: padded, index: proof.index, actualDepth: sibs.length };
}

const in0State = paddedProof(stateTree, 2); // real input 0 at index 2
const in1State = paddedProof(stateTree, 3); // real input 1 at index 3
const in0Asp = paddedProof(aspTree, LABEL_INDEX);
const in1Asp = paddedProof(aspTree, LABEL_INDEX); // both inputs share the label leaf

// ── Assemble the circuit input (all field elements as decimal strings) ────────
const S = (x: bigint): string => x.toString();
const arr = (xs: bigint[]): string[] => xs.map(S);

const input = {
  // public inputs
  stateRoot: S(stateRoot),
  stateTreeDepth: S(BigInt(stateDepth)),
  aspRoot: S(aspRoot),
  context: S(nextField()), // contract-supplied; any field element satisfies the
                           // circuit's no-op pin (binding is checked on-chain).
  // private: per-input
  inAmount: arr([in0.amount, in1.amount]),
  inLabel: arr([in0.label, in1.label]),
  inSpendingPK: arr([in0.spendingPK, in1.spendingPK]),
  inViewingPKBlind: arr([in0.viewingPKBlind, in1.viewingPKBlind]),
  inNullifier: arr([in0.nullifier, in1.nullifier]),
  inSecret: arr([in0.secret, in1.secret]),
  inIsDummy: arr([in0.isDummy, in1.isDummy]),
  inStateIndex: [S(BigInt(in0State.index)), S(BigInt(in1State.index))],
  inStateSiblings: [arr(in0State.siblings), arr(in1State.siblings)],
  inAspIndex: [S(BigInt(in0Asp.index)), S(BigInt(in1Asp.index))],
  inAspSiblings: [arr(in0Asp.siblings), arr(in1Asp.siblings)],
  // aspTreeDepth is a private witness (not public in v1)
  aspTreeDepth: S(BigInt(aspDepth)),
  // private: per-output
  outAmount: arr([out0.amount, out1.amount]),
  outLabel: arr([out0.label, out1.label]),
  outSpendingPK: arr([out0.spendingPK, out1.spendingPK]),
  outViewingPKBlind: arr([out0.viewingPKBlind, out1.viewingPKBlind]),
  outNullifier: arr([out0.nullifier, out1.nullifier]),
  outSecret: arr([out0.secret, out1.secret]),
  // private: unshield amount
  withdrawnAmount: S(withdrawnAmount),
};

const outPath = join(process.cwd(), "test/fixtures/note_spend_input.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(input, null, 2) + "\n");

console.log("note_spend witness fixture written:", outPath);
console.log("  inputs:  $10 real + $0 dummy");
console.log("  outputs: $7 recipient + $3 change, withdrawn=0  (conservation ✓)");
console.log("  stateRoot:", S(stateRoot), `(depth ${stateDepth})`);
console.log("  aspRoot:  ", S(aspRoot), `(depth ${aspDepth})`);
console.log("  expected public signals [nullHash0, nullHash1, outCom0, outCom1, stateRoot, stateTreeDepth, aspRoot, context]:");
console.log("    nullifierHashes:", S(poseidon1([in0.nullifier])), S(poseidon1([in1.nullifier])));
console.log("    outputCommitments:",
  S(commitmentOf(out0.amount, npkOf(out0.spendingPK, out0.viewingPKBlind), out0.secret)),
  S(commitmentOf(out1.amount, npkOf(out1.spendingPK, out1.viewingPKBlind), out1.secret)),
);
