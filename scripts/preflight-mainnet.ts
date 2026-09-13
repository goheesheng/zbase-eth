#!/usr/bin/env tsx
import { createPublicClient, http } from "viem";
import {
  contractStackLaunchIssues,
  getActiveChain,
  getStackByName,
} from "../src/lib/contracts";
import { postmanSignerConfigIssues, postmanSignerKind } from "../src/lib/postman-signer";

const SEPOLIA_WITHDRAWAL_VERIFIER = "0x5f5505242730dfc8a2c2637eb5258dc2c6622641";
const SEPOLIA_COMMITMENT_VERIFIER = "0x293400accdeb0c1c2d419868303a8e96c09900ab";
const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ASSET_CONFIG_ABI = [{
  name: "assetConfig",
  type: "function",
  stateMutability: "view",
  inputs: [{ type: "address" }],
  outputs: [
    { type: "address" },
    { type: "uint256" },
    { type: "uint256" },
    { type: "uint256" },
  ],
}] as const;
const TREE_SIZE_ABI = [{
  name: "currentTreeSize",
  type: "function",
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint256" }],
}] as const;

let failures = 0;
let warnings = 0;

function pass(message: string): void {
  console.log(`  OK   ${message}`);
}

function warn(message: string): void {
  warnings += 1;
  console.warn(`  WARN ${message}`);
}

function fail(message: string): void {
  failures += 1;
  console.error(`  FAIL ${message}`);
}

function has(name: string): boolean {
  return Boolean(process.env[name] && String(process.env[name]).trim() !== "");
}

console.log("zBase Base mainnet preflight\n");

if (process.env.NEXT_PUBLIC_NETWORK === "mainnet") {
  pass("NEXT_PUBLIC_NETWORK=mainnet");
} else {
  fail("NEXT_PUBLIC_NETWORK must be set to mainnet for a production launch");
}

const stack = getStackByName("single-value", "mainnet");
const stackIssues = contractStackLaunchIssues(stack);
if (stackIssues.length === 0) {
  pass("mainnet contract stack is fully populated");
} else {
  for (const issue of stackIssues) fail(`mainnet contract stack: ${issue}`);
}

if (stack.usdc.toLowerCase() === BASE_MAINNET_USDC.toLowerCase()) {
  pass("mainnet USDC address is Circle canonical Base USDC");
} else {
  fail(`mainnet USDC is ${stack.usdc}; expected ${BASE_MAINNET_USDC}`);
}

if (stack.withdrawalVerifier.toLowerCase() === SEPOLIA_WITHDRAWAL_VERIFIER) {
  fail("withdrawalVerifier is still the Base Sepolia placeholder");
}
if (stack.commitmentVerifier.toLowerCase() === SEPOLIA_COMMITMENT_VERIFIER) {
  fail("commitmentVerifier is still the Base Sepolia placeholder");
}

const activeChain = getActiveChain("mainnet");
const mainnetRpcConfigured = has("BASE_MAINNET_RPC") || has("NEXT_PUBLIC_BASE_MAINNET_RPC");
if (mainnetRpcConfigured) {
  pass(`mainnet read RPC configured (${activeChain.readRpcUrl.startsWith("https://mainnet.base.org") ? "public fallback" : "custom"})`);
} else {
  fail("BASE_MAINNET_RPC or NEXT_PUBLIC_BASE_MAINNET_RPC is required");
}

if (stackIssues.length === 0 && mainnetRpcConfigured) {
  let requiredMinimum = 1_000_000n;
  try {
    if (has("ZBASE_REQUIRED_MIN_DEPOSIT_ATOMIC")) {
      requiredMinimum = BigInt(process.env.ZBASE_REQUIRED_MIN_DEPOSIT_ATOMIC!);
      if (requiredMinimum <= 0n) throw new Error("not positive");
    }
  } catch {
    fail("ZBASE_REQUIRED_MIN_DEPOSIT_ATOMIC must be a positive integer");
    requiredMinimum = 1_000_000n;
  }
  const configuredAnonymity = Number(process.env.ZBASE_MIN_CUSTOMER_ANONYMITY_SET ?? 30);
  const requiredAnonymity =
    Number.isSafeInteger(configuredAnonymity) && configuredAnonymity > 0
      ? configuredAnonymity
      : 30;

  try {
    const client = createPublicClient({
      chain: activeChain.chain,
      transport: http(activeChain.readRpcUrl),
    });
    const [assetConfig, treeSize] = await Promise.all([
      client.readContract({
        address: stack.entrypoint,
        abi: ASSET_CONFIG_ABI,
        functionName: "assetConfig",
        args: [stack.usdc],
      }),
      client.readContract({
        address: stack.usdcPool,
        abi: TREE_SIZE_ABI,
        functionName: "currentTreeSize",
      }),
    ]);

    if (assetConfig[0].toLowerCase() !== stack.usdcPool.toLowerCase()) {
      fail(`on-chain USDC assetConfig points to ${assetConfig[0]}, not ${stack.usdcPool}`);
    } else {
      pass("on-chain USDC assetConfig points to the configured privacy pool");
    }
    if (assetConfig[1] < requiredMinimum) {
      fail(
        `on-chain minimum deposit is ${assetConfig[1]} atomic USDC; required >= ${requiredMinimum}`,
      );
    } else {
      pass(`on-chain minimum deposit is ${assetConfig[1]} atomic USDC`);
    }
    if (treeSize < BigInt(requiredAnonymity)) {
      fail(`anonymity set is ${treeSize}; customer launch requires at least ${requiredAnonymity}`);
    } else {
      pass(`anonymity set is ${treeSize} (required ${requiredAnonymity})`);
    }
    if (String(process.env.ZBASE_ANONYMITY_SET_PROVENANCE_VERIFIED) !== "true") {
      fail("set ZBASE_ANONYMITY_SET_PROVENANCE_VERIFIED=true only after independent-depositor provenance review");
    } else {
      pass("anonymity-set provenance review is explicitly approved");
    }
  } catch (error) {
    fail(`could not verify live pool minimum/anonymity state: ${(error as Error).message}`);
  }
}
if (has("BASE_MAINNET_WRITE_RPC")) {
  pass("dedicated mainnet write RPC configured");
} else {
  warn("BASE_MAINNET_WRITE_RPC not set; writes will use the read RPC");
}

const signerIssues = postmanSignerConfigIssues();
let signerKind: ReturnType<typeof postmanSignerKind> | null = null;
try {
  signerKind = postmanSignerKind();
} catch {
  signerKind = null;
}
if (signerIssues.length === 0) {
  pass(`postman signer configured (${signerKind})`);
} else {
  for (const issue of signerIssues) fail(`postman signer: ${issue}`);
}
if (
  signerKind === "eoa" &&
  String(process.env.ZBASE_ALLOW_MAINNET_EOA_POSTMAN ?? "false").toLowerCase() !== "true"
) {
  fail("POSTMAN_SIGNER=eoa is blocked for mainnet; use POSTMAN_SIGNER=cdp or set the emergency override");
}

if (has("ASP_UPDATE_SECRET") || has("CRON_SECRET")) {
  pass("ASP update route has bearer-secret protection");
} else {
  fail("set ASP_UPDATE_SECRET or CRON_SECRET before production");
}

if (has("HYPERSYNC_TOKEN")) {
  pass("HyperSync token configured for ASP/deposit scans");
} else {
  fail("HYPERSYNC_TOKEN is required for reliable mainnet ASP scans");
}

if (has("UPSTASH_REDIS_REST_URL") && has("UPSTASH_REDIS_REST_TOKEN")) {
  pass("Upstash Redis configured for persistent authz/rate-limit state");
} else {
  fail("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for mainnet");
}

const provider = String(process.env.ASP_SCREENING_PROVIDER ?? "ofac").trim().toLowerCase();
if (provider === "" || provider === "ofac") {
  pass("ASP screening provider: OFAC + policy overlay");
  warn("paid graph-taint/KYT provider is not enabled; set ASP_SCREENING_PROVIDER=chainalysis when the account/API is ready");
} else if (provider === "chainalysis") {
  if (has("CHAINALYSIS_SCREENING_URL") && has("CHAINALYSIS_API_KEY")) {
    pass("Chainalysis ASP screening env configured");
  } else {
    fail("ASP_SCREENING_PROVIDER=chainalysis requires CHAINALYSIS_SCREENING_URL and CHAINALYSIS_API_KEY");
  }
} else {
  fail(`unsupported ASP_SCREENING_PROVIDER=${process.env.ASP_SCREENING_PROVIDER}`);
}

if (has("ZBASE_SEED_ENCRYPTION_KEY")) {
  pass("seed-note encryption key configured");
} else {
  warn("ZBASE_SEED_ENCRYPTION_KEY missing; seed-pool operations will be disabled/unsafe");
}

console.log("");
if (failures > 0) {
  console.error(`Preflight FAILED: ${failures} blocker(s), ${warnings} warning(s).`);
  process.exit(1);
}

console.log(`Preflight passed with ${warnings} warning(s).`);
