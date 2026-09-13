/**
 * settlement-store.ts — idempotency for /api/facilitator/settle-x402.
 *
 * settle-x402 withdraws from the pool (SPENDS the note) before the seller delivers. If the
 * HTTP response is lost (client timeout / network drop) after the withdrawal, the client
 * cannot tell whether the note was spent and could retry — paying a SECOND time from the
 * change note. This store makes settlement idempotent on the note's `nullifier` (single-use,
 * known to both sides, provable on-chain):
 *
 *   - RESERVE before withdrawing. SET NX a per-attempt LEASE TOKEN. Only the first caller wins.
 *   - FINALIZE the built X-PAYMENT header after a successful withdrawal, so a retry re-serves
 *     the SAME header instead of withdrawing again.
 *   - A retry sees a settled RECORD → gets the stored header; an in-flight LEASE → 409.
 *
 * Two keys per nullifier (no cjson dependency — plain GET/SET/DEL/EXISTS + Lua compare):
 *   - `<base>:lock` = the lease token, TTL 1h. Present ⇒ a withdrawal is in-flight.
 *   - `<base>`      = the settled record JSON, TTL 1h. Present ⇒ settlement completed.
 *
 * The lease token closes the stale-worker race: finalize/release only mutate when the CALLER
 * still owns the lock, and the settled record is written with SET-NX semantics so a stale
 * worker can never clobber the winner's record. The on-chain `nullifierHashes` check (in the
 * route) is the backstop when this store is lost. Store-off (no Upstash) degrades to the prior
 * non-idempotent behavior — never worse.
 */
import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

const UPSTASH_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? null;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? null;
const redis = UPSTASH_URL && UPSTASH_TOKEN ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN }) : null;

const TTL_SECONDS = 3600; // 1h — long enough for retries, bounded growth.

export interface SettlementRecord {
  status: "in-flight" | "settled";
  payer: string;
  startedAt: number;
  xPayment?: string;
  amount?: string;
  fundingTxHash?: string;
  nextDeposit?: unknown;
}

/** A reservation the caller holds while withdrawing. `token` gates finalize/release. */
export interface Reservation {
  ok: boolean;
  token: string;
}

export function settlementStoreAvailable(): boolean {
  return redis !== null;
}

// Canonicalize the nullifier so `1`, `01`, and `0x1` map to ONE key (the contract hashes the
// numeric value, so they are the same note). Falls back to the raw string if it isn't numeric.
function canon(nullifier: string): string {
  try {
    return BigInt(nullifier).toString();
  } catch {
    return nullifier;
  }
}
const recordKey = (network: string, nullifier: string) => `settle:${network}:${canon(nullifier)}`;
const lockKey = (network: string, nullifier: string) => `${recordKey(network, nullifier)}:lock`;

/** The settlement record for this nullifier, or null. Settled record wins; else in-flight lease. */
export async function getSettlement(network: string, nullifier: string): Promise<SettlementRecord | null> {
  if (!redis) return null;
  const rec = await redis.get<SettlementRecord>(recordKey(network, nullifier));
  if (rec) return { ...rec, status: "settled" };
  // Existence check only — the lock value (a raw token written by Lua) must not be round-tripped
  // through the client's JSON deserializer (which would mangle a non-JSON token string).
  const held = await redis.exists(lockKey(network, nullifier));
  if (held) return { status: "in-flight", payer: "", startedAt: 0 };
  return null;
}

// Reserve via Lua so the token is stored RAW. If we wrote it with redis.set() the client would
// JSON-serialize the string (store `"uuid"` with quotes), but Lua's redis.call('GET') in
// finalize/release compares against the raw ARGV token (`uuid`) — the quotes would make every
// ownership check fail, silently defeating the lease. Writing through Lua keeps stored bytes and
// compared bytes identical.
const RESERVE_LUA = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', tonumber(ARGV[2])) then
  return 1
end
return 0
`;

/**
 * Reserve BEFORE withdrawing. `SET <lock> <token> NX` (via Lua) — only the first caller wins.
 * Returns `{ok:true, token}` if reserved (safe to withdraw), `{ok:false}` if a lease/record
 * already exists (concurrent or prior settlement). With the store off, returns ok with an empty
 * token (no idempotency; prior behavior). Keep the token and pass it to finalize/release.
 */
export async function reserveSettlement(network: string, nullifier: string): Promise<Reservation> {
  const token = redis ? randomUUID() : "";
  if (!redis) return { ok: true, token };
  const r = await redis.eval(RESERVE_LUA, [lockKey(network, nullifier)], [token, String(TTL_SECONDS)]);
  return { ok: r === 1, token };
}

// Write the settled record only if the caller still owns the lock OR no record exists yet, then
// drop our lock. Never clobbers an existing settled record (SET-NX on the record). Atomic.
const FINALIZE_LUA = `
local lock = redis.call('GET', KEYS[2])
if lock == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
  redis.call('DEL', KEYS[2])
  return 1
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
  return 2
end
return 0
`;

/**
 * Finalize a successful settlement so a retry re-serves the SAME header (no second withdraw).
 * Only mutates when the caller still owns the lease (`token`) or no record exists yet — a stale
 * worker whose lease expired can never overwrite the winner's record.
 */
export async function finalizeSettlement(
  network: string,
  nullifier: string,
  token: string,
  rec: { payer: string; xPayment: string; amount?: string; fundingTxHash?: string; nextDeposit?: unknown },
): Promise<void> {
  if (!redis) return;
  const value = JSON.stringify({ status: "settled", startedAt: Math.floor(Date.now() / 1000), ...rec } satisfies SettlementRecord);
  await redis.eval(FINALIZE_LUA, [recordKey(network, nullifier), lockKey(network, nullifier)], [token, value, String(TTL_SECONDS)]);
}

// Delete the lock only if the caller still owns it (compare-and-delete). A stale worker whose
// lease already expired (and was re-reserved by another) cannot delete the new holder's lock.
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Release the reservation after a FAILED withdrawal (note unspent → allow a clean retry). */
export async function releaseSettlement(network: string, nullifier: string, token: string): Promise<void> {
  if (!redis) return;
  await redis.eval(RELEASE_LUA, [lockKey(network, nullifier)], [token]);
}
