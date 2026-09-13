/**
 * private-payout.ts — OPT-IN seller privacy (Slice 4). Sellers receive
 * IMMEDIATELY to their existing wallet (Slices 1-2); this is a SEPARATE, async
 * "sweep to pool" layer that makes accumulated revenue UNLINKABLE.
 *
 * Mechanism (no meta-address): the seller derives a pool-note precommitment from
 * their EXISTING HD wallet (`deriveForwardingNote(mnemonic, index)`) and registers
 * their payTo as a `watchedAddress`. The forwarding engine then auto-deposits USDC
 * received at that address into the privacy pool, crediting the seller. Later the
 * seller recovers the notes (`recoverPrivatePayoutNotes`) and withdraws to any
 * address — no on-chain link between the sales and the withdrawal.
 *
 * TRADEOFF: pooled funds are NOT immediately spendable (deposit → anonymity delay
 * → withdraw). This is private *savings*, not the receive path. Amounts are still
 * visible on-chain; only the sale↔withdrawal link is broken. The forwarding engine
 * is operator-run today (scripts/forwarding-engine.ts), not a hosted service.
 */
import { deriveForwardingNote, recoverForwardingNotes, type ForwardingNoteSecrets } from "@zbase-protocol/core";
import { registrationMessage } from "@/app/api/forwarding/register/route";

export type PayoutNetwork = "mainnet" | "sepolia";

/** Sign an arbitrary message (EIP-191 personal_sign) with the watchedAddress key. */
export type SignMessage = (message: string) => Promise<`0x${string}`> | `0x${string}`;

/** Derive the seller's pool-note secrets from their existing HD wallet (no meta-address). */
export function derivePayoutNote(mnemonic: string, index: number): ForwardingNoteSecrets {
  return deriveForwardingNote(mnemonic, index);
}

/**
 * The exact registration payload + canonical message to sign. Pure (no network) —
 * so a caller can inspect/sign it however they like before POSTing.
 */
export function buildPayoutRegistration(args: {
  watchedAddress: `0x${string}`;
  mnemonic: string;
  index: number;
  network: PayoutNetwork;
}): {
  note: ForwardingNoteSecrets;
  message: string;
  body: { watchedAddress: `0x${string}`; authorityMode: "b1"; precommitment: string; nextIndex: number; network: PayoutNetwork };
} {
  const note = deriveForwardingNote(args.mnemonic, args.index);
  const message = registrationMessage(args.watchedAddress, note.precommitment, args.index, args.network);
  return {
    note,
    message,
    body: {
      watchedAddress: args.watchedAddress,
      authorityMode: "b1",
      precommitment: note.precommitment,
      nextIndex: args.index,
      network: args.network,
    },
  };
}

/**
 * Enable private payout: derive the note, sign the registration with the seller's
 * existing wallet key, and register the watched address. Returns the derived note
 * to PERSIST (it is the claim authority — store it durably, never in logs/chat).
 */
export async function enablePrivatePayout(args: {
  baseUrl: string;
  watchedAddress: `0x${string}`;
  mnemonic: string;
  index: number;
  network: PayoutNetwork;
  signMessage: SignMessage;
  fetchImpl?: typeof fetch;
}): Promise<{ note: ForwardingNoteSecrets; registered: boolean; error?: string }> {
  const { note, message, body } = buildPayoutRegistration(args);
  const signature = await args.signMessage(message);
  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(`${args.baseUrl.replace(/\/$/, "")}/api/forwarding/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, signature }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { note, registered: false, error: (err as { error?: string }).error ?? `HTTP ${res.status}` };
  }
  return { note, registered: true };
}

/**
 * Claim side: given the pool's Deposited events, recover which notes (across the
 * seller's HD indices up to `maxIndex`) belong to this seller. Feed the results
 * into the pool withdraw flow to move funds out unlinkably.
 */
export function recoverPrivatePayoutNotes(
  mnemonic: string,
  depositedEvents: Array<{ commitment: string; label: string; value: string }>,
  maxIndex: number,
): Array<ForwardingNoteSecrets & { value: string; label: string; commitment: string }> {
  return recoverForwardingNotes(mnemonic, depositedEvents, maxIndex);
}
