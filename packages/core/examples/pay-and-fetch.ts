/**
 * Safe happy-path: pay one x402 API privately and use its data.
 *
 * ⚠️ THIS SPENDS REAL USDC when run against a real seller on mainnet. It is opt-in: it does nothing
 * unless you set ZBASE_PAY_URL (and provide a funded note). Read ./handle-tri-state.ts first — that
 * is the pattern you must follow for money-safety.
 *
 *   ZBASE_PAY_URL=https://api.seller.com/endpoint npx tsx examples/pay-and-fetch.ts
 *
 * Payment facts this example pins (always be explicit about these):
 *   network  eip155:8453 (Base mainnet)     token  USDC
 *   ceiling  50000 atomic = 0.05 USDC        recipient  the seller's payTo from its 402
 */
import { createFacilitatorClient, type DepositSecrets } from "@zbase-protocol/core";

const url = process.env.ZBASE_PAY_URL;
if (!url) {
  console.log("Set ZBASE_PAY_URL to run this (it spends real USDC). See ./handle-tri-state.ts for the safe pattern.");
  process.exit(0);
}

// Bring your own funded note + persistence. NEVER hardcode note secrets in source.
declare const myFundedNote: DepositSecrets;
declare function saveNote(n: DepositSecrets): void;

const zbase = createFacilitatorClient({
  baseUrl: "https://zbase.app",
  network: "eip155:8453",
});

const res = await zbase.payAndFetch(
  url,
  { method: "GET" },
  {
    deposit: myFundedNote,
    onNoteRotate: saveNote,
    maxAmountAtomic: "50000", // 0.05 USDC ceiling vs a hostile 402
    acceptNotPrivate: true, // open pilot: settle even though the set < 30
  },
);

if (res.outcome === "delivered") {
  console.log("status:", res.status);
  console.log("data:", res.response);
  console.log("funding tx:", res.fundingTxHash);
  console.log("private?:", res.privacy?.private);
} else {
  // free | refused | uncertain — handle exactly like ./handle-tri-state.ts. Never re-pay from a
  // different note on "uncertain"; retry the same call (res.safeToRetry).
  console.log("non-delivered outcome:", res.outcome);
}
