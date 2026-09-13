/**
 * test-indexer-parity.ts — prove the indexer cache produces the SAME tree the
 * full chain scan would. This is the correctness guarantee for upgrade #1: a
 * cached-leaves tree must root-match a from-scratch tree over the same leaves, and
 * cacheRootMatches must accept the true root + reject a wrong one.
 *
 * Pure/offline — exercises the indexer's tree-building + verification logic with
 * in-memory leaf sets (no Redis, no chain). Run: npx tsx scripts/test-indexer-parity.ts
 */

import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2 } from "poseidon-lite";
import { buildTreesFromState, cacheRootMatches, cacheLabelsMatch, type IndexerState } from "../src/lib/indexer.ts";

const hash = (a: bigint, b: bigint) => poseidon2([a, b]);
let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

// Deterministic-ish leaf set (the values don't matter, only that both paths use
// the SAME ordered set — that's what the cache must preserve).
function leafSet(n: number): bigint[] {
  const out: bigint[] = [];
  let x = 7n;
  for (let i = 0; i < n; i++) {
    x = poseidon2([x, BigInt(i)]);
    out.push(x);
  }
  return out;
}

console.log("indexer parity test\n");

for (const n of [0, 1, 2, 3, 7, 8, 33, 100]) {
  const leaves = leafSet(n);
  const labels = leafSet(Math.max(1, Math.floor(n / 2)));

  // "Full scan" reference: build the tree directly (what withdraw did before).
  const refState = new LeanIMT<bigint>(hash);
  if (leaves.length > 0) refState.insertMany(leaves);
  const refRoot = leaves.length > 0 ? refState.root : 0n;

  // "Cache" path: build via the indexer helper from the same ordered leaves.
  const state: IndexerState = { leaves, labels, cursor: 0n, leafCount: leaves.length };
  const { stateTree, aspTree } = buildTreesFromState(state);
  const cacheRoot = leaves.length > 0 ? stateTree.root : 0n;

  if (cacheRoot === refRoot) ok(`n=${n}: cache root == full-scan root`);
  else bad(`n=${n}: ROOT MISMATCH cache=${cacheRoot} ref=${refRoot}`);

  // ASP tree parity too.
  const refAsp = new LeanIMT<bigint>(hash);
  refAsp.insertMany(labels);
  if (aspTree.root === refAsp.root) ok(`n=${n}: ASP root parity`);
  else bad(`n=${n}: ASP ROOT MISMATCH`);

  // cacheRootMatches: accepts the true on-chain root, rejects a wrong one.
  if (cacheRootMatches(state, refRoot)) ok(`n=${n}: cacheRootMatches accepts true root`);
  else bad(`n=${n}: cacheRootMatches WRONGLY rejected the true root`);

  if (n > 0) {
    if (!cacheRootMatches(state, refRoot + 1n)) ok(`n=${n}: cacheRootMatches rejects a wrong root`);
    else bad(`n=${n}: cacheRootMatches WRONGLY accepted a bad root`);
  }

  // cacheLabelsMatch (security fix Finding 4): the ASP-root guard accepts the true
  // label root and rejects a corrupted (e.g. duplicated) label list.
  if (cacheLabelsMatch(state, refAsp.root)) ok(`n=${n}: cacheLabelsMatch accepts true ASP root`);
  else bad(`n=${n}: cacheLabelsMatch WRONGLY rejected the true ASP root`);
  // Simulate a label-race duplication: appending a dup must change the ASP root,
  // so the guard rejects it → withdraw falls back to chain scan (no wedge).
  const dupState: IndexerState = { ...state, labels: [...labels, labels[labels.length - 1]] };
  if (!cacheLabelsMatch(dupState, refAsp.root)) ok(`n=${n}: cacheLabelsMatch rejects duplicated labels (race guard)`);
  else bad(`n=${n}: cacheLabelsMatch FAILED to catch duplicated labels`);
}

// Order-sensitivity: a reordered leaf set must NOT match (proves the cache must
// preserve _index order — the whole reason syncIndexer sorts by index).
{
  const leaves = leafSet(5);
  const reordered = [...leaves].reverse();
  const ref = new LeanIMT<bigint>(hash); ref.insertMany(leaves);
  const state: IndexerState = { leaves: reordered, labels: [], cursor: 0n, leafCount: 5 };
  if (!cacheRootMatches(state, ref.root)) ok("reordered leaves correctly FAIL the root check (order matters)");
  else bad("reordered leaves wrongly passed — order-sensitivity broken");
}

console.log("");
if (failed) { console.log("INDEXER PARITY: FAILED"); process.exit(1); }
console.log("INDEXER PARITY: all checks passed");
