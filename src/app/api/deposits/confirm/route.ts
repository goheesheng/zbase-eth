import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { getActiveChain, getActiveStack, isZeroAddress } from "@/lib/contracts";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import {
  findPoolDeposits,
  isTransactionHash,
  transactionBlockAge,
  transactionConfirmations,
} from "@/lib/deposit-confirmation";
import {
  acquireAspUpdateLock,
  aspUpdateSharedStateAvailable,
  getDepositAspRecord,
  ownsAspUpdateLock,
  releaseAspUpdateLock,
  writeDepositAspRecord,
} from "@/lib/asp-update-state";
import { refreshAspRoot } from "@/lib/asp-root-updater";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function minimumConfirmations(network: "mainnet" | "sepolia"): bigint {
  const configured = Number(process.env.ZBASE_ASP_CONFIRMATIONS);
  if (Number.isSafeInteger(configured) && configured > 0) return BigInt(configured);
  return network === "mainnet" ? 2n : 1n;
}

function maximumReceiptAgeBlocks(): bigint {
  const configured = Number(process.env.ZBASE_ASP_CONFIRM_MAX_AGE_BLOCKS);
  if (Number.isSafeInteger(configured) && configured > 0) return BigInt(configured);
  // About ten minutes on Base. This prevents scraping historical deposit hashes
  // to authorize repeated full-history scans; operators retain the private
  // repair endpoint for genuinely late confirmations.
  return 300n;
}

async function queued(args: {
  network: string;
  pool: string;
  txHash: `0x${string}`;
  reason: string;
  httpStatus?: number;
}) {
  const record = await writeDepositAspRecord({
    network: args.network,
    pool: args.pool,
    txHash: args.txHash,
    status: "queued",
    reason: args.reason,
  });
  return NextResponse.json(record, {
    status: record.status === "queued" ? (args.httpStatus ?? 202) : 200,
  });
}

/**
 * POST /api/deposits/confirm { txHash }
 *
 * A successful, sufficiently-confirmed Deposited event from the configured
 * pool is the authorization to request one idempotent ASP refresh. No signer or
 * ASP secret crosses the browser boundary.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON body with txHash" }, { status: 400 });
  }
  const txHash = (body as { txHash?: unknown } | null)?.txHash;
  if (!isTransactionHash(txHash)) {
    return NextResponse.json(
      { error: "txHash must be a 0x-prefixed 32-byte transaction hash" },
      { status: 400 },
    );
  }

  const stack = getActiveStack();
  const activeChain = getActiveChain();
  const network = stack.facilitatorNetwork;
  const pool = stack.usdcPool;

  if (isZeroAddress(pool) || isZeroAddress(stack.entrypoint)) {
    return NextResponse.json({ error: "Active privacy-pool stack is not configured" }, { status: 503 });
  }
  // Shared idempotency and locking are mandatory where real funds/gas are used.
  if (activeChain.network === "mainnet" && !aspUpdateSharedStateAvailable()) {
    return NextResponse.json(
      { error: "Deposit confirmation is locked: mainnet requires Upstash Redis." },
      { status: 503 },
    );
  }

  // This global guard MUST run before the receipt RPC. A per-hash-only limit is
  // bypassable by sending unlimited random hashes.
  const preflight = await checkRateLimit(
    request,
    "deposit-confirm-preflight",
    `${network}:global`,
  );
  if (!preflight.success) return rateLimitResponse(preflight);
  const perTx = await checkRateLimit(
    request,
    "deposit-confirm",
    `${network}:${txHash.toLowerCase()}`,
  );
  if (!perTx.success) return rateLimitResponse(perTx);

  const existing = await getDepositAspRecord(network, pool, txHash);
  if (existing?.status === "included" || existing?.status === "rejected") {
    return NextResponse.json(existing);
  }

  const publicClient = createPublicClient({
    chain: activeChain.chain,
    transport: http(activeChain.readRpcUrl),
  });

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  } catch {
    return queued({
      network,
      pool,
      txHash,
      reason: "Transaction is not confirmed on the active network yet.",
    });
  }
  if (receipt.status !== "success") {
    return NextResponse.json(
      { error: "Transaction reverted; it cannot authorize an ASP update." },
      { status: 400 },
    );
  }

  const deposits = findPoolDeposits(receipt.logs, pool);
  if (deposits.length === 0) {
    return NextResponse.json(
      { error: "Transaction did not emit Deposited from the active privacy pool." },
      { status: 400 },
    );
  }

  const latestBlock = await publicClient.getBlockNumber();
  const confirmations = transactionConfirmations(latestBlock, receipt.blockNumber);
  const requiredConfirmations = minimumConfirmations(activeChain.network);
  if (confirmations < requiredConfirmations) {
    return queued({
      network,
      pool,
      txHash,
      reason: `Waiting for confirmations (${confirmations}/${requiredConfirmations}).`,
    });
  }
  if (transactionBlockAge(latestBlock, receipt.blockNumber) > maximumReceiptAgeBlocks()) {
    return NextResponse.json(
      {
        error:
          "Deposit confirmation window expired. The operator ASP repair path must process this historical deposit.",
      },
      { status: 410 },
    );
  }

  await writeDepositAspRecord({
    network,
    pool,
    txHash,
    status: "queued",
    reason: "Confirmed pool deposit; awaiting ASP processing lock.",
  });
  const lock = await acquireAspUpdateLock(network, pool);
  if (!lock.acquired) {
    return queued({
      network,
      pool,
      txHash,
      reason: "Another ASP update is processing; retry shortly.",
    });
  }

  try {
    const result = await refreshAspRoot({
      requiredDepositTxHash: txHash,
      maySubmitUpdate: () => ownsAspUpdateLock(network, pool, lock.token),
    });
    const record = await writeDepositAspRecord({
      network,
      pool,
      txHash,
      status: result.status,
      reason: result.reason,
      root: result.root,
      aspTxHash: result.txHash,
    });
    return NextResponse.json(record, { status: result.status === "queued" ? 202 : 200 });
  } catch (error) {
    console.error("[Deposit Confirm] ASP refresh failed:", (error as Error).message);
    return queued({
      network,
      pool,
      txHash,
      reason: "ASP refresh failed; the confirmed deposit remains queued for retry.",
      httpStatus: 503,
    });
  } finally {
    await releaseAspUpdateLock(network, pool, lock.token);
  }
}
