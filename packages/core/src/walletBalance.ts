/**
 * walletBalance.ts — your balance, from a seed phrase and the chain. Nothing else.
 *
 * This is the piece that turns a bag of note-secrets into a wallet.
 *
 * Today a caller must hold every note file forever: a note's nullifier/secret ARE
 * the money, they are handed over exactly once, and if you drop them the funds are
 * locked in the pool for good — no ragequit, no re-derivation, no support ticket.
 * That is not a hypothetical failure mode. It cost 0.985 USDC on 2026-07-16, to an
 * implementation that had read the warning.
 *
 * A wallet does not work that way. A seed phrase reconstructs everything. So:
 *
 *   notes = recoverForwardingNotes(mnemonic, depositedEvents, maxIndex)
 *   unspent = notes where !nullifierHashes(nullifierHash(note))     // chain truth
 *   balance = sum(unspent.value)
 *
 * The seed is the only durable secret. Lose the device, restore from 12 words.
 *
 * ── Why the spent check must be on-chain ─────────────────────────────────────
 * The existing local `isSpent` (src/lib/deposit-vault.ts) reads a `withdrawn`
 * flag off the stored record. A fresh install restoring from a seed has no such
 * record, so every recovered note would look spendable — including ones already
 * spent. The pool's `nullifierHashes` mapping is the only source of truth a
 * restored wallet can trust (vendor/0xbow/contracts/State.sol:64).
 *
 * ── Scope, and an honest limit ───────────────────────────────────────────────
 * This recovers DEPOSITS. It does NOT yet recover change notes.
 *
 * A deposit emits `Deposited(commitment, label, value)` — everything needed to match
 * a derived candidate. A CHANGE note is inserted as a tree leaf and emits only
 * `LeafInserted(index, leaf, root)`: no value. Its secrets ARE derivable (the caller
 * supplies nextNullifier/nextSecret — see facilitatorClient.nextNoteFrom), but
 * without the value you cannot reconstruct Poseidon3(value, label, precommitment) to
 * prove which leaf is yours.
 *
 * So the caller must still keep the change note's VALUE from the payment response
 * (SDK: nextDeposit / onNoteRotate). Derivation removes the fatal half — the secrets
 * are no longer losable — but "restore from 12 words" is complete for deposits only.
 * Closing it needs the value in the leaf event, or reconstruction from the
 * withdrawal's public signals.
 *
 * Single-value pool only (the deployed one). Do NOT extend this to the UTXO /
 * `Transferred` rail: packages/core/src/experimental.ts:9-13 documents a live
 * ciphertext wire-format break — "Building a wallet on createScanner today will
 * LOSE received funds."
 */
import { computeNullifierHash } from "./account.js";
import {
  recoverForwardingNotes,
  recoverChangeNotes,
  type ForwardingNoteSecrets,
} from "./forwardingNotes.js";

/**
 * A note recovered from the seed, with its on-chain facts attached.
 *
 * The five required fields are what it takes to spend a note. HD-deposit extras
 * (`index`, `precommitment`, `derivationPath`) are present on recovered DEPOSITS and
 * absent on recovered CHANGE notes, which are parent-keyed rather than HD-indexed.
 */
export type RecoveredNote = {
  nullifier: string;
  secret: string;
  value: string;
  label: string;
  commitment: string;
  index?: number;
  precommitment?: string;
  derivationPath?: string;
  /**
   * True on recovered CHANGE notes — everything from `getWalletBalance` is seed-recovered,
   * so a change note (which carries no HD `index`) is still recoverable and must clear the
   * spend-guard. Deposits pass the guard via `index`; this is the change-note equivalent.
   */
  recoverable?: boolean;
};

/** A recovered note plus whether the chain says it is already spent. */
export type WalletNote = RecoveredNote & { spent: boolean };

export interface WalletBalance {
  /** Spendable total, atomic units. This is "your balance". */
  atomic: bigint;
  /** Unspent notes, largest first — feed the first one that covers a price. */
  spendable: WalletNote[];
  /** Recovered but already spent on-chain. Useful for history/debugging. */
  spent: WalletNote[];
  /** Highest index that produced an on-chain note; -1 when nothing was found. */
  highestFoundIndex: number;
}

/**
 * Reads `nullifierHashes(uint256)` off the deployed pool. Inject your own so this
 * module stays chain-client agnostic (viem publicClient, wagmi readContract, an
 * RPC batch — whatever the caller already has).
 */
export type IsNullifierSpent = (nullifierHash: string) => Promise<boolean>;

/**
 * Rebuild the wallet's balance from the seed + on-chain Deposited events.
 *
 * @param mnemonic        the ONLY durable secret. Never leaves the caller.
 * @param depositedEvents pool `Deposited` events { commitment, label, value }.
 *                        Fetch with the app's existing indexer/HyperSync scan.
 * @param isSpent         on-chain spent check (see IsNullifierSpent).
 * @param maxIndex        highest derivation index to scan, inclusive. Scan a
 *                        window PAST the last known note so a gap (a deposit that
 *                        never confirmed) doesn't truncate recovery. Default 50.
 *
 * Cost: recoverForwardingNotes is O(maxIndex × events) — it must test each derived
 * note against every event because (value, label) aren't known a priori
 * (forwardingNotes.ts:179). Fine per-user today; revisit if the event set grows.
 */
export async function getWalletBalance(args: {
  mnemonic: string;
  depositedEvents: Array<{ commitment: string; label: string; value: string }>;
  isSpent: IsNullifierSpent;
  maxIndex?: number;
  /**
   * Pool `Withdrawn` events { value, spentNullifier, newCommitment } from
   * /api/deposits/events. Supply them and CHANGE notes are recovered too (the whole
   * lineage rebuilds from the seed). Omit and only deposits are recovered — the balance
   * is then a lower bound, missing any unspent change.
   */
  withdrawals?: Array<{ value: string; spentNullifier: string; newCommitment: string }>;
}): Promise<WalletBalance> {
  const maxIndex = args.maxIndex ?? 50;
  const deposits = recoverForwardingNotes(args.mnemonic, args.depositedEvents, maxIndex);
  // Change notes: walk the withdrawal chain from the recovered deposits. Parent-keyed,
  // so no seed index needed beyond the deposits already recovered.
  const changes = args.withdrawals
    ? recoverChangeNotes(deposits, args.withdrawals)
    : [];
  // Mark change notes recoverable: they came from the seed (via the withdrawal chain), so
  // they clear the spend-guard even though they carry no HD index.
  const recovered: RecoveredNote[] = [
    ...deposits,
    ...changes.map((c) => ({ ...c, recoverable: true })),
  ];

  const checked: WalletNote[] = await Promise.all(
    recovered.map(async (n) => ({
      ...n,
      spent: await args.isSpent(computeNullifierHash(n.nullifier)),
    })),
  );

  const spendable = checked
    .filter((n) => !n.spent)
    .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));

  return {
    atomic: spendable.reduce((sum, n) => sum + BigInt(n.value), 0n),
    spendable,
    spent: checked.filter((n) => n.spent),
    // Deposits only — change notes are parent-keyed and carry no HD index.
    highestFoundIndex: deposits.length ? Math.max(...deposits.map((n) => n.index)) : -1,
  };
}

/**
 * Pick a single note that covers `amountAtomic`.
 *
 * Smallest-sufficient, not largest-first: it leaves the big notes intact for big
 * payments, and keeps change from fragmenting the set faster than it has to. The
 * pool spends ONE note per withdrawal (the circuit takes a single existing
 * nullifier/secret), so a balance that is merely large enough IN TOTAL is not
 * necessarily spendable — hence returning null rather than throwing on a
 * sum-is-enough-but-no-single-note-fits balance, which the caller must handle by
 * consolidating.
 */
export function selectNote(balance: WalletBalance, amountAtomic: bigint): WalletNote | null {
  const sufficient = balance.spendable
    .filter((n) => BigInt(n.value) >= amountAtomic)
    .sort((a, b) => (BigInt(a.value) > BigInt(b.value) ? 1 : -1));
  return sufficient[0] ?? null;
}
