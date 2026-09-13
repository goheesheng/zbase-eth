import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { getActiveStack, getActiveChain } from "@/lib/contracts";
import { internalUrl } from "@/lib/internal-url";
import { settleReadinessVerdict } from "@/lib/settle-readiness";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import {
  deriveX402PayerKey,
  buildExactPaymentHeader,
  chainIdFromCaip2,
} from "@/lib/x402-exact-payment";
import {
  settlementStoreAvailable,
  getSettlement,
  reserveSettlement,
  finalizeSettlement,
  releaseSettlement,
} from "@/lib/settlement-store";
import { computeNullifierHash } from "@zbase-protocol/core";
import { privateKeyToAccount } from "viem/accounts";

/** `mapping(uint256 => bool) public nullifierHashes` — chain truth for "already spent". */
const POOL_SPENT_ABI = [
  { name: "nullifierHashes", type: "function", stateMutability: "view", inputs: [{ name: "h", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** On-chain backstop: has this note's nullifier already been spent? (store-loss recovery.) */
async function nullifierSpentOnChain(nullifier: string): Promise<boolean> {
  const stack = getActiveStack();
  const chain = getActiveChain();
  const client = createPublicClient({ chain: chain.chain, transport: http(chain.readRpcUrl) });
  const hash = computeNullifierHash(nullifier);
  return (await client.readContract({
    address: stack.usdcPool as `0x${string}`,
    abi: POOL_SPENT_ABI,
    functionName: "nullifierHashes",
    args: [BigInt(hash)],
  })) as boolean;
}

/**
 * POST /api/facilitator/settle-x402
 *
 * Standard-x402 private settlement. Unlike /api/facilitator/settle (which pays
 * the provider directly from the pool and returns a proprietary X-Payment-TxHash
 * that only zBase-aware servers accept), this route produces a SPEC-STANDARD
 * `X-PAYMENT` header (EIP-3009 `exact` scheme) that ANY x402 provider's own
 * facilitator will verify + broadcast — while keeping the payer unlinkable.
 *
 * Flow:
 *   1. Derive a single-use payer EOA `E` deterministically from the note.
 *   2. Withdraw the exact amount from the pool to `E` (ZK; no link to depositor).
 *   3. `E` signs transferWithAuthorization(E -> payTo, amount).
 *   4. Return the base64 `X-PAYMENT` header. If `url` is supplied, also proxy the
 *      provider request with the header attached and return its response.
 *
 * Body:
 *   {
 *     accepts:  { scheme:"exact", network, asset, amount|maxAmountRequired,
 *                 payTo, maxTimeoutSeconds?, extra:{ name, version } },
 *     zbaseDeposit: { nullifier, secret, value, label, commitment },
 *     x402Version?: number,          // echoed; defaults to 2
 *     url?: string, method?: string, // optional one-shot provider proxy
 *     body?: unknown, headers?: object
 *   }
 *
 * SECURITY: the note secrets and the derived key never leave this backend and
 * are never logged. See docs/x402 facilitator model.
 */
export async function POST(request: Request) {
  // MONEY-SAFETY (P1, 2026-08-03): declared OUTSIDE the try so the catch below can see it.
  // Once the withdrawal request has been dispatched, the pool withdrawal MAY have broadcast —
  // so ANY subsequent throw (including an unparseable/truncated /api/withdraw body) must be
  // reported as UNCERTAIN, never as a bare settled:false. The SDK treats a parseable
  // settled:false WITHOUT `uncertain` as PROVEN unspent and lets the caller pay again from a
  // different note — i.e. a real double-spend of the customer's funds.
  let withdrawDispatched = false;
  try {
    // The launch gate, enforced — not just published. /supported reporting
    // customerReady:false while this route settles anyway means a buyer pays, gets
    // their data, and believes it was private when it was not. Checked first: a
    // refusal must cost nothing and leave the note unspent.
    const verdict = await settleReadinessVerdict();
    if (!verdict.allow) return verdict.refusal;

    const body = await request.json();
    const accepts = body.accepts ?? body.paymentDetails;
    const zbaseDeposit = body.zbaseDeposit ?? body.zx402Deposit;

    if (!accepts || typeof accepts !== "object") {
      return NextResponse.json(
        { settled: false, error: "Missing `accepts` (an entry from the provider's 402 response)." },
        { status: 400 },
      );
    }
    if ((accepts.scheme ?? "exact") !== "exact") {
      return NextResponse.json(
        { settled: false, error: `Only the "exact" scheme is supported; got "${accepts.scheme}".` },
        { status: 400 },
      );
    }

    const payTo: string | undefined = accepts.payTo;
    const amountAtomic: string | undefined =
      accepts.amount?.toString() ?? accepts.maxAmountRequired?.toString();
    const asset: string | undefined = accepts.asset;
    const network: string | undefined = accepts.network;
    const extra = accepts.extra ?? {};

    if (!payTo || !amountAtomic || !asset || !network) {
      return NextResponse.json(
        { settled: false, error: "accepts must include payTo, amount (or maxAmountRequired), asset, and network." },
        { status: 400 },
      );
    }
    if (!zbaseDeposit?.nullifier || !zbaseDeposit?.secret || !zbaseDeposit?.value ||
        !zbaseDeposit?.label || !zbaseDeposit?.commitment) {
      return NextResponse.json(
        { settled: false, error: "Missing zbaseDeposit (nullifier, secret, value, label, commitment). Deposit USDC via the zBase app first." },
        { status: 400 },
      );
    }

    // Rate-limit on the on-chain-revealed nullifier (privacy-neutral, mirrors /settle).
    const rl = await checkRateLimit(request, "settle", `${network}:${String(zbaseDeposit.nullifier).toLowerCase()}`);
    if (!rl.success) return rateLimitResponse(rl);

    // The provider's facilitator settles on ITS chain; we can only fund from the
    // pool's active network/asset. Reject mismatches loudly rather than pay into
    // a token/chain we can't source.
    const stack = getActiveStack();
    if (network !== stack.facilitatorNetwork) {
      return NextResponse.json(
        { settled: false, error: `Provider wants ${network} but this pool settles on ${stack.facilitatorNetwork}. Fund a pool on the provider's network.` },
        { status: 400 },
      );
    }
    if (asset.toLowerCase() !== stack.usdc.toLowerCase()) {
      return NextResponse.json(
        { settled: false, error: `Provider asset ${asset} is not the pool asset ${stack.usdc}. Only the pool's USDC is spendable.` },
        { status: 400 },
      );
    }
    if (!extra.name || !extra.version) {
      return NextResponse.json(
        { settled: false, error: "accepts.extra must include the token's EIP-712 { name, version } (needed to sign transferWithAuthorization)." },
        { status: 400 },
      );
    }

    let chainId: number;
    try {
      chainId = chainIdFromCaip2(network);
    } catch (e) {
      return NextResponse.json({ settled: false, error: (e as Error).message }, { status: 400 });
    }

    // 1. Derive the single-use payer EOA (deterministic → crash-recoverable).
    const payerKey = deriveX402PayerKey(zbaseDeposit, payTo);
    const payer = privateKeyToAccount(payerKey).address;

    // 2. Build + sign the EIP-3009 payment header BEFORE the withdrawal. The payer key is
    //    deterministic, so the authorization can be signed before the withdrawal funds E.
    //    Doing it FIRST means a build/sign failure (bad maxTimeoutSeconds/address, signing
    //    error) returns settled:false with the note UNSPENT — the withdrawal (step 3) is then
    //    the LAST mutating step, so settled:false reliably means "note not spent, safe to
    //    retry." Previously this ran AFTER the withdrawal, so a build failure spent the note
    //    yet reported settled:false (Codex 2026-07-20).
    const maxTimeoutSeconds = Number(accepts.maxTimeoutSeconds ?? 300);
    const x402Version = Number(body.x402Version ?? accepts.x402Version ?? 2);
    let payment: Awaited<ReturnType<typeof buildExactPaymentHeader>>;
    try {
      payment = await buildExactPaymentHeader({
        privateKey: payerKey,
        payTo,
        amountAtomic,
        asset,
        usdcName: String(extra.name),
        usdcVersion: String(extra.version),
        chainId,
        network,
        x402Version,
        maxTimeoutSeconds,
        nowSec: Math.floor(Date.now() / 1000),
      });
    } catch (e) {
      return NextResponse.json(
        { settled: false, error: `Failed to build the payment header (note unspent): ${(e as Error).message}` },
        { status: 400 },
      );
    }

    // 3. IDEMPOTENT WITHDRAWAL (Part 2). This is where the note is SPENT. A lost HTTP response
    //    must not let a retry withdraw twice — settlement is idempotent on the single-use
    //    nullifier (see settlement-store.ts) with an on-chain nullifierHashes backstop.
    const nullifier = String(zbaseDeposit.nullifier);
    const storeOn = settlementStoreAvailable();
    let xPaymentHeader = payment.header;
    let effPayer: string = payer;
    let withdrawData: { txHash?: string; nextDeposit?: unknown; changeNoteSupported?: unknown } = {};
    let leaseToken = "";

    const existing = storeOn ? await getSettlement(network, nullifier) : null;
    if (existing?.status === "settled") {
      // REPLAY of a completed settlement — re-serve the stored header, NO second withdrawal.
      xPaymentHeader = existing.xPayment ?? payment.header;
      effPayer = existing.payer ?? payer;
      withdrawData = { txHash: existing.fundingTxHash, nextDeposit: existing.nextDeposit };
    } else if (existing?.status === "in-flight") {
      // A first attempt is mid-withdrawal. Do NOT start a second — tell the caller to poll.
      return NextResponse.json(
        { settled: false, settling: true, error: "A settlement for this note is already in progress. Retry shortly; do not start a new payment." },
        { status: 409 },
      );
    } else {
      // No record. Backstop: did a prior lost/released attempt already spend this note on-chain?
      let alreadySpent = false;
      try {
        alreadySpent = await nullifierSpentOnChain(nullifier);
      } catch {
        /* backstop read failed — fall through to reserve + withdraw (prior behavior) */
      }
      if (alreadySpent) {
        // The note IS spent (an earlier attempt withdrew) but this server has NO record of that
        // settlement. `nullifierHashes=true` proves only that the note was consumed — not its
        // recipient, amount, funding tx, change note, or the payment header that was served. We
        // must NOT fabricate a confident success here: re-signing a fresh header binds a NEW
        // random nonce to a payer derived from the CURRENT request's `payTo`, so if the seller's
        // terms changed since the lost attempt the authorization would be unfunded, and even an
        // identical retry cannot recover the original `nextDeposit`. Report UNCERTAIN instead:
        // the note is already spent (no double-spend risk — the caller must NOT re-pay), but this
        // settlement cannot be reconstructed. The change note is seed-recoverable from the parent.
        return NextResponse.json(
          {
            settled: false,
            uncertain: true,
            alreadySpent: true,
            error:
              "This note was already spent by a prior settlement whose record is lost (store loss or TTL). " +
              "Do NOT re-pay: no double-spend is possible, but this settlement cannot be reconstructed. " +
              "The change note is recoverable from your seed (recoverChangeNotes).",
          },
          { status: 409 },
        );
      } else {
        const reservation = storeOn ? await reserveSettlement(network, nullifier) : { ok: true, token: "" };
        leaseToken = reservation.token;
        if (!reservation.ok) {
          return NextResponse.json(
            { settled: false, settling: true, error: "A settlement for this note is already in progress. Retry shortly." },
            { status: 409 },
          );
        }
        // Withdraw the exact amount to E — the LAST mutating step. nextNullifier/nextSecret:
        // the caller's seed-derived CHANGE-note secrets, forwarded verbatim so the change note
        // is re-derivable from their seed (otherwise it is randomised, handed back once, and a
        // crash before persisting loses the remainder — 0.985 USDC, 2026-07-16).
        // Set BEFORE the fetch: the request itself may broadcast, so from this line on every
        // failure path is ambiguous by default (see `withdrawDispatched` at the top of POST).
        withdrawDispatched = true;
        const withdrawRes = await fetch(internalUrl(request, "/api/withdraw"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nullifier: zbaseDeposit.nullifier,
            secret: zbaseDeposit.secret,
            value: zbaseDeposit.value,
            label: zbaseDeposit.label,
            commitment: zbaseDeposit.commitment,
            recipient: payer,
            amountAtomic,
            ...(body.nextNullifier !== undefined ? { nextNullifier: body.nextNullifier } : {}),
            ...(body.nextSecret !== undefined ? { nextSecret: body.nextSecret } : {}),
          }),
        });
        withdrawData = await withdrawRes.json();
        if (!withdrawRes.ok || (withdrawData as { error?: string }).error) {
          // Distinguish PROVEN pre-spend failure from AMBIGUOUS failure. /api/withdraw broadcasts
          // the withdrawal, then waits for a receipt: a 400 (bad request) or 503 (indexer cold)
          // is rejected BEFORE any transaction, so the note is definitively unspent. But a 500 (or
          // any other status) can be an RPC timeout AFTER broadcast — the note may already be
          // spent. Releasing the lease there would let a retry launch a SECOND proof + withdrawal;
          // the pool nullifier stops both from landing, but the API could still authorize spending
          // the resulting change note. So:
          //   - 400 / 503  → PROVEN unspent: release the lease, safe to retry the SAME note.
          //   - otherwise  → UNCERTAIN: keep the lease (retries get 409 → poll), never release.
          const provenUnspent = withdrawRes.status === 400 || withdrawRes.status === 503;
          if (storeOn && provenUnspent) await releaseSettlement(network, nullifier, leaseToken);
          const errMsg = (withdrawData as { error?: string }).error || "Pool withdrawal to payer EOA failed";
          if (provenUnspent) {
            return NextResponse.json(
              {
                settled: false,
                error: errMsg,
                details:
                  withdrawRes.status === 400
                    ? "Rejected before spending. The note is unspent — fix the request and retry."
                    : "Indexer cold before any transaction. The note is unspent; retry re-derives the same payer EOA.",
              },
              { status: withdrawRes.status === 400 ? 400 : 503 },
            );
          }
          return NextResponse.json(
            {
              settled: false,
              uncertain: true,
              error: errMsg,
              details:
                "The withdrawal may have broadcast before failing — the note MAY be spent. Do NOT re-pay from a " +
                "different note; retry THIS settlement (idempotent on the nullifier) to replay or resolve it.",
            },
            { status: 500 },
          );
        }
        // Finalize so a lost-response retry re-serves THIS exact header (no second withdrawal).
        // The withdrawal already SUCCEEDED and the note is spent, so a finalize (Redis) failure
        // must NEVER roll back to settled:false — that would read as "note unspent" and invite a
        // double-pay. Swallow it: the on-chain nullifierHashes backstop still covers store loss,
        // and everything the caller needs (header, payer, tx) is returned below regardless.
        if (storeOn) {
          try {
            await finalizeSettlement(network, nullifier, leaseToken, {
              payer,
              xPayment: payment.header,
              amount: amountAtomic,
              fundingTxHash: (withdrawData as { txHash?: string }).txHash,
              nextDeposit: (withdrawData as { nextDeposit?: unknown }).nextDeposit,
            });
          } catch {
            /* note is already spent — never fail a completed settlement on a store write */
          }
        }
      }
    }

    // 4. The payment header was already built + signed in step 2 (before the withdrawal).
    //    Optional one-shot proxy so the caller gets data in a single round trip.
    let providerResponse: unknown = undefined;
    let providerStatus: number | undefined = undefined;
    if (typeof body.url === "string" && body.url.length > 0) {
      try {
        const method = (body.method ?? "GET").toUpperCase();
        const res = await fetch(body.url, {
          method,
          headers: {
            "X-PAYMENT": xPaymentHeader,
            ...(body.headers && typeof body.headers === "object" ? body.headers : {}),
            ...(body.body != null ? { "Content-Type": "application/json" } : {}),
          },
          ...(body.body != null ? { body: JSON.stringify(body.body) } : {}),
        });
        providerStatus = res.status;
        const ct = res.headers.get("content-type") || "";
        providerResponse = ct.includes("application/json") ? await res.json() : await res.text();
      } catch (e) {
        providerResponse = { error: (e as Error).message?.slice(0, 300) };
      }
    }

    return NextResponse.json({
      settled: true,
      scheme: "exact",
      network,
      // The standard header the caller attaches to the provider request. Any
      // x402 provider's facilitator verifies + broadcasts payer -> payTo.
      xPayment: xPaymentHeader,
      // The single-use payer EOA the pool funded. No on-chain link to the depositor.
      payer: effPayer,
      amount: amountAtomic,
      // Pool withdrawal that funded the payer (public; unlinkable to depositor).
      fundingTxHash: withdrawData.txHash,
      // Change note for the next settle (caller keeps it; secrets stay with caller).
      nextDeposit: withdrawData.nextDeposit,
      changeNoteSupported: withdrawData.changeNoteSupported,
      expiresAt: Math.floor(Date.now() / 1000) + maxTimeoutSeconds,
      ...(providerStatus !== undefined ? { providerStatus, providerResponse } : {}),
      // The privacy claim for THIS payment, from the same evaluation that decided whether
      // it was allowed at all — so a permitted payment can never carry a claim the gates
      // do not back.
      //
      // This block used to hardcode `linkable: false` with "there is no on-chain link
      // between the depositor and this payment" on EVERY success. That sentence is only
      // true once the anonymity set is large; at a set of one it is precisely false, and
      // it was being told to the caller as fact. The mechanism (a fresh EOA funded by a
      // Groth16 withdrawal) is real, but a mechanism is not a guarantee: it hides you IN
      // A CROWD, and it cannot hide you when there is no crowd.
      privacy: {
        ...verdict.privacy,
        method: "Groth16 ZK-SNARK (Privacy Pools) + single-use payer EOA",
        // `linkable` is the inverse of the claim we can actually back, not a constant.
        linkable: !verdict.privacy.private,
        amountVisible: true,
        note: "The provider is paid by a fresh EOA funded from the pool. The amount is visible on-chain regardless of set size (see threat model).",
      },
    });
  } catch (error) {
    const msg = (error as Error).message?.slice(0, 300) || "Unknown error";
    // If the withdrawal was already dispatched, the note MAY be spent (e.g. the broadcast
    // succeeded but /api/withdraw's response body was truncated, so `.json()` threw). Reporting
    // a bare settled:false here would be read as PROVEN unspent and authorise paying again from
    // another note. Fail ambiguous, never optimistic.
    if (withdrawDispatched) {
      return NextResponse.json(
        {
          settled: false,
          uncertain: true,
          error: msg,
          details:
            "The withdrawal had already been dispatched when this failed — the note MAY be spent. " +
            "Do NOT re-pay from a different note; retry THIS settlement (idempotent on the nullifier) " +
            "to replay or resolve it.",
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ settled: false, error: msg }, { status: 500 });
  }
}
