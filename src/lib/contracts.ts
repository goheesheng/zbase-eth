/**
 * Central contract-stack registry.
 *
 * zBase runs against a single deployed stack on Base Sepolia (the addresses
 * recorded in CLAUDE.md "Deployed Contracts — plain 0xbow Privacy Pool (CURRENT)").
 * The live pool is a plain 0xbow PrivacyPool — NO yield, NO Morpho (verified
 * on-chain 2026-06-25). PrivacyPoolMorpho.sol (the yield patch) was never deployed.
 *
 * Historical note: this file briefly supported a STAGING stack that deployed
 * a parallel MockUSDC + MockMorphoVault + PrivacyPoolMorpho on Base Sepolia
 * via `zbase-protocol/pkg/contracts/script/DeployStaging.s.sol`. The staging
 * path was abandoned 2026-06-01 because PrivacyPoolMorpho.sol is only the
 * yield-distribution patch — it has no Merkle tree, no Deposited event, and
 * no way to spend deposited commitments back out. Making staging fully
 * functional would require vendoring 0xbow's upstream Entrypoint + PrivacyPool
 * (~1-2 days plus permanent upstream-sync burden), which we don't intend to
 * pay for now. Testers acquire real Sepolia USDC via faucet.circle.com.
 *
 * The staging contracts deployed earlier today (MockUSDC, MockMorphoVault,
 * PrivacyPoolMorpho, ThresholdEntrypoint) remain on-chain, orphaned and
 * costing nothing. If a future change re-enables staging, the addresses are
 * preserved in git history at the chore(staging-abandoned) commit.
 *
 * Date: 2026-06-01
 *
 * 2026-06-09 — Phase 1A UTXO scaffold. Added dual-stack support so callers
 * can opt into the new variable-amount UTXO pool deployed alongside the
 * existing single-value plain 0xbow PrivacyPool. The two pools have disjoint
 * anonymity sets by design (different SCOPE values), so callers must pick
 * one and stick with it for a given deposit's lifecycle. Default remains
 * "single-value" — UTXO is opt-in via `getActiveStack({ stack: "utxo" })`.
 */

import type { Address, Chain } from "viem";
import { base, baseSepolia } from "viem/chains";

export type StackName = "single-value" | "utxo";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Which chain the stack is deployed on. Selection is by the `NEXT_PUBLIC_NETWORK`
 * env var (server + client), defaulting to "sepolia" so existing behavior is
 * unchanged until mainnet is explicitly turned on. "mainnet" = Base mainnet
 * (eip155:8453); "sepolia" = Base Sepolia (eip155:84532).
 */
export type StackNetwork = "sepolia" | "mainnet";

/** Resolve the active network from env, defaulting to sepolia (back-compat). */
export function activeNetwork(): StackNetwork {
  const n = (process.env.NEXT_PUBLIC_NETWORK ?? "").toLowerCase();
  return n === "mainnet" ? "mainnet" : "sepolia";
}

/**
 * Per-network chain + RPC resolution (B6 fix, audit-sweep-2026-06-17).
 *
 * The withdraw / asp-update / verify routes previously HARDCODED
 * `chain: baseSepolia` and `"https://sepolia.base.org"` even though they read
 * their contract addresses from `getActiveStack()`. On `NEXT_PUBLIC_NETWORK=mainnet`
 * they would sign for chainId 84532 against mainnet addresses and broadcast to a
 * Sepolia RPC — a broken (and dangerous) money path. This helper is the single
 * source of truth for "which chain + which RPC" so a network flip is consistent
 * everywhere.
 *
 * RPC precedence (read): per-network env override → public fallback. The write
 * RPC defaults to the same read RPC unless a dedicated write override is set.
 * Operators SHOULD set the env overrides for production (public RPCs rate-limit
 * and cap eth_getLogs — see CLAUDE.md gotchas).
 */
export interface ActiveChain {
  network: StackNetwork;
  chain: Chain;
  /** RPC for eth_call / readContract. */
  readRpcUrl: string;
  /** RPC for signed writes (sendRawTransaction). */
  writeRpcUrl: string;
}

export function getActiveChain(network?: StackNetwork): ActiveChain {
  const net: StackNetwork = network ?? activeNetwork();
  if (net === "mainnet") {
    const read =
      process.env.BASE_MAINNET_RPC ??
      process.env.NEXT_PUBLIC_BASE_MAINNET_RPC ??
      "https://mainnet.base.org";
    const write = process.env.BASE_MAINNET_WRITE_RPC ?? read;
    return { network: net, chain: base, readRpcUrl: read, writeRpcUrl: write };
  }
  const read =
    process.env.BASE_SEPOLIA_RPC ??
    process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ??
    "https://sepolia.base.org";
  const write = process.env.BASE_SEPOLIA_WRITE_RPC ?? read;
  return { network: net, chain: baseSepolia, readRpcUrl: read, writeRpcUrl: write };
}

export interface ContractStack {
  label: "production";
  /**
   * Which logical stack this is. Used for log telemetry + sanity checks
   * downstream — the actual pool to talk to is `usdcPool` below.
   */
  stack: StackName;
  /**
   * CAIP-2 network identifier for the x402 facilitator (e.g. "eip155:84532"
   * for Base Sepolia, "eip155:8453" for Base mainnet). Used as the network
   * namespace for Upstash tier lookups in /api/withdraw. When mainnet is
   * added, this field MUST be populated correctly on the mainnet stack —
   * otherwise tier lookups will silently miss and per-settle fees default
   * to 0 (FIND-301 reopens).
   */
  facilitatorNetwork: "eip155:84532" | "eip155:8453";
  entrypoint: `0x${string}`;
  usdcPool: `0x${string}`;
  usdc: `0x${string}`;
  withdrawalVerifier: `0x${string}`;
  commitmentVerifier: `0x${string}`;
  /** First block to scan from in eth_getLogs sweeps. */
  poolDeployBlock: bigint;
  /**
   * B2 ExecutorProcessooor — the private-funded-DeFi-access executor (Layer 2).
   * OPTIONAL: unset/zero-address means the /api/facilitator/call path is disabled
   * (returns 501). Populated per-stack from env EXECUTOR_PROCESSOOOR after deploy.
   * Testnet-only until externally audited (see plan §4b).
   */
  executorProcessooor?: `0x${string}`;
}

/** Reads EXECUTOR_PROCESSOOOR from env; zero-address (disabled) if unset/invalid. */
function envExecutor(): `0x${string}` {
  const v = process.env.EXECUTOR_PROCESSOOOR ?? process.env.NEXT_PUBLIC_EXECUTOR_PROCESSOOOR;
  return /^0x[0-9a-fA-F]{40}$/.test(v ?? "")
    ? (v as `0x${string}`)
    : ZERO_ADDRESS;
}

function asAddress(value: string | undefined, fallback: `0x${string}` = ZERO_ADDRESS): `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value ?? "") ? (value as `0x${string}`) : fallback;
}

function envAddress(names: readonly string[], fallback: `0x${string}` = ZERO_ADDRESS): `0x${string}` {
  for (const name of names) {
    const value = process.env[name];
    const parsed = asAddress(value);
    if (!isZeroAddress(parsed)) return parsed;
  }
  return fallback;
}

function envBigInt(names: readonly string[], fallback = 0n): bigint {
  for (const name of names) {
    const value = process.env[name];
    if (!value) continue;
    try {
      const parsed = BigInt(value);
      if (parsed >= 0n) return parsed;
    } catch {
      // keep scanning aliases
    }
  }
  return fallback;
}

function asNonNegativeBigInt(value: string | undefined, fallback = 0n): bigint {
  if (!value) return fallback;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function isZeroAddress(address: string | undefined | null): boolean {
  return !address || address.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Production stack — must match CLAUDE.md verbatim. Do NOT edit these
 * addresses without updating CLAUDE.md in the same change.
 */
export const PRODUCTION_STACK: ContractStack = {
  label: "production",
  stack: "single-value",
  facilitatorNetwork: "eip155:84532",
  entrypoint: "0x598ffaac79ae29b1aae571fd91899d4492183688",
  usdcPool: "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  withdrawalVerifier: "0x5f5505242730dfc8a2c2637eb5258dc2c6622641",
  commitmentVerifier: "0x293400accdeb0c1c2d419868303a8e96c09900ab",
  poolDeployBlock: 40668000n,
  executorProcessooor: envExecutor(),
};

/**
 * UTXO stack — Phase 1A scaffold (Shipment A.1). The pool address is a
 * placeholder until `scripts/deploy-utxo-pool.sh` runs and the operator
 * pastes the deployed address back in.
 *
 * Shares the Entrypoint (ASP root oracle), USDC token, and verifier
 * artifacts with the single-value stack. Only the pool address differs.
 *
 * IMPORTANT: do NOT route real USDC through this stack until BOTH
 *  (a) `scripts/deploy-utxo-pool.sh` populates `usdcPool` AND
 *  (b) the `note_spend.circom` trusted-setup ceremony has produced a real
 *      Groth16 verifier deployed at `withdrawalVerifier`.
 * Until then, callers should only use `unsafeTestMode=true` paths in dev.
 */
export const UTXO_STACK: ContractStack = {
  label: "production",
  stack: "utxo",
  facilitatorNetwork: "eip155:84532",
  entrypoint: "0x598ffaac79ae29b1aae571fd91899d4492183688",
  // TODO: set after `scripts/deploy-utxo-pool.sh` runs
  usdcPool: ZERO_ADDRESS as Address,
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  // TODO: ceremony — replace with deployed Verifier_NoteSpend address once
  // the trusted-setup ceremony for note_spend.circom completes. Until then
  // the UTXOPool contract should be deployed pointing at an UnsafeMockVerifier
  // so the scaffold smoke tests can run (see scripts/deploy-utxo-pool.sh).
  withdrawalVerifier: ZERO_ADDRESS as Address,
  commitmentVerifier: "0x293400accdeb0c1c2d419868303a8e96c09900ab",
  // UTXO pool deploy block — populate alongside `usdcPool` after deploy.
  poolDeployBlock: 0n,
};

/**
 * Base MAINNET single-value stack (Road A — production launch).
 *
 * Verifiers: 0xbow's audited Groth16 verifiers are the SAME BYTECODE on every
 * chain but NOT the same ADDRESS — verified on-chain 2026-06-28: 0x5f5505... /
 * 0x293400… have NO CODE on Base mainnet (0xbow deploys via CREATE2 with a
 * deployer-namespaced salt -> per-chain addresses). They must be DEPLOYED to Base
 * mainnet (DeployMainnetPool.s.sol does this) and supplied through env. USDC is
 * Circle's canonical Base-mainnet token. The pool (plain 0xbow PrivacyPool, no
 * yield, same design as the live Sepolia pool; NOT PrivacyPoolMorpho, which was
 * never deployed) + Entrypoint + deploy block are required before mainnet launch.
 * Mainnet deploys 0xbow's upstream PrivacyPool + Entrypoint (vendor from
 * github.com/0xbow-io/privacy-pools-core); the operator sets env vars after deploy.
 *
 * IMPORTANT: do NOT flip NEXT_PUBLIC_NETWORK=mainnet until usdcPool/entrypoint/
 * poolDeployBlock below are real deployed addresses, the ASP root has been set on
 * the mainnet Entrypoint, and the mainnet facilitator path is wired (Phase A3).
 * Until then, selecting mainnet would point the app at address(0).
 */
export const MAINNET_STACK: ContractStack = {
  label: "production",
  stack: "single-value",
  facilitatorNetwork: "eip155:8453",
  // Mainnet stack is env-wired so deployment does not require a code change.
  // Preflight/health fail closed while any required address is unset/zero.
  entrypoint: envAddress(
    ["BASE_MAINNET_ENTRYPOINT"],
    asAddress(process.env.NEXT_PUBLIC_BASE_MAINNET_ENTRYPOINT),
  ),
  usdcPool: envAddress(
    ["BASE_MAINNET_POOL"],
    asAddress(process.env.NEXT_PUBLIC_BASE_MAINNET_POOL),
  ),
  // Circle USDC on Base mainnet (canonical).
  usdc: envAddress(
    ["BASE_MAINNET_USDC"],
    asAddress(
      process.env.NEXT_PUBLIC_BASE_MAINNET_USDC,
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ),
  ),
  // Required mainnet verifier addresses. Sepolia verifier addresses have no code
  // on Base mainnet. 0xbow verifiers
  // are per-chain (CREATE2 deployer-namespaced salt). DeployMainnetPool.s.sol
  // deploys fresh WithdrawalVerifier + CommitmentVerifier on mainnet; set those
  // env vars before NEXT_PUBLIC_NETWORK=mainnet. (commitmentVerifier doubles
  // as the ragequit verifier.) See docs/release/mainnet-runbook-single-value.md.
  withdrawalVerifier: envAddress([
    "BASE_MAINNET_WITHDRAWAL_VERIFIER",
  ], asAddress(process.env.NEXT_PUBLIC_BASE_MAINNET_WITHDRAWAL_VERIFIER)),
  commitmentVerifier: envAddress([
    "BASE_MAINNET_COMMITMENT_VERIFIER",
  ], asAddress(process.env.NEXT_PUBLIC_BASE_MAINNET_COMMITMENT_VERIFIER)),
  poolDeployBlock: envBigInt(
    ["BASE_MAINNET_POOL_DEPLOY_BLOCK"],
    asNonNegativeBigInt(process.env.NEXT_PUBLIC_BASE_MAINNET_POOL_DEPLOY_BLOCK),
  ),
  executorProcessooor: envExecutor(),
};

export function contractStackLaunchIssues(stack: ContractStack = getActiveStack()): string[] {
  const issues: string[] = [];
  if (isZeroAddress(stack.entrypoint)) issues.push("entrypoint is unset/zero");
  if (isZeroAddress(stack.usdcPool)) issues.push("usdcPool is unset/zero");
  if (isZeroAddress(stack.usdc)) issues.push("usdc is unset/zero");
  if (isZeroAddress(stack.withdrawalVerifier)) issues.push("withdrawalVerifier is unset/zero");
  if (isZeroAddress(stack.commitmentVerifier)) issues.push("commitmentVerifier is unset/zero");
  if (stack.poolDeployBlock <= 0n) issues.push("poolDeployBlock must be > 0");
  return issues;
}

/**
 * The single source of truth for "which stack is this code talking to?".
 *
 * Selection is two-dimensional: (network, stack). Network defaults to the
 * `NEXT_PUBLIC_NETWORK` env var (sepolia unless explicitly "mainnet"); stack
 * defaults to "single-value". UTXO is opt-in via `{ stack: "utxo" }` and is
 * Sepolia-only for now (no mainnet UTXO until the ceremony + C4 fix — Road B).
 *
 * Back-compat: callers that pass nothing get the Sepolia single-value stack,
 * exactly as before this change.
 */
export function getActiveStack(opts?: {
  stack?: StackName;
  network?: StackNetwork;
}): ContractStack {
  const network: StackNetwork = opts?.network ?? activeNetwork();
  const name: StackName = opts?.stack ?? "single-value";
  return getStackByName(name, network);
}

/**
 * Direct lookup by stack name + network. Throws on unknown names so a typo
 * doesn't silently fall through to single-value (which would route a UTXO spend
 * to the wrong pool address). Throws if mainnet UTXO is requested — that stack
 * does not exist yet (Road B: needs the trusted-setup ceremony + C4 fix first).
 */
export function getStackByName(
  name: StackName,
  network: StackNetwork = "sepolia",
): ContractStack {
  if (network === "mainnet") {
    if (name === "single-value") return MAINNET_STACK;
    // UTXO on mainnet is intentionally absent — gated on the ceremony + the C4
    // circuit fix (see docs/security/internal-audit-2026-06-11.md). Fail loud
    // rather than silently route mainnet UTXO funds to a Sepolia/zero address.
    throw new Error(
      `No mainnet stack for "${name}" — UTXO mainnet is gated on the trusted-setup ceremony (Road B).`,
    );
  }
  switch (name) {
    case "single-value":
      return PRODUCTION_STACK;
    case "utxo":
      return UTXO_STACK;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown stack name: ${exhaustive as string}`);
    }
  }
}
