/**
 * @zbase-protocol/core — Chain-agnostic ZK privacy for x402 agent payments
 *
 * This package contains universal logic shared across all chain implementations:
 * - ZK proof generation (Groth16 via snarkjs)
 * - Merkle tree operations (Poseidon + lean-imt)
 * - Account/secrets management
 * - Privacy scanner scoring
 * - Abstract interfaces for Pool and Facilitator
 *
 * Chain-specific implementations:
 * - Base / EVM — Solidity Privacy Pools, plain USDC pool today (no deployed yield)
 * - @zbase-protocol/svm — Solana devnet scaffold, paused for audit fixes
 */

// Types & Interfaces
export type {
  AccountSecrets,
  ZX402AccountData,
  ChainType,
  DepositResult,
  WithdrawResult,
  PayResult,
  PoolStats,
  ZX402Pool,
  VerifyRequest,
  VerifyResponse,
  SettleRequest,
  SettleResponse,
  ZX402Facilitator,
  AgentPermissions,
  AgentInfo,
  RegisterAgentRequest,
  ExposureReport,
  SupportedCapabilities,
} from "./types.js";

// Account management
export {
  generateDepositSecrets,
  computeCommitment,
  computePrecommitment,
  computeNullifierHash,
  computeLabel,
  feToBE32,
  SNARK_SCALAR_FIELD,
  createAccount,
  serializeAccount,
  deserializeAccount,
} from "./account.js";

// ZK Proofs
export type { ProofInput, Groth16Proof, ProofResult } from "./proofs.js";
export { generateWithdrawalProof, verifyProofLocally } from "./proofs.js";

// Merkle tree
export { buildMerkleTree, generateMerkleProof, getTreeDepth } from "./merkle.js";

// Facilitator client — the buildable-on-top-of SDK surface
// (prepareDeposit / verifyPayment / settlePrivately). See facilitatorClient.ts.
export type {
  FacilitatorClientConfig,
  FacilitatorNetwork,
  DepositSecrets,
  PreparedDeposit,
  VerifyResult,
  SettleResult,
  SettleX402Result,
  X402AcceptsEntry,
  X402PaymentRequired,
  PrivateFetchResult,
  ProbeResult,
  DiscoveredResource,
  DepositConfig,
  FacilitatorReadiness,
} from "./facilitatorClient.js";
export {
  FacilitatorClient,
  createFacilitatorClient,
  assertSafeFacilitatorBaseUrl,
  parsePaymentRequired,
  selectExactAccepts,
  dummyX402Payload,
  // Message-only classifier: explains a seller-facilitator FAULT (CoinGecko-class) as the
  // seller's issue, not zBase. Never gates spending.
  diagnoseSellerFacilitatorFault,
  DEFAULT_BAZAAR_DISCOVERY_URL,
  DEFAULT_FACILITATOR_URL,
  BASE_MAINNET,
  BASE_SEPOLIA,
  depositConfigFor,
  // Parent-keyed change-note secrets: supply the result to /api/withdraw and the
  // remainder survives a crash (re-derivable from the note you spent). Exported so a
  // wallet can derive without going through a client.
  nextNoteFrom,
  // Recovery guard + predicate. `assertChangeRecoverable` throws unless a note's change
  // is durably recoverable; `isNoteRecoverable` is the underlying test.
  assertChangeRecoverable,
  isNoteRecoverable,
  // Thrown when the facilitator says it is closed for customer use. Catch it to
  // distinguish "not ready" from a real failure.
  FacilitatorNotReadyError,
} from "./facilitatorClient.js";

// Drop-in `exact`-scheme client for @x402/core: an existing x402 buyer switches
// to private payments with one `client.register(network, createZBaseExactClient(...))`
// instead of rewriting call sites onto payAndFetch. See x402SchemeClient.ts.
export type {
  ZBaseExactClientConfig,
  X402PaymentRequirements,
  X402PaymentPayloadResult,
} from "./x402SchemeClient.js";
export { ZBaseExactClient, createZBaseExactClient } from "./x402SchemeClient.js";

// Drop-in viem LocalAccount for the OTHER x402 generation: x402-fetch@1 /
// x402-axios@1 take `EvmSigner = SignerWallet | LocalAccount`, not a scheme
// client. Trade-off: the payer EOA is fixed per account (payments link to each
// other, never to your deposit). See x402PrivateAccount.ts.
export type { ZBasePrivateAccountConfig } from "./x402PrivateAccount.js";
export { createZBasePrivateAccount, deriveZBaseAccountKey } from "./x402PrivateAccount.js";

// Seller side — gate an API with x402 and receive immediately to your existing wallet.
export type {
  SellerConfig,
  Seller,
  SellerAccepts,
  SellerPaymentRequired,
} from "./sellerClient.js";
export { createSeller, buildPaymentRequired, DEFAULT_SELLER_FACILITATOR_URL } from "./sellerClient.js";

// Private swap-as-settlement: build a CallPlan for a Uniswap-V3-style router swap
// (the executor's whitelisted swap target). See swapPlan.ts + the Xochi analysis §7.
export type { BuildSwapCallPlanOpts } from "./swapPlan.js";
export {
  buildSwapCallPlan,
  EXACT_INPUT_SINGLE_SELECTOR,
} from "./swapPlan.js";

// Wallet balance: reconstruct spendable notes from a SEED PHRASE + the chain, with
// no note file. A note is spend authority handed over exactly once — drop it and the
// funds are locked forever (0.985 USDC, 2026-07-16). Derivation + on-chain spent
// checks make a seed sufficient, which is what makes this a wallet. See
// walletBalance.ts.
export type { WalletBalance, WalletNote, RecoveredNote, IsNullifierSpent } from "./walletBalance.js";
export { getWalletBalance, selectNote } from "./walletBalance.js";

// BIP39 seed management. A note IS spend authority, so a wallet built on this
// package needs to generate and validate a seed the same way it would a private
// key — the seed is what makes notes re-derivable instead of losable.
export type { ViewingKey } from "./viewingKeyHD.js";
export {
  generateNewMnemonic,
  isValidMnemonic,
  mnemonicFromEntropy,
  exportMnemonic,
  deriveViewingKeyFromMnemonic,
  deriveViewingKeyFromSeed,
  ZBASE_VIEWING_KEY_PATH_PREFIX,
} from "./viewingKeyHD.js";

// D3 forwarding notes (Phase 2 / forwarding rail): deterministic seed-derived
// deposit notes so a bounded relayer can deposit on the user's behalf WITHOUT
// being able to spend. Recovery is scan-by-commitment (no shared index). See
// forwardingNotes.ts + docs/superpowers/specs/2026-07-09-private-funding-rail-design.md.
export type { ForwardingNoteSecrets, SpendableNote } from "./forwardingNotes.js";
export {
  deriveForwardingNote,
  precommitmentForRelayer,
  recoverForwardingNotes,
  // Parent-keyed change-note derivation — collision-proof with deposits, and the basis
  // for change-note recovery. See forwardingNotes.ts.
  deriveChangeNote,
  // Seed-only change-note recovery: walk Withdrawn events from recovered deposits.
  recoverChangeNotes,
  ZBASE_FORWARDING_PATH_PREFIX,
} from "./forwardingNotes.js";


// ─────────────────────────────────────────────────────────────────────────
// UTXO note surface — SCAFFOLD (SDK audit 2026-07-09).
//
// The variable-amount UTXO primitives are a PRE-DEPLOYMENT scaffold: the UTXO
// pool is not deployed (routes return 501) and the trusted-setup ceremony has
// not run. The 2026-07-09 SDK audit found that shipping them on the MAIN entry
// with production-looking types was a fund-lock footgun for integrators
// (incompatible note wire formats; NPK-default-0 notes addressable to nobody;
// seed-vs-mnemonic recovery divergence).
//
// These exports remain here because the zBase app itself imports them for the
// 501-gated UTXO route. For EXTERNAL integrators, they are also re-exported from
// the `@zbase-protocol/core/experimental` subpath (see package.json `exports`) —
// the intent being that a first-party consumer uses the main entry, while a
// third party has to reach for `/experimental` explicitly and thereby accept
// that this surface is unfinished. The public README documents ONLY the
// deployed surface. Do NOT rely on the UTXO wire format until the pool ships.
//
// TODO(post-ceremony): fix the note wire format (packCiphertext vs scanner
// bytes32[4]), require real NPK binding in createNote, and reject <64-byte
// recovery seeds — then promote to the main documented surface.
//
// The UTXO exports now live in ./experimental.ts, published under the subpath
// `@zbase-protocol/core/experimental`. The main entry (this file) ships ONLY the
// deployed, audited surface. Internal callers (the zBase app's 501-gated UTXO
// route) import from "@zbase-protocol/core/experimental" too.
// ─────────────────────────────────────────────────────────────────────────

// ERC-5564 stealth addresses (Shipment B.1 — scheme id 1, secp256k1)
export type {
  StealthMetaAddress,
  StealthMetaAddressWithPrivate,
  DerivedStealthAddress,
  ScanMatch,
} from "./stealth.js";
export {
  STEALTH_SCHEME_ID,
  DEFAULT_CHAIN_TAG,
  generateMetaAddress,
  parseMetaAddress,
  isStealthMetaAddress,
  deriveStealthAddress,
  scanForPayments,
  computeStealthPrivateKey,
} from "./stealth.js";
