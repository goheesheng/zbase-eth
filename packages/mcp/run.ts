/**
 * run.ts — drive the zBase MCP wallet tools from the CLI, without an MCP client.
 *
 * Same code path the Claude/agent MCP tools use (fund_address → fund_sweep → pay), just
 * invoked directly so you can test the gasless flow end to end. Secrets never print: the
 * seed lives at ~/.zbase/seed (0600), derived addresses/notes stay local.
 *
 * The gasless deposit: send USDC to the funding address (no ETH, no approve — awal
 * `send`, an exchange, MetaMask all work), then `sweep` signs a receiveWithAuthorization
 * and the postman submits + deposits. You pay zero gas.
 *
 *   npx tsx run.ts address                 # the address to send USDC to
 *   npx tsx run.ts balance                 # spendable pool balance (from your seed)
 *   npx tsx run.ts sweep [amount]          # sign the funded USDC into the pool (gasless)
 *   npx tsx run.ts pay <url> [maxUSDC]     # pay an x402 provider privately from the pool
 */
import { createFacilitatorClient } from "@zbase-protocol/core";
import { fundAddress, fundSweep } from "./src/tools/fund.js";
import { payPrivately } from "./src/tools/pay-privately.js";
import { walletBalance } from "./src/tools/wallet-balance.js";
import { loadWalletBalance } from "./src/tools/wallet-balance.js";
import { ZBASE_FACILITATOR_URL, ZBASE_NETWORK } from "./src/config.js";
import { noteAt } from "./src/account.js";

async function nextNoteSlot(): Promise<{ precommitment: string; index: number }> {
  const balance = await loadWalletBalance();
  const index = balance.highestFoundIndex + 1;
  return { precommitment: noteAt(index).precommitment, index };
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  switch (cmd) {
    case "address":
      console.log(await fundAddress());
      break;
    case "balance":
      console.log(await walletBalance({}));
      break;
    case "sweep": {
      // Ignore a non-numeric arg (e.g. a pasted "# comment") — sweep the full balance.
      const amount = a1 && /^\d+(\.\d+)?$/.test(a1) ? a1 : undefined;
      console.log(await fundSweep({ amount }, await nextNoteSlot()));
      break;
    }
    case "probe": {
      // Free-probe a seller WITHOUT paying (SDK 0.4.0 client.probe): reads the 402 + sends
      // an invalid-signature dummy that never settles. Tells you if a real pay would
      // deliver ($0, no note spent).
      if (!a1) throw new Error("usage: run.ts probe <url> [--body '<json>']");
      const bodyIdx = process.argv.indexOf("--body");
      const body = bodyIdx >= 0 ? process.argv[bodyIdx + 1] : undefined;
      const init = {
        method: body ? "POST" : "GET",
        ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
      };
      const client = createFacilitatorClient({ baseUrl: ZBASE_FACILITATOR_URL, network: ZBASE_NETWORK });
      console.log(JSON.stringify(await client.probe(a1, init), null, 2));
      break;
    }
    case "pay": {
      if (!a1) throw new Error("usage: run.ts pay <url> [maxUSDC] [--pilot] [--body '<json>'] [--no-probe]");
      // --pilot acknowledges the open-pilot disclosure (anonymity set < minimum): the
      // payment settles but is NOT crowd-anonymous yet. Without it the SDK refuses.
      const acceptNotPrivate =
        process.argv.includes("--pilot") || process.argv.includes("--accept-not-private");
      const maxUSDC = a2 && /^\d+(\.\d+)?$/.test(a2) ? a2 : "0.10";
      // --body '<json>' switches to POST (for sellers like BlockRun whose x402
      // endpoints are POST /v1/search, /v1/chat/completions).
      const bodyIdx = process.argv.indexOf("--body");
      const body = bodyIdx >= 0 ? process.argv[bodyIdx + 1] : undefined;
      const method = body ? "POST" : undefined;
      // Free-probe runs by default; --no-probe skips it (only for a proven seller).
      const skipProbe = process.argv.includes("--no-probe");
      console.log(await payPrivately({ url: a1, maxAmountUSDC: maxUSDC, acceptNotPrivate, method, body, skipProbe }));
      break;
    }
    default:
      console.log("commands: address | balance | sweep [amount] | probe <url> | pay <url> [maxUSDC] [--pilot] [--body '<json>'] [--no-probe]");
  }
}

main().catch((e) => {
  console.error("FAILED:", (e as Error).message);
  process.exit(1);
});
