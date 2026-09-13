import { NextResponse } from "next/server";
import { getAgentRegistry } from "../../agent/register/route";
import { activeNetwork, getActiveStack, getActiveChain } from "@/lib/contracts";
import { getFacilitatorReadiness } from "@/lib/facilitator-readiness";
import {
  cacheLabelsMatch,
  cacheRootMatches,
  readIndexer,
} from "@/lib/indexer";

// B6 fix (audit-sweep-2026-06-17): the pool address + chain are resolved from
// the active stack/network at call time (see inside the handler), NOT hardcoded
// to the Sepolia pool. Pre-fix, a mainnet payment (verify now accepts
// eip155:8453) was checked against the Sepolia pool's anonymity set, making the
// verify result meaningless on mainnet.

/**
 * POST /api/facilitator/verify
 *
 * x402 standard verify endpoint.
 * Validates that the payment can be settled through the privacy pool.
 *
 * Standard x402 facilitators verify a signed USDC transfer.
 * zBase verifies the payer has a ZK-ready deposit in the privacy pool.
 *
 * Body: {
 *   paymentPayload: string (base64),
 *   paymentDetails: {
 *     scheme: "exact",
 *     networkId: "eip155:84532",
 *     payTo: "0x...",
 *     maxAmountRequired: "1000000",
 *   },
 *   // zBase extension: deposit secrets for ZK proof
 *   zbaseDeposit?: {
 *     nullifier: string,
 *     secret: string,
 *     value: string,
 *     label: string,
 *     commitment: string,
 *   }
 *   // Phase 1A UTXO extension (Shipment A.1): UTXO note bundle. When present
 *   // the settle is routed through /api/withdraw?pool=utxo instead of the
 *   // single-value pool. UTXO notes can pay variable amounts in one
 *   // anonymity set (kills whale correlation). Both fields may be present
 *   // during a transition; UTXO takes precedence (a log warning is emitted).
 *   zbaseUtxoNotes?: Array<{
 *     amount: string,
 *     label: string,
 *     nullifier: string,
 *     secret: string,
 *   }>
 * }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { paymentDetails } = body;
    const zbaseDeposit = body.zbaseDeposit ?? body.zx402Deposit;
    const zbaseUtxoNotes = body.zbaseUtxoNotes as
      | Array<{ amount?: string; label?: string; nullifier?: string; secret?: string }>
      | undefined;
    if (zbaseDeposit && Array.isArray(zbaseUtxoNotes) && zbaseUtxoNotes.length > 0) {
      console.warn(
        "[facilitator/verify] both zbaseDeposit and zbaseUtxoNotes present — UTXO takes precedence (Phase 1A).",
      );
    }

    if (!paymentDetails) {
      return NextResponse.json({
        valid: false,
        reason: "Missing paymentDetails",
      }, { status: 400 });
    }

    // Standard x402 checks
    if (paymentDetails.scheme !== "exact") {
      return NextResponse.json({
        valid: false,
        reason: `Unsupported scheme: ${paymentDetails.scheme}. zBase supports 'exact' only.`,
      });
    }

    // zBase supports Base Sepolia (eip155:84532) + Base mainnet (eip155:8453).
    if (
      paymentDetails.networkId &&
      paymentDetails.networkId !== "eip155:84532" &&
      paymentDetails.networkId !== "eip155:8453"
    ) {
      return NextResponse.json({
        valid: false,
        reason: `Unsupported network: ${paymentDetails.networkId}. zBase supports Base Sepolia (eip155:84532) and Base mainnet (eip155:8453).`,
      });
    }

    // ── Phase 1A UTXO branch ────────────────────────────────────────────────
    // When UTXO notes are present, validate them as a bundle (sum >= required
    // payment) and short-circuit. The single-value commitment-exists check
    // does not apply — UTXO commitments live in the UTXOPool's separate
    // state tree. A full on-chain existence check is deferred to /settle
    // (which forwards to /api/withdraw?pool=utxo where the contract enforces
    // it via stateRoot + nullifier checks).
    if (Array.isArray(zbaseUtxoNotes) && zbaseUtxoNotes.length > 0) {
      // UTXO is Sepolia-only — settle throws on mainnet (getStackByName("utxo")).
      // Reject here so verify never returns valid:true for a bundle that can
      // never settle on mainnet (codex 2026-07-13).
      if (activeNetwork() === "mainnet") {
        return NextResponse.json({
          valid: false,
          reason: "UTXO notes are not supported on Base mainnet (single-value pool only).",
        });
      }
      const required = ["amount", "label", "nullifier", "secret"] as const;
      let sum = 0n;
      for (let i = 0; i < zbaseUtxoNotes.length; i++) {
        const note = zbaseUtxoNotes[i];
        for (const field of required) {
          const v = note[field];
          if (!v || v === "0x" || v === "undefined") {
            return NextResponse.json({
              valid: false,
              reason: `Invalid UTXO note field zbaseUtxoNotes[${i}].${field}`,
            });
          }
        }
        try {
          sum += BigInt(note.amount as string);
        } catch {
          return NextResponse.json({
            valid: false,
            reason: `Invalid UTXO note amount at index ${i}`,
          });
        }
      }
      let requiredAmount = 0n;
      try {
        requiredAmount = BigInt(paymentDetails.maxAmountRequired || "0");
      } catch {
        return NextResponse.json({
          valid: false,
          reason: "Invalid paymentDetails.maxAmountRequired",
        });
      }
      if (sum < requiredAmount) {
        return NextResponse.json({
          valid: false,
          reason: `Insufficient UTXO note balance: have ${sum}, need ${requiredAmount}`,
        });
      }
      return NextResponse.json({
        valid: true,
        reason:
          "UTXO note bundle verified (Phase 1A). Settlement will route through /api/withdraw?pool=utxo.",
        privacy: {
          method: "Groth16 ZK-SNARK (UTXO note-spend, v0 scaffold)",
          pool: "utxo",
          noteCount: zbaseUtxoNotes.length,
          // Anonymity set computed on-chain at settle-time; not exposed here.
        },
      });
    }

    // zBase privacy verification
    if (zbaseDeposit) {
      // Validate deposit secrets are present
      const required = ["nullifier", "secret", "value", "label", "commitment"];
      for (const field of required) {
        if (!zbaseDeposit[field] || zbaseDeposit[field] === "0x" || zbaseDeposit[field] === "undefined") {
          return NextResponse.json({
            valid: false,
            reason: `Invalid deposit field: ${field}`,
          });
        }
      }

      // Check the deposit value is sufficient for the payment
      try {
        const depositValue = BigInt(zbaseDeposit.value);
        const requiredAmount = BigInt(paymentDetails.maxAmountRequired || "0");
        if (depositValue < requiredAmount) {
          return NextResponse.json({
            valid: false,
            reason: `Insufficient deposit: have ${depositValue}, need ${requiredAmount}`,
          });
        }
      } catch {
        return NextResponse.json({
          valid: false,
          reason: "Invalid deposit value format",
        });
      }

      // Agent identity + permission checks (solves a16z's "who it represents + what it's allowed to do").
      // Permission results are enforced but NEVER echoed to the caller — the
      // agent's identity must not leak to the provider.
      const agentId = body.agentId as string | undefined;

      if (agentId) {
        const registry = getAgentRegistry();
        const agent = registry.get(agentId);

        if (!agent) {
          return NextResponse.json({
            valid: false,
            reason: `Agent ${agentId} not found. Register at POST /api/agent/register first.`,
          });
        }

        // Check per-transaction spend limit
        const requiredAmount = BigInt(paymentDetails.maxAmountRequired || "0");
        const maxPerTx = BigInt(agent.permissions.maxSpendPerTx);
        if (requiredAmount > maxPerTx) {
          return NextResponse.json({
            valid: false,
            reason: `Payment exceeds the agent's per-transaction spend limit: needs ${requiredAmount}, max ${maxPerTx}`,
          });
        }

        // Check daily spend limit
        const now = new Date();
        const resetAt = new Date(agent.dailyResetAt);
        if (now.getTime() - resetAt.getTime() > 86400000) {
          // Reset daily counter
          agent.dailySpent = "0";
          agent.dailyResetAt = now.toISOString();
        }
        const dailySpent = BigInt(agent.dailySpent);
        const maxPerDay = BigInt(agent.permissions.maxSpendPerDay);
        if (dailySpent + requiredAmount > maxPerDay) {
          return NextResponse.json({
            valid: false,
            reason: `Payment exceeds the agent's daily spend limit: spent ${dailySpent} + needs ${requiredAmount}, max/day ${maxPerDay}`,
          });
        }

        // Check allowed providers
        if (agent.permissions.allowedProviders.length > 0 && paymentDetails.payTo) {
          const allowed = agent.permissions.allowedProviders.map((a: string) => a.toLowerCase());
          if (!allowed.includes(paymentDetails.payTo.toLowerCase())) {
            return NextResponse.json({
              valid: false,
              reason: `The agent is not authorized to pay this provider.`,
            });
          }
        }

      }

      // Verify the commitment exists on-chain — network-aware pool + chain (B6).
      const activeStack = getActiveStack();
      if (
        paymentDetails.networkId &&
        paymentDetails.networkId !== activeStack.facilitatorNetwork
      ) {
        return NextResponse.json(
          {
            valid: false,
            reason: `Requested network ${paymentDetails.networkId} does not match active stack ${activeStack.facilitatorNetwork}.`,
          },
          { status: 400 },
        );
      }
      const poolAddress = activeStack.usdcPool;
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (
        poolAddress.toLowerCase() === ZERO ||
        activeStack.entrypoint.toLowerCase() === ZERO ||
        activeStack.poolDeployBlock === 0n
      ) {
        return NextResponse.json(
          {
            valid: false,
            reason:
              "Active Base stack is not fully configured. Deploy and wire entrypoint, pool, and poolDeployBlock before enabling mainnet verification.",
          },
          { status: 503 },
        );
      }

      const readiness = await getFacilitatorReadiness();
      if (!readiness.verificationReady) {
        const reasons = readiness.blockingReasons.filter((reason) =>
          reason.blocks.includes("verification"),
        );
        return NextResponse.json(
          {
            valid: false,
            code: "FACILITATOR_NOT_READY",
            reason: reasons[0]?.message ?? "The privacy facilitator is not ready for verification.",
            blockingReasons: reasons,
            preflightOnly: true,
          },
          { status: 503 },
        );
      }

      const treeSize = readiness.anonymitySet;
      const onchainStateRoot = BigInt(readiness.currentStateRoot);
      const onchainAspRoot = BigInt(readiness.latestAspRoot);

      let commitment: bigint;
      try {
        commitment = BigInt(zbaseDeposit.commitment);
      } catch {
        return NextResponse.json({
          valid: false,
          reason: "Invalid commitment format",
        });
      }

      const cached = await readIndexer({
        network: activeStack.facilitatorNetwork,
        pool: poolAddress,
        deployBlock: activeStack.poolDeployBlock,
      });
      const leavesOk = cacheRootMatches(cached, onchainStateRoot);
      const labelsOk = cacheLabelsMatch(cached, onchainAspRoot);
      if (!leavesOk || !labelsOk) {
        return NextResponse.json({
          valid: false,
          reason:
            "Indexer cache is cold or stale. Access should be released only after /settle succeeds.",
          preflightOnly: true,
          cache: {
            leavesOk,
            labelsOk,
            leafCount: cached.leafCount,
          },
        });
      }

      if (!cached.leaves.includes(commitment)) {
        return NextResponse.json({
          valid: false,
          reason: "Commitment not found in the root-verified state tree.",
        });
      }

      // Privacy: the verify response goes to the resource server/provider. It
      // must NOT carry the paying agent's stable identity (owner wallet, id,
      // name, spend counters) — that would let any provider join a payment to a
      // wallet and fingerprint the agent across payments, the exact link zBase
      // exists to break. Return only the spec-standard {valid, reason}.
      return NextResponse.json({
        valid: true,
        reason: agentId
          ? "Agent verified. Identity confirmed, permissions checked, deposit sufficient."
          : "ZK-ready deposit verified. Payment can be settled privately.",
        privacy: {
          method: "Groth16 ZK-SNARK",
          pool: poolAddress,
          anonymitySet: treeSize,
        },
      });
    }

    // No zBase deposit provided — return info about how to use zBase
    return NextResponse.json({
      valid: false,
      reason: "zBase is a privacy facilitator. Provide zbaseDeposit (nullifier, secret, value, label, commitment) to verify. Deposit USDC at the zBase frontend first.",
      howToUse: {
        step1: "Deposit USDC at zbase.xyz (creates ZK-ready secrets)",
        step2: "Include zbaseDeposit in verify request",
        step3: "Call /settle with the same deposit to complete private payment",
      },
    });
  } catch (error) {
    return NextResponse.json({
      valid: false,
      reason: `Verification error: ${(error as Error).message}`,
    }, { status: 500 });
  }
}
