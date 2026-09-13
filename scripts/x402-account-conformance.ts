/**
 * Compile-time conformance: the zBase private account IS an x402-fetch signer.
 *
 * Type-checked, not run. The entire v1 adoption story rests on this compiling:
 *
 *   wrapFetchWithPayment(fetch, createZBasePrivateAccount({ deposit }))
 *
 * x402-fetch@1 takes `EvmSigner = SignerWallet<Chain,Transport,Account> |
 * LocalAccount`. A mocked unit test cannot prove we satisfy that — it only
 * asserts our own shape back at us. Only the real type can.
 *
 * Run: npm run test:x402-account-conformance
 */
import { wrapFetchWithPayment } from "x402-fetch";
import { createZBasePrivateAccount } from "../packages/core/src/x402PrivateAccount.js";

const account = createZBasePrivateAccount({
  deposit: { nullifier: "1", secret: "2", value: "990000", label: "3", commitment: "4" },
  onNoteRotate: (n) => void n,
  maxAmountAtomic: "10000",
});

// THE assertion. If this stops compiling, x402-fetch users cannot use zBase.
const fetchWithPay = wrapFetchWithPayment(fetch, account);

void fetchWithPay;
export {};
