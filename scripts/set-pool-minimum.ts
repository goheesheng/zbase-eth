/**
 * set-pool-minimum.ts — arm the on-chain minimum deposit. Prints calldata; sends nothing.
 *
 * WHY THIS EXISTS
 * The live mainnet Entrypoint has `minimumDepositAmount = 0`, so zero-value deposits are
 * free and unlimited. That is not cosmetic:
 *
 *   - Anyone can mint unlimited commitments for the price of gas, so the anonymity set
 *     is not evidence of anything and ANONYMITY_SET_PROVENANCE_NOT_VERIFIED can never
 *     honestly be cleared.
 *   - anonymity-set/route.ts counts deposits by depositor identity and never reads
 *     `_value`, so spam inflates `organicDeposits` and can push `disclosureMode` from
 *     "bootstrap" to "raw" — making the pool REVEAL a thin organic set. An attacker can
 *     make it lie about itself.
 *
 * The on-chain guard already exists — `if (_value < _config.minimumDepositAmount) revert
 * MinimumDepositAmount();` (Entrypoint.sol:329). It is simply inert against a floor of 0.
 * One transaction re-arms it at the source.
 *
 * HOW IT GOT HERE (so it isn't repeated)
 * The pool deployed 2026-07-13 with `vm.envOr('POOL_MIN_DEPOSIT', uint256(0))` — default
 * zero, no guard. The `require(minDeposit > 0)` landed 2026-07-16, three days AFTER the
 * pool was live. The runbook's "the deploy script refuses zero" is true of the script and
 * false of the chain, and the runbook itself says the live proxy is the source of truth.
 *
 * THE FOOTGUN THIS SCRIPT DEFUSES
 * `updatePoolConfiguration(asset, minimumDepositAmount, vettingFeeBPS, maxRelayFeeBPS)` is
 * NOT a partial setter — it overwrites all three. Hand-typing it with guessed fees would
 * silently reset the vetting fee and max relay fee, and readiness only ever reads
 * assetConfig[1], so the regression would be invisible. This script READS the live config
 * and re-passes the existing fees verbatim, so the only field that can change is the one
 * you meant to change.
 *
 * It does NOT hold the owner key and does not send. It prints calldata for
 * 0xfEbC47781B32d3c36A94674CF822Bc469dbbF378 (the only OWNER_ROLE holder, verified
 * on-chain) to submit.
 *
 * Run: npx tsx scripts/set-pool-minimum.ts [--min <atomic>]
 */
import { createPublicClient, http, encodeFunctionData, formatUnits, getAddress } from "viem";
import { base, baseSepolia } from "viem/chains";

const ASSET_CONFIG_ABI = [
  {
    name: "assetConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_asset", type: "address" }],
    outputs: [
      { name: "pool", type: "address" },
      { name: "minimumDepositAmount", type: "uint256" },
      { name: "vettingFeeBPS", type: "uint256" },
      { name: "maxRelayFeeBPS", type: "uint256" },
    ],
  },
] as const;

const UPDATE_POOL_CONFIG_ABI = [
  {
    name: "updatePoolConfiguration",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_asset", type: "address" },
      { name: "_minimumDepositAmount", type: "uint256" },
      { name: "_vettingFeeBPS", type: "uint256" },
      { name: "_maxRelayFeeBPS", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const NETWORK = (process.env.NETWORK ?? "mainnet") as "mainnet" | "sepolia";
const MAINNET = {
  chain: base,
  rpc: process.env.BASE_MAINNET_RPC ?? "https://mainnet.base.org",
  entrypoint: getAddress("0x275fAA86e2E316Abe46807453c1D95f101d36431"),
  usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  owner: getAddress("0xfebc47781b32d3c36a94674cf822bc469dbbf378"),
};
const SEPOLIA = {
  chain: baseSepolia,
  rpc: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org",
  entrypoint: getAddress("0x598ffaac79ae29b1aae571fd91899d4492183688"),
  usdc: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  owner: null as `0x${string}` | null,
};

async function main() {
  const cfg = NETWORK === "mainnet" ? MAINNET : SEPOLIA;
  const argMin = process.argv.indexOf("--min");
  const targetMin = argMin > -1 ? BigInt(process.argv[argMin + 1]) : 1_000_000n; // $1

  if (targetMin <= 0n) {
    throw new Error("--min must be > 0. A zero minimum is the bug this script exists to fix.");
  }

  const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
  const live = await client.readContract({
    address: cfg.entrypoint,
    abi: ASSET_CONFIG_ABI,
    functionName: "assetConfig",
    args: [cfg.usdc],
  });

  const [pool, minimumDepositAmount, vettingFeeBPS, maxRelayFeeBPS] = live;

  console.log(`\nzBase — arm the on-chain minimum deposit (${NETWORK})\n`);
  console.log("  LIVE assetConfig(USDC):");
  console.log("    pool                :", pool);
  console.log(
    "    minimumDepositAmount:",
    minimumDepositAmount.toString(),
    minimumDepositAmount === 0n ? "  ← ZERO: zero-value spam is free and unlimited" : "",
  );
  console.log("    vettingFeeBPS       :", vettingFeeBPS.toString());
  console.log("    maxRelayFeeBPS      :", maxRelayFeeBPS.toString());

  if (minimumDepositAmount >= targetMin) {
    console.log(
      `\n  Already at or above ${targetMin} atomic (${formatUnits(targetMin, 6)} USDC). Nothing to do.\n`,
    );
    return;
  }

  // The whole point: re-pass the LIVE fees. updatePoolConfiguration overwrites all three,
  // and readiness only reads index [1] — so a wrong fee here would never be caught.
  const data = encodeFunctionData({
    abi: UPDATE_POOL_CONFIG_ABI,
    functionName: "updatePoolConfiguration",
    args: [cfg.usdc, targetMin, vettingFeeBPS, maxRelayFeeBPS],
  });

  console.log("\n  PROPOSED change — ONLY the minimum moves:");
  console.log(
    `    minimumDepositAmount: ${minimumDepositAmount} → ${targetMin}  (${formatUnits(targetMin, 6)} USDC)`,
  );
  console.log(`    vettingFeeBPS       : ${vettingFeeBPS} → ${vettingFeeBPS}  (re-passed verbatim)`);
  console.log(`    maxRelayFeeBPS      : ${maxRelayFeeBPS} → ${maxRelayFeeBPS}  (re-passed verbatim)`);

  console.log("\n  SEND FROM (only OWNER_ROLE holder, verified on-chain):");
  console.log("   ", cfg.owner ?? "(unknown for this network — check hasRole before sending)");

  console.log("\n  cast send \\");
  console.log(`    ${cfg.entrypoint} \\`);
  console.log(`    "updatePoolConfiguration(address,uint256,uint256,uint256)" \\`);
  console.log(`    ${cfg.usdc} ${targetMin} ${vettingFeeBPS} ${maxRelayFeeBPS} \\`);
  console.log(`    --rpc-url ${cfg.chain.id === 8453 ? "https://mainnet.base.org" : "https://sepolia.base.org"} \\`);
  console.log("    --private-key $OWNER_PRIVATE_KEY");

  console.log("\n  raw calldata:");
  console.log("   ", data);

  console.log("\n  AFTER SENDING, verify all three (the fee regression is the real risk):");
  console.log("    npx tsx scripts/set-pool-minimum.ts     # re-run: should say 'Nothing to do'");
  console.log("");
}

main().catch((e) => {
  console.error("FAILED:", (e as Error).message);
  process.exit(1);
});
