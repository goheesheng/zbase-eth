import { NextResponse } from "next/server";
import { getAgentRegistry } from "../../agent/register/route";
// audit-sweep-2026-06-17: import the F8-fixed stealth impl from the core package.
// The stale src/lib/stealth.ts duplicate (pre-F8: no `% n` reduction, no
// zero/identity stealth-key guard) was deleted — the facilitator must run the
// audited code, not a forked copy.
import { deriveStealthAddress, isStealthMetaAddress } from "@zbase-protocol/core";
import {
  findProviderByPayTo,
  recordStealthDerivation,
  type ProviderRecord,
} from "../../providers/register/route";
import {
  accessFeeAtomic,
  feeEnforced,
  getAuthorizedTier,
  minimumSettleAtomic,
  perSettleFeeAtomic,
  treasuryAddress,
  takePercentFor,
  takeBpsFor,
  resolveEffectiveFeeTier,
  type FacilitatorNetwork,
} from "@/lib/facilitator-authz";
import { internalUrl } from "@/lib/internal-url";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getActiveStack, getStackByName } from "@/lib/contracts";

/**
 * POST /api/facilitator/settle
 *
 * x402 standard settle endpoint.
 * Generates a ZK proof and settles the payment through the privacy pool.
 *
 * Now also handles agent identity + permission tracking:
 * - If agentId is provided, updates the agent's spend counters
 * - Returns an identity proof in the receipt (agent name + tx count)
 * - This solves a16z's "how it gets paid" + "prove who it represents"
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { paymentDetails, agentId } = body;
    const zbaseDeposit = body.zbaseDeposit ?? body.zx402Deposit;
    // ── Phase 1A: UTXO note bundle (Shipment A.1) ───────────────────────────
    // Optional. When present, the settle is routed through
    // /api/withdraw?pool=utxo&unsafeTestMode=<flag> instead of the
    // single-value pool. The pool the caller deposited into determines
    // which field they should populate; both may be present during a
    // transition (UTXO takes precedence + a warning is logged).
    const zbaseUtxoNotes = body.zbaseUtxoNotes as
      | Array<{ amount?: string; label?: string; nullifier?: string; secret?: string }>
      | undefined;
    const utxoUnsafeTestMode = body.utxoUnsafeTestMode === true;
    const useUtxo = Array.isArray(zbaseUtxoNotes) && zbaseUtxoNotes.length > 0;
    const activeStack = getActiveStack();
    const network: FacilitatorNetwork = activeStack.facilitatorNetwork;
    if (zbaseDeposit && useUtxo) {
      console.warn(
        "[facilitator/settle] both zbaseDeposit and zbaseUtxoNotes present — UTXO takes precedence (Phase 1A).",
      );
    }

    // Bind the rate limit to (network, nullifier) — privacy-preserving
    // per-buyer identifier (FIND-100 fix, 2026-06-07 audit). The middleware
    // strips IP headers from /api/facilitator/*; without an explicit key
    // the limiter would degrade to a single global bucket. The nullifier
    // is revealed on-chain at settle time, so reusing it here leaks nothing.
    // For the UTXO path, use the first input note's nullifier as the rate-
    // limit key (privacy-preserving per-buyer identifier; revealed on-chain
    // at settle time anyway).
    const rateLimitKey = useUtxo
      ? `eip155:84532:utxo:${String(zbaseUtxoNotes![0].nullifier ?? "").toLowerCase()}`
      : zbaseDeposit?.nullifier
        ? `${network}:${String(zbaseDeposit.nullifier).toLowerCase()}`
        : undefined;
    const rl = await checkRateLimit(request, "settle", rateLimitKey);
    if (!rl.success) return rateLimitResponse(rl);

    if (!paymentDetails?.payTo) {
      return NextResponse.json({
        settled: false,
        error: "Missing paymentDetails.payTo (provider address)",
      }, { status: 400 });
    }

    if (
      paymentDetails.networkId &&
      paymentDetails.networkId !== network
    ) {
      return NextResponse.json({
        settled: false,
        error: `Requested network ${paymentDetails.networkId} does not match active stack ${network}.`,
      }, { status: 400 });
    }

    if (!zbaseDeposit && !useUtxo) {
      return NextResponse.json({
        settled: false,
        error: "Missing zbaseDeposit or zbaseUtxoNotes. Use the zBase frontend to deposit USDC first, then include your deposit secrets (single-value pool) or note bundle (UTXO pool).",
      }, { status: 400 });
    }

    const ZERO = "0x0000000000000000000000000000000000000000";
    if (
      !useUtxo &&
      (activeStack.usdcPool.toLowerCase() === ZERO ||
        activeStack.entrypoint.toLowerCase() === ZERO ||
        activeStack.poolDeployBlock === 0n)
    ) {
      return NextResponse.json(
        {
          settled: false,
          error:
            "Active Base stack is not fully configured. Deploy and wire entrypoint, pool, and poolDeployBlock before enabling mainnet settlement.",
        },
        { status: 503 },
      );
    }

    // The amount the agent is actually paying for this call. Spend limits
    // check against this, not the full deposit value (which is a one-time
    // shielded balance that can fund many payments).
    let paymentAmount: bigint;
    try {
      paymentAmount = BigInt(paymentDetails.maxAmountRequired || "0");
    } catch {
      return NextResponse.json({
        settled: false,
        error: "Invalid paymentDetails.maxAmountRequired",
      }, { status: 400 });
    }

    if (paymentAmount <= 0n) {
      return NextResponse.json({
        settled: false,
        error: "paymentDetails.maxAmountRequired must be > 0",
      }, { status: 400 });
    }

    // ── Phase 1A UTXO branch ───────────────────────────────────────────────
    // When the caller passes `zbaseUtxoNotes`, the deposit lives in the
    // UTXO pool (Shipment A.1), not the active single-value plain 0xbow pool.
    // Forward to /api/withdraw?pool=utxo with a body the UTXO handler
    // expects (notes array + withdrawAmount + recipient).
    //
    // SECURITY (2026-06-09 review fix): the UTXO branch MUST run the same
    // access-fee + tier-authz + minimum-settle gates as Path D before
    // forwarding. Without these checks, any caller passing zbaseUtxoNotes
    // bypasses fee enforcement entirely. The first input note's nullifier
    // is the authz lookup key (mirrors single-value's use of
    // zbaseDeposit.nullifier; same on-chain-revealed identifier so no
    // additional privacy cost).
    if (useUtxo) {
      // 1. Access-fee + tier-authz gate (Path D parity).
      // The UTXO pool is Sepolia-ONLY by design (mainnet UTXO is gated on the
      // ceremony + C4 fix — Road B; getStackByName throws for mainnet UTXO).
      // So pin the UTXO network to Sepolia explicitly rather than deriving it
      // from activeNetwork() — otherwise flipping NEXT_PUBLIC_NETWORK=mainnet
      // would make every UTXO settle throw instead of using its real network.
      const utxoNetwork: FacilitatorNetwork = getStackByName("utxo", "sepolia").facilitatorNetwork;
      const utxoNullStr = String(zbaseUtxoNotes![0].nullifier ?? "");
      const utxoTier = utxoNullStr
        ? await getAuthorizedTier(utxoNetwork, utxoNullStr)
        : null;
      const utxoIsAuthd = utxoTier !== null;
      if (feeEnforced()) {
        if (!utxoNullStr) {
          return NextResponse.json({
            settled: false,
            error: "zbaseUtxoNotes[0].nullifier required for fee authorization check",
          }, { status: 400 });
        }
        if (!utxoIsAuthd) {
          return NextResponse.json({
            settled: false,
            error: "Nullifier not authorized for this facilitator. POST to /api/facilitator/authorize first.",
            authorization: {
              network: utxoNetwork,
              treasury: treasuryAddress(),
              instructions:
                "1. Send a USDC Transfer of >= the chosen tier's accessFeeAtomic to treasury on the matching network. " +
                "2. POST { network, accessTokenTxHash, nullifierHash: <utxo-note-nullifier>, tier } to /api/facilitator/authorize. " +
                "3. Retry this settle. Same nullifier covers unlimited UTXO-path settles against the source note bundle.",
            },
          }, { status: 402 });
        }
      } else if (utxoNullStr && !utxoIsAuthd) {
        console.log(`[facilitator-fee] grace-period unauthorized UTXO settle: nullifier=${utxoNullStr.slice(0, 12)}... network=${utxoNetwork} would-charge-standard=${perSettleFeeAtomic(paymentAmount, utxoNetwork, "standard").toString()} atomic`);
      }

      // 2. Minimum-settle gate (Path D parity).
      if (utxoIsAuthd && utxoTier && utxoTier !== "enterprise") {
        const utxoMinSettle = minimumSettleAtomic(utxoNetwork, utxoTier);
        if (paymentAmount < utxoMinSettle) {
          return NextResponse.json({
            settled: false,
            error: `Settle amount below minimum for ${utxoTier} tier. paymentAmount=${paymentAmount.toString()} < minimum=${utxoMinSettle.toString()} atomic USDC.`,
            minimumSettle: {
              tier: utxoTier,
              network: utxoNetwork,
              atomicUsdc: utxoMinSettle.toString(),
              usdc: (Number(utxoMinSettle) / 1_000_000).toFixed(6),
            },
          }, { status: 400 });
        }
      }

      // 3. Per-tx agent spend limit (Path D parity).
      // Daily-cap mutation intentionally omitted — UTXO smoke traffic
      // should not consume single-value agent budgets during transition.
      if (agentId) {
        const registry = getAgentRegistry();
        const agent = registry.get(agentId);
        if (!agent) {
          return NextResponse.json({
            settled: false,
            error: `Agent ${agentId} not found. Register at POST /api/agent/register first.`,
          }, { status: 400 });
        }
        const maxPerTx = BigInt(agent.permissions.maxSpendPerTx);
        if (paymentAmount > maxPerTx) {
          return NextResponse.json({
            settled: false,
            error: `Agent ${agent.name} exceeds per-tx limit: ${paymentAmount} > ${maxPerTx}`,
          }, { status: 403 });
        }
      }

      // 4. Forward to /api/withdraw?pool=utxo. The withdraw route's
      //    handleUtxoSpend applies its own rate-limit + opt-in env gate
      //    for unsafeTestMode (see route.ts:763+).
      const utxoUrl = new URL(internalUrl(request, "/api/withdraw"));
      utxoUrl.searchParams.set("pool", "utxo");
      if (utxoUnsafeTestMode) {
        utxoUrl.searchParams.set("unsafeTestMode", "true");
      }
      const utxoRes = await fetch(utxoUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: paymentDetails.payTo,
          withdrawAmount: paymentAmount.toString(),
          notes: zbaseUtxoNotes,
        }),
      });
      const utxoData = await utxoRes.json();
      if (!utxoRes.ok || utxoData.error) {
        return NextResponse.json({
          settled: false,
          error: utxoData.error || "UTXO settlement failed",
          details: "ZK note-spend submission failed. Check note balance, recipient, and that the UTXO pool is deployed.",
        }, { status: utxoRes.status === 503 ? 503 : 500 });
      }
      return NextResponse.json({
        settled: true,
        pool: "utxo",
        txHash: utxoData.txHash,
        network: utxoNetwork,
        amount: paymentAmount.toString(),
        gasUsed: utxoData.gasUsed,
        blockNumber: utxoData.blockNumber,
        unsafeTestMode: utxoData.unsafeTestMode === true,
        proofTimeMs: utxoData.proofTimeMs,
        privacy: {
          method: "Groth16 ZK-SNARK (UTXO note-spend, v0 scaffold)",
          linkable: false,
          note: "Payment settled from the UTXO pool. Variable-amount notes share one anonymity set — kills whale correlation vs single-value pool.",
        },
      });
    }

    // === Path D: facilitator access-fee gate + tier-based pricing ============
    // Buyer must have called /api/facilitator/authorize for this nullifier
    // BEFORE the first settle. The authorize endpoint records the nullifier
    // AND the tier (standard or compliance) after verifying the on-chain
    // USDC transfer to treasury.
    //
    // Hybrid pricing — per-settle fee is enforced ON-CHAIN by the pool contract
    // via the relay struct's feeRecipient + relayFeeBPS fields (wired in
    // /api/withdraw, which resolves tier server-side from the nullifier so
    // callers can't override):
    //   - standard tier:   500 bps (5.00%) routed to treasury per settle
    //   - compliance tier: 500 bps (5.00%) — deprecated alias of standard
    //   - enterprise tier: 0 bps (flat subscription + data product, no per-settle take)
    //
    // The floor (Sepolia $0.002 standard / $0.010 compliance) is enforced
    // here in /settle via minimumSettleAtomic — sub-minimum settles 400 so
    // the percentage take always meets or exceeds the floor.
    // Network from the active single-value stack (sepolia vs mainnet) — not hardcoded.
    const nullStr = zbaseDeposit?.nullifier ? String(zbaseDeposit.nullifier) : "";
    const nullifierTier = nullStr ? await getAuthorizedTier(network, nullStr) : null;

    // Step D (2026-06-23, revenue model): the take is the SELLER's tier when the
    // payTo is a registered provider — "providers pay to get paid privately" — and
    // falls back to the payer's nullifier tier otherwise. The provider record's
    // tier (set at /api/providers/register) wins because the seller is the one
    // choosing standard vs compliance (audit-ready receipts). This resolves the
    // tier OFF-CHAIN only; the contract-invariant pin of feeRecipient/relayFeeBPS
    // is still deferred to the UTXO redesign. Inert while FEE_REQUIRED=false.
    const registeredProvider = await findProviderByPayTo(paymentDetails.payTo);
    const providerTier =
      registeredProvider?.tier === "standard" || registeredProvider?.tier === "compliance"
        ? registeredProvider.tier
        : null;
    // AUDIT HIGH #3 (2026-07-09): charge the HIGHER take — a self-registered
    // `standard` provider must NOT downgrade a `compliance` nullifier. Was
    // `providerTier ?? nullifierTier` (provider unconditionally won).
    const tier = resolveEffectiveFeeTier(providerTier, nullifierTier);
    const isAuthd = tier !== null;
    const computedFee = isAuthd
      ? perSettleFeeAtomic(paymentAmount, network, tier)
      : 0n;
    if (feeEnforced()) {
      if (!nullStr) {
        return NextResponse.json({
          settled: false,
          error: "zbaseDeposit.nullifier required for fee authorization check",
        }, { status: 400 });
      }
      if (!isAuthd) {
        const standardAccessFee = accessFeeAtomic(network, "standard");
        const complianceAccessFee = accessFeeAtomic(network, "compliance");
        const authorizeBodyStandard = JSON.stringify({
          network,
          accessTokenTxHash: "<your USDC transfer tx hash>",
          nullifierHash: nullStr,
          tier: "standard",
        });
        const curlExample = [
          "# Standard tier ($" + (Number(standardAccessFee) / 1_000_000).toString() + " access fee, " + takePercentFor("standard") + " per settle)",
          "curl -X POST https://zbase.app/api/facilitator/authorize \\",
          "  -H 'Content-Type: application/json' \\",
          `  -d '${authorizeBodyStandard}'`,
        ].join("\n");
        return NextResponse.json({
          settled: false,
          error: "Nullifier not authorized for this facilitator. POST to /api/facilitator/authorize first.",
          curlExample,
          authorization: {
            network,
            treasury: treasuryAddress(),
            tiers: {
              standard: {
                accessFeeAtomic: standardAccessFee.toString(),
                accessFeeUsdc: (Number(standardAccessFee) / 1_000_000).toString(),
                perSettleTake: takePercentFor("standard") + " with $0.002 floor",
              },
              compliance: {
                accessFeeAtomic: complianceAccessFee.toString(),
                accessFeeUsdc: (Number(complianceAccessFee) / 1_000_000).toString(),
                perSettleTake: takePercentFor("compliance") + " with $0.010 floor",
              },
              enterprise: "Contact @zbase__ on Twitter — out-of-band onboarding, $2,500-$25,000/mo flat",
            },
            instructions:
              "1. Send a USDC Transfer of >= the chosen tier's accessFeeAtomic to treasury on the matching network. " +
              "2. POST { network, accessTokenTxHash, nullifierHash, tier } to /api/facilitator/authorize. " +
              "3. Retry this settle. The same nullifier covers unlimited settles against your deposit at the chosen tier's per-settle rate.",
          },
        }, { status: 402 });
      }
    } else if (nullStr && !isAuthd) {
      // Grace period telemetry — what tier WOULD have charged, at what amount.
      console.log(`[facilitator-fee] grace-period unauthorized settle: nullifier=${nullStr.slice(0, 12)}... network=${network} would-charge-standard=${perSettleFeeAtomic(paymentAmount, network, "standard").toString()} atomic`);
    }

    // === Minimum-settle gate (2026-06-08) =====================================
    // The on-chain pool contract takes only the bps (no floor enforcement),
    // so we reject sub-minimum settles here to guarantee the percentage take
    // always meets or exceeds the published floor. Standard tier minimum on
    // Sepolia = ~$0.667; compliance ~$1.000. Enterprise (tier=enterprise) has
    // no per-settle take, so no minimum applies.
    if (isAuthd && tier && tier !== "enterprise") {
      const minSettle = minimumSettleAtomic(network, tier);
      if (paymentAmount < minSettle) {
        return NextResponse.json({
          settled: false,
          error: `Settle amount below minimum for ${tier} tier. paymentAmount=${paymentAmount.toString()} < minimum=${minSettle.toString()} atomic USDC.`,
          minimumSettle: {
            tier,
            network,
            atomicUsdc: minSettle.toString(),
            usdc: (Number(minSettle) / 1_000_000).toFixed(6),
            why: "On-chain fee enforcement uses bps only (no contract-level floor). " +
              "Settles below this minimum would have a per-settle take less than the " +
              "published floor, so we reject them upstream. Bump your settle amount " +
              "or switch to a tier with a lower minimum (standard < compliance).",
          },
        }, { status: 400 });
      }
    }

    // If agent is specified, verify permissions before settling
    let agentInfo = null;
    if (agentId) {
      const registry = getAgentRegistry();
      const agent = registry.get(agentId);

      if (!agent) {
        return NextResponse.json({
          settled: false,
          error: `Agent ${agentId} not found. Register at POST /api/agent/register first.`,
        }, { status: 400 });
      }

      // Check per-tx limit (against the payment amount, not the deposit value)
      const maxPerTx = BigInt(agent.permissions.maxSpendPerTx);
      if (paymentAmount > maxPerTx) {
        return NextResponse.json({
          settled: false,
          error: `Agent ${agent.name} exceeds per-tx limit: ${paymentAmount} > ${maxPerTx}`,
        }, { status: 403 });
      }

      // Check daily limit
      const now = new Date();
      const resetAt = new Date(agent.dailyResetAt);
      if (now.getTime() - resetAt.getTime() > 86400000) {
        agent.dailySpent = "0";
        agent.dailyResetAt = now.toISOString();
      }
      const dailySpent = BigInt(agent.dailySpent);
      const maxPerDay = BigInt(agent.permissions.maxSpendPerDay);
      if (dailySpent + paymentAmount > maxPerDay) {
        return NextResponse.json({
          settled: false,
          error: `Agent ${agent.name} exceeds daily limit: spent ${dailySpent} + ${paymentAmount} > ${maxPerDay}`,
        }, { status: 403 });
      }

      // Check allowed-providers whitelist (parity with /verify)
      if (agent.permissions.allowedProviders.length > 0) {
        const allowed = agent.permissions.allowedProviders.map((a: string) => a.toLowerCase());
        if (!allowed.includes(paymentDetails.payTo.toLowerCase())) {
          return NextResponse.json({
            settled: false,
            error: `Agent ${agent.name} is not authorized to pay ${paymentDetails.payTo}. Allowed: ${agent.permissions.allowedProviders.join(", ")}`,
          }, { status: 403 });
        }
      }

      agentInfo = agent;
    }

    // ── Shipment B.1: per-call stealth recipient rotation (ERC-5564) ───────
    // If payTo is a registered provider — either as their ERC-5564 meta-address
    // or as a fallback 0x-address they registered — derive a fresh stealth
    // address for this single payment. The provider scans ephemeralPubkey
    // events to claim funds. If payTo is a plain unregistered address,
    // settle as before (backwards-compatible).
    let recipientForProof: string = paymentDetails.payTo;
    let stealthInfo:
      | { ephemeralPubkey: string; viewTag: string; provider: ProviderRecord }
      | null = null;
    try {
      const provider = await findProviderByPayTo(paymentDetails.payTo);
      if (provider) {
        const derived = deriveStealthAddress(provider.metaAddress);
        recipientForProof = derived.stealthAddress;
        stealthInfo = {
          ephemeralPubkey: derived.ephemeralPublicKey,
          viewTag: derived.viewTag,
          provider,
        };
        // Fire-and-forget: bumping the counter is best-effort metadata.
        recordStealthDerivation(provider.id).catch((err) =>
          console.warn(`[stealth] could not record derivation: ${(err as Error).message}`),
        );
        console.log(
          `[stealth] provider=${provider.id} ${provider.providerName} → ${derived.stealthAddress} (ephem ${derived.ephemeralPublicKey.slice(0, 12)}…)`,
        );
      } else if (isStealthMetaAddress(paymentDetails.payTo)) {
        // payTo is shaped like a meta-address but no provider is registered for
        // it. Refuse rather than try to send USDC to a non-address — the
        // withdraw call would 400 with a confusing error otherwise.
        return NextResponse.json({
          settled: false,
          error: "payTo looks like an ERC-5564 meta-address but is not registered. POST it to /api/providers/register first.",
        }, { status: 400 });
      }
    } catch (e) {
      console.warn(`[stealth] derivation skipped: ${(e as Error).message}`);
    }

    // Delegate to the existing withdraw API (which handles ZK proof + relay)
    // 2026-06-08: /api/withdraw resolves fee parameters server-side from the
    // nullifier's tier (Upstash lookup). The body fields feeRecipient + relayFeeBPS
    // are no longer accepted — closing FIND-301 where a buyer could call
    // /api/withdraw directly with relayFeeBPS=0 to skip the per-settle take.
    // /settle's only job is to forward the deposit secrets; the on-chain
    // fee split is enforced inside /api/withdraw via getAuthorizedTier().
    const withdrawRes = await fetch(internalUrl(request, "/api/withdraw"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nullifier: zbaseDeposit.nullifier,
        secret: zbaseDeposit.secret,
        value: zbaseDeposit.value,
        label: zbaseDeposit.label,
        commitment: zbaseDeposit.commitment,
        recipient: recipientForProof,
        amountAtomic: paymentAmount.toString(),
      }),
    });

    const withdrawData = await withdrawRes.json();

    if (!withdrawRes.ok || withdrawData.error) {
      return NextResponse.json({
        settled: false,
        error: withdrawData.error || "Settlement failed",
        details: "ZK proof generation or relay submission failed. Check deposit secrets and try again.",
      }, { status: 500 });
    }

    // Update agent spend counters by the payment amount, not the deposit value
    if (agentInfo) {
      agentInfo.totalSpent = (BigInt(agentInfo.totalSpent) + paymentAmount).toString();
      agentInfo.dailySpent = (BigInt(agentInfo.dailySpent) + paymentAmount).toString();
      agentInfo.txCount += 1;
      console.log(`[Agent Registry] ${agentInfo.name} (${agentInfo.id}): tx #${agentInfo.txCount}, total spent: ${agentInfo.totalSpent}`);
    }

    return NextResponse.json({
      settled: true,
      txHash: withdrawData.txHash,
      // B6 follow-up (2026-06-23): the success receipt must report the ACTIVE
      // network, not a hardcoded Sepolia value, or a mainnet settle mislabels
      // its receipt. `network` is resolved from getActiveStack() at the top.
      network,
      // 2026-06-09: /api/withdraw no longer echoes `amount` (CSO-P2 fix —
      // stripped from withdraw response to avoid leaking the settle size in
      // an HTTP body before the tx confirms). We already have it locally as
      // `paymentAmount` (the value we just sent in the withdraw POST), so
      // forward that directly.
      amount: paymentAmount.toString(),
      remainingValue: withdrawData.remainingValue,
      expectedRemainingValue: withdrawData.expectedRemainingValue,
      changeNoteSupported: withdrawData.changeNoteSupported,
      nextDeposit: withdrawData.nextDeposit,
      proofTimeMs: withdrawData.proofTimeMs,
      pricing: {
        tier: tier ?? "standard",
        perSettleFeeAtomic: computedFee.toString(),
        perSettleFeeUsdc: (Number(computedFee) / 1_000_000).toString(),
        feeModel: tier === "enterprise"
          ? "flat-subscription (no per-settle take)"
          : `${takePercentFor(tier ?? "standard")} on-chain (min settle ~$${(Number(minimumSettleAtomic(network, tier ?? "standard")) / 1_000_000).toFixed(3)})`,
        feeRoute: tier === "enterprise" ? "recipient (no split)" : `pool → ${treasuryAddress()} (${takeBpsFor(tier ?? "standard")} bps)`,
        note: tier === "enterprise"
          ? "Enterprise: no per-settle take; flat subscription handled out-of-band."
          : "Per-settle fee is ON-CHAIN — pool contract routes (paymentAmount × bps / 10000) to treasury via the relay struct's feeRecipient + relayFeeBPS fields. Recipient receives the remainder. Verify on BaseScan: the WithdrawalRelayed event shows _amount = recipient share, _feeAmount = treasury share.",
      },
      privacy: {
        method: "Groth16 ZK-SNARK",
        linkable: false,
        note: "Payment settled from the privacy pool. No on-chain link between the payer and this transaction.",
        // Shipment B.1 — when stealthInfo is set, the on-chain recipient is a
        // fresh address derived from the provider's ERC-5564 meta-address.
        // The provider scans `ephemeralPubkey` to claim. If unset, the payment
        // went to the literal payTo (backwards-compatible path).
        recipientStealth: stealthInfo !== null,
        ...(stealthInfo && {
          recipient: recipientForProof,
          ephemeralPubkey: stealthInfo.ephemeralPubkey,
          viewTag: stealthInfo.viewTag,
          schemeId: 1,
          providerId: stealthInfo.provider.id,
          providerName: stealthInfo.provider.providerName,
        }),
      },
      // Deprecated yield field kept for response compatibility. The active
      // pool is a plain 0xbow PrivacyPool with no Morpho/yield leg; values are
      // expected to be zero unless a future/historical yield variant is routed.
      yield: {
        earned: withdrawData.yield?.earned ?? "0",
        protocolFee: withdrawData.yield?.protocolFee ?? "0",
        feeBps: withdrawData.yield?.feeBps ?? 100,
        present: withdrawData.yield?.present ?? false,
        note:
          withdrawData.yield?.present && BigInt(withdrawData.yield?.earned || "0") > 0n
            ? "A historical yield-variant event was detected. The active plain 0xbow pool is not expected to emit this."
            : "No yield is active on the current plain 0xbow pool; this field is retained for backwards-compatible clients.",
      },
      // Agent identity proof -- solves "prove who it represents"
      //
      // Privacy note (Phase 1C, per plan file): txCount + totalSpent +
      // dailySpent stripped from the response because this response goes
      // to the recipient/provider, who can correlate stats across many
      // payments to fingerprint paying agents. The fields are still
      // tracked server-side for permission enforcement; agent owners can
      // expose them via an owner-authenticated readback in a follow-up.
      // Privacy: this receipt goes to the recipient/provider. Do NOT echo the
      // agent's stable identity (id/name/owner wallet) — a provider could join
      // it to a wallet and fingerprint the payer across payments. Return only a
      // boolean attestation that the payment was within an agent's permission
      // bounds; the owner can prove identity out-of-band if it ever needs to.
      ...(agentInfo && {
        agent: {
          identityProof: {
            note: "Payment was made by a registered zBase agent within its permission bounds.",
            verified: true,
          },
        },
      }),
    });
  } catch (error) {
    return NextResponse.json({
      settled: false,
      error: (error as Error).message?.slice(0, 500) || "Unknown error",
    }, { status: 500 });
  }
}
