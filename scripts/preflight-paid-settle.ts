/**
 * preflight-paid-settle.ts — READ-ONLY go/no-go check before running
 * `scripts/simulate-buyer.ts` (the real on-chain paid-settle proof on Sepolia).
 *
 * Why: simulate-buyer.ts spends real testnet funds across multiple txs (deposit,
 * access fee, relay). If the buyer wallet is underfunded, the RPC is wrong, the
 * dev server is down, or FEE_REQUIRED isn't actually on, the run fails halfway
 * and burns a 1-USDC deposit for nothing. This script makes ZERO transactions —
 * it only reads balances + pings endpoints — and prints PASS/FAIL so the real run
 * starts from a known-good state.
 *
 * It mirrors simulate-buyer.ts's exact constants (USDC/treasury/amounts) so what
 * it checks is what the real run will use — no drift.
 *
 * Usage (same env as the real run):
 *   BUYER_PRIVATE_KEY=0x... \
 *   ZBASE_API_URL=http://localhost:3009 \
 *   BASE_SEPOLIA_RPC=https://base-sepolia.g.alchemy.com/v2/KEY \
 *   npx tsx scripts/preflight-paid-settle.ts
 *
 * Exit 0 = all green, safe to run simulate-buyer.ts. Non-zero = fix the flagged
 * item first. Makes no changes, signs nothing, sends nothing.
 */

import { createPublicClient, http, formatUnits, formatEther, getAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ── Mirror simulate-buyer.ts constants (Sepolia single-value stack) ──
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const TREASURY = "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21" as const;
const DEPOSIT_AMOUNT_USDC = 1_000_000n; // 1 USDC
const ACCESS_FEE_USDC = 1_000n; // 0.001 USDC
// Mirror simulate-buyer.ts so the expected treasury delta is computed from the
// SAME numbers the real run uses (no hardcoded total that goes stale on a rate
// change — this drifted across the 2026 pricing revisions).
const SETTLE_AMOUNT_USDC = 700_000n; // 0.70 USDC settle
const STANDARD_TAKE_BPS = BigInt(process.env.ZBASE_FEE_STANDARD_BPS ?? "500"); // 5% default; keep in sync w/ facilitator-authz
const EXPECTED_TAKE_USDC = (SETTLE_AMOUNT_USDC * STANDARD_TAKE_BPS) / 10000n;
const EXPECTED_TREASURY_DELTA_USDC = ACCESS_FEE_USDC + EXPECTED_TAKE_USDC;
// The $0.70 settle is paid OUT OF the deposited note, not from fresh wallet USDC,
// so the buyer only needs deposit + access fee in USDC. Add a small buffer.
const REQUIRED_USDC = DEPOSIT_AMOUNT_USDC + ACCESS_FEE_USDC; // 1.001 USDC
const REQUIRED_USDC_WITH_BUFFER = REQUIRED_USDC + 10_000n; // +0.01 buffer
// Gas across deposit + approve + access-fee txs on Base Sepolia. ~0.005 ETH is
// the script's stated floor; require a hair more.
const REQUIRED_ETH_WEI = 5_000_000_000_000_000n; // 0.005 ETH

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const c = {
  cyan: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[1;32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[1;31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[1;33m${s}\x1b[0m`,
};
let failed = false;
const pass = (m: string) => console.log(c.green("  PASS  ") + m);
const fail = (m: string) => {
  console.log(c.red("  FAIL  ") + m);
  failed = true;
};
const warn = (m: string) => console.log(c.yellow("  WARN  ") + m);
const info = (m: string) => console.log("        " + m);

async function main() {
  console.log(c.cyan("\n=== preflight: paid-settle on Base Sepolia (READ-ONLY) ===\n"));

  // 1. Env vars
  const rawKey = process.env.BUYER_PRIVATE_KEY;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC;
  const apiUrl = process.env.ZBASE_API_URL ?? "http://localhost:3009";
  const feeRequired = String(process.env.ZBASE_FEE_REQUIRED ?? "false").toLowerCase() === "true";

  if (!rawKey) {
    fail("BUYER_PRIVATE_KEY not set — needed to derive the buyer address (never sent anywhere).");
    finish();
    return;
  }
  if (!rpcUrl) {
    fail("BASE_SEPOLIA_RPC not set — needed to read balances. Use your Alchemy/Infura key.");
    finish();
    return;
  }
  pass("BUYER_PRIVATE_KEY + BASE_SEPOLIA_RPC present");
  info(`ZBASE_API_URL = ${apiUrl}`);

  // 2. FEE_REQUIRED — the whole point of the test
  if (feeRequired) {
    pass("ZBASE_FEE_REQUIRED=true — the fee gate will be enforced (this is what we're proving)");
  } else {
    fail(
      "ZBASE_FEE_REQUIRED is NOT 'true'. The dev server must run with ZBASE_FEE_REQUIRED=true, " +
        "or the settle won't charge and the test proves nothing. Pass it inline when starting the server.",
    );
  }

  // 3. Derive buyer address
  let buyer: `0x${string}`;
  try {
    const key = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
    buyer = privateKeyToAccount(key).address;
    pass(`buyer address derived: ${buyer}`);
  } catch (e) {
    fail(`BUYER_PRIVATE_KEY invalid: ${(e as Error).message}`);
    finish();
    return;
  }

  // 4. RPC reachable + correct chain
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (e) {
    fail(`RPC unreachable at BASE_SEPOLIA_RPC: ${(e as Error).message}`);
    finish();
    return;
  }
  if (chainId === baseSepolia.id) {
    pass(`RPC reachable, chainId ${chainId} (Base Sepolia)`);
  } else {
    fail(`RPC chainId is ${chainId}, expected ${baseSepolia.id} (Base Sepolia). Wrong network.`);
  }

  // 5. Buyer ETH balance (gas)
  const ethWei = await client.getBalance({ address: buyer });
  if (ethWei >= REQUIRED_ETH_WEI) {
    pass(`buyer ETH: ${formatEther(ethWei)} ETH (≥ ${formatEther(REQUIRED_ETH_WEI)} needed for gas)`);
  } else {
    fail(
      `buyer ETH: ${formatEther(ethWei)} ETH — need ≥ ${formatEther(REQUIRED_ETH_WEI)}. ` +
        "Faucet: https://www.alchemy.com/faucets/base-sepolia",
    );
  }

  // 6. Buyer USDC balance (deposit + access fee)
  const usdc = (await client.readContract({
    address: USDC,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [buyer],
  })) as bigint;
  if (usdc >= REQUIRED_USDC_WITH_BUFFER) {
    pass(
      `buyer USDC: ${formatUnits(usdc, 6)} (≥ ${formatUnits(REQUIRED_USDC, 6)} needed: ` +
        `1.0 deposit + 0.001 access fee; the $0.70 settle comes out of the deposit)`,
    );
  } else {
    fail(
      `buyer USDC: ${formatUnits(usdc, 6)} — need ≥ ${formatUnits(REQUIRED_USDC, 6)}. ` +
        "Faucet: https://faucet.circle.com (Base Sepolia, 10 USDC/hr)",
    );
  }

  // 7. Treasury readable (we'll diff its balance after the run)
  try {
    const treasuryUsdc = (await client.readContract({
      address: USDC,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [getAddress(TREASURY)],
    })) as bigint;
    pass(`treasury readable: ${formatUnits(treasuryUsdc, 6)} USDC now (expect +${formatUnits(EXPECTED_TREASURY_DELTA_USDC, 6)} after the run)`);
    info(`  treasury = ${TREASURY}  (access ${formatUnits(ACCESS_FEE_USDC, 6)} + take ${formatUnits(EXPECTED_TAKE_USDC, 6)} @ ${Number(STANDARD_TAKE_BPS) / 100}% = ${formatUnits(EXPECTED_TREASURY_DELTA_USDC, 6)})`);
  } catch (e) {
    fail(`could not read treasury USDC balance: ${(e as Error).message}`);
  }

  // 8. Dev server + facilitator up
  try {
    const res = await fetch(`${apiUrl}/api/facilitator/supported`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const body = (await res.json()) as { pricing?: { enforced?: boolean } };
      pass(`facilitator reachable at ${apiUrl} (HTTP ${res.status})`);
      // Cross-check the SERVER's enforced flag matches our intent.
      const serverEnforced = body?.pricing?.enforced;
      if (serverEnforced === true) {
        pass("server reports pricing.enforced = true (fee gate live on the running server)");
      } else if (serverEnforced === false) {
        fail(
          "server reports pricing.enforced = false — the RUNNING dev server does NOT have " +
            "ZBASE_FEE_REQUIRED=true. Restart it with that env var (setting it only for this " +
            "script does NOT affect the already-running server).",
        );
      } else {
        warn("could not read pricing.enforced from /supported — verify the server has FEE_REQUIRED=true");
      }
    } else {
      fail(`facilitator returned HTTP ${res.status} at ${apiUrl}/api/facilitator/supported`);
    }
  } catch (e) {
    fail(
      `dev server not reachable at ${apiUrl}: ${(e as Error).message}. ` +
        "Start it: ZBASE_FEE_REQUIRED=true npm run dev -- -p 3009",
    );
  }

  // 9. ASP-root staleness hint (not a hard gate)
  info("");
  info("REMINDER: pre-warm the ASP root before settling to avoid an 18s on-chain wait:");
  info(`  curl -s -X POST ${apiUrl}/api/asp-update`);

  finish();
}

function finish() {
  console.log("");
  if (failed) {
    console.log(c.red("=== NOT READY — fix the FAIL items above before running simulate-buyer.ts ==="));
    process.exit(1);
  } else {
    console.log(c.green("=== READY — safe to run the on-chain paid-settle proof ==="));
    console.log("");
    console.log("Next (this SPENDS testnet funds — you run it):");
    console.log(
      "  BUYER_PRIVATE_KEY=$BUYER_PRIVATE_KEY ZBASE_API_URL=$ZBASE_API_URL \\",
    );
    console.log("    BASE_SEPOLIA_RPC=$BASE_SEPOLIA_RPC npx tsx scripts/simulate-buyer.ts");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(c.red("preflight crashed: ") + (e as Error).message);
  process.exit(1);
});
