import { NextResponse } from "next/server";
import { getActiveStack } from "@/lib/contracts";
import { internalUrl } from "@/lib/internal-url";

/**
 * POST /api/x402-pay
 *
 * Private x402 Payment Proxy for AI Agents
 *
 * An agent sends us the x402 payment details, and we handle the payment
 * privately through the zBase privacy pool. The agent never exposes its
 * wallet on-chain.
 *
 * Flow:
 *   1. Agent hits an x402 endpoint, gets 402 response with payment details
 *   2. Agent calls this proxy with: { url, paymentDetails, depositSecrets }
 *   3. Proxy generates ZK withdrawal proof → pays provider from privacy pool
 *   4. Proxy fetches the original URL (now paid) → returns content to agent
 *
 * Body: {
 *   url: string,                    // The x402 endpoint URL
 *   provider: string,               // Provider's payment address (from 402 response)
 *   amount: string,                 // Payment amount in USDC (from 402 response)
 *   nullifier: string,              // Agent's deposit secrets
 *   secret: string,
 *   value: string,
 *   label: string,
 *   commitment: string,
 * }
 *
 * Returns: {
 *   success: boolean,
 *   paymentTxHash: string,          // The private payment tx
 *   response?: any,                 // The service response (if URL was fetched)
 *   proofTime: number,              // Time to generate ZK proof (ms)
 * }
 */
export async function POST(request: Request) {
  if (process.env.ZBASE_ENABLE_LEGACY_X402_PAY !== "true") {
    return NextResponse.json(
      {
        success: false,
        error:
          "Legacy /api/x402-pay is disabled for the Base mainnet launch. Use /api/facilitator/authorize and /api/facilitator/settle instead.",
      },
      { status: 410 },
    );
  }

  try {
    const body = await request.json();
    const { url, provider, amount, nullifier, secret, value, label, commitment } = body;

    if (!provider || !nullifier || !value || !label || !commitment) {
      return NextResponse.json(
        { error: "Missing required fields: provider, nullifier, secret, value, label, commitment" },
        { status: 400 }
      );
    }

    const startTime = Date.now();

    // Step 1: Generate ZK proof and pay provider via the withdraw API
    const withdrawRes = await fetch(internalUrl(request, "/api/withdraw"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nullifier,
        secret,
        value,
        label,
        commitment,
        recipient: provider,
        amountAtomic: amount,
      }),
    });

    const withdrawData = await withdrawRes.json();
    const proofTime = Date.now() - startTime;

    if (!withdrawRes.ok || withdrawData.error) {
      return NextResponse.json(
        { error: `Private payment failed: ${withdrawData.error}`, proofTime },
        { status: 500 }
      );
    }

    // Step 2: If a URL was provided, fetch the service content (now that payment is done)
    let serviceResponse = null;
    if (url) {
      try {
        const serviceRes = await fetch(url, {
          headers: {
            "X-Payment-Tx": withdrawData.txHash,
            "X-Payment-Method": "zbase-private",
          },
        });
        if (serviceRes.ok) {
          const contentType = serviceRes.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            serviceResponse = await serviceRes.json();
          } else {
            serviceResponse = await serviceRes.text();
          }
        }
      } catch {
        // Service fetch failed, but payment succeeded
        serviceResponse = null;
      }
    }

    return NextResponse.json({
      success: true,
      paymentTxHash: withdrawData.txHash,
      // 2026-06-09: /api/withdraw no longer echoes `amount` (CSO-P2 fix).
      // We forward the caller's input `amount` directly — it's what we just
      // settled and the caller already knows it.
      amount,
      remainingValue: withdrawData.remainingValue,
      expectedRemainingValue: withdrawData.expectedRemainingValue,
      changeNoteSupported: withdrawData.changeNoteSupported,
      nextDeposit: withdrawData.nextDeposit,
      proofTime,
      provider,
      noteValue: value,
      serviceResponse,
      privacy: {
        method: "Groth16 ZK-SNARK",
        pool: "zBase Privacy Pool (plain USDC, no yield)",
        linkable: false,
        note: "Payment came from the privacy pool contract, not the agent's wallet. No on-chain link exists between the agent and this payment.",
      },
    });
  } catch (error) {
    console.error("[x402-pay] Error:", error);
    return NextResponse.json(
      { error: (error as Error).message?.slice(0, 500) || "Unknown error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/x402-pay
 *
 * Returns info about the private x402 payment endpoint.
 * Agents can discover this endpoint and its capabilities.
 */
export async function GET() {
  const stack = getActiveStack();
  return NextResponse.json({
    name: "zBase Private x402 Payments",
    version: "0.1.0",
    description: "Pay x402 AI agent services privately using ZK proofs. Your wallet address never appears on-chain.",
    endpoints: {
      pay: "POST /api/x402-pay",
      deposit: "Use the zBase frontend to deposit USDC into the privacy pool first",
      withdraw: "POST /api/withdraw (direct withdrawal)",
      aspUpdate: "POST /api/asp-update (auto-updates after deposit)",
    },
    privacy: {
      proofSystem: "Groth16 (zk-SNARKs)",
      compliance: "Association Set Provider (Vitalik Buterin research)",
      yield: "none (active pool is plain USDC)",
    },
    contracts: {
      entrypoint: stack.entrypoint,
      usdcPool: stack.usdcPool,
      network: stack.facilitatorNetwork === "eip155:8453" ? "Base mainnet (8453)" : "Base Sepolia (84532)",
    },
    stack: stack.label,
  });
}
