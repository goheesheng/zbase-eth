import { NextResponse } from "next/server";
import { getActiveStack } from "@/lib/contracts";
import { pricingStructure } from "@/lib/facilitator-authz";
import { getFacilitatorReadiness } from "@/lib/facilitator-readiness";

/**
 * GET /api/facilitator/supported
 *
 * x402 Facilitator discovery endpoint.
 * Returns supported networks, tokens, and capabilities.
 * Any x402 client can call this to discover what zBase supports.
 */
export async function GET() {
  const stack = getActiveStack();
  const readiness = await getFacilitatorReadiness();
  // B6 follow-up (audit-sweep-2026-06-17, LOW-1): advertise the ACTIVE network,
  // not a hardcoded Sepolia value. Pre-fix this returned eip155:84532 even on a
  // mainnet flip, telling x402 clients the wrong network. Derive both the CAIP-2
  // id and the human label from the active stack.
  const isMainnet = stack.facilitatorNetwork === "eip155:8453";
  const networkLabel = isMainnet ? "Base Mainnet (8453)" : "Base Sepolia (84532)";
  // Early access is not a mode anyone turns on — if the stack is sound and the set is
  // thin, zBase settles and discloses. See src/lib/pilot.ts.
  const inPilot = !readiness.customerReady && readiness.pilotReady;
  return NextResponse.json({
    x402Version: 2,
    facilitator: "zBase Privacy Facilitator",
    version: "1.0.0",
    status: readiness.customerReady ? "active" : inPilot ? "pilot" : "deployed-not-customer-ready",
    description: readiness.customerReady
      ? "Privacy-preserving x402 settlement through a Groth16 privacy pool."
      : inPilot
        ? "PILOT — settlement works and is open to anyone who deposits, but payments are NOT private yet: " +
          `the pool has ${readiness.organicAnonymitySet ?? "an unknown number of"} independent depositor(s) and privacy requires ${readiness.minimumAnonymitySet}. ` +
          "Every pilot settlement discloses this in its response. Privacy is claimed only when the set is real."
        : "The privacy facilitator is deployed but closed for customer use until its runtime, review, legal, and demand gates pass.",
    // Stays FALSE in pilot. It is not a synonym for "works" — it is the privacy claim,
    // and the pilot's whole premise is that the claim is not yet earned.
    customerReady: readiness.customerReady,
    pilotReady: readiness.pilotReady,
    verificationReady: readiness.verificationReady,
    blockingReasons: readiness.blockingReasons,
    // EMPTY in pilot, deliberately, even though the pilot is open to everyone.
    //
    // "Open" and "advertised" are different things, and this array is the difference. A
    // generic x402 client reads `supported[]` to decide whether zBase is a usable rail and
    // would route traffic here on the strength of it alone — never having read `status`,
    // `pilot`, or any disclosure. Listing here would make zBase a DEFAULT for agents that
    // never chose it and cannot read prose. Anyone who deliberately points at zBase still
    // gets through; they just have to have chosen it.
    supported: readiness.customerReady
      ? [
          {
            scheme: "exact",
            network: stack.facilitatorNetwork,
            asset: stack.usdc,
            symbol: "USDC",
            decimals: 6,
          },
        ]
      : [],
    pilot: {
      enabled: inPilot,
      private: false,
      anonymitySet: readiness.organicAnonymitySet,
      minimumForPrivacy: readiness.minimumAnonymitySet,
      howToJoin: inPilot
        ? "Open to anyone who deposits — no key, no allowlist. Deposit at /app#deposit, then POST " +
          "/api/facilitator/settle-x402 as usual. Payments settle and the seller is paid; every response carries a " +
          "privacy block stating that the payment is NOT private and why. Each independent depositor grows the set " +
          "toward the privacy minimum, which is the only thing that makes it private. SDK callers must pass " +
          "acceptNotPrivate:true — an explicit acknowledgement that this is not private yet, so nobody wires zBase in " +
          "expecting privacy and silently gets none."
        : null,
    },
    privacy: {
      // The CLAIM, not the mechanism. False in pilot even though every Groth16 proof and
      // fresh payer EOA is fully operational — the machinery working is not the same as
      // the property holding, and this field is what clients read as the property.
      enabled: readiness.customerReady,
      verificationReady: readiness.verificationReady,
      /** Independent depositors — the real set. `anonymitySet` below is pool commitments. */
      organicAnonymitySet: readiness.organicAnonymitySet,
      method: "Groth16 ZK-SNARK (Privacy Pools)",
      compliance: "Association Set Provider (ASP)",
      anonymitySet: readiness.anonymitySet,
      minimumCustomerAnonymitySet: readiness.minimumAnonymitySet,
      minimumDepositAmount: readiness.assetConfig.minimumDepositAmount,
      requiredMinimumDepositAmount: readiness.assetConfig.requiredMinimumDepositAmount,
      latestAspRoot: readiness.latestAspRoot,
      indexer: readiness.indexer,
    },
    // The deployed pool is a PLAIN 0xbow PrivacyPool: NO yield, NO Morpho
    // (verified on-chain 2026-06-25 — it reverts on every Morpho/yield getter;
    // ASSET() returns raw USDC). A Morpho yield variant (PrivacyPoolMorpho.sol)
    // exists on disk but was never deployed and is NOT on the roadmap (the math
    // doesn't work at agent-TVL scale; see docs/strategy/revenue-model-*). Do
    // not advertise yield to x402 clients.
    contracts: {
      entrypoint: stack.entrypoint,
      privacyPool: stack.usdcPool,
      network: networkLabel, // B6 follow-up: active network, not hardcoded
    },
    stack: stack.label,
    agentRegistry: {
      enabled: true,
      productionReady: false,
      register: "POST /api/agent/register",
      list: "GET /api/agent/register",
      lookup: "GET /api/agent/register?id=agent_xxx",
      features: [
        "Agent identity (public key + owner wallet)",
        "Per-transaction spend limits",
        "Daily spend limits",
        "Provider whitelist",
        "Category-based permissions",
        "Spend tracking + tx count",
      ],
      note: "Prototype surface only. It does not establish production authorization, demand, or wallet-owned enforcement.",
    },
    pricing: pricingStructure(),
    // Endpoints an x402 client/SDK uses to pay ANY standard provider privately.
    // settle-x402 returns a spec-standard `X-PAYMENT` header the provider's own
    // facilitator verifies — the interop path for non-zBase-aware providers.
    endpoints: {
      verify: "POST /api/facilitator/verify",
      settle: "POST /api/facilitator/settle",
      settleX402: "POST /api/facilitator/settle-x402",
    },
    links: {
      docs: "https://docs.zbase.app",
      repo: "https://github.com/goheesheng/zBase",
      deposit: "/app#deposit",
      sdk: "https://www.npmjs.com/package/@zbase-protocol/core",
      authorize: "/api/facilitator/authorize",
    },
  });
}

/**
 * POST /api/facilitator/supported
 *
 * x402 convention allows POST on discovery endpoints. Delegates to GET — the
 * response is identical (discovery is read-only). Added so x402 clients that
 * POST (e.g. awal, the SDK integration test) don't get a 405.
 */
export async function POST() {
  return GET();
}
