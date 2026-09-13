import { NextResponse } from "next/server";
import {
  accessFeeAtomic,
  minimumSettleAtomic,
  recordAuthorization,
  treasuryAddress,
  tryConsumeTxHash,
  takeBpsFor,
  takePercentFor,
  isFacilitatorNetwork,
  viemChainForNetwork,
  type FacilitatorNetwork,
  type PricingTier,
} from "@/lib/facilitator-authz";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

/**
 * POST /api/facilitator/authorize
 *
 * Path D access-token verification. Buyer sends a USDC transfer for the
 * per-network fee to the treasury wallet, then POSTs the tx hash + their
 * pool nullifier-hash here to unlock /api/facilitator/settle for that
 * nullifier.
 *
 * Body:
 *   {
 *     network: "eip155:84532" | "eip155:8453" | "eip155:11155111",
 *     accessTokenTxHash: "0x...",
 *     nullifierHash: "0x..." | "<bigint as string>",
 *     tier?: "standard" | "compliance"  // default: "standard"
 *   }
 *
 * The tier determines:
 *   - the required access-fee amount (compliance is 10x standard)
 *   - the per-settle take rate when /settle is called against this nullifier
 *     (single 5.00% tier — compliant by default; `compliance` is a deprecated alias)
 *
 * Enterprise tier is NOT accessible via this endpoint — enterprise customers
 * have nullifiers recorded out-of-band via offline-signed contracts.
 *
 * On success: returns { authorized: true, tier }. The same nullifier can then
 * pay any number of settles up to its on-chain deposit balance at the tier's rate.
 */
export async function POST(request: Request) {
  try {
    // Parse body FIRST so we can bind the rate limit to (network, txHash) —
    // a privacy-neutral per-call identifier instead of IP. FIND-100 from
    // the 2026-06-07 audit: src/proxy.ts strips x-forwarded-for from
    // /api/facilitator/*, so IP-based rate-limiting collapses to one
    // global bucket. Binding to txHash keys each legit buyer into their
    // own bucket; fake-hash spam falls through into an "anonymous" pool
    // (acceptable: still rate-limited, just shared among bad actors).
    const body = await request.json();
    const {
      network,
      accessTokenTxHash,
      nullifierHash,
      tier: requestedTier,
      ownershipSignature, // F6: optional EIP-191 sig proving caller owns Transfer.from
    } = body as {
      network?: string;
      accessTokenTxHash?: string;
      nullifierHash?: string;
      tier?: string;
      ownershipSignature?: string;
    };

    // Validate tier (default standard; reject enterprise — that's out-of-band)
    let tier: PricingTier;
    if (requestedTier === undefined || requestedTier === "standard") {
      tier = "standard";
    } else if (requestedTier === "compliance") {
      tier = "compliance";
    } else if (requestedTier === "enterprise") {
      return NextResponse.json(
        {
          authorized: false,
          error: "Enterprise tier is not accessible via /authorize. Contact sales (@zbase__ on Twitter) for enterprise onboarding.",
        },
        { status: 400 },
      );
    } else {
      return NextResponse.json(
        {
          authorized: false,
          error: `Unknown tier '${requestedTier}'. Must be 'standard' or 'compliance'.`,
        },
        { status: 400 },
      );
    }

    if (!isFacilitatorNetwork(network)) {
      return NextResponse.json(
        {
          authorized: false,
          error:
            "network must be one of 'eip155:84532' (Base Sepolia), 'eip155:8453' (Base mainnet), or 'eip155:11155111' (Ethereum Sepolia)",
        },
        { status: 400 },
      );
    }

    if (
      typeof accessTokenTxHash !== "string" ||
      !/^0x[a-fA-F0-9]{64}$/.test(accessTokenTxHash)
    ) {
      return NextResponse.json(
        {
          authorized: false,
          error: "accessTokenTxHash must be a 0x-prefixed 32-byte hex string",
        },
        { status: 400 },
      );
    }

    // Pre-RPC guard. The tx-hash bucket below is still useful for idempotency,
    // but cannot be the first limiter because attackers can vary tx hashes and
    // force unbounded Base RPC receipt lookups.
    const preflightRl = await checkRateLimit(request, "authorize-preflight", `${network}:global`);
    if (!preflightRl.success) return rateLimitResponse(preflightRl);

    const rateLimitKey = `${network}:${accessTokenTxHash.toLowerCase()}`;
    const rl = await checkRateLimit(request, "authorize", rateLimitKey);
    if (!rl.success) return rateLimitResponse(rl);
    if (typeof nullifierHash !== "string" || nullifierHash.length === 0) {
      return NextResponse.json(
        {
          authorized: false,
          error:
            "nullifierHash required (the Poseidon(nullifier, secret) value used in the buyer's pool deposit)",
        },
        { status: 400 },
      );
    }

    // === IMPORTANT: do NOT short-circuit on !feeEnforced() ================
    // FIND-200 (2026-06-07 audit): the earlier implementation short-circuited
    // here and recorded the authorization WITHOUT checking the access-token
    // tx existed on-chain. Verified live exploit: fake hash 0xdead...0001
    // returned HTTP 200 authorized:true. After flipping ZBASE_FEE_REQUIRED
    // =true, those pre-authorized nullifiers would have gotten free settles.
    //
    // Now: /authorize ALWAYS verifies on-chain. ZBASE_FEE_REQUIRED only
    // controls /settle's gating behavior (whether unauthorized settles
    // return 402 or proceed to ZK proof generation). The authorize
    // contract is: "you sent USDC to treasury → I record your nullifier
    // as paid." That's true regardless of whether settles are gated.

    // Verify the on-chain access-token tx. Network-aware: Base Sepolia, Base
    // mainnet, or Ethereum Sepolia. ETHONLINE-2026: chain comes from the
    // shared viemChainForNetwork helper (no more ad hoc base|baseSepolia
    // branching); RPC + USDC are keyed lookups that fail closed via
    // Record<FacilitatorNetwork, ...> exhaustiveness.
    const { createPublicClient, http, decodeEventLog, parseAbiItem, verifyMessage } =
      await import("viem");

    const isMainnet = network === "eip155:8453";
    const chain = viemChainForNetwork(network);
    const RPC_BY_NETWORK: Record<FacilitatorNetwork, string> = {
      "eip155:8453": process.env.BASE_MAINNET_RPC || "https://mainnet.base.org",
      "eip155:84532": process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      "eip155:11155111": process.env.ETH_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
    };
    // USDC token to match in the Transfer log, per network (Circle canonical
    // for Base; verified-on-chain address for Ethereum Sepolia).
    const USDC_BY_NETWORK: Record<FacilitatorNetwork, string> = {
      "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "eip155:11155111": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    };
    const rpc = RPC_BY_NETWORK[network];
    const usdcAddress = USDC_BY_NETWORK[network].toLowerCase();
    const client = createPublicClient({ chain, transport: http(rpc) });

    let receipt;
    try {
      receipt = await client.getTransactionReceipt({
        hash: accessTokenTxHash as `0x${string}`,
      });
    } catch {
      return NextResponse.json(
        {
          authorized: false,
          error:
            "Could not fetch access-token tx receipt. Wait a few seconds for the tx to confirm and try again.",
        },
        { status: 400 },
      );
    }

    if (!receipt || receipt.status !== "success") {
      return NextResponse.json(
        { authorized: false, error: "Access-token tx did not succeed on-chain." },
        { status: 400 },
      );
    }

    // Parse the USDC Transfer log: must be a transfer of >= expected fee, to the
    // treasury wallet. USDC contract on Base Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e.
    //
    // TODO v1.5: support DAI/USDT/PYUSD/EURC. Requires a price-feed oracle to
    // convert "any stablecoin worth $0.001" into per-asset atomic amounts.
    // Until then, USDC-only matches the pool asset, /supported declaration,
    // and the x402 protocol convention.
    //
    // TODO v1.5: add SIWE/EIP-712 signature gate to prove the caller owns
    // the `Transfer.from` address. Without it, an attacker can monitor the
    // mempool for $0.001 transfers and race to authorize their own nullifier.
    // Attack value ($0.001) is below defense cost (+1s every integration),
    // so deferred until mainnet pricing makes the attack economical.
    const TRANSFER_EVENT = parseAbiItem(
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    );
    // Required access fee depends on the tier — compliance is 10x standard.
    const need = accessFeeAtomic(network as FacilitatorNetwork, tier);
    const treasury = treasuryAddress();

    let sawValidTransfer = false;
    let transferFrom = ""; // F6: the address that paid the access fee
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== usdcAddress) continue;
      try {
        const decoded = decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName !== "Transfer") continue;
        const args = decoded.args as {
          from: string;
          to: string;
          value: bigint;
        };
        if (args.to.toLowerCase() === treasury && args.value >= need) {
          sawValidTransfer = true;
          transferFrom = args.from.toLowerCase();
          break;
        }
      } catch {
        // Not a Transfer log on this contract; skip.
      }
    }

    if (!sawValidTransfer) {
      return NextResponse.json(
        {
          authorized: false,
          error: `Access-token tx must include a USDC Transfer of >= ${need.toString()} atomic units to ${treasury} for tier '${tier}'.`,
          requiredFee: {
            tier,
            atomic: need.toString(),
            usdc: (Number(need) / 1_000_000).toString(),
          },
        },
        { status: 400 },
      );
    }

    // === F6: ownership proof of the access-token payer ====================
    // Without this, an attacker can watch the mempool for anyone's fee transfer
    // and race /authorize to bind THEIR own nullifier to someone else's payment.
    // We require the caller to sign a message binding (txHash, nullifierHash)
    // with the key that controls Transfer.from. Enforced when
    // ZBASE_REQUIRE_AUTHORIZE_OWNERSHIP=true OR on mainnet (eip155:8453), where
    // the access fee is high enough to make the race economical. On Sepolia with
    // the flag unset it stays optional (back-compat for existing test flows).
    const requireOwnership =
      String(process.env.ZBASE_REQUIRE_AUTHORIZE_OWNERSHIP ?? "").toLowerCase() === "true" ||
      network === "eip155:8453";
    if (requireOwnership) {
      const ownershipMessage =
        `zBase facilitator access authorization\n` +
        `Network: ${network}\n` +
        `Access-token tx: ${(accessTokenTxHash as string).toLowerCase()}\n` +
        `Nullifier: ${(nullifierHash as string).toLowerCase()}\n` +
        `Payer: ${transferFrom}`;
      let ownerOk = false;
      if (typeof ownershipSignature === "string" && /^0x[0-9a-fA-F]{130}$/.test(ownershipSignature)) {
        try {
          ownerOk = await verifyMessage({
            address: transferFrom as `0x${string}`,
            message: ownershipMessage,
            signature: ownershipSignature as `0x${string}`,
          });
        } catch {
          ownerOk = false;
        }
      }
      if (!ownerOk) {
        return NextResponse.json(
          {
            authorized: false,
            error:
              "Ownership proof required: sign the authorization message with the wallet that paid the access fee (Transfer.from) and resend as `ownershipSignature`.",
            ownershipMessage,
            payer: transferFrom,
          },
          { status: 401 },
        );
      }
    }

    // === Replay protection — atomic consume-or-reject =====================
    // Try to consume the tx hash. Returns true if THIS request was the first
    // (and only) one to claim it. Returns false if a concurrent or previous
    // request already consumed it. Atomic via Redis SETNX — eliminates the
    // time-of-check-time-of-use race the prior two-call pattern had.
    const consumed = await tryConsumeTxHash(
      network as FacilitatorNetwork,
      accessTokenTxHash,
    );
    if (!consumed) {
      return NextResponse.json(
        {
          authorized: false,
          error:
            "This access-token tx has already been used to authorize another nullifier. Each tx authorizes exactly one nullifier — send a new USDC tx to authorize this one.",
        },
        { status: 400 },
      );
    }

    await recordAuthorization(network as FacilitatorNetwork, nullifierHash, tier);

    return NextResponse.json({
      authorized: true,
      network,
      tier,
      feePaidAtomic: need.toString(),
      feePaidUsdc: (Number(need) / 1_000_000).toString(),
      treasury,
      nullifierHash,
      perSettle: {
        takeBps: takeBpsFor(tier),
        takePercent: takePercentFor(tier),
        minimumSettleAtomic: minimumSettleAtomic(network as FacilitatorNetwork, tier).toString(),
        minimumSettleUsdc: (Number(minimumSettleAtomic(network as FacilitatorNetwork, tier)) / 1_000_000).toFixed(6),
        enforcement: "on-chain via pool contract's feeRecipient + relayFeeBPS fields",
        note: tier === "compliance"
          ? `${takePercentFor("compliance")} deducted from each settle on-chain (compliance tier — audit-ready receipts).`
          : `${takePercentFor("standard")} deducted from each settle on-chain. Settles below minimumSettle are rejected with HTTP 400.`,
      },
      note: `Authorization persisted in Upstash (TTL 30d). Same nullifier covers unlimited settles at the ${tier} tier until deposit balance is spent. Per-settle fee is enforced on-chain — no need to send a separate tx per settle.`,
    });
  } catch (error) {
    return NextResponse.json(
      {
        authorized: false,
        error: (error as Error).message?.slice(0, 500) || "Unknown error",
      },
      { status: 500 },
    );
  }
}
