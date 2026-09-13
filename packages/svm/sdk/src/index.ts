/**
 * @zbase-protocol/svm — Solana implementation of zx402 privacy payments
 *
 * Chain-specific implementation for Solana. Implements the interfaces
 * from @zbase-protocol/core using Anchor programs and SPL tokens.
 *
 * Usage:
 *   import { SvmPool, SvmFacilitator } from "@zbase-protocol/svm";
 *   import { Connection, Keypair } from "@solana/web3.js";
 *
 *   const pool = new SvmPool({
 *     connection: new Connection("https://api.mainnet-beta.solana.com"),
 *     wallet: myKeypair,
 *     network: "mainnet-beta",
 *   });
 *
 *   // Deposit USDC into the privacy pool
 *   const deposit = await pool.deposit("10.0");
 *
 *   // Withdraw privately via ZK proof
 *   const withdrawal = await pool.withdraw(deposit.secrets, recipientAddress);
 *
 *   // Or use as an x402 facilitator
 *   const facilitator = new SvmFacilitator({ connection, wallet });
 *   const supported = facilitator.getSupported();
 */

export {
  SvmPool,
  PRIVATE_SVM_SCHEME,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  deriveSvmRecipientTokenAccount,
  validatePreparedSvmPayment,
} from "./pool.js";
export type {
  SvmPoolConfig,
  PreparedSvmPayment,
  PreparedSvmWithdrawal,
  PreparedSvmPaymentExpectations,
  ValidatedPreparedSvmPayment,
} from "./pool.js";
export { SvmFacilitator } from "./facilitator.js";
export type { SvmFacilitatorConfig } from "./facilitator.js";
export {
  PrivateExactSvmClientScheme,
  PrivateExactSvmServerScheme,
} from "./x402.js";
export type { PrivateExactSvmClientConfig } from "./x402.js";

// Re-export core types for convenience
export type {
  ZX402Pool,
  ZX402Facilitator,
  AccountSecrets,
  DepositResult,
  WithdrawResult,
  PayResult,
  PoolStats,
  VerifyRequest,
  VerifyResponse,
  SettleRequest,
  SettleResponse,
  SupportedCapabilities,
} from "@zbase-protocol/core";
