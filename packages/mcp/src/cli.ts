#!/usr/bin/env node
/**
 * zbase — CLI for the zBase private agent wallet. The same code path the MCP tools use,
 * exposed as shell commands so a Claude Code skill (or any script) can drive it.
 *
 * Secrets never print (except `seed show`, which is gated). The 12-word seed lives at
 * ~/.zbase/seed (0600); every note derives from it.
 *
 *   zbase address                      # the address to send USDC to (creates a wallet on first run)
 *   zbase balance                      # spendable pool balance
 *   zbase sweep [amount]               # move funded USDC into the pool (gasless)
 *   zbase probe <url> [--body '<json>']# does this seller deliver? ($0, spends nothing)
 *   zbase pay <url> [maxUSDC] [--pilot] [--body '<json>'] [--no-probe]
 *   zbase seed show                    # SENSITIVE: print the 12-word seed to back up offline
 *   zbase seed import "<12 words>"     # import an existing BIP39 wallet (refuses to overwrite)
 */
import { createFacilitatorClient } from "@zbase-protocol/core";
import { fundAddress, fundSweep } from "./tools/fund.js";
import { payPrivately } from "./tools/pay-privately.js";
import { walletBalance, loadWalletBalance } from "./tools/wallet-balance.js";
import { ZBASE_FACILITATOR_URL, ZBASE_NETWORK } from "./config.js";
import { noteAt } from "./account.js";
import { getOrCreateSeed, importSeed, seedExists, walletHome } from "./wallet.js";

async function nextNoteSlot(): Promise<{ precommitment: string; index: number }> {
  const balance = await loadWalletBalance();
  const index = balance.highestFoundIndex + 1;
  return { precommitment: noteAt(index).precommitment, index };
}

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}
function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HELP = `zbase — private agent wallet on Base

  zbase address                         the USDC deposit address (creates a wallet on first run)
  zbase balance                         spendable pool balance
  zbase sweep [amount]                  move funded USDC into the pool (gasless)
  zbase probe <url> [--body '<json>']   will this seller deliver? ($0)
  zbase pay <url> [maxUSDC] [--pilot] [--body '<json>'] [--no-probe]
  zbase seed show                       SENSITIVE: print the 12-word seed to back up offline
  zbase seed import "<12 words>"        import an existing BIP39 wallet

Money-safety: read the pay result's outcome. On "settled_not_delivered" the note IS spent (do not
re-pay that seller); on "uncertain" it MAY be. Either way pay re-selects a DIFFERENT note next call —
run 'balance' first, never blind-retry.`;

async function main(): Promise<void> {
  const [cmd, a1, a2] = process.argv.slice(2);
  switch (cmd) {
    case "address":
      console.log(await fundAddress());
      break;
    case "balance":
      console.log(await walletBalance({}));
      break;
    case "sweep": {
      const amount = a1 && /^\d+(\.\d+)?$/.test(a1) ? a1 : undefined;
      console.log(await fundSweep({ amount }, await nextNoteSlot()));
      break;
    }
    case "probe": {
      if (!a1) throw new Error("usage: zbase probe <url> [--body '<json>']");
      const body = argValue("--body");
      const init = {
        method: body ? "POST" : "GET",
        ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
      };
      const client = createFacilitatorClient({ baseUrl: ZBASE_FACILITATOR_URL, network: ZBASE_NETWORK });
      console.log(JSON.stringify(await client.probe(a1, init), null, 2));
      break;
    }
    case "pay": {
      if (!a1) throw new Error("usage: zbase pay <url> [maxUSDC] [--pilot] [--body '<json>'] [--no-probe]");
      const acceptNotPrivate = argFlag("--pilot") || argFlag("--accept-not-private");
      const maxUSDC = a2 && /^\d+(\.\d+)?$/.test(a2) ? a2 : "0.10";
      const body = argValue("--body");
      const method = body ? "POST" : undefined;
      const skipProbe = argFlag("--no-probe");
      console.log(await payPrivately({ url: a1, maxAmountUSDC: maxUSDC, acceptNotPrivate, method, body, skipProbe }));
      break;
    }
    case "seed": {
      if (a1 === "show" || a1 === "backup") {
        const existed = seedExists();
        const seed = getOrCreateSeed();
        console.log(
          JSON.stringify(
            {
              seed,
              storedAt: walletHome(),
              wasNewlyCreated: !existed,
              warning: "Anyone with these words owns your funds. Write them down offline.",
            },
            null,
            2,
          ),
        );
      } else if (a1 === "import") {
        if (!a2) throw new Error('usage: zbase seed import "<12-word mnemonic>"');
        importSeed(a2);
        console.log(JSON.stringify({ imported: true, storedAt: walletHome() }, null, 2));
      } else {
        throw new Error("usage: zbase seed <show|import>");
      }
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error("FAILED:", (e as Error).message);
  process.exit(1);
});
