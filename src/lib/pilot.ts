/**
 * pilot.ts — zBase settles real money on mainnet today, and every response says how
 * private that payment actually was.
 *
 * THERE IS NO PILOT MODE. The file keeps the name because the concept it killed is worth
 * remembering.
 *
 * The instinct is to treat "not private enough yet" as a launch stage: a beta, a
 * restricted group, a switch the operator flips when ready. Three drafts went that way —
 * a shared bearer key, then an allowlist, then a single ZBASE_PILOT_ENABLED switch — and
 * each one was answering the wrong question.
 *
 * The software is production-ready. It has been for a while. What is not ready is
 * ARITHMETIC: a privacy pool hides your withdrawal among N independent deposits, and N is
 * currently small. At N=1 an observer just looks at the only deposit in the pool. No flag
 * changes that, no gate changes that, and shipping more code does not change it either.
 * It changes when strangers deposit, which is why `customerReady` flips to true on its own
 * at k=30 (MAINNET_ANONYMITY_FLOOR) and nobody flips it by hand.
 *
 * Every gate we invented was therefore withholding a capability zBase HAD, in order to
 * manage a claim it could not back. Those are different problems, and only the second one
 * is real. So:
 *
 *   - If the stack is sound enough to move real money (`pilotReady` — see ReadinessScope),
 *     it moves real money, for anyone who deposited. No key, no allowlist, no switch.
 *   - Every settle carries a `privacy` block stating whether it was private, the live
 *     independent-depositor count, and what the count must reach. See pilotDisclosure().
 *   - `customerReady` is the CLAIM, not the door. It stays false until the math is true.
 *
 * What still refuses is safety, never privacy: unprotected seed keys, an unverifiable
 * set, a broken stack. A disclosure can honestly say "this is not anonymous yet". It
 * cannot say "the secrets that spend your money are unencrypted" and call that a product.
 *
 * The one question left was always "what do we tell the payer?" — and that is the whole
 * rest of this file.
 */

/**
 * The privacy disclosure attached to every settle that a caller could mistake for a
 * private one.
 *
 * settle-readiness.ts already established the principle for the refusal path: "The
 * caller's payment WOULD succeed — that is exactly why we refuse. Say so." A 200 needs
 * the symmetric treatment, and more urgently. A refusal is self-explanatory; a silent
 * success is where a false belief actually forms — the client gets their data, the
 * payment worked, and nothing ever told them the withdrawal is linkable to their
 * deposit. This block is the thing that tells them.
 */
export interface PrivacyDisclosure {
  /** Whether THIS payment is actually private. False until the set reaches the minimum. */
  private: boolean;
  /** Independent depositors right now. null = could not be counted. */
  anonymitySet: number | null;
  /** What the set must reach before `private` can be true. */
  minimumForPrivacy: number;
  /** Plain-language statement, written to be understood without reading the spec. */
  disclosure: string;
}

export function pilotDisclosure(
  organicAnonymitySet: number | null,
  minimumForPrivacy: number,
): PrivacyDisclosure {
  const set =
    typeof organicAnonymitySet === "number"
      ? `${organicAnonymitySet} independent depositor(s)`
      : "an unknown number of independent depositors";
  return {
    private: false,
    anonymitySet: organicAnonymitySet,
    minimumForPrivacy,
    disclosure:
      `THIS PAYMENT IS NOT PRIVATE YET. The pool currently has ${set}; privacy requires ` +
      `at least ${minimumForPrivacy}. With a set this small, an observer can link this ` +
      `withdrawal back to your deposit. The payment settled and the seller was paid — only ` +
      `the privacy claim is withheld. zBase is an early product: it becomes private once the ` +
      `set is large enough, automatically, and each independent depositor moves it there.`,
  };
}

/** The disclosure for the operator's own ZBASE_ALLOW_UNREADY_SETTLE bypass. */
export function bypassDisclosure(
  organicAnonymitySet: number | null,
  minimumForPrivacy: number,
): PrivacyDisclosure {
  return {
    private: false,
    anonymitySet: organicAnonymitySet,
    minimumForPrivacy,
    disclosure:
      "NOT PRIVATE — the operator has set ZBASE_ALLOW_UNREADY_SETTLE, which bypasses the " +
      "launch gates for plumbing tests. No privacy property is asserted for this payment.",
  };
}

/** The disclosure for a fully customer-ready facilitator: the claim the gates back. */
export function privateDisclosure(
  organicAnonymitySet: number | null,
  minimumForPrivacy: number,
): PrivacyDisclosure {
  return {
    private: true,
    anonymitySet: organicAnonymitySet,
    minimumForPrivacy,
    disclosure:
      "Private: settled from the privacy pool with an anonymity set at or above the launch minimum.",
  };
}
