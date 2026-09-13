/**
 * canary-mainnet.ts — ONE real-USDC buyer→facilitator→seller payment on Base mainnet.
 *
 * Proves the path the product claims:
 *   402 → parsePaymentRequired → selectExactAccepts → POST /api/facilitator/settle-x402
 *   (ZK pool withdraw → ephemeral payer E → E signs EIP-3009) → retry with X-PAYMENT.
 *
 * USES createPrivateFetch + onNoteRotate, NOT raw payAndFetch.
 *
 * WHY THAT MATTERS (learned the expensive way, 2026-07-16): the change note's
 * nullifier/secret are generated RANDOMLY server-side (withdraw/route.ts:555-556)
 * and returned exactly ONCE as `nextDeposit`. They are never persisted server-side
 * and never logged. If the client process dies between the response and writing
 * them to disk, the remaining balance is locked in the pool FOREVER — no ragequit
 * (it needs those same secrets), no re-derivation. A first canary lost 0.985 USDC
 * exactly that way: it read the wrong result field (`data` instead of `response`),
 * threw, and never reached its save.
 *
 * So: onNoteRotate persists the note the moment the SDK hands it over, BEFORE any
 * logging or parsing can throw. Persist first, print second — always.
 *
 * Run: npx tsx scripts/canary-mainnet.ts
 */
import fs from "node:fs";
import path from "node:path";
import { createFacilitatorClient } from "../packages/core/src/index.ts";

const FACILITATOR = "https://zbase.app";
const SELLER = "https://x402.zbase.app/api/zx402/privacy-check";
const NETWORK = "eip155:8453" as const;
const MAX_ATOMIC = "10000"; // $0.01 hard ceiling — refuses a hostile 402

const dir = path.join(process.cwd(), "data");
const file = fs
  .readdirSync(dir)
  .filter((f) => /^mainnet-(deposit|change)-.*\.json$/.test(f))
  .sort()
  .pop();
if (!file) throw new Error("no spendable mainnet note found in data/");

const rec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
for (const k of ["nullifier", "secret", "label", "commitment"]) {
  if (!rec[k]) throw new Error(`note record missing ${k}`);
}
const value = rec.valueAtomic ?? rec.value;
if (!value) throw new Error("note record missing valueAtomic/value");

const deposit = {
  nullifier: rec.nullifier,
  secret: rec.secret,
  value: String(value),
  label: rec.label,
  commitment: rec.commitment,
};

console.log("zBase mainnet canary");
console.log("  note file   :", file);
console.log("  note value  :", (Number(value) / 1e6).toFixed(6), "USDC");
console.log("  spend cap   :", (Number(MAX_ATOMIC) / 1e6).toFixed(6), "USDC");
console.log("");

const client = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK });

// PERSIST-FIRST: fires the instant the SDK produces a change note, before anything
// else can throw. Losing this callback = losing the remaining balance, permanently.
const saveNote = (next: { nullifier: string; secret: string; value: string; label: string; commitment: string }) => {
  const out = path.join(dir, `mainnet-change-${Date.now()}.json`);
  fs.writeFileSync(
    out,
    JSON.stringify({ network: rec.network ?? "base-mainnet", ...next, valueAtomic: next.value, parent: file }, null, 2),
    { mode: 0o600 },
  );
  console.log("  [saved] change note ->", path.basename(out), `(${(Number(next.value) / 1e6).toFixed(6)} USDC)`);
};

const buy = client.createPrivateFetch({ deposit, maxAmountAtomic: MAX_ATOMIC, onNoteRotate: saveNote });

const started = Date.now();
try {
  const res = await buy(SELLER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: rec.depositor ?? "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21" }),
  });

  console.log("");
  console.log("RESULT:", res.paid ? "PAID + FETCHED" : "FETCHED (was free)", "in", ((Date.now() - started) / 1000).toFixed(1) + "s");
  console.log("  http status :", res.status);
  console.log("  payer EOA   :", res.payer ?? "(n/a)");
  const body = typeof res.response === "string" ? res.response : JSON.stringify(res.response ?? null);
  console.log("  seller body :", (body ?? "(empty)").slice(0, 240));
} catch (e) {
  console.log("");
  console.log("RESULT: FAILED after", ((Date.now() - started) / 1000).toFixed(1) + "s");
  console.log("  error:", String((e as Error).message).slice(0, 400));
  process.exitCode = 1;
}
