/**
 * settle-readiness.ts — make the launch gate real on the routes that move money.
 *
 * `getFacilitatorReadiness()` was consumed by /health, /supported and
 * /facilitator/verify ONLY. The settle routes were not gated, so the facilitator
 * could publish `customerReady:false` with its reasons while `settle-x402` happily
 * executed payments: the buyer got their data and believed they had paid privately.
 * At an anonymity set below the launch minimum the withdrawal is linkable to the
 * deposit, so they had not.
 *
 * A gate that only the honest client honours is not a gate. The SDK now checks it
 * (FacilitatorNotReadyError), but a direct HTTP caller — or anyone still on an older
 * SDK — bypasses that entirely. This is the server-side half.
 *
 * ── SCOPE: the BUYER path only ───────────────────────────────────────────────
 * This gates /api/facilitator/settle-x402, which funds a payment from the pool and
 * is therefore the route that makes the privacy claim.
 *
 * It deliberately does NOT gate /api/facilitator/x402/{verify,settle}. Those are the
 * SELLER-facing spec surface: a seller points its facilitatorUrl at zBase and we
 * verify + broadcast an EIP-3009 authorization it already holds. That service makes
 * no privacy claim — the buyer's privacy either happened upstream in settle-x402 or
 * was never on offer — so refusing it because OUR anonymity set is small would be a
 * category error: a seller's legitimate settlement blocked for a reason that does not
 * apply to them.
 *
 * The rule: gate what claims privacy, not what moves money.
 *
 * ESCAPE HATCH: ZBASE_ALLOW_UNREADY_SETTLE=true. The operator has to be able to
 * exercise their own plumbing before the gates open, and every prior gate in this
 * codebase has the same shape (cf. ZBASE_ALLOW_MAINNET_EOA_POSTMAN). It is
 * deliberately an ENV var, not a request field: a caller must never be able to talk
 * the facilitator out of its own launch gate.
 */
import { NextResponse } from "next/server";
import { getFacilitatorReadiness } from "./facilitator-readiness";
import {
  bypassDisclosure,
  pilotDisclosure,
  privateDisclosure,
  type PrivacyDisclosure,
} from "./pilot";

/** True when the operator has explicitly allowed settling on an unready facilitator. */
export function unreadySettleAllowed(): boolean {
  return String(process.env.ZBASE_ALLOW_UNREADY_SETTLE ?? "false").toLowerCase() === "true";
}

/**
 * The verdict for one settle request.
 *
 * Allowing carries a `privacy` disclosure rather than a bare `null`, and that is the
 * point: this function is the ONLY place that knows whether a given payment is private,
 * so it must hand that fact to the route rather than let the route assume. A route that
 * could proceed without being told would eventually proceed silently — which is exactly
 * the failure pilot mode exists to prevent.
 */
export type SettleVerdict =
  | { allow: true; privacy: PrivacyDisclosure }
  | { allow: false; refusal: NextResponse };

/**
 * Decide whether this settle may proceed, and with what privacy claim.
 *
 * Called BEFORE any note is spent, so a refusal costs the caller nothing: the note is
 * unspent and the request is safe to retry once the gates open.
 *
 * The order matters. Customer-ready is checked before pilot so a fully-launched
 * facilitator never mislabels a genuinely private payment as a pilot one.
 */
export async function settleReadinessVerdict(): Promise<SettleVerdict> {
  const readiness = await getFacilitatorReadiness();
  const set = readiness.organicAnonymitySet;
  const min = readiness.minimumAnonymitySet;

  // The operator's own plumbing bypass. Still discloses — bypassing a gate does not
  // create the property the gate was checking.
  if (unreadySettleAllowed() && !readiness.customerReady) {
    return { allow: true, privacy: bypassDisclosure(set, min) };
  }

  if (readiness.customerReady) {
    return { allow: true, privacy: privateDisclosure(set, min) };
  }

  // The stack is sound but the set is thin: settle, and disclose that it is not private.
  //
  // No key, no allowlist, no switch — see pilot.ts. There is nothing to check and nothing
  // to open: this route takes an anonymous note by design so it cannot know who is
  // calling, and a caller can only spend a note they deposited. Refusing would hold their
  // own funds hostage to a privacy claim we are simultaneously telling them they do not
  // have. Informed consent belongs in the SDK (`acceptNotPrivate`), where there is a
  // developer to inform; this route's job is to make the disclosure impossible to miss.
  if (readiness.pilotReady) {
    return { allow: true, privacy: pilotDisclosure(set, min) };
  }

  // Reaching here means !pilotReady: something a disclosure cannot cover is broken
  // (unprotected keys, a dead stack, an unverifiable set). Report only what the caller
  // can act on.
  const reasons = readiness.blockingReasons.filter((r) => r.blocks.includes("customer"));

  return {
    allow: false,
    refusal: NextResponse.json(
      {
        settled: false,
        code: "FACILITATOR_NOT_READY",
        error:
          reasons[0]?.message ??
          "The privacy facilitator is not ready for customer use.",
        // The caller's payment WOULD succeed — that is exactly why we refuse. Say so,
        // rather than let them read a 503 as "try again later".
        details:
          "The facilitator cannot safely settle right now — this is NOT the anonymity set " +
          "being small (that would settle, with a disclosure). Something a disclosure cannot " +
          "cover is wrong; see blockingReasons. Your note is unspent and safe to retry.",
        blockingReasons: readiness.blockingReasons.filter((r) => r.blocks.includes("pilot")),
      },
      { status: 503 },
    ),
  };
}
