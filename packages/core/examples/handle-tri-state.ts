/**
 * FLAGSHIP EXAMPLE — the money-safety pattern every agent MUST follow.
 *
 * A private payment has a tri-state outcome (plus a throw). Handling it wrong DOUBLE-PAYS.
 * Rule: settlement is idempotent on the note's nullifier, so retrying the SAME call with the
 * SAME deposit is safe. Paying from a DIFFERENT note is what double-pays. Never do that.
 *
 * This file has NO network calls and spends NO funds — it just encodes the correct control flow
 * so an agent can copy it. Compiles against the published types.
 *
 *   npx tsx examples/handle-tri-state.ts
 */
import type {
  FacilitatorClient,
  DepositSecrets,
  PrivateFetchResult,
} from "@zbase-protocol/core";

/**
 * Pay an x402 URL exactly once, safely. Returns the provider response on success.
 * `save` persists the change note; `deposit` is the note to spend.
 */
export async function payOnce(
  zbase: FacilitatorClient,
  url: string,
  deposit: DepositSecrets,
  save: (n: DepositSecrets) => void | Promise<void>,
): Promise<unknown> {
  let res: PrivateFetchResult;
  try {
    res = await zbase.payAndFetch(
      url,
      { method: "GET" },
      {
        deposit,
        onNoteRotate: save, // persist the change note the instant it exists
        maxAmountAtomic: "50000", // hard ceiling (0.05 USDC) vs a hostile 402
      },
    );
  } catch (err) {
    // THROW == provably unspent. The note is untouched; retrying with the SAME note is safe.
    // Do NOT swallow this into "success", and do NOT pay from a different note here.
    throw err;
  }

  switch (res.outcome) {
    case "delivered":
      // Paid and the provider returned a 2xx. onNoteRotate already persisted res.nextDeposit.
      // NOTE: a 2xx proves the provider responded, not that the payload is correct — check it.
      return res.response;
    case "settled_not_delivered":
      // The note IS SPENT and the provider did not return a 2xx: the money left and the value
      // did not arrive. The spend is FINAL, so do NOT re-pay this seller — payOnce would select
      // a DIFFERENT note and you would pay twice for one purchase.
      // res.sellerFault, when set, names a fault in the SELLER's own x402 facilitator (the same
      // payment succeeds against other sellers), so the right move is a different provider.
      throw new Error(
        res.sellerFault
          ? `settled but the seller failed to deliver (seller-side fault): ${res.sellerFault}`
          : "settled but the seller returned no 2xx — note spent, do not retry this seller",
      );
    case "free":
      // The resource was not 402 — nothing was paid.
      return res.response;
    case "refused":
      // The free-probe found a bespoke/incompatible seller. Nothing paid, note untouched.
      throw new Error("seller incompatible with the standard x402 payload");
    case "uncertain":
      // The note MAY be spent. safeToRetry === true because settlement is idempotent on the note.
      // Retry THIS EXACT call with the SAME deposit — never pay from a different note.
      if (res.safeToRetry) return payOnce(zbase, url, deposit, save);
      throw new Error("settlement uncertain and not marked safe to retry");
    default: {
      // Exhaustiveness guard — a new outcome must be handled explicitly.
      const _never: never = res.outcome;
      throw new Error(`unhandled outcome: ${String(_never)}`);
    }
  }
}
