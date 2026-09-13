/**
 * POST /api/demo/run
 *
 * Public, unauthenticated demo of a private settle on Base Sepolia.
 * Triggered from /app#try (the page route was at /demo until 2026-06-02 when
 * it was folded into /app; the route URL here is unchanged). Hard-capped to
 * prevent abuse:
 *   - 1 request per IP per 60s (in-memory rate limit)
 *   - max 50 runs per UTC day (in-memory counter)
 *   - DEMO_WALLET_PRIVATE_KEY env (separate from postman/treasury)
 *   - $1 USDC per run (hardcoded, not from request body — see comment at
 *     DEMO_DEPOSIT_AMOUNT_USDC for why it's not $0.10)
 *   - refuses if demo wallet balance < $1 USDC
 *   - 120s overall wall-clock deadline (returns status: "timeout") — bumped
 *     from 60s on 2026-06-02 after observed Base Sepolia confirmation
 *     latencies of 30-50s per tx pushed the typical full flow to 50-75s.
 *     A hung tx still abandons at 120s so budget doesn't drain forever.
 *
 * Phase 2 (LIVE): the route performs the full settle pipeline end-to-end:
 *   1. deposit() $1 USDC from the demo wallet to the entrypoint
 *   2. parse on-chain Deposited event to recover commitment + label + value
 *   3. confirm the deposit so the server-side ASP updater includes its label
 *   4. generate a fresh ephemeral recipient address (random one-shot key)
 *   5. call /api/withdraw to generate the Groth16 proof + relay settle
 *   6. return both tx hashes + BaseScan links for the UI
 *
 * Failed runs still count against rate-limit + daily budget to defeat
 * retry-storm attacks.
 *
 * NEVER log DEMO_WALLET_PRIVATE_KEY. NEVER expose it in responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { activeNetwork, getActiveStack } from "@/lib/contracts";
import { confirmDepositForAsp } from "@/lib/asp-confirm-client";
import { hypersyncUrlFor } from "@/lib/hypersync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── safety caps (hardcoded) ─────────────────────────────────────────────────

// Must be ≥ entrypoint.assetConfig(USDC).minimumDepositAmount. The deployed
// pool at 0x598ffa…83688 requires 1.0 USDC; deposits below revert.
const DEMO_DEPOSIT_AMOUNT_USDC = 1;
const DEMO_DEPOSIT_AMOUNT_ATOMIC = BigInt(1 * 1_000_000); // 6-decimal USDC
const RATE_LIMIT_WINDOW_MS = 60_000;
// Tightened from 50 → 25 (2026-06-07) to halve the worst-case daily USDC
// burn on the demo wallet (~25 USDC/day instead of 50). Demo wallet refill
// is manual via Circle faucet (10 USDC/hour cap); 25/day keeps it sustainable
// without daily attention. Pair with the daily-quota banner in TryWithoutWallet.
const DAILY_RUN_LIMIT = 25;
const MIN_WALLET_BALANCE_USDC = 1; // refuse if below this
// Abandon threshold for the whole flow. Bumped from 60s on 2026-06-02 after
// observed Base Sepolia confirmation latencies of 30-50s per tx pushed the
// typical full flow (deposit + ASP update + withdraw) to 50-75s. Pre-bump,
// the route was timing out on successful runs — the user saw an error while
// the on-chain tx had actually landed. 120s covers the 99th percentile of
// observed Sepolia behaviour today and leaves headroom for occasional RPC
// stutter. Rate-limit + daily counters increment before the flow starts, so
// a hung run still counts against the abuse caps either way.
const HARD_TIMEOUT_MS = 120_000;

// ── chain constants ─────────────────────────────────────────────────────────
// Routed through getActiveStack(). Post-staging-abandonment (2026-06-01) this
// always returns the production stack; the indirection is kept so a future
// staging revival doesn't require code edits here.

const _stack = getActiveStack();
const ENTRYPOINT_ADDRESS = _stack.entrypoint;
const USDC_POOL_ADDRESS = _stack.usdcPool;
const USDC_ADDRESS = _stack.usdc;
// keccak256("Deposited(address,uint256,uint256,uint256,uint256)") — verified
// against scripts/seed-pools.ts (canonical reference).
const DEPOSITED_TOPIC =
  "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";

const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ── in-memory state (single-instance only) ──────────────────────────────────

const ipLastRunAt = new Map<string, number>();
let dailyRunCount = 0;
let dailyResetUtc = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function resetDailyIfNewUtcDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyResetUtc) {
    dailyRunCount = 0;
    dailyResetUtc = today;
  }
}

/** Normalize an IP string so IPv6 aliases of the same host collapse to one
 *  bucket (audit F5): lowercase, strip an IPv4-mapped IPv6 prefix, and reduce a
 *  full-form loopback to `::1`. Best-effort — we only need stable bucketing. */
function normalizeIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  // ::ffff:1.2.3.4  → 1.2.3.4
  s = s.replace(/^::ffff:/, "");
  // 0000:...:0001 loopback → ::1
  if (/^(0+:){7}0*1$/.test(s)) s = "::1";
  // strip a :port suffix on bare IPv4 (Vercel usually doesn't add one)
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.split(":")[0];
  return s;
}

function getClientIp(req: NextRequest): string {
  // Middleware strips x-forwarded-for from facilitator routes but NOT from
  // /api/demo. We use the IP for rate-limiting only; never log it.
  //
  // F5: trust x-real-ip FIRST. On Vercel x-real-ip is set to the true client
  // IP by the platform, while x-forwarded-for is a client-spoofable CSV — an
  // attacker can prepend arbitrary entries (`a, b, c`) and we previously took
  // the FIRST, so each fake entry became a fresh per-IP bucket, letting one
  // attacker burn the whole daily demo budget. Prefer x-real-ip; only fall back
  // to the LAST x-forwarded-for hop (the one the trusted proxy appended), and
  // normalize so IPv6 aliases don't multiply buckets.
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return normalizeIp(realIp);
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return normalizeIp(hops[hops.length - 1]);
  }
  return "unknown";
}

function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result % SNARK_FIELD;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label}`)), ms),
    ),
  ]);
}

/**
 * GET /api/demo/run
 *
 * Returns the current daily quota state so the /app#try banner can render
 * "Demo quota: X/25 today — refills at 00:00 UTC". No side effects, no auth,
 * no IP recording. Safe to poll from the client every ~30s.
 */
export async function GET() {
  resetDailyIfNewUtcDay();
  const now = new Date();
  const tomorrowUtc = new Date(now);
  tomorrowUtc.setUTCDate(tomorrowUtc.getUTCDate() + 1);
  tomorrowUtc.setUTCHours(0, 0, 0, 0);
  return NextResponse.json({
    used: dailyRunCount,
    limit: DAILY_RUN_LIMIT,
    remaining: Math.max(0, DAILY_RUN_LIMIT - dailyRunCount),
    resetAt: tomorrowUtc.toISOString(),
    enabled: activeNetwork() !== "mainnet" && Boolean(process.env.DEMO_WALLET_PRIVATE_KEY),
    reason: activeNetwork() === "mainnet" ? "demo runner is Sepolia-only" : undefined,
  });
}

export async function POST(req: NextRequest) {
  resetDailyIfNewUtcDay();

  if (activeNetwork() === "mainnet") {
    return NextResponse.json(
      {
        status: "disabled",
        error: "Public demo runner is Sepolia-only and is disabled on Base mainnet.",
      },
      { status: 503 },
    );
  }

  // === safety gate 1: env =================================================
  const demoKey = process.env.DEMO_WALLET_PRIVATE_KEY;
  if (!demoKey) {
    return NextResponse.json(
      {
        status: "disabled",
        error: "Demo wallet not configured. Set DEMO_WALLET_PRIVATE_KEY in .env.local to enable.",
      },
      { status: 503 },
    );
  }

  // === safety gate 2: rate limit ==========================================
  const ip = getClientIp(req);
  const now = Date.now();
  const lastRun = ipLastRunAt.get(ip);
  if (lastRun && now - lastRun < RATE_LIMIT_WINDOW_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - lastRun)) / 1000);
    return NextResponse.json(
      {
        status: "rate_limited",
        error: `Try again in ${waitSec}s. One demo run per minute per IP.`,
      },
      { status: 429 },
    );
  }

  // === safety gate 3: daily budget ========================================
  if (dailyRunCount >= DAILY_RUN_LIMIT) {
    return NextResponse.json(
      {
        status: "budget_exhausted",
        error: `Demo wallet daily quota reached (${DAILY_RUN_LIMIT}/${DAILY_RUN_LIMIT}). For unlimited runs, install @zbase-protocol/core and bring your own Sepolia USDC. See https://github.com/goheesheng/zBase.`,
        nextResetUtc: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
        limit: DAILY_RUN_LIMIT,
      },
      { status: 503 },
    );
  }

  // === safety gate 4: wallet balance check ===============================
  // Lazy import viem to keep cold-start small for the gates that bail early.
  const {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
  } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  const {
    privateKeyToAccount,
    generatePrivateKey,
  } = await import("viem/accounts");

  const rpc = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpc),
  });

  const account = privateKeyToAccount(demoKey as `0x${string}`);

  try {
    const balance = (await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    const balanceUsdc = Number(balance) / 1_000_000;
    if (balanceUsdc < MIN_WALLET_BALANCE_USDC) {
      return NextResponse.json(
        {
          status: "wallet_empty",
          error: `Demo wallet has ${balanceUsdc.toFixed(2)} USDC, needs ≥ ${MIN_WALLET_BALANCE_USDC}. Refill required. DM @zbase__ if urgent.`,
        },
        { status: 503 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      {
        status: "rpc_down",
        error: `Could not check demo wallet balance: ${(err as Error).message}`,
      },
      { status: 503 },
    );
  }

  // === all gates passed — record rate limit + budget BEFORE running =======
  // (so a failed run still counts; we don't want infinite retries blowing budget)
  ipLastRunAt.set(ip, now);
  dailyRunCount++;

  // === Phase 2: real settle pipeline ======================================
  // Wrap the whole flow in a hard 60s timeout. On Sepolia the happy path is
  // typically 8-15s, but RPC degradation can blow that out; 60s is the
  // abandon threshold. Any failure (including timeout) preserves the
  // already-incremented rate limit + budget counters.

  try {
    const result = await withTimeout(
      runDemoFlow({
        demoKey,
        publicClient,
        createWalletClient,
        http,
        baseSepolia,
        privateKeyToAccount,
        generatePrivateKey,
        req,
        startedAt: now,
      }),
      HARD_TIMEOUT_MS,
      "demo_flow",
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = (err as Error).message || "Unknown error";
    if (msg.startsWith("timeout:")) {
      // The on-chain tx may have landed AFTER the timeout — Sepolia
      // confirmation latency is the bottleneck, not the proof generation.
      // Tell the user to check the demo wallet's recent activity on
      // BaseScan before retrying, so they don't double-spend the rate
      // limit on an attempt that actually succeeded.
      const demoAddress = (() => {
        try {
          // Same key the gate at line 165 derived from. Compute once here
          // so we can show the address (not the key) to the user.
          const { privateKeyToAccount } = require("viem/accounts");
          return privateKeyToAccount(
            (process.env.DEMO_WALLET_PRIVATE_KEY || "") as `0x${string}`,
          ).address;
        } catch {
          return null;
        }
      })();
      return NextResponse.json(
        {
          status: "timeout",
          error: `Demo timed out after ${HARD_TIMEOUT_MS / 1000}s. The on-chain transaction may have landed anyway — check the demo wallet's recent transactions on BaseScan before retrying.`,
          demoWalletAddress: demoAddress,
          baseScanRecentTxUrl: demoAddress
            ? `https://sepolia.basescan.org/address/${demoAddress}`
            : null,
          retryHint: "Wait 60s (rate limit), then click again. Typical Base Sepolia settle is 50-75s today.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        status: "settle_failed",
        error: `Demo settle failed: ${msg.slice(0, 300)}`,
      },
      { status: 503 },
    );
  }
}

// ── Phase 2 settle pipeline ────────────────────────────────────────────────

interface DemoFlowDeps {
  demoKey: string;
  // viem types are heavy; using `any` here keeps the lazy-import boundary
  // clean without bleeding viem types into the gate-only cold-start path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createWalletClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  http: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseSepolia: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  privateKeyToAccount: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generatePrivateKey: any;
  req: NextRequest;
  startedAt: number;
}

async function runDemoFlow(deps: DemoFlowDeps) {
  const {
    demoKey,
    publicClient,
    createWalletClient,
    http,
    baseSepolia,
    privateKeyToAccount,
    generatePrivateKey,
    req,
    startedAt,
  } = deps;

  // Poseidon is heavy — lazy import.
  const { poseidon2 } = await import("poseidon-lite");

  const account = privateKeyToAccount(demoKey as `0x${string}`);
  // Writes go through public RPC; Infura rejects some pool writes.
  const writeRpcUrl = "https://sepolia.base.org";
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(writeRpcUrl),
  });

  // ── 1. Approve USDC if allowance < deposit amount ────────────────────────
  const ERC20_ABI = [
    {
      name: "allowance",
      type: "function" as const,
      stateMutability: "view" as const,
      inputs: [
        { name: "owner", type: "address" as const },
        { name: "spender", type: "address" as const },
      ],
      outputs: [{ type: "uint256" as const }],
    },
    {
      name: "approve",
      type: "function" as const,
      stateMutability: "nonpayable" as const,
      inputs: [
        { name: "spender", type: "address" as const },
        { name: "amount", type: "uint256" as const },
      ],
      outputs: [{ type: "bool" as const }],
    },
  ] as const;

  const allowance = (await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, ENTRYPOINT_ADDRESS],
  })) as bigint;

  if (allowance < DEMO_DEPOSIT_AMOUNT_ATOMIC) {
    const approveTx = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ENTRYPOINT_ADDRESS, 2n ** 256n - 1n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  // ── 2. Build precommitment + deposit ─────────────────────────────────────
  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const precommitment = poseidon2([nullifier, secret]);

  const DEPOSIT_ABI = [
    {
      name: "deposit",
      type: "function" as const,
      stateMutability: "nonpayable" as const,
      inputs: [
        { name: "_asset", type: "address" as const },
        { name: "_amount", type: "uint256" as const },
        { name: "_precommitment", type: "uint256" as const },
      ],
      outputs: [],
    },
  ] as const;

  const depositTxHash = await walletClient.writeContract({
    address: ENTRYPOINT_ADDRESS,
    abi: DEPOSIT_ABI,
    functionName: "deposit",
    args: [USDC_ADDRESS, DEMO_DEPOSIT_AMOUNT_ATOMIC, precommitment],
    gas: 1_000_000n,
  });

  const depositReceipt = await publicClient.waitForTransactionReceipt({
    hash: depositTxHash,
  });
  if (depositReceipt.status !== "success") {
    throw new Error(`Deposit tx reverted: ${depositTxHash}`);
  }

  // ── 3. Parse Deposited event for on-chain commitment + label + value ─────
  // Per CLAUDE.md: value is POST-FEE (vetting fee deducted), label is
  // computed on-chain. We MUST read both from the event.
  let onChainCommitment = 0n;
  let onChainLabel = 0n;
  let onChainValue = 0n;
  for (const log of depositReceipt.logs as Array<{
    address: string;
    topics: string[];
    data: string;
  }>) {
    if (
      log.address.toLowerCase() === USDC_POOL_ADDRESS.toLowerCase() &&
      log.topics[0] === DEPOSITED_TOPIC
    ) {
      const data = log.data;
      if (data.length >= 258) {
        onChainCommitment = BigInt("0x" + data.slice(2, 66));
        onChainLabel = BigInt("0x" + data.slice(66, 130));
        onChainValue = BigInt("0x" + data.slice(130, 194));
      }
      break;
    }
  }
  if (onChainLabel === 0n || onChainValue === 0n) {
    throw new Error(
      `Deposit confirmed but Deposited event missing/unparseable. tx=${depositTxHash}`,
    );
  }

  // ── 4. Wait for HyperSync to index the new deposit, then trigger ASP update.
  // Without this poll there's a race: HyperSync indexes Deposited events with
  // 1–10s lag. If asp-update runs before the new label is visible, it builds
  // an on-chain ASP root that excludes it — then withdraw rebuilds the same
  // (still-stale) HyperSync labels and fails with "Label not found in ASP tree".
  // Poll HyperSync directly until our label shows up; cap at 60s.
  const apiBase = getApiBase(req);
  const { createPublicClient: createPC, http: httpT } = await import("viem");
  const { baseSepolia: baseSep } = await import("viem/chains");
  // The demo is Base-Sepolia-only by design (baseSep below); chainId 84532 is
  // always HyperSync-entitled today, so this is `hypersyncUrlFor(84532) ?? <today's
  // literal>` — an explicit fallback so behaviour is unchanged if HYPERSYNC_CHAINS
  // is ever narrowed.
  const HYPERSYNC_URL = hypersyncUrlFor(84532) ?? "https://base-sepolia.rpc.hypersync.xyz";
  const hsClient = createPC({
    chain: baseSep,
    transport: httpT(HYPERSYNC_URL, {
      fetchOptions: {
        headers: {
          Authorization: `Bearer ${process.env.HYPERSYNC_TOKEN || ""}`,
        },
      },
    }),
  });
  const DEPOSITED_EVENT_FOR_POLL = {
    type: "event" as const,
    name: "Deposited" as const,
    inputs: [
      { name: "_depositor", type: "address" as const, indexed: true as const },
      { name: "_commitment", type: "uint256" as const, indexed: false as const },
      { name: "_label", type: "uint256" as const, indexed: false as const },
      { name: "_value", type: "uint256" as const, indexed: false as const },
      { name: "_precommitmentHash", type: "uint256" as const, indexed: false as const },
    ],
  };
  const HS_POLL_DEADLINE = Date.now() + 60_000;
  let labelVisible = false;
  while (Date.now() < HS_POLL_DEADLINE) {
    try {
      const recentLogs = await hsClient.getLogs({
        address: USDC_POOL_ADDRESS as `0x${string}`,
        event: DEPOSITED_EVENT_FOR_POLL,
        fromBlock: depositReceipt.blockNumber,
        toBlock: "latest",
      });
      if (
        recentLogs.some(
          (l) => (l.args as { _label?: bigint })._label === onChainLabel,
        )
      ) {
        labelVisible = true;
        break;
      }
    } catch {
      // transient HyperSync hiccup — retry
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!labelVisible) {
    throw new Error(
      `HyperSync did not index deposit label ${onChainLabel.toString()} within 60s. tx=${depositTxHash}`,
    );
  }

  // Submit only the public tx hash. /api/deposits/confirm independently proves
  // the pool event; ASP_UPDATE_SECRET and signer authority remain server-side.
  const asp = await confirmDepositForAsp(depositTxHash, {
    endpoint: `${apiBase}/api/deposits/confirm`,
    maxAttempts: 3,
    retryDelayMs: 2_000,
  });
  if (asp.status === "rejected") {
    throw new Error("Demo deposit was rejected by association policy");
  }

  // ── 5. Generate a fresh ephemeral recipient ──────────────────────────────
  // One-shot random key; we don't keep it. Only the .address is used as
  // the withdraw destination, so the demo wallet -> recipient link is
  // unobservable on-chain (that's the whole point).
  const ephemeralAccount = privateKeyToAccount(generatePrivateKey());
  const ephemeralRecipient = ephemeralAccount.address;

  // ── 6. Withdraw: /api/withdraw handles proof gen + relay submission ──────
  const withdrawRes = await fetch(`${apiBase}/api/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nullifier: nullifier.toString(),
      secret: secret.toString(),
      value: onChainValue.toString(),
      label: onChainLabel.toString(),
      commitment: onChainCommitment.toString(),
      recipient: ephemeralRecipient,
      // amountAtomic omitted → withdraw full value
    }),
  });

  if (!withdrawRes.ok) {
    const body = await withdrawRes.text().catch(() => "");
    throw new Error(
      `Withdraw failed (HTTP ${withdrawRes.status}): ${body.slice(0, 200)}`,
    );
  }
  const withdrawJson = (await withdrawRes.json()) as {
    success?: boolean;
    txHash?: string;
    error?: string;
  };
  if (!withdrawJson.success || !withdrawJson.txHash) {
    throw new Error(
      `Withdraw returned non-success: ${withdrawJson.error || "unknown"}`,
    );
  }
  const settleTxHash = withdrawJson.txHash;

  // ── 7. Anonymity-set size (best-effort, non-fatal) ───────────────────────
  let anonymitySetSize = 0;
  try {
    const treeSize = (await publicClient.readContract({
      address: USDC_POOL_ADDRESS,
      abi: [
        {
          name: "currentTreeSize",
          type: "function" as const,
          stateMutability: "view" as const,
          inputs: [],
          outputs: [{ type: "uint256" as const }],
        },
      ],
      functionName: "currentTreeSize",
    })) as bigint;
    anonymitySetSize = Number(treeSize);
  } catch {
    // Non-fatal: the settle is real even if this read fails.
    anonymitySetSize = 0;
  }

  const totalWallClockMs = Date.now() - startedAt;

  return {
    status: "ok",
    depositTxHash,
    settleTxHash,
    ephemeralRecipient,
    totalWallClockMs,
    anonymitySetSize,
    baseScanLinks: {
      deposit: `https://sepolia.basescan.org/tx/${depositTxHash}`,
      settle: `https://sepolia.basescan.org/tx/${settleTxHash}`,
    },
    gatesChecked: {
      envConfigured: true,
      rateLimit: true,
      dailyBudget: `${dailyRunCount}/${DAILY_RUN_LIMIT} runs used today`,
      walletBalanceOk: true,
    },
    demoDepositAmountUsdc: DEMO_DEPOSIT_AMOUNT_USDC,
  };
}

function getApiBase(req: NextRequest): string {
  // Prefer explicit env (set in production) so we don't trust the Host header.
  // Falls back to request URL for local dev.
  const envBase = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  try {
    const url = new URL(req.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "http://localhost:3000";
  }
}
