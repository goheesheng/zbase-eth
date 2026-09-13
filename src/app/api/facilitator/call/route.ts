import { NextResponse } from "next/server";
import { getActiveStack } from "@/lib/contracts";
import { internalUrl } from "@/lib/internal-url";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { executorGateForStack } from "@/lib/executor-gate";
import { isAddress } from "viem";

/**
 * POST /api/facilitator/call — private-funded DeFi access (B2, ExecutorProcessooor).
 *
 * Releases pool funds DIRECTLY into a whitelisted contract call (e.g. an ERC-4626
 * vault deposit) from an UNLINKED position. This route does authz + call-plan
 * validation, then forwards to /api/withdraw with a `callPlan` field. The withdraw
 * route sets processooor = EXECUTOR, encodes ExecPlan into `data`, binds the whole
 * plan into the proof `context`, and submits via ExecutorProcessooor.executeFromPool.
 *
 * Privacy: this hides WHO funded the call, NOT what the call does (the on-chain call
 * is public). Do NOT market as "private trading". See the zBase threat model.
 *
 * Disabled (501) unless the active stack has a deployed executorProcessooor.
 * Testnet-only until externally audited (plan §4b).
 */
export async function POST(request: Request) {
  try {
    const stack = getActiveStack();
    const executorGate = executorGateForStack(stack);
    if (!executorGate.enabled) {
      return NextResponse.json(
        {
          executed: false,
          code: executorGate.code,
          error: executorGate.error,
        },
        { status: 501 },
      );
    }

    const body = await request.json();
    const zbaseDeposit = body.zbaseDeposit ?? body.zx402Deposit;
    const callPlan = body.callPlan;
    const amountAtomic = body.amountAtomic;
    const agentId = body.agentId;

    if (body.networkId !== stack.facilitatorNetwork) {
      return NextResponse.json(
        {
          executed: false,
          error: `networkId must match the active stack (${stack.facilitatorNetwork}).`,
        },
        { status: 400 },
      );
    }

    // Rate-limit on (network, nullifier) — same privacy-preserving key as settle.
    const rateLimitKey = zbaseDeposit?.nullifier
      ? `${stack.facilitatorNetwork}:call:${String(zbaseDeposit.nullifier).toLowerCase()}`
      : undefined;
    const rl = await checkRateLimit(request, "settle", rateLimitKey);
    if (!rl.success) return rateLimitResponse(rl);

    if (!zbaseDeposit) {
      return NextResponse.json(
        { executed: false, error: "Missing zbaseDeposit (deposit secrets). Deposit USDC first." },
        { status: 400 },
      );
    }

    // ── Validate the call plan ──────────────────────────────────────────────
    const err = validateCallPlan(callPlan);
    if (err) return NextResponse.json({ executed: false, error: err }, { status: 400 });

    if (
      !amountAtomic ||
      !/^\d+$/.test(String(amountAtomic)) ||
      BigInt(String(amountAtomic)) <= 0n
    ) {
      return NextResponse.json(
        { executed: false, error: "amountAtomic must be a positive integer string (atomic USDC)." },
        { status: 400 },
      );
    }

    // Forward to /api/withdraw with the callPlan. The withdraw route's callPlan
    // sibling branch resolves the tier server-side (never from the body), binds the
    // plan into `context`, and submits executeFromPool. Fee params are NOT trusted
    // from the client here — same FIND-301 discipline as the plain settle path.
    const withdrawUrl = new URL(internalUrl(request, "/api/withdraw"));
    const res = await fetch(withdrawUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nullifier: zbaseDeposit.nullifier,
        secret: zbaseDeposit.secret,
        value: zbaseDeposit.value,
        label: zbaseDeposit.label,
        commitment: zbaseDeposit.commitment,
        amountAtomic: String(amountAtomic),
        // The executor path: the withdraw route reads this to switch to executeFromPool.
        callPlan: {
          target: callPlan.target,
          inputToken: callPlan.inputToken,
          outputToken: callPlan.outputToken,
          minOut: String(callPlan.minOut),
          recipient: callPlan.recipient,
          callData: callPlan.callData,
        },
        ...(agentId ? { agentId } : {}),
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { executed: false, error: data?.error ?? `withdraw failed (${res.status})`, details: data },
        { status: res.status },
      );
    }
    return NextResponse.json({
      executed: true,
      txHash: data.txHash,
      network: stack.facilitatorNetwork,
      pricing: data.pricing,
      nextDeposit: data.nextDeposit,
    });
  } catch (e) {
    return NextResponse.json(
      { executed: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

/** Returns an error string if the plan is malformed, else null. */
function validateCallPlan(p: unknown): string | null {
  if (!p || typeof p !== "object") return "Missing callPlan.";
  const c = p as Record<string, unknown>;
  if (!isAddress(String(c.target))) return "callPlan.target must be an address.";
  if (!isAddress(String(c.inputToken))) return "callPlan.inputToken must be an address.";
  if (!isAddress(String(c.outputToken))) return "callPlan.outputToken must be an address.";
  if (!isAddress(String(c.recipient))) return "callPlan.recipient must be an address.";
  if (!/^\d+$/.test(String(c.minOut)) || BigInt(String(c.minOut)) <= 0n) {
    return "callPlan.minOut must be a positive integer string.";
  }
  if (typeof c.callData !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(c.callData) || c.callData.length < 10) {
    return "callPlan.callData must be 0x-hex with at least a 4-byte selector.";
  }
  return null;
}
