/**
 * Pure receipt validation for the public deposit-confirmation endpoint.
 *
 * This module deliberately has no RPC, Redis, signer, or Next.js imports so the
 * security boundary can be regression-tested without touching live services.
 */

export const DEPOSITED_TOPIC =
  "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";

export interface ReceiptLogLike {
  address: string;
  topics: readonly (string | null)[];
  data: string;
  logIndex?: number | null;
}

export interface ConfirmedDepositEvent {
  depositor: `0x${string}`;
  commitment: bigint;
  label: bigint;
  value: bigint;
  precommitmentHash: bigint;
  logIndex: number;
}

export function isTransactionHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function transactionConfirmations(
  latestBlock: bigint,
  receiptBlock: bigint,
): bigint {
  if (latestBlock < receiptBlock) return 0n;
  return latestBlock - receiptBlock + 1n;
}

export function transactionBlockAge(latestBlock: bigint, receiptBlock: bigint): bigint {
  if (latestBlock < receiptBlock) return 0n;
  return latestBlock - receiptBlock;
}

/**
 * Return only authentic Deposited logs emitted by the configured pool.
 * Matching the topic alone is insufficient: any attacker contract can emit an
 * event with the same signature. The emitting address is the trust boundary.
 */
export function findPoolDeposits(
  logs: readonly ReceiptLogLike[],
  poolAddress: string,
): ConfirmedDepositEvent[] {
  const pool = poolAddress.toLowerCase();
  const deposits: ConfirmedDepositEvent[] = [];

  for (const log of logs) {
    if (log.address.toLowerCase() !== pool) continue;
    if (log.topics[0]?.toLowerCase() !== DEPOSITED_TOPIC) continue;
    // Four non-indexed uint256 values = 4 * 32 bytes, plus the 0x prefix.
    if (!/^0x[0-9a-fA-F]+$/.test(log.data) || log.data.length < 258) continue;
    const depositorTopic = log.topics[1];
    if (!depositorTopic || !/^0x[0-9a-fA-F]{64}$/.test(depositorTopic)) continue;

    try {
      const commitment = BigInt(`0x${log.data.slice(2, 66)}`);
      const label = BigInt(`0x${log.data.slice(66, 130)}`);
      const value = BigInt(`0x${log.data.slice(130, 194)}`);
      const precommitmentHash = BigInt(`0x${log.data.slice(194, 258)}`);
      // A successful pool deposit always has positive post-fee value. Rejecting
      // zero also prevents malformed event fixtures from authorizing work.
      if (value <= 0n) continue;
      deposits.push({
        depositor: `0x${depositorTopic.slice(-40)}` as `0x${string}`,
        commitment,
        label,
        value,
        precommitmentHash,
        logIndex: log.logIndex ?? deposits.length,
      });
    } catch {
      // Malformed data is not a deposit authorization.
    }
  }

  return deposits;
}
