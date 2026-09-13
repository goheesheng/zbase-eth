/**
 * Forwarding rail — InboundWatcher + compliance gate (Phase 2)
 *
 * Detects inbound USDC transfers to watched receiving addresses and screens the
 * PAYER against the SAME OFAC/ASP source used for deposits, BEFORE the deposit is
 * queued. This is the compliance invariant that keeps the forwarding rail exactly
 * as compliant as v1: because the rail accepts funds from arbitrary, privacy-
 * unaware payers, it MUST screen the inbound sender, or it becomes an easier
 * on-ramp for illicit funds than v1 (where the depositor self-selected).
 *
 *   Clean payer  → PendingDeposit enqueued (the engine deposits it into the pool).
 *   Tainted payer → QUARANTINED, never auto-deposited. The engine leaves the funds
 *                   in the watched address and flags them; a human decides
 *                   (refund / manual review). NEVER auto-privatize tainted funds.
 *
 * This module is PURE DETECTION + SCREENING — it holds no keys and moves no funds.
 * The actual deposit (which needs the B1 relayer key) happens in the engine daemon
 * behind the DepositAuthority seam.
 */

import {
  createConfiguredScreeningProvider,
  type ReasonCode,
  type SanctionsProvider,
} from "./ofac-screening";

/** The canonical ERC-20 Transfer event topic0. */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

/** A raw inbound USDC transfer to a watched address, as read from the chain. */
export interface InboundTransfer {
  /** The payer (Transfer `from`). This is the address that gets screened. */
  payer: `0x${string}`;
  /** The watched receiving address (Transfer `to`). */
  watchedAddress: `0x${string}`;
  /** Atomic USDC amount. */
  amount: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
  /** Log index within the tx — used with txHash for a stable identity. */
  logIndex: number;
}

/** A screened inbound transfer that is CLEAN and ready to auto-deposit. */
export interface PendingDeposit {
  /** Stable identity: `${txHash}:${logIndex}` — dedupes re-orgs / replays. */
  id: string;
  payer: `0x${string}`;
  watchedAddress: `0x${string}`;
  amount: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
}

/** A screened inbound transfer that FAILED screening — never auto-deposited. */
export interface QuarantinedInbound {
  id: string;
  payer: `0x${string}`;
  watchedAddress: `0x${string}`;
  amount: bigint;
  txHash: `0x${string}`;
  reasonCode: ReasonCode;
}

export interface ScreenInboundResult {
  /** Clean inbound transfers, ready for the deposit queue. */
  pending: PendingDeposit[];
  /** Tainted inbound transfers — held, never auto-deposited. */
  quarantined: QuarantinedInbound[];
  /** Total screened this pass. */
  screened: number;
  snapshotVersion: string;
}

function inboundId(t: InboundTransfer): string {
  return `${t.txHash}:${t.logIndex}`;
}

/**
 * Screen a batch of inbound transfers against the OFAC/ASP source. The payer
 * (`from`) is the address screened — the same primitive deposits use. A provider
 * can be injected (tests / reuse across a pass); otherwise the current snapshot
 * is loaded.
 *
 * Dedupe: callers should pass a `seenIds` set of already-processed identities so a
 * re-org replay or an overlapping scan window never double-queues the same
 * transfer. Anything already in `seenIds` is skipped entirely.
 */
export async function screenInbound(
  transfers: readonly InboundTransfer[],
  opts?: { provider?: SanctionsProvider; seenIds?: ReadonlySet<string> },
): Promise<ScreenInboundResult> {
  let prov = opts?.provider;
  let snapshotVersion: string;
  if (!prov) {
    const configured = await createConfiguredScreeningProvider();
    prov = configured.provider;
    snapshotVersion = prov.snapshotVersion;
  } else {
    snapshotVersion = prov.snapshotVersion;
  }

  const seen = opts?.seenIds;
  const pending: PendingDeposit[] = [];
  const quarantined: QuarantinedInbound[] = [];
  let screened = 0;

  for (const t of transfers) {
    const id = inboundId(t);
    if (seen?.has(id)) continue; // already processed — dedupe re-orgs/overlap
    screened += 1;

    const reason = prov.screenAddress
      ? await prov.screenAddress(t.payer)
      : prov.reasonFor(t.payer);
    if (reason) {
      quarantined.push({
        id,
        payer: t.payer,
        watchedAddress: t.watchedAddress,
        amount: t.amount,
        txHash: t.txHash,
        reasonCode: reason,
      });
    } else {
      pending.push({
        id,
        payer: t.payer,
        watchedAddress: t.watchedAddress,
        amount: t.amount,
        txHash: t.txHash,
        blockNumber: t.blockNumber,
      });
    }
  }

  return { pending, quarantined, screened, snapshotVersion };
}

/**
 * Decode a raw ERC-20 Transfer log into an InboundTransfer, keeping only transfers
 * whose `to` is one of the watched addresses. Returns null for non-matching logs.
 *
 * `topics` = [Transfer topic0, from (indexed), to (indexed)]; `data` = amount.
 * Addresses are the low 20 bytes of the 32-byte topic word.
 */
export function decodeInboundTransfer(
  log: { topics: readonly string[]; data: string; transactionHash: string; blockNumber: bigint; logIndex: number },
  watchedSet: ReadonlySet<string>,
): InboundTransfer | null {
  if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) {
    return null;
  }
  const from = `0x${log.topics[1].slice(26)}`.toLowerCase() as `0x${string}`;
  const to = `0x${log.topics[2].slice(26)}`.toLowerCase() as `0x${string}`;
  if (!watchedSet.has(to)) return null;

  const amount = BigInt(log.data);
  if (amount === 0n) return null; // ignore zero-value transfers

  return {
    payer: from,
    watchedAddress: to,
    amount,
    txHash: log.transactionHash as `0x${string}`,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  };
}
