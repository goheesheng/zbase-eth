/**
 * recover-postman-usdc.ts — return USDC held by the CDP postman smart account.
 *
 * Runs LOCALLY — no box/SSH needed. The postman is a CDP-managed smart account, so the
 * CDP credentials are the only thing required; the CDP API controls the account.
 *
 * Provide the SAME CDP credentials the server uses (from /srv/zbase/mainnet/app.env):
 *   CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET
 * plus CDP_POSTMAN_OWNER / CDP_POSTMAN_SMART_ACCOUNT only if you overrode the defaults.
 *
 * It resolves the postman with the exact same names zBase uses, then REFUSES to send
 * unless the resolved address matches the expected postman — so wrong creds/names abort
 * instead of touching the wrong wallet.
 *
 *   RETURN_TO=0x12FCed65536f4F19757b56d276172c177Bf53C01 \
 *   CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... CDP_WALLET_SECRET=... \
 *   npx tsx scripts/recover-postman-usdc.ts
 *
 * RETURN_ATOMIC defaults to 1000000 ($1 — the stranded amount). Override to send more.
 */
import "./load-env"; // loads .env.local (CDP creds live there)
import {
  createPublicClient,
  http,
  getAddress,
  encodeFunctionData,
  parseAbi,
  formatUnits,
} from "viem";
import { base } from "viem/chains";

const GO = process.argv.includes("--go"); // default is a DRY RUN — nothing sent without --go

const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const DEST = getAddress(process.env.RETURN_TO ?? "0x12FCed65536f4F19757b56d276172c177Bf53C01");
const AMOUNT = BigInt(process.env.RETURN_ATOMIC ?? "1000000"); // $1.00 — the stranded amount
const EXPECT_POSTMAN = getAddress(
  process.env.EXPECT_POSTMAN ?? "0xd411f68a53F5698d05c840C52065a624F9CC5769",
);

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

async function main() {
  for (const k of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) {
    if (!process.env[k]) throw new Error(`Missing ${k} — copy it from /srv/zbase/mainnet/app.env`);
  }
  const ownerName = process.env.CDP_POSTMAN_OWNER ?? "zbase-postman-owner";
  const smartName = process.env.CDP_POSTMAN_SMART_ACCOUNT ?? "zbase-postman";

  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const cdp = new CdpClient();
  const owner = await cdp.evm.getOrCreateAccount({ name: ownerName });
  const smart = await cdp.evm.getOrCreateSmartAccount({ name: smartName, owner });

  console.log("resolved postman:", smart.address, "(expected", EXPECT_POSTMAN + ")");
  if (getAddress(smart.address) !== EXPECT_POSTMAN) {
    throw new Error(
      `Resolved ${smart.address} != expected ${EXPECT_POSTMAN}. Wrong CDP account/names — aborting so we never touch the wrong wallet.`,
    );
  }

  const pub = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_MAINNET_RPC ?? "https://mainnet.base.org"),
  });
  const bal = (await pub.readContract({
    address: USDC,
    abi: ERC20,
    functionName: "balanceOf",
    args: [EXPECT_POSTMAN],
  })) as bigint;
  console.log("postman USDC balance:", formatUnits(bal, 6));

  const amount = AMOUNT > bal ? bal : AMOUNT;
  if (amount <= 0n) {
    console.log("nothing to return — postman holds 0 USDC.");
    return;
  }

  console.log();
  console.log("  WILL SEND :", formatUnits(amount, 6), "USDC");
  console.log("  FROM      :", EXPECT_POSTMAN, "(postman)");
  console.log("  TO        :", DEST, "  <-- the wallet that RECEIVES the USDC");
  console.log();

  if (!GO) {
    console.log("DRY RUN — nothing sent. Re-run with --go to execute the transfer.");
    return;
  }

  console.log(`sending ${formatUnits(amount, 6)} USDC -> ${DEST} (gasless userOp)…`);
  const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [DEST, amount] });
  const userOp = await smart.sendUserOperation({ network: "base", calls: [{ to: USDC, data, value: 0n }] });
  const receipt = await smart.waitForUserOperation(userOp);
  if (receipt.status !== "complete" || !receipt.transactionHash) {
    throw new Error(`userOp did not complete: status=${receipt.status}`);
  }
  console.log("DONE. tx:", `https://basescan.org/tx/${receipt.transactionHash}`);
}

main().catch((e) => {
  console.error("FAILED:", (e as Error).message);
  process.exit(1);
});
