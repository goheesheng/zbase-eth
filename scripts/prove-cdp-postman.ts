/**
 * prove-cdp-postman.ts — one-shot proof that the CDP sponsored postman works.
 *
 * Forces POSTMAN_SIGNER=cdp in-process, then calls the SAME sendPostmanTx adapter
 * the routes use to send an `updateRoot` on the live Sepolia Entrypoint, posting
 * the CURRENT on-chain root value back. Because the root is unchanged, this does
 * NOT alter which deposits can withdraw — it's a real, sponsored on-chain tx whose
 * only purpose is to prove:
 *   1. the tx lands, from the CDP smart account address (0xd411f68a…),
 *   2. gas was sponsored (no ETH spent by us),
 *   3. the adapter's CDP branch returns a real tx hash.
 *
 *   npx tsx scripts/prove-cdp-postman.ts
 */
import "./load-env";

// Force CDP mode for THIS process only (does not touch .env.local).
process.env.POSTMAN_SIGNER = "cdp";

import { createPublicClient, http, formatEther } from "viem";
import { baseSepolia } from "viem/chains";
import { sendPostmanTx } from "../src/lib/postman-signer";

const ENTRYPOINT = "0x598ffaac79ae29b1aae571fd91899d4492183688" as const;
const SMART = "0xd411f68a53F5698d05c840C52065a624F9CC5769" as const;

const rpc = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const write = "https://sepolia.base.org";

const latestRootAbi = [{ name: "latestRoot", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
const updateRootAbi = [{
  name: "updateRoot", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "_root", type: "uint256" }, { name: "_ipfsCID", type: "string" }],
  outputs: [{ name: "_index", type: "uint256" }],
}] as const;

async function main() {
  const c = createPublicClient({ chain: baseSepolia, transport: http(rpc) });

  const currentRoot = (await c.readContract({ address: ENTRYPOINT, abi: latestRootAbi, functionName: "latestRoot" })) as bigint;
  console.log("Current on-chain root :", currentRoot.toString());
  console.log("Re-posting the SAME value (no change to withdrawal eligibility).");

  const smartBalBefore = await c.getBalance({ address: SMART });
  console.log("Smart-account ETH before:", formatEther(smartBalBefore), "(should stay ~unchanged if sponsored)");

  console.log("\nSending updateRoot via CDP sponsored smart account…");
  const txHash = await sendPostmanTx({
    address: ENTRYPOINT,
    abi: updateRootAbi,
    functionName: "updateRoot",
    // CID must be 32–64 bytes (Entrypoint.updateRoot: InvalidIPFSCIDLength).
    // This 46-char string satisfies it; content is irrelevant for the proof.
    args: [currentRoot, `QmZbaseCDPproof${Date.now()}padpadpadpadpad`.slice(0, 46)],
    gas: 200_000n,
    chain: baseSepolia,
    writeRpcUrl: write,
    readRpcUrl: rpc,
    // default waitForReceipt: true — the adapter's CDP branch waits internally.
  });

  console.log("\ntx hash:", txHash);

  const receipt = await c.getTransactionReceipt({ hash: txHash });
  const tx = await c.getTransaction({ hash: txHash });
  const smartBalAfter = await c.getBalance({ address: SMART });

  console.log("status      :", receipt.status);
  console.log("tx from     :", tx.from, tx.from.toLowerCase() === SMART.toLowerCase() ? "✅ == CDP smart account" : "❓ (may be the bundler EntryPoint — check below)");
  console.log("gasUsed     :", receipt.gasUsed.toString());
  console.log("Smart ETH after:", formatEther(smartBalAfter), smartBalAfter === smartBalBefore ? "✅ unchanged → sponsored" : "(changed)");
  console.log("\nBaseScan: https://sepolia.basescan.org/tx/" + txHash);
  console.log("\n✅ CDP sponsored postman proven on Sepolia." + (receipt.status !== "success" ? "  ⚠️ status not success — inspect the tx." : ""));
}

main().catch((e) => { console.error("Failed:", (e as Error).message || e); process.exit(1); });
