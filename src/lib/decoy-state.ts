/**
 * Upstash-backed decoy state for the /api/cron/decoy route (shipment A.2).
 *
 * The original CLI `scripts/decoy-scheduler.ts` kept state in a local JSON
 * file (`.decoy-state/deposits.json`). That doesn't work on Vercel
 * serverless. This module is the cron-route equivalent: read/write the
 * scheduler's working set (reusable deposit notes + daily budget
 * accounting) to the same Upstash Redis instance already used by
 * `/api/facilitator/*` for authorization tokens (`src/lib/facilitator-authz.ts`).
 *
 * Keys (namespaced under `decoy:`):
 *   - `decoy:notes`         JSON-encoded DecoyNote[] (mutable working set)
 *   - `decoy:spent-today`   number USD spent today (resets on day boundary)
 *   - `decoy:day-start`     unix-seconds start of the current 24h budget window
 *   - `decoy:total-fires`   lifetime decoy count (monotonic)
 *   - `decoy:last-fire-at`  unix-seconds of last successful fire
 */

import { Redis } from "@upstash/redis";

const UPSTASH_URL =
  process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? null;
const UPSTASH_TOKEN =
  process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? null;

const redis =
  UPSTASH_URL && UPSTASH_TOKEN
    ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN })
    : null;

const KEY_NOTES = "decoy:notes";
const KEY_SPENT_TODAY = "decoy:spent-today";
const KEY_DAY_START = "decoy:day-start";
const KEY_TOTAL_FIRES = "decoy:total-fires";
const KEY_LAST_FIRE = "decoy:last-fire-at";

// ── Phase 1B: transfer-side decoy namespace ────────────────────────────────
// Separately namespaced from the unshield (withdraw-side) decoy pool above.
// Reasoning: a transfer decoy never burns USDC out of the pool — it just
// hops a note between two burn-derived viewing keys. The two pools have
// different lifetimes (transfer outputs are spendable indefinitely; unshield
// outputs sit in the change-note workflow until reused), different state-tree
// positions, and different budget shapes (transfer cost ≈ Groth16 gas only,
// no USDC sunk cost). Keeping the state separate prevents the two cron
// loops from clobbering each other's working set or budget counters.
const KEY_TRANSFER_NOTES = "decoy:transfer:notes";
const KEY_TRANSFER_SPENT_TODAY = "decoy:transfer:spent-today";
const KEY_TRANSFER_DAY_START = "decoy:transfer:day-start";
const KEY_TRANSFER_TOTAL_FIRES = "decoy:transfer:total-fires";
const KEY_TRANSFER_LAST_FIRE = "decoy:transfer:last-fire-at";

export type DecoyNote = {
  nullifier: string;
  secret: string;
  value: string;
  label: string;
  commitment: string;
  depositTxHash?: string;
  depositTimestamp?: number;
};

export type DecoyBudget = {
  spentTodayUsd: number;
  dayStartUnix: number;
  totalFires: number;
  lastFireAt: number | null;
};

export function isDecoyStateAvailable(): boolean {
  return redis !== null;
}

export async function loadDecoyNotes(): Promise<DecoyNote[]> {
  if (!redis) return [];
  const raw = await redis.get<DecoyNote[]>(KEY_NOTES);
  return raw ?? [];
}

export async function saveDecoyNotes(notes: DecoyNote[]): Promise<void> {
  if (!redis) return;
  await redis.set(KEY_NOTES, notes);
}

export async function loadDecoyBudget(): Promise<DecoyBudget> {
  if (!redis) {
    return { spentTodayUsd: 0, dayStartUnix: 0, totalFires: 0, lastFireAt: null };
  }
  const [spentRaw, dayStartRaw, totalRaw, lastRaw] = await Promise.all([
    redis.get<number>(KEY_SPENT_TODAY),
    redis.get<number>(KEY_DAY_START),
    redis.get<number>(KEY_TOTAL_FIRES),
    redis.get<number>(KEY_LAST_FIRE),
  ]);
  let spentTodayUsd = spentRaw ?? 0;
  let dayStartUnix = dayStartRaw ?? Math.floor(Date.now() / 1000);
  // Reset daily budget if we've crossed a 24h boundary (same rule as the CLI).
  const now = Math.floor(Date.now() / 1000);
  if (now - dayStartUnix > 86400) {
    spentTodayUsd = 0;
    dayStartUnix = now;
  }
  return {
    spentTodayUsd,
    dayStartUnix,
    totalFires: totalRaw ?? 0,
    lastFireAt: lastRaw ?? null,
  };
}

export async function recordDecoyFire(
  budget: DecoyBudget,
  amountUsd: number,
): Promise<void> {
  if (!redis) return;
  const now = Math.floor(Date.now() / 1000);
  await Promise.all([
    redis.set(KEY_SPENT_TODAY, budget.spentTodayUsd + amountUsd),
    redis.set(KEY_DAY_START, budget.dayStartUnix),
    redis.set(KEY_TOTAL_FIRES, budget.totalFires + 1),
    redis.set(KEY_LAST_FIRE, now),
  ]);
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 1B: transfer-side decoy API (shielded-to-shielded hop)
// ──────────────────────────────────────────────────────────────────────────
//
// Same shape as the unshield-side helpers above, but pointed at the
// `decoy:transfer:*` Upstash key namespace. The two pools must NEVER alias
// — a transfer-decoy note "spent" by the unshield loop would either
// (a) fail with a double-spend error on-chain because the unshield loop
//     would treat its commitment as still-usable and spend it twice, or
// (b) succeed in burning real USDC out of the pool because a transfer
//     output that was "spendable indefinitely" got pulled into an
//     unshield burn — which would silently inflate the unshield-side
//     daily budget without crediting the transfer-side counter.
// Either failure mode would corrupt the budget accounting that gates
// production safety on both crons. Keep the two namespaces fully disjoint.

export async function loadDecoyTransferNotes(): Promise<DecoyNote[]> {
  if (!redis) return [];
  const raw = await redis.get<DecoyNote[]>(KEY_TRANSFER_NOTES);
  return raw ?? [];
}

export async function saveDecoyTransferNotes(notes: DecoyNote[]): Promise<void> {
  if (!redis) return;
  await redis.set(KEY_TRANSFER_NOTES, notes);
}

export async function loadDecoyTransferBudget(): Promise<DecoyBudget> {
  if (!redis) {
    return { spentTodayUsd: 0, dayStartUnix: 0, totalFires: 0, lastFireAt: null };
  }
  const [spentRaw, dayStartRaw, totalRaw, lastRaw] = await Promise.all([
    redis.get<number>(KEY_TRANSFER_SPENT_TODAY),
    redis.get<number>(KEY_TRANSFER_DAY_START),
    redis.get<number>(KEY_TRANSFER_TOTAL_FIRES),
    redis.get<number>(KEY_TRANSFER_LAST_FIRE),
  ]);
  let spentTodayUsd = spentRaw ?? 0;
  let dayStartUnix = dayStartRaw ?? Math.floor(Date.now() / 1000);
  // Reset on the same 24h boundary as the unshield-side budget — but the
  // two counters are independent (one cron's budget exhaustion does NOT
  // pause the other; each is tracked separately).
  const now = Math.floor(Date.now() / 1000);
  if (now - dayStartUnix > 86400) {
    spentTodayUsd = 0;
    dayStartUnix = now;
  }
  return {
    spentTodayUsd,
    dayStartUnix,
    totalFires: totalRaw ?? 0,
    lastFireAt: lastRaw ?? null,
  };
}

export async function recordDecoyTransferFire(
  budget: DecoyBudget,
  amountUsd: number,
): Promise<void> {
  if (!redis) return;
  const now = Math.floor(Date.now() / 1000);
  await Promise.all([
    redis.set(KEY_TRANSFER_SPENT_TODAY, budget.spentTodayUsd + amountUsd),
    redis.set(KEY_TRANSFER_DAY_START, budget.dayStartUnix),
    redis.set(KEY_TRANSFER_TOTAL_FIRES, budget.totalFires + 1),
    redis.set(KEY_TRANSFER_LAST_FIRE, now),
  ]);
}
