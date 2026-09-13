/**
 * pay-privately.ts — pay any x402 provider from the pool.
 *
 * The old `pay` tool took the note's nullifier/secret as TOOL ARGUMENTS: the agent had
 * to hold bearer secrets, pass them through a transcript any client may log, and
 * remember the change note or lose it. That is what EPHEMERAL mode was apologising
 * for.
 *
 * Now the tool takes a URL. The note is selected from the seed-derived balance, the
 * change note derives at the next index, and no secret ever enters the conversation.
 *
 * As of @zbase-protocol/core 0.4.0 the SDK's payAndFetch does the heavy lifting itself:
 * it FREE-PROBES the seller before spending (refuses a bespoke facilitator with the note
 * untouched), sends BOTH transport headers (X-PAYMENT + Payment-Signature), and re-sends
 * with backoff on a post-settlement 402. This tool is now a thin wrapper that selects the
 * note and formats the result.
 */
import { z } from "zod";
import { formatUnits } from "viem";
import { createFacilitatorClient, selectNote, diagnoseSellerFacilitatorFault } from "@zbase-protocol/core";
import { loadWalletBalance } from "./wallet-balance.js";
import { ZBASE_FACILITATOR_URL, ZBASE_NETWORK } from "../config.js";

export const payPrivatelySchema = z.object({
  url: z.string().url().describe("The x402 provider URL to pay and fetch, e.g. https://api.provider.ai/data"),
  method: z.string().optional().describe("HTTP method (default GET)"),
  body: z.string().optional().describe("Request body as a JSON string, for POST/PUT"),
  maxAmountUSDC: z
    .string()
    .optional()
    .describe("Refuse to pay more than this, e.g. '0.05'. Defaults to 0.10 — a hostile 402 should not be able to drain a note."),
  acceptNotPrivate: z
    .boolean()
    .optional()
    .describe("Acknowledge and proceed while the facilitator is in open PILOT (anonymity set below the privacy minimum): the payment settles but is NOT crowd-anonymous yet. Default false — the SDK refuses rather than pay non-privately without consent."),
  skipProbe: z
    .boolean()
    .optional()
    .describe("Skip the free-probe pre-check. Default false — the SDK always probes first. The probe costs $0 (a 402 read + an invalid-signature dummy that never settles) and refuses BEFORE spending a note if the seller runs a bespoke facilitator that would settle-but-not-deliver. Only skip for a seller you have already proven."),
});

export async function payPrivately(args: z.infer<typeof payPrivatelySchema>): Promise<string> {
  const maxAmountAtomic = BigInt(Math.round(Number(args.maxAmountUSDC ?? "0.10") * 1e6));

  const balance = await loadWalletBalance();
  if (balance.spendable.length === 0) {
    // Pre-settlement: no note was touched, so retrying after funding is safe.
    return JSON.stringify({
      paid: false,
      outcome: "error",
      safeToRetry: true,
      reason:
        "No spendable notes. Call fund_address to get a deposit address, send USDC, then fund_sweep.",
      balanceUSDC: "0",
    });
  }

  // Pick a note that covers the ceiling we are willing to pay. The pool spends ONE
  // note per withdrawal, so "the total is enough" is not "payable" — selecting on the
  // total and discovering that at settle time would burn a real on-chain attempt.
  const note = selectNote(balance, maxAmountAtomic);
  if (!note) {
    return JSON.stringify({
      paid: false,
      outcome: "error",
      safeToRetry: true,
      reason: `No SINGLE note covers ${formatUnits(maxAmountAtomic, 6)} USDC. Total is ${formatUnits(balance.atomic, 6)}, largest note is ${formatUnits(BigInt(balance.spendable[0].value), 6)}. Each payment spends one note; deposit a larger one.`,
      balanceUSDC: formatUnits(balance.atomic, 6),
    });
  }

  // Pass the configured network through to the SDK (not just the base URL) so ZBASE_NETWORK
  // actually selects the payment chain — default Base mainnet, overridable for another chain.
  const client = createFacilitatorClient({ baseUrl: ZBASE_FACILITATOR_URL, network: ZBASE_NETWORK });

  // The try wraps ONLY the settlement call. Formatting the result happens AFTER the try, so a
  // formatter error on an already-SETTLED response can never be caught here and misreported as
  // "pre-settlement, safe to retry" — that would be a double-pay path (Codex BLOCKER).
  let res: Awaited<ReturnType<typeof client.payAndFetch>>;
  try {
    res = await client.payAndFetch(
      args.url,
      { method: args.method ?? "GET", ...(args.body ? { body: args.body, headers: { "Content-Type": "application/json" } } : {}) },
      {
        deposit: {
          nullifier: note.nullifier,
          secret: note.secret,
          value: note.value,
          label: note.label,
          commitment: note.commitment,
          index: note.index,
          recoverable: note.recoverable,
        },
        maxAmountAtomic,
        // The facilitator still discloses the pilot state; this just consents to it.
        acceptNotPrivate: args.acceptNotPrivate,
        // The SDK free-probes by default and refuses BEFORE spending if the seller runs a
        // bespoke facilitator. `skipProbe` bypasses it for a seller already proven.
        skipProbe: args.skipProbe,
        // No mnemonic needed: change notes are parent-keyed (0.3.0+), so the SDK derives
        // the change from the note being spent and a lost response is re-derivable.
      },
    );
  } catch (e) {
    // This catch must NEVER throw AND must NEVER over-promise safety. A throw from payAndFetch is
    // UNCERTAIN: core does not type its errors, and some throws happen AFTER the settlement is
    // broadcast (a post-settle body-parse error, or an unguarded String() on a hostile value inside
    // core), so the note MAY already be spent. Default EVERY throw to safeToRetry:false — a blind retry
    // re-selects a DIFFERENT note and would double-pay. Coerce the message safely (a null-prototype
    // object can make String() itself throw, so wrap it and fall back to a fixed string).
    let msg = "unknown error";
    try {
      msg = String((e as { message?: unknown } | null | undefined)?.message ?? e ?? "unknown error").slice(0, 300);
    } catch {
      /* keep the fixed fallback */
    }
    return JSON.stringify(
      {
        paid: false,
        outcome: "uncertain",
        safeToRetry: false,
        error: msg,
        note: "The payment errored and settlement MAY have broadcast — the note may already be spent. Do NOT blindly retry: this tool would spend a DIFFERENT note. Run `balance` and confirm you were NOT charged before paying again.",
      },
      null,
      2,
    );
  }

  // Defensive formatter: a malformed amount on a SETTLED response must NOT throw (that would fall
  // into the pre-settlement catch above and mislabel a spent note as safe-to-retry). Swallow instead.
  const usd = (v: unknown): string | undefined => {
    try {
      return v == null ? undefined : formatUnits(BigInt(v as string), 6);
    } catch {
      return undefined;
    }
  };

  // Money-safety switch on the SDK's discriminated `outcome`. IMPORTANT: this tool re-selects a note
  // from a fresh balance on EVERY call, so "retry the same pay" does NOT resubmit the same note — on
  // any spent-or-maybe-spent outcome the agent must run `balance` first (safeToRetry:false); a blind
  // retry would pick a DIFFERENT note and pay twice.

  // refused: probe refused BEFORE settling — the note was never touched.
  if (res.outcome === "refused") {
    // If the refusal is a SELLER-SIDE facilitator fault (CoinGecko-class), say so explicitly and
    // log it — the same payment works with other x402 sellers, so this is NOT a zBase problem.
    const sellerFault = res.sellerFault ?? diagnoseSellerFacilitatorFault(res.response);
    if (sellerFault) {
      console.error(`[zbase-pay] refused: ${args.url} — seller-side facilitator fault (NOT zBase). Note untouched.`);
    }
    return JSON.stringify(
      {
        paid: false,
        outcome: "refused",
        compatible: false,
        safeToRetry: true,
        ...(sellerFault ? { sellerFault } : {}),
        reason: res.probeReason,
        note: sellerFault
          ? "Refused BEFORE any settlement — your note is UNTOUCHED. This is the SELLER's x402 facilitator faulting on a standard payment (not a zBase or payment problem); the same payment succeeds with other x402 sellers. Pick a different seller."
          : "Free-probe refused BEFORE any settlement — your note is UNTOUCHED. This seller will not accept a standard zBase payment (bespoke facilitator or non-Base/USDC offer). Fix the seller, then retrying is safe.",
      },
      null,
      2,
    );
  }

  // free: no 402 was returned — nothing was paid.
  if (res.outcome === "free") {
    return JSON.stringify(
      { paid: false, outcome: "free", safeToRetry: true, status: res.status, response: res.response, note: "The resource was free; no payment made." },
      null,
      2,
    );
  }

  // uncertain: the note MAY already be spent. Because this tool re-selects on the next call, a blind
  // retry can pick a DIFFERENT note and double-pay. Force a balance check first.
  if (res.outcome === "uncertain") {
    return JSON.stringify(
      {
        paid: false,
        outcome: "uncertain",
        safeToRetry: false,
        status: res.status,
        response: res.response,
        note: "Settlement UNCERTAIN — the note MAY already be spent. Do NOT retry blindly: this tool would select a DIFFERENT note and pay twice. Run `balance` and inspect the chain; only pay again if you confirm you were NOT charged.",
      },
      null,
      2,
    );
  }

  // delivered: settled — the note IS SPENT. `status` is the seller's HTTP response. The change note
  // (res.nextDeposit) carries BEARER SECRETS and must NEVER enter the transcript — summarise it as
  // value + recoverable only. fundingTxHash and amount are public on-chain.
  const delivered = res.status >= 200 && res.status < 300;
  const changeNote =
    res.nextDeposit && typeof res.nextDeposit === "object"
      ? { valueUSDC: usd(res.nextDeposit.value), recoverable: res.nextDeposit.recoverable !== false }
      : undefined;
  const amountUSDC = usd(res.amount);
  // Settle-but-not-deliver: if the seller's OWN facilitator faulted on the payment
  // (CoinGecko-class), diagnose it so the user/agent knows the note was spent because the
  // SELLER's facilitator failed — not because of a zBase or payment error. Log it too.
  const sellerFault = delivered ? undefined : diagnoseSellerFacilitatorFault(res.response);
  if (sellerFault) {
    console.error(`[zbase-pay] settled but seller did not deliver: ${args.url} — seller-side facilitator fault (NOT zBase). Note spent; change recoverable from seed.`);
  }
  return JSON.stringify(
    {
      paid: true,
      // Was hardcoded "delivered" even when `delivered` was false — contradictory output from the
      // exact contract this product sells. Now mirrors the core client's discriminated outcome.
      outcome: delivered ? "delivered" : "settled_not_delivered",
      delivered,
      safeToRetry: false,
      status: res.status,
      response: res.response,
      payer: res.payer,
      ...(amountUSDC ? { amountUSDC } : {}),
      ...(res.fundingTxHash ? { fundingTxHash: res.fundingTxHash } : {}),
      ...(changeNote ? { changeNote } : {}),
      ...(sellerFault ? { sellerFault } : {}),
      privacy: res.privacy,
      note: delivered
        ? "Paid from the pool and the provider delivered. It saw a single-use address with no link to your funding wallet. Change note derived from your seed — nothing to save."
        : sellerFault
          ? "Settled from the pool — the note IS SPENT (change recoverable from your seed) — but the SELLER's x402 facilitator faulted and returned no data. This is a SELLER-SIDE issue, NOT zBase: the same payment succeeds with other x402 sellers. Do NOT blindly retry this seller (it would spend a DIFFERENT note). Use a different seller."
          : "Settled from the pool — the note IS SPENT (change recoverable from your seed) — but the provider did not return a 2xx. Do NOT blindly retry: this tool would spend a DIFFERENT note. Run `balance` and inspect the response before paying again.",
    },
    null,
    2,
  );
}
