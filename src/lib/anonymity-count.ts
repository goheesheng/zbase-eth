/**
 * anonymity-count.ts — ONE definition of "how big is the anonymity set".
 *
 * There were two, and they disagreed. That is the bug:
 *
 *   - /api/anonymity-set counted ORGANIC deposits: Deposited events, treasury excluded
 *     (route.ts:304-314). Correct in spirit.
 *   - facilitator-readiness counted `currentTreeSize` — TREE LEAVES. That includes
 *     treasury-seeded deposits AND change notes.
 *
 * The readiness one is the one that gates customerReady, and it was wrong in a way that
 * defeats its own purpose. Two consequences, both live before this file existed:
 *
 *   1. The pool reported `anonymitySet: 2` from a SINGLE deposit, because a canary's own
 *      change note was counted as anonymity. Your own change is not a crowd.
 *   2. 30 treasury-seeded deposits — or 30 of one user's own payments — would flip
 *      `customerReady: true` and make /supported announce "Privacy-preserving x402
 *      settlement" with ZERO independent depositors.
 *
 * The gate was built precisely to prevent that ("Commitment count is not treated as
 * independent anonymity", commit 6824137) and its own measurement walked around it.
 *
 * WHAT COUNTS, and why each exclusion is load-bearing:
 *
 *   - Only `Deposited` events. Change notes enter the tree via `LeafInserted` and are
 *     YOUR OWN money moving. Counting them means paying yourself into privacy.
 *   - Treasury-seeded deposits are excluded. You cannot hide from yourself; a pool of
 *     N deposits all made by the operator has an anonymity set of one.
 *   - Zero-value deposits are excluded. While the entrypoint's minimumDepositAmount is
 *     0, anyone can mint unlimited commitments for gas. A free deposit is not a
 *     participant — it is spam, and counting it lets an attacker inflate the set or
 *     force /api/anonymity-set out of bootstrap mode and REVEAL a thin organic set.
 *
 * The honest number is: how many DISTINCT, INDEPENDENT parties put real money in.
 */

/**
 * The countable floor is POST-FEE, and that distinction is not pedantry.
 *
 * The entrypoint checks its minimum against the PRE-fee amount
 * (`if (_value < _config.minimumDepositAmount) revert` — Entrypoint.sol:329), then
 * deposits `_amountAfterFees` into the pool. The `Deposited` event therefore carries the
 * POST-fee value: a $1.00 deposit at 100 BPS vetting emits 990_000, not 1_000_000.
 *
 * So comparing event values against the on-chain minimum directly would reject every
 * legitimate minimum-sized deposit as dust — the count would read zero while real
 * participants were depositing. Derive the floor instead.
 */
export function countableFloorAtomic(
  onChainMinimumAtomic: bigint,
  vettingFeeBPS: bigint,
): bigint {
  if (onChainMinimumAtomic <= 0n) return 1n; // minimum unarmed: only reject literal zero-value spam
  return (onChainMinimumAtomic * (10_000n - vettingFeeBPS)) / 10_000n;
}

/**
 * Default floor: the post-fee value of a $1 deposit at the live 100 BPS vetting fee.
 * Prefer countableFloorAtomic() with the live assetConfig; this is the fallback for
 * callers that cannot read the chain.
 */
export const MIN_COUNTABLE_DEPOSIT_ATOMIC = 990_000n; // $1.00 pre-fee → $0.99 in the pool

export interface CountableDeposit {
  depositor: `0x${string}`;
  value: bigint;
}

export interface AnonymityCount {
  /** Independent, non-zero-value deposits. THIS is the anonymity set. */
  organic: number;
  /** Deposits from the treasury. Real money, but zero anonymity — you can't hide from yourself. */
  seeded: number;
  /** Excluded as spam (below the countable minimum). */
  dust: number;
  /** Distinct non-treasury depositor addresses with a countable deposit. */
  distinctDepositors: number;
}

/**
 * Count the anonymity set from Deposited events.
 *
 * `distinctDepositors` is the number to look at when judging whether the set is real:
 * one party making 30 deposits is 30 organic deposits and ONE participant. Sybils make
 * that imperfect — an attacker can split across addresses — which is exactly why
 * ANONYMITY_SET_PROVENANCE_NOT_VERIFIED stays a human judgement rather than a number.
 * This function makes the number honest; it cannot make it sufficient.
 */
export function countAnonymitySet(
  deposits: readonly CountableDeposit[],
  treasury: `0x${string}` | null,
  minAtomic: bigint = MIN_COUNTABLE_DEPOSIT_ATOMIC,
): AnonymityCount {
  const t = treasury?.toLowerCase();
  const distinct = new Set<string>();
  let organic = 0;
  let seeded = 0;
  let dust = 0;

  for (const d of deposits) {
    const who = d.depositor.toLowerCase();
    if (d.value < minAtomic) {
      dust += 1; // spam or a pre-minimum historical deposit — not a participant
      continue;
    }
    if (t && who === t) {
      seeded += 1;
      continue;
    }
    organic += 1;
    distinct.add(who);
  }

  return { organic, seeded, dust, distinctDepositors: distinct.size };
}
