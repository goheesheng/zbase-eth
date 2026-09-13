import { NextResponse } from "next/server";
import { getThirdPartyEndpoints } from "@/lib/external-x402-catalog";
import { getActiveStack } from "@/lib/contracts";
import { exposurePaymentConfig } from "@/lib/exposure-payment";

// Solana is paused by default while the product focuses on Base mainnet launch.
// Operators must explicitly opt in after the SVM audit fixes are deployed.
const SVM_READY =
  String(process.env.ZX402_SVM_READY ?? "false").toLowerCase() === "true";

export async function GET() {
  const stack = getActiveStack();
  const exposurePayment = exposurePaymentConfig();
  const isMainnet = stack.facilitatorNetwork === "eip155:8453";
  // Best-effort: never block the discovery response on third-party state.
  let thirdPartyEndpoints: Awaited<ReturnType<typeof getThirdPartyEndpoints>> = [];
  try {
    thirdPartyEndpoints = await getThirdPartyEndpoints();
  } catch {
    // getThirdPartyEndpoints already swallows errors and falls back, but
    // catch here too to keep `/api/zbase/supported` honest about its
    // own resilience.
  }

  // Per-chain capability matrix mirrors STATUS.md. Until ZX402_SVM_READY=true
  // is set on the server, the SVM row reports custodial+paused so the public
  // discovery surface cannot lead the deployed reality.
  const chains = [
    {
      id: "solana-devnet",
      network: "solana:devnet",
      privacy: SVM_READY
        ? "on-chain Groth16 + ASP enforced"
        : "paused — audit fixes pending",
      yield: "n/a (paused)",
      status: SVM_READY ? "explicitly enabled devnet" : "paused — Base mainnet launch focus",
    },
    {
      id: isMainnet ? "base-mainnet" : "base-sepolia",
      network: stack.facilitatorNetwork,
      privacy: "on-chain Groth16 + ASP enforced",
      yield: "n/a (plain USDC privacy pool)",
      status: isMainnet ? "active mainnet stack" : "live (testnet)",
    },
  ];

  return NextResponse.json({
    service: "zBase Privacy Scanner",
    version: "1.0.0",
    description:
      "Privacy exposure analysis for AI agent payments on Base. Solana/SVM is paused while audit fixes are applied.",
    network: stack.facilitatorNetwork,
    chains,
    endpoints: {
      "POST /api/zbase/privacy-check": {
        price: "free preview",
        description:
          "Redacted preview: x402 payment exposure for a wallet address",
      },
      "POST /api/zbase/exposure-report": {
        price: exposurePayment.displayPrice,
        x402: {
          scheme: "exact",
          network: exposurePayment.network,
          asset: exposurePayment.asset,
          payTo: exposurePayment.payTo,
          amount: exposurePayment.amountAtomic,
        },
        description:
          "Paid full report: provider history, evidence, behavior inference, and risk exposure",
      },
      "GET /api/zbase/exposure-report/:id": {
        price: "included after report purchase",
        description:
          "Fetch a generated report. Full output requires Authorization: Bearer <accessToken>.",
      },
    },
    /**
     * Catalog of third-party x402-paid endpoints zBase can route privately.
     * Source: src/lib/external-x402-catalog.ts (currently mirrors SAN
     * Foundation; adds others as we integrate). Cached for 1 hour.
     * Today: the routing requires zBase mainnet, which is gated on the
     * Solana V1 deploy. See STATUS.md.
     */
    thirdPartyEndpoints,
    roadmap: {
      phase1: "Privacy scanner (live now)",
      phase2: "Agent identity registry with spend limits",
      phase3: SVM_READY
        ? "Full ZK privacy facilitator — private x402 payments on Base + explicitly enabled Solana devnet"
        : "Base mainnet pilot first; Solana resumes after SVM audit fixes",
    },
    links: {
      github: "https://github.com/goheesheng/zx402",
      status: "https://github.com/goheesheng/zx402/blob/main/STATUS.md",
    },
  });
}
