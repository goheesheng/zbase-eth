/**
 * Forwarding rail — engine CORE (Phase 2). Testable, key-agnostic.
 *
 * This module contains the fund-safety-critical logic of the auto-privatize
 * engine, behind a `DepositAuthority` SEAM so it can be fully unit-tested with a
 * mock signer (no live key, no chain). The daemon (scripts/forwarding-engine.ts)
 * is a thin wrapper that supplies the real InboundWatcher + a postman-signer-backed
 * authority and loops.
 *
 * Flow for one clean PendingDeposit (immediate policy — no jitter, per rev-b):
 *   1. Derive the deposit precommitment for the user (already registered).
 *   2. B1 authority calls deposit() into the pool at that precommitment.
 *   3. ONLY AFTER on-chain confirmation, mark the deposit done + advance the
 *      user's index. Never advance before confirm (an advanced-but-unconfirmed
 *      index = a note the user can still recover by scan, but the ENGINE would
 *      skip a slot — harmless for recovery, but we keep the invariant tight).
 *
 * FUND-SAFETY INVARIANTS (mirrors spec §6):
 *   - Screening happens BEFORE this core ever sees a deposit (watcher gate). This
 *     core only processes CLEAN, already-screened PendingDeposits.
 *   - A deposit that reverts or errors is retried; funds stay in the watched
 *     address (never lost). The `id` (txHash:logIndex) dedupes so a retry never
 *     double-deposits the same inbound.
 *   - Budget cap: refuse to exceed a per-run spend ceiling (guards a runaway key).
 *   - Recovery is scan-by-commitment (D3), so even if this engine's own state
 *     desyncs, the user still finds every note from their seed. This core CANNOT
 *     lose funds — worst case it fails to deposit and the funds sit recoverable
 *     in the watched address.
 */

import type { PendingDeposit } from "./forwarding-watcher";

/**
 * The seam: "who signs the deposit tx." B1 wraps the existing postman signer
 * (chosen 2026-07-09). A mock implements this for tests. The authority is bounded
 * to depositing — it is handed a precommitment + amount and returns the tx hash;
 * it cannot spend the resulting note (that needs the user's seed).
 */
export interface DepositAuthority {
  /**
   * Deposit `amount` (atomic USDC) into the pool at `precommitment`, on behalf of
   * the watched address's owner. Resolves to the on-chain tx hash AFTER the tx is
   * confirmed. Throws on revert / failure (the caller keeps the deposit queued).
   */
  deposit(args: {
    watchedAddress: `0x${string}`;
    amount: bigint;
    precommitment: string;
  }): Promise<{ txHash: `0x${string}` }>;
}

/** Resolves the precommitment + fresh index the user registered for a watched address. */
export interface PrecommitmentSource {
  /**
   * Returns the precommitment the engine should deposit at for this watched
   * address, or null if the address isn't registered (skip it).
   */
  precommitmentFor(watchedAddress: `0x${string}`): Promise<string | null>;
  /** Record that a deposit landed, so the next inbound uses a fresh slot. */
  advance(watchedAddress: `0x${string}`, txHash: `0x${string}`): Promise<void>;
}

export interface EngineState {
  /** Ids (txHash:logIndex) already deposited — dedupe across runs. */
  processedIds: Set<string>;
  /**
   * Precommitments already deposited at. AUDIT HIGH (2026-07-09): every deposit
   * note's nullifier is deterministic per precommitment, so depositing TWICE at
   * the same precommitment produces two notes sharing ONE nullifier — the user
   * can spend only one; the second is PERMANENTLY LOCKED (nullifier already
   * spent). The registry stores one precommitment per address, so a 2nd inbound
   * to the same address would reuse it. This set makes the engine REFUSE a
   * second deposit at a used precommitment — the excess inbound is skipped
   * (funds stay recoverable in the watched address) until the user registers a
   * FRESH precommitment. Fail-safe, never fail-locked.
   */
  depositedPrecommitments: Set<string>;
  /** Atomic USDC spent this run, for the budget cap. */
  spentThisRun: bigint;
}

export interface ProcessResult {
  deposited: Array<{ id: string; txHash: `0x${string}`; amount: bigint }>;
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
}

export interface ProcessOptions {
  /** Max atomic USDC to deposit in one run (runaway-key guard). Default: no cap. */
  maxSpendAtomic?: bigint;
  /** Minimum inbound amount worth depositing (dust guard). Default 0. */
  minAmountAtomic?: bigint;
}

/**
 * Process a batch of CLEAN, pre-screened PendingDeposits. Pure orchestration over
 * the two seams — no chain, no key of its own. Idempotent: an id in
 * `state.processedIds` is skipped, so re-running with an overlapping batch never
 * double-deposits.
 */
export async function processPendingDeposits(
  pending: readonly PendingDeposit[],
  authority: DepositAuthority,
  source: PrecommitmentSource,
  state: EngineState,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const result: ProcessResult = { deposited: [], skipped: [], failed: [] };
  const minAmount = opts.minAmountAtomic ?? 0n;

  for (const p of pending) {
    // Dedupe — never deposit the same inbound twice.
    if (state.processedIds.has(p.id)) {
      result.skipped.push({ id: p.id, reason: "already-processed" });
      continue;
    }

    // Dust guard.
    if (p.amount < minAmount) {
      result.skipped.push({ id: p.id, reason: "below-min-amount" });
      continue;
    }

    // Budget cap (runaway-key guard).
    if (opts.maxSpendAtomic !== undefined && state.spentThisRun + p.amount > opts.maxSpendAtomic) {
      result.skipped.push({ id: p.id, reason: "run-budget-exceeded" });
      continue;
    }

    // Resolve the user's registered precommitment.
    const precommitment = await source.precommitmentFor(p.watchedAddress);
    if (!precommitment) {
      result.skipped.push({ id: p.id, reason: "not-registered" });
      continue;
    }

    // AUDIT HIGH (2026-07-09) — reused-precommitment fund-lock guard. Depositing a
    // SECOND inbound at the same precommitment would mint a note whose nullifier
    // collides with the first → the second is permanently unspendable. Refuse it.
    // The inbound is NOT marked processed, so once the user registers a fresh
    // precommitment the next run deposits it correctly; until then the funds sit
    // recoverable in the watched address. Fail-safe, never fail-locked.
    if (state.depositedPrecommitments.has(precommitment)) {
      result.skipped.push({
        id: p.id,
        reason: "precommitment-already-used — register a fresh precommitment to deposit this inbound",
      });
      continue;
    }

    // Deposit. On ANY failure, do NOT mark processed and do NOT advance — the
    // funds stay in the watched address, recoverable, and the next run retries.
    try {
      const { txHash } = await authority.deposit({
        watchedAddress: p.watchedAddress,
        amount: p.amount,
        precommitment,
      });

      // Only AFTER a confirmed deposit: mark processed, record the precommitment
      // (so it can never be reused), count spend, advance the slot.
      state.processedIds.add(p.id);
      state.depositedPrecommitments.add(precommitment);
      state.spentThisRun += p.amount;
      await source.advance(p.watchedAddress, txHash);

      result.deposited.push({ id: p.id, txHash, amount: p.amount });
    } catch (e) {
      result.failed.push({ id: p.id, error: (e as Error).message?.slice(0, 200) ?? "deposit failed" });
      // Intentionally NOT added to processedIds → retried next run. Funds safe.
    }
  }

  return result;
}
