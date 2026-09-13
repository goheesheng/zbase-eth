#!/usr/bin/env node
/**
 * @zbase-protocol/mcp — a private agent wallet, over MCP.
 *
 * Send USDC to your wallet; it lands in a ZK privacy pool. Ask it to call any x402
 * provider; it pays from the pool. The provider sees a single-use address with no link
 * to your funding wallet.
 *
 *   fund_address  → where to send USDC (any wallet works; you never need ETH)
 *   fund_sweep    → move what arrived into the pool
 *   balance       → your spendable balance, rebuilt from the seed
 *   pay           → pay + fetch any x402 URL, privately
 *   seed_backup   → show the 12 words, once, so you can write them down
 *
 * WHAT CHANGED IN 0.2.0, and why:
 *
 * This package used to be a stateless HTTP proxy that held no keys. Its `pay` tool
 * took note secrets as TOOL ARGUMENTS, and an "EPHEMERAL mode" asked the model not to
 * persist them — while they travelled through a transcript any client may log, and
 * while unspent deposits became unrecoverable when the conversation ended. Its
 * `deposit` tool ignored its own amount argument and returned no secrets, so it could
 * not even chain into `pay`.
 *
 * That design asked a language model to be the custodian of bearer secrets. A note's
 * nullifier/secret ARE the money and are issued exactly once: drop them and the funds
 * are locked in the pool forever — no ragequit, no re-derivation. 0.985 USDC was lost
 * exactly that way on 2026-07-16 by a careful implementation that had read the
 * warning.
 *
 * So now there is ONE seed on disk (0600, ~/.zbase), every note derives from it, and
 * no secret ever enters the conversation. EPHEMERAL mode is deleted: it was a prompt
 * pretending to be a guarantee, and with derivation there is nothing to be ephemeral
 * about.
 *
 * Transport: stdio. Configure in claude_desktop_config.json:
 *
 *   { "mcpServers": { "zbase": { "command": "npx", "args": ["-y", "@zbase-protocol/mcp"] } } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fundAddressSchema, fundSweepSchema, fundAddress, fundSweep } from "./tools/fund.js";
import { walletBalanceSchema, walletBalance, loadWalletBalance } from "./tools/wallet-balance.js";
import { payPrivatelySchema, payPrivately } from "./tools/pay-privately.js";
import { getOrCreateSeed, seedExists, walletHome } from "./wallet.js";
import { noteAt } from "./account.js";
import { ZBASE_FACILITATOR_URL, ZBASE_NETWORK } from "./config.js";

const SERVER_NAME = "zbase";
const SERVER_VERSION = "0.3.1";

/**
 * The next free note index: highest found on-chain + 1.
 *
 * Derived from the CHAIN, not a local counter. A counter would desync from reality the
 * moment a machine is wiped or a deposit is made elsewhere, and reusing an index mints
 * a duplicate commitment whose second note is unspendable. The seed plus the pool's
 * public commitments are the only two things that are always true.
 */
async function nextNoteSlot(): Promise<{ precommitment: string; index: number }> {
  const balance = await loadWalletBalance();
  const index = balance.highestFoundIndex + 1;
  return { precommitment: noteAt(index).precommitment, index };
}

async function main(): Promise<void> {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        `zBase — a private agent wallet on Base. Facilitator: ${ZBASE_FACILITATOR_URL}. Network: ${ZBASE_NETWORK}.\n` +
        `Flow: fund_address (get a deposit address) → user sends USDC from any wallet → fund_sweep ` +
        `(move it into the privacy pool) → pay (call any x402 provider privately). balance shows what is spendable.\n` +
        `You never handle secrets: every note derives from a seed stored locally at ${walletHome()}. ` +
        `Do NOT ask the user for private keys or note secrets, and do not put them in the conversation.\n` +
        `Each payment spends ONE note, so a payment larger than the biggest single note fails even when the ` +
        `total covers it — balance reports largestNoteUSDC for this reason.`,
    },
  );

  server.registerTool(
    "fund_address",
    {
      title: "Get your funding address",
      description:
        "Returns the address to send USDC to. Any wallet works — it is an ordinary transfer and you do NOT need ETH. " +
        "The address is derived from your seed, so it survives a wiped machine. Funds sitting there are NOT private yet; " +
        "call fund_sweep to move them into the pool.",
      inputSchema: fundAddressSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text", text: await fundAddress() }] }),
  );

  server.registerTool(
    "fund_sweep",
    {
      title: "Move funded USDC into the privacy pool",
      description:
        "Sweeps USDC sitting at your funding address into the ZK privacy pool. Signs a gasless EIP-3009 authorization " +
        "locally — you never need ETH and the facilitator never holds your key. Omit `amount` to sweep everything. " +
        "The resulting note derives from your seed; there is nothing to write down.",
      inputSchema: fundSweepSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => ({ content: [{ type: "text", text: await fundSweep(args, await nextNoteSlot()) }] }),
  );

  server.registerTool(
    "balance",
    {
      title: "Your spendable pool balance",
      description:
        "Your balance, rebuilt from your seed plus the pool's public commitments. No note file is involved — a wiped " +
        "machine restores from the seed alone. Reports largestNoteUSDC because each payment spends ONE note.",
      inputSchema: walletBalanceSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => ({ content: [{ type: "text", text: await walletBalance(args) }] }),
  );

  server.registerTool(
    "pay",
    {
      title: "Pay an x402 provider privately",
      description:
        "Pays and fetches any x402 URL using funds from the privacy pool. The provider is paid by a single-use address " +
        "with no on-chain link to your funding wallet, and it needs no zBase integration — it sees an ordinary x402 " +
        "payment. Change is derived from your seed automatically. " +
        "MONEY-SAFETY: read the result's `outcome` + `safeToRetry`. outcome:'refused' or a clean pre-settlement " +
        "error means the note is UNTOUCHED (safeToRetry:true) — retrying is safe. outcome:'delivered' means the " +
        "seller returned a 2xx. outcome:'settled_not_delivered' means the note IS spent and the seller returned no " +
        "2xx — the spend is final, so do NOT re-pay that seller. outcome:'uncertain' means the note MAY be spent. " +
        "On any of the last three this tool re-selects a DIFFERENT note on the next call — do NOT blindly retry. " +
        "Run `balance` first and only pay again if you confirm you were not charged. A blind retry is the one way " +
        "to double-pay.",
      inputSchema: payPrivatelySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => ({ content: [{ type: "text", text: await payPrivately(args) }] }),
  );

  server.registerTool(
    "seed_backup",
    {
      title: "Show your seed phrase (SENSITIVE)",
      description:
        "Reveals the 12-word seed that controls ALL your funds, so you can write it down offline. Anyone who reads it " +
        "can spend everything. It will appear in this conversation's history — only call it when the user explicitly " +
        "asks to back up, and tell them to store it offline.",
      inputSchema: z.object({
        confirm: z
          .literal(true)
          .describe("Must be true. The user has explicitly asked to see the seed and understands it will appear here."),
      }).shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      // Gated on an explicit confirm because a model that volunteers this into a
      // transcript has just published the wallet.
      const existed = seedExists();
      const seed = getOrCreateSeed();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                seed,
                storedAt: walletHome(),
                wasNewlyCreated: !existed,
                warning:
                  "Anyone with these words owns your funds. Write them down offline. They are now in this conversation's history — treat it accordingly.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout IS the MCP transport.
  console.error(`[zbase-mcp] ${SERVER_NAME} v${SERVER_VERSION}`);
  console.error(`[zbase-mcp] facilitator: ${ZBASE_FACILITATOR_URL} (${ZBASE_NETWORK})`);
  console.error(`[zbase-mcp] wallet: ${walletHome()}`);
}

main().catch((err) => {
  console.error("[zbase-mcp] fatal:", err);
  process.exit(1);
});
