/**
 * Legacy zBase SDK — local snapshot only
 *
 * The maintained public integration surface is @zbase-protocol/core. Do not
 * publish or recommend this legacy package without a separate API reconciliation.
 *
 * @example Basic usage
 * ```ts
 * import { ZX402 as ZBase } from "./dist/index.js";
 *
 * const zbase = new ZBase({ rpcUrl: "...", privateKey: "0x..." });
 * const account = zbase.createAccount();
 * await zbase.deposit(account, "10.0");
 * await zbase.pay(account, "0xProvider...");
 * ```
 *
 * @example Private x402 with wrapFetch (one-line privacy for agents)
 * ```ts
 * const privateFetch = zbase.wrapFetch(account);
 * const data = await privateFetch("https://api.example.com/paid-endpoint");
 * // 402 → ZK proof → private payment → data. Nobody knows who paid.
 * ```
 */

export { ZX402 } from "./zx402.js";
export { ZX402Account } from "./account.js";
export type {
  ZX402Config,
  DepositResult,
  WithdrawalResult,
  PaymentResult,
  AccountSecrets,
} from "./types.js";
