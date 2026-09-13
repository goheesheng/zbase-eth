import { NextResponse } from "next/server";
import { encodeFunctionData, isAddress } from "viem";
import { join } from "path";
import * as snarkjs from "snarkjs";
import { getActiveStack } from "@/lib/contracts";
import { formatProofForSolidity } from "@/lib/privacy";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

/**
 * POST /api/ragequit — the depositor's PUBLIC self-exit (escape hatch).
 *
 * Ragequit lets the ORIGINAL depositor reclaim their own deposited USDC directly,
 * WITHOUT going through the ASP-approved private-withdraw path. It's the
 * "you can always get your money back" guarantee: if the ASP never approves a
 * deposit (compliance stalls, postman censors), the depositor can still exit.
 *
 * ⚠️ This is a PUBLIC withdrawal by design. Ragequit is NOT private — the pool's
 * `ragequit()` is gated by `require(depositors[label] == msg.sender)`
 * (OnlyOriginalDepositor), so it MUST be sent from the original depositor's own
 * wallet, and the payout goes to that wallet, revealing the deposit↔depositor
 * link on-chain. That is the trade-off: you give up privacy to guarantee exit.
 * Users opt into this only when they'd otherwise be stuck. For a PRIVATE exit,
 * use /api/withdraw (relayed, ASP-approved) instead.
 *
 * Because it must be sent by the depositor, this route does NOT relay/sign the tx
 * (unlike /api/withdraw, which the POSTMAN relays). It generates the Groth16
 * commitment proof server-side (needs the wasm/zkey) and returns the ragequit()
 * CALLDATA for the caller's OWN wallet (wagmi/viem) to sign and submit.
 *
 * Body: { nullifier, secret, value, label, commitment } — the deposit secrets the
 *       user already holds in localStorage (same shape as /api/withdraw).
 * Returns: { to, data, note } — an unsigned tx the depositor's wallet submits.
 *
 * Public-signal order is verified to match the contract's RagequitProof:
 *   [0]=commitmentHash [1]=nullifierHash [2]=value [3]=label
 * (0xbow commitment.sym, checked 2026-07-01).
 */

// 0xbow PrivacyPool.ragequit(RagequitProof) — RagequitProof = (pA, pB, pC, pubSignals[4]).
const RAGEQUIT_ABI = [
  {
    name: "ragequit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_proof",
        type: "tuple",
        components: [
          { name: "pA", type: "uint256[2]" },
          { name: "pB", type: "uint256[2][2]" },
          { name: "pC", type: "uint256[2]" },
          { name: "pubSignals", type: "uint256[4]" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export async function POST(request: Request) {
  try {
    const stack = getActiveStack();
    if (stack.usdcPool === ZERO_ADDR) {
      return NextResponse.json(
        { error: `Pool not deployed on ${stack.facilitatorNetwork} — ragequit unavailable.` },
        { status: 503 },
      );
    }

    const body = await request.json();
    const {
      nullifier: nullifierStr,
      secret: secretStr,
      value: valueStr,
      label: labelStr,
      // depositor wallet the tx will be sent FROM (informational — the contract
      // enforces msg.sender == original depositor; we just echo it back + gate the
      // rate limit on the nullifier).
      depositor,
    } = body;

    // Validate the required BigInt inputs.
    for (const [name, v] of Object.entries({
      nullifier: nullifierStr,
      secret: secretStr,
      value: valueStr,
      label: labelStr,
    })) {
      if (v === undefined || v === null || v === "" || v === "0x") {
        return NextResponse.json({ error: `Missing/invalid field: ${name}` }, { status: 400 });
      }
    }
    if (depositor !== undefined && !isAddress(depositor)) {
      return NextResponse.json({ error: `Invalid depositor address: "${depositor}"` }, { status: 400 });
    }

    // Rate limit (nullifier-keyed) — same posture as the settle/withdraw paths.
    const rl = await checkRateLimit(
      request,
      "settle",
      `${stack.facilitatorNetwork}:ragequit:${String(nullifierStr).toLowerCase()}`,
    );
    if (!rl.success) return rateLimitResponse(rl);

    let value: bigint, label: bigint, nullifier: bigint, secret: bigint;
    try {
      value = BigInt(valueStr);
      label = BigInt(labelStr);
      nullifier = BigInt(nullifierStr);
      secret = BigInt(secretStr);
    } catch {
      return NextResponse.json({ error: "Fields must be valid integers/hex." }, { status: 400 });
    }

    // 1. Generate the Groth16 commitment proof (= the ragequit proof) SERVER-SIDE.
    //    Uses filesystem paths (process.cwd() + public/circuits/...), NOT the
    //    browser paths in privacy.ts's generateCommitmentProof (that helper is
    //    client-only). Mirrors the withdraw route's fullProve pattern.
    //    publicSignals come out in the contract's expected order:
    //    [commitmentHash, nullifierHash, value, label] (verified via commitment.sym).
    let proof: unknown, publicSignals: string[];
    try {
      const wasmPath = join(process.cwd(), "public/circuits/commitment/commitment.wasm");
      const zkeyPath = join(process.cwd(), "public/circuits/commitment/groth16_pkey.zkey");
      const res = await snarkjs.groth16.fullProve(
        { value, label, nullifier, secret },
        wasmPath,
        zkeyPath,
      );
      proof = res.proof;
      publicSignals = res.publicSignals as string[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { error: `Proof generation failed: ${msg}. Check the deposit secrets are correct.` },
        { status: 400 },
      );
    }

    if (!Array.isArray(publicSignals) || publicSignals.length !== 4) {
      return NextResponse.json(
        { error: `Unexpected public-signal count (${(publicSignals as unknown[])?.length}); expected 4.` },
        { status: 500 },
      );
    }

    // 2. Format into the RagequitProof tuple the contract expects.
    const formatted = formatProofForSolidity(
      proof as { pi_a: string[]; pi_b: string[][]; pi_c: string[] },
      publicSignals,
    );

    // 3. Encode the ragequit() calldata. The caller's OWN wallet submits this —
    //    we do NOT sign/relay (the contract requires msg.sender == depositor).
    const data = encodeFunctionData({
      abi: RAGEQUIT_ABI,
      functionName: "ragequit",
      args: [
        {
          pA: formatted.pA,
          pB: formatted.pB,
          pC: formatted.pC,
          pubSignals: formatted.pubSignals as unknown as readonly [bigint, bigint, bigint, bigint],
        },
      ],
    });

    return NextResponse.json({
      ragequit: true,
      network: stack.facilitatorNetwork,
      to: stack.usdcPool,
      data,
      // The caller signs + submits this from the ORIGINAL depositor wallet.
      note:
        "PUBLIC exit: submit this tx from the wallet that made the original deposit " +
        "(the contract enforces OnlyOriginalDepositor). Funds return to that wallet, " +
        "revealing the deposit↔depositor link on-chain. For a private exit use /api/withdraw.",
      depositor: depositor ?? null,
      commitmentHash: publicSignals[0],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Ragequit failed: ${msg}` }, { status: 500 });
  }
}
