/**
 * print-cdp-postman.ts — get-or-create the CDP postman smart account, print its
 * ADDRESS. Run once before enabling POSTMAN_SIGNER=cdp: you need this address to
 * grant it the ASP_POSTMAN role on the Entrypoint (or pass as ENTRYPOINT_POSTMAN
 * at deploy). See docs/release/cdp-postman-setup.md.
 *
 * Uses the SAME account names + resolution as src/lib/postman-signer.ts, so the
 * address printed here is exactly the one that will sign in cdp mode.
 *
 *   npx tsx scripts/print-cdp-postman.ts
 *
 * Reads CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET from .env.local.
 * Idempotent: same names → same accounts across runs (safe to re-run).
 */
import "./load-env";
import { CdpClient } from "@coinbase/cdp-sdk";

async function main() {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    console.error(
      "Missing CDP creds. Set CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET in .env.local.",
    );
    process.exit(1);
  }

  const ownerName = process.env.CDP_POSTMAN_OWNER ?? "zbase-postman-owner";
  const smartName = process.env.CDP_POSTMAN_SMART_ACCOUNT ?? "zbase-postman";

  // CdpClient reads the three CDP_* vars from env automatically.
  const cdp = new CdpClient();

  console.log(`Resolving CDP accounts (owner="${ownerName}", smart="${smartName}")…`);
  const owner = await cdp.evm.getOrCreateAccount({ name: ownerName });
  const smart = await cdp.evm.getOrCreateSmartAccount({ name: smartName, owner });

  console.log("");
  console.log("  Owner EOA (CDP-managed):", owner.address);
  console.log("  POSTMAN smart account   :", smart.address);
  console.log("");
  console.log("Next: grant this smart account ASP_POSTMAN on the Entrypoint —");
  console.log("  existing pool : owner calls grantRole(_ASP_POSTMAN, <smart addr>)");
  console.log("  fresh deploy  : pass ENTRYPOINT_POSTMAN=<smart addr>");
  console.log("Then set POSTMAN_SIGNER=cdp. Base Sepolia gas is auto-sponsored;");
  console.log("mainnet needs a Paymaster policy in the CDP Portal.");
}

main().catch((err) => {
  console.error("Failed:", (err as Error).message || err);
  process.exit(1);
});
