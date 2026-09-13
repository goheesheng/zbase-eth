import { NextResponse } from "next/server";
import { createPublicClient, http, type Hex } from "viem";
import { getActiveStack, getActiveChain } from "@/lib/contracts";
import {
  verifyExactPaymentLocal,
  settleTakeAtomic,
  splitSignature,
  USDC_TRANSFER_WITH_AUTHORIZATION_ABI,
  type ExactAuthorization,
} from "@/lib/x402-facilitator";
import { sendPostmanTx } from "@/lib/postman-signer";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

/**
 * POST /api/facilitator/x402/settle — SPEC-COMPLIANT x402 facilitator settle.
 *
 * Body: { x402Version, paymentPayload, paymentRequirements }.
 * Returns the standard `SettleResponse` { success, transaction, network, payer, errorReason?, errorMessage? }.
 *
 * Re-verifies the payment, guards nonce replay, broadcasts the buyer's gasless
 * EIP-3009 `transferWithAuthorization` to the seller's payTo via the postman
 * (funds land in the seller's wallet immediately), and RECORDS a flat 5% take
 * (inert while FEE_REQUIRED=false; EIP-3009 is fixed-recipient so it's billed,
 * not skimmed on-chain).
 */
const ERC20_BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const paymentPayload = body.paymentPayload;
    const requirements = body.paymentRequirements ?? paymentPayload?.accepted;
    if (!paymentPayload || !requirements) {
      return NextResponse.json({ success: false, errorReason: "bad_request", errorMessage: "paymentPayload and paymentRequirements are required" }, { status: 400 });
    }

    const auth = (paymentPayload.payload as { authorization?: ExactAuthorization })?.authorization;
    const signature = (paymentPayload.payload as { signature?: string })?.signature as Hex | undefined;
    if (!auth || !signature) {
      return NextResponse.json({ success: false, errorReason: "invalid_payment", errorMessage: "missing signature/authorization" }, { status: 400 });
    }

    // Rate-limit on the EIP-3009 nonce (single-use, revealed on-chain — privacy-neutral).
    const rl = await checkRateLimit(request, "settle", `x402:${String(auth.nonce).toLowerCase()}`);
    if (!rl.success) return rateLimitResponse(rl);

    const stack = getActiveStack();
    const chain = getActiveChain();
    if (requirements.network !== stack.facilitatorNetwork) {
      return NextResponse.json({ success: false, errorReason: "unsupported_network", errorMessage: `This facilitator settles ${stack.facilitatorNetwork}.` }, { status: 400 });
    }
    if (requirements.asset?.toLowerCase() !== stack.usdc.toLowerCase()) {
      return NextResponse.json({ success: false, errorReason: "unsupported_asset", errorMessage: `Only ${stack.usdc} is settled here.` }, { status: 400 });
    }

    const local = await verifyExactPaymentLocal(paymentPayload, requirements, Math.floor(Date.now() / 1000));
    if (!local.valid) {
      return NextResponse.json({ success: false, errorReason: "invalid_payment", errorMessage: local.reason }, { status: 400 });
    }

    // Balance re-check (a stale verify could race a spend elsewhere).
    const publicClient = createPublicClient({ chain: chain.chain, transport: http(chain.readRpcUrl) });
    const balance = (await publicClient.readContract({
      address: stack.usdc as Hex,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [auth.from as Hex],
    })) as bigint;
    if (balance < BigInt(requirements.amount)) {
      return NextResponse.json({ success: false, errorReason: "insufficient_funds", errorMessage: "Payer balance below the required amount." }, { status: 400 });
    }

    // Broadcast the buyer's gasless authorization. USDC pulls `value` from `from`
    // to `to` (the seller's payTo). The postman pays gas.
    const { v, r, s } = splitSignature(signature);
    let txHash: `0x${string}`;
    try {
      txHash = await sendPostmanTx({
        address: stack.usdc as Hex,
        abi: USDC_TRANSFER_WITH_AUTHORIZATION_ABI,
        functionName: "transferWithAuthorization",
        args: [
          auth.from as Hex,
          auth.to as Hex,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce as Hex,
          v,
          r,
          s,
        ],
        chain: chain.chain,
        writeRpcUrl: chain.writeRpcUrl,
        readRpcUrl: chain.readRpcUrl,
      });
    } catch (e) {
      return NextResponse.json({ success: false, errorReason: "settlement_failed", errorMessage: (e as Error).message?.slice(0, 200) }, { status: 502 });
    }

    // Record the flat 5% take (inert until FEE_REQUIRED=true; EIP-3009 pays the
    // seller the FULL amount, so the take is billed to the registered seller, not
    // skimmed here). See revenue model.
    const takeAtomic = settleTakeAtomic(requirements.amount).toString();
    console.log(`[x402-facilitator] settled ${requirements.amount} to ${auth.to} tx=${txHash} recorded-take(5%)=${takeAtomic}`);

    return NextResponse.json({
      success: true,
      transaction: txHash,
      network: requirements.network,
      payer: auth.from,
    });
  } catch (error) {
    return NextResponse.json({ success: false, errorReason: "error", errorMessage: (error as Error).message?.slice(0, 200) }, { status: 500 });
  }
}
