import { NextResponse } from "next/server";
import { isAddress, getAddress, type Hex } from "viem";
import { getActiveStack } from "@/lib/contracts";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { createB1DepositAuthority } from "@/lib/forwarding-authority";
import { createEip3009SweepAuthority, type SweepAuthorization } from "@/lib/forwarding-sweep";

/**
 * POST /api/forwarding/sweep — "I sent USDC to my wallet; put it in the pool."
 *
 * The client-initiated half of the forwarding rail. The user's wallet holds the key
 * to the receiving address, so IT signs; the server only submits. There is no
 * standing authorization and no server-held claim on anyone's funds — the daemon
 * (scripts/forwarding-engine.ts) can't do this precisely because it has no key, which
 * is why it is being demoted to reconciliation.
 *
 * Body:
 *   {
 *     authorization: { from, to, value, validAfter, validBefore, nonce },  // EIP-3009
 *     signature: "0x…",           // ReceiveWithAuthorization, signed by `from`
 *     precommitment: "12345…"     // where the pool credits the resulting note
 *   }
 *
 * Flow: submit the authorization (postman receives the USDC) → measure the actual
 * balance delta → approve if needed → Entrypoint.deposit(measured delta,
 * precommitment). See forwarding-sweep.ts for why the delta is measured rather than
 * trusted, and forwarding-authority.ts for what happens without a sweep at all.
 *
 * SELF-AUTHORIZING: the EIP-3009 signature IS the authorization. We add no bearer
 * check because there is nothing extra to prove — only the holder of `from`'s key can
 * produce it, and `receiveWithAuthorization` requires msg.sender == to, so a captured
 * body is useless to anyone but this postman. USDC's own `authorizationState` mapping
 * is the hard replay guard.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      authorization?: SweepAuthorization;
      signature?: string;
      precommitment?: string;
    };

    const auth = body.authorization;
    const signature = body.signature;
    const precommitment = body.precommitment;

    if (!auth || typeof auth !== "object") {
      return NextResponse.json({ error: "Missing `authorization`." }, { status: 400 });
    }
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return NextResponse.json(
        { error: "`signature` must be a 65-byte hex EIP-712 signature." },
        { status: 400 },
      );
    }
    if (typeof precommitment !== "string" || !/^[0-9]+$/.test(precommitment) || BigInt(precommitment) <= 0n) {
      return NextResponse.json(
        { error: "`precommitment` must be a positive decimal field element — it is where your note is credited." },
        { status: 400 },
      );
    }
    if (!auth.from || !isAddress(auth.from) || !auth.to || !isAddress(auth.to)) {
      return NextResponse.json({ error: "authorization.from/.to must be addresses." }, { status: 400 });
    }
    for (const k of ["value", "validAfter", "validBefore"] as const) {
      if (typeof auth[k] !== "string" || !/^[0-9]+$/.test(auth[k])) {
        return NextResponse.json({ error: `authorization.${k} must be a decimal string.` }, { status: 400 });
      }
    }
    if (typeof auth.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) {
      return NextResponse.json({ error: "authorization.nonce must be a 32-byte hex value." }, { status: 400 });
    }
    const value = BigInt(auth.value);
    if (value <= 0n) {
      return NextResponse.json({ error: "authorization.value must be > 0." }, { status: 400 });
    }

    // Rate-limit on the EIP-3009 nonce, NOT the address. The nonce is single-use and
    // revealed on-chain anyway, so keying on it is privacy-neutral; keying on
    // `from` would build a server-side per-user request log on a privacy rail
    // (mirrors x402/settle). Soft guard only — USDC's authorizationState is the hard
    // one, and the in-memory rate-limit fallback is per-instance.
    const rl = await checkRateLimit(request, "sweep", `sweep:${auth.nonce.toLowerCase()}`);
    if (!rl.success) return rateLimitResponse(rl);

    const stack = getActiveStack();
    if (!stack.entrypoint || /^0x0{40}$/i.test(stack.entrypoint)) {
      return NextResponse.json(
        { error: `Pool not provisioned on ${stack.facilitatorNetwork} — sweep unavailable.` },
        { status: 503 },
      );
    }

    const watched = getAddress(auth.from) as `0x${string}`;

    // The sweep moves the user's funds to the postman; the authority then deposits
    // EXACTLY what arrived. Passing the sweeper is what makes createB1DepositAuthority
    // willing to run at all — without it, it throws rather than spend the treasury.
    const sweep = createEip3009SweepAuthority({
      authorization: { ...auth, from: watched, to: getAddress(auth.to) as `0x${string}` },
      signature: signature as Hex,
    });
    const authority = createB1DepositAuthority(sweep);

    const { txHash } = await authority.deposit({
      watchedAddress: watched,
      amount: value,
      precommitment,
    });

    // Do NOT echo the precommitment. /api/forwarding/register's GET deliberately
    // strips it, because publishing (address, precommitment) lets an observer link a
    // public receiving address to a pool deposit — exactly the unlinkability this
    // rail exists to provide. The caller already has it; there is nothing to return.
    return NextResponse.json(
      { swept: true, depositTxHash: txHash },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = (e as Error).message ?? "Unknown error";
    // A refusal (bad from/to, no sweep, zero delta) is the caller's problem and their
    // funds are untouched — a 400 tells them to fix and retry. Anything else is ours.
    const isCallerFault =
      /is not the watched address|is not the postman|moved 0 atomic USDC|REFUSED/i.test(msg);
    return NextResponse.json(
      { swept: false, error: msg.slice(0, 300) },
      { status: isCallerFault ? 400 : 500 },
    );
  }
}
