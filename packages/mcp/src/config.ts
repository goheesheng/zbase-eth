/**
 * Shared config for the @zbase-protocol/mcp server.
 *
 * The hosted zBase facilitator at https://zbase.app is the default; self-hosters
 * point at their own deployment via ZBASE_FACILITATOR_URL.
 *
 * Config only. The wallet's seed lives in wallet.ts (a 0600 file), NOT here and NOT
 * in env by default. Note-spend proving still happens at the facilitator — it needs
 * the note secrets to prove — but the SEED never leaves this machine, so a
 * compromised facilitator can spend one note, not derive the rest.
 */

import type { FacilitatorNetwork } from "@zbase-protocol/core";

export const ZBASE_FACILITATOR_URL =
  process.env.ZBASE_FACILITATOR_URL ?? "https://zbase.app";

// Typed so it is passed straight to the SDK client (which selects the payment chain from it).
// Base mainnet default; override for other chains (e.g. ZBASE_NETWORK=eip155:84532 for Base
// Sepolia, or ZBASE_NETWORK=eip155:11155111 for Ethereum Sepolia — ETHONLINE-2026).
export const ZBASE_NETWORK = (process.env.ZBASE_NETWORK ?? "eip155:8453") as FacilitatorNetwork;

export const FETCH_TIMEOUT_MS = Number(
  process.env.ZBASE_FETCH_TIMEOUT_MS ?? 120_000,
);

/**
 * Phase 1C amount bucketing. Unique payment amounts are a fingerprint: an
 * observer who sees a $3.17 deposit and a $3.17-shaped conservation chain
 * can link them even through the pool. Paying in standard buckets puts every
 * payment in a crowd of identical-value payments.
 *
 * Non-bucket amounts produce a privacyWarning in the pay result by default;
 * set ZBASE_STRICT_AMOUNT_BUCKETS=true to reject them before any proof
 * generation or facilitator round-trip.
 */
export const RECOMMENDED_AMOUNTS_USDC = [1, 5, 10, 50, 100] as const;

export const STRICT_AMOUNT_BUCKETS =
  String(process.env.ZBASE_STRICT_AMOUNT_BUCKETS ?? "false").toLowerCase() ===
  "true";

// EPHEMERAL mode removed in 0.2.0. It asked the model to treat note secrets as
// session-only while those secrets travelled through tool arguments any client may
// log — a prompt pretending to be a guarantee, whose actual effect was that unspent
// deposits died with the conversation. Notes now derive from a local seed, so there
// is nothing to be ephemeral about. --ephemeral / ZBASE_EPHEMERAL are ignored.

export type ZBaseDeposit = {
  nullifier: string;
  secret: string;
  value: string;
  label: string;
  commitment: string;
};

export type PaymentDetails = {
  scheme: "exact";
  networkId: string;
  payTo: string;
  maxAmountRequired: string; // atomic USDC (6 decimals)
};
