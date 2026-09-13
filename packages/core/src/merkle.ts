/**
 * @zbase-protocol/core — Chain-agnostic Merkle tree operations
 *
 * Uses Lean Incremental Merkle Tree (lean-imt) with Poseidon hashing.
 * Same tree structure works for both EVM and Solana verifiers.
 */

import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2 } from "poseidon-lite";

const TREE_DEPTH = 32;

/**
 * Build a Merkle tree from leaf values (commitments).
 * The hash function (Poseidon2) is identical across chains.
 */
export function buildMerkleTree(leaves: bigint[]): LeanIMT {
  const hash = (a: bigint, b: bigint) => poseidon2([a, b]);
  const tree = new LeanIMT(hash);

  for (const leaf of leaves) {
    tree.insert(leaf);
  }

  return tree;
}

/**
 * Generate a Merkle proof for a leaf, shaped for `note_spend.circom`'s
 * `LeanIMTInclusionProof(levels=TREE_DEPTH)`.
 *
 * B3 fix (audit-sweep-2026-06-17): zk-kit's `generateProof` returns a
 * **compacted** proof — levels where the leaf has no right sibling are DROPPED
 * from `siblings`, and `proof.index` is **recomputed** over only the surviving
 * path bits (it is NOT the raw `leafIndex`). The circuit walks `actualDepth`
 * real levels, decomposing `index` into bits and pairing bit `lvl` with
 * `siblings[lvl]` — exactly the compacted shape. The previous implementation
 * fed the RAW `leafIndex` bits alongside the compacted-then-zero-padded
 * siblings; for any leaf whose path crosses a dropped level the index bits and
 * siblings misaligned, producing a wrong root and an unsatisfiable witness.
 * (It only worked for left-spine leaves where `proof.index === leafIndex` and
 * no level is dropped — which is why the original committed fixture passed.)
 *
 * Correct mapping, matching zk-kit's own `verifyProof`:
 *   - `index`       = proof.index            (compacted path, NOT leafIndex)
 *   - `actualDepth` = siblings.length        (number of real levels)
 *   - `siblings`    = proof.siblings, zero-padded to TREE_DEPTH
 *   - `pathIndices` = bits of proof.index over TREE_DEPTH levels
 *
 * `actualDepth` and `index` are returned alongside so the witness builder can
 * feed the circuit's `actualDepth`/`index` inputs directly.
 */
export function generateMerkleProof(
  tree: LeanIMT,
  leafIndex: number
): {
  pathElements: bigint[];
  pathIndices: number[];
  index: number;
  actualDepth: number;
  root: bigint;
} {
  const proof = tree.generateProof(leafIndex);

  const siblings = proof.siblings.map((s: bigint | bigint[]) =>
    Array.isArray(s) ? s[0] : s
  ) as bigint[];

  // F12: a LeanIMT proof has `depth` siblings (variable with tree size), but the
  // fixed-depth circuit expects exactly TREE_DEPTH padded siblings. Validate we
  // don't EXCEED the circuit depth (would silently truncate / produce a wrong
  // root), then zero-pad up to TREE_DEPTH (the LeanIMT "no right sibling"
  // sentinel is 0, matching the circuit's padding convention).
  if (siblings.length > TREE_DEPTH) {
    throw new Error(
      `merkle: proof depth ${siblings.length} exceeds circuit TREE_DEPTH ${TREE_DEPTH}`,
    );
  }

  const actualDepth = siblings.length;
  const index = proof.index; // compacted path index (NOT leafIndex)

  // pathIndices = bits of the COMPACTED index over TREE_DEPTH levels. Bits at or
  // above actualDepth are 0 (the circuit's `active[lvl]` gate ignores them).
  const pathIndices: number[] = [];
  let idx = index;
  for (let i = 0; i < TREE_DEPTH; i++) {
    pathIndices.push(idx & 1);
    idx >>= 1;
  }

  const paddedElements = siblings.slice();
  while (paddedElements.length < TREE_DEPTH) paddedElements.push(0n);

  return {
    pathElements: paddedElements,
    pathIndices,
    index,
    actualDepth,
    root: tree.root,
  };
}

/**
 * Get the tree depth constant.
 */
export function getTreeDepth(): number {
  return TREE_DEPTH;
}
