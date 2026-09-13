import { NextResponse } from "next/server";
import { createPublicClient, http, type Hex } from "viem";
import { getActiveStack, getActiveChain } from "@/lib/contracts";
import { verifyExactPaymentLocal } from "@/lib/x402-facilitator";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

/**
 * POST /api/facilitator/x402/verify — SPEC-COMPLIANT x402 facilitator verify.
 *
 * Body: { x402Version, paymentPayload, paymentRequirements }.
 * Returns the standard `VerifyResponse` { isValid, invalidReason?, invalidMessage?, payer? }.
 *
 * Unlike the pool routes (/verify, /settle) this speaks the STANDARD interface so
 * a seller's stock x402 middleware can point `facilitatorUrl` here. It verifies a
 * standard EIP-3009 `exact` payment: recovers the signer off-chain, then checks the
 * payer's on-chain USDC balance covers the amount.
 */
const ERC20_BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export async function POST(request: Request) {
  try {
    const rl = await checkRateLimit(request, "verify");
    if (!rl.success) return rateLimitResponse(rl);

    const body = await request.json();
    const paymentPayload = body.paymentPayload;
    const requirements = body.paymentRequirements ?? paymentPayload?.accepted;
    if (!paymentPayload || !requirements) {
      return NextResponse.json({ isValid: false, invalidReason: "bad_request", invalidMessage: "paymentPayload and paymentRequirements are required" }, { status: 400 });
    }

    const stack = getActiveStack();
    if (requirements.network !== stack.facilitatorNetwork) {
      return NextResponse.json({ isValid: false, invalidReason: "unsupported_network", invalidMessage: `This facilitator settles ${stack.facilitatorNetwork}, not ${requirements.network}.` });
    }
    if (requirements.asset?.toLowerCase() !== stack.usdc.toLowerCase()) {
      return NextResponse.json({ isValid: false, invalidReason: "unsupported_asset", invalidMessage: `Only ${stack.usdc} is settled here.` });
    }

    const local = await verifyExactPaymentLocal(paymentPayload, requirements, Math.floor(Date.now() / 1000));
    if (!local.valid) {
      return NextResponse.json({ isValid: false, invalidReason: "invalid_payment", invalidMessage: local.reason });
    }

    // On-chain: the payer EOA must actually hold >= value (else settle would revert).
    const chain = getActiveChain();
    const publicClient = createPublicClient({ chain: chain.chain, transport: http(chain.readRpcUrl) });
    const balance = (await publicClient.readContract({
      address: stack.usdc as Hex,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [local.payer as Hex],
    })) as bigint;
    if (balance < BigInt(requirements.amount)) {
      return NextResponse.json({ isValid: false, invalidReason: "insufficient_funds", invalidMessage: "Payer balance below the required amount." });
    }

    return NextResponse.json({ isValid: true, payer: local.payer });
  } catch (error) {
    return NextResponse.json({ isValid: false, invalidReason: "error", invalidMessage: (error as Error).message?.slice(0, 200) }, { status: 500 });
  }
}
