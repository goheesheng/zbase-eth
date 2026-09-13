import { Redis } from "@upstash/redis";

export type DepositAspStatus = "queued" | "included" | "rejected";

export interface DepositAspRecord {
  txHash: `0x${string}`;
  status: DepositAspStatus;
  reason?: string;
  root?: string;
  aspTxHash?: `0x${string}`;
  createdAt: string;
  updatedAt: string;
}

export interface AspUpdateStateStore {
  get(network: string, pool: string, txHash: `0x${string}`): Promise<DepositAspRecord | null>;
  put(
    network: string,
    pool: string,
    record: DepositAspRecord,
  ): Promise<DepositAspRecord>;
  acquireLock(network: string, pool: string, token: string): Promise<boolean>;
  ownsLock(network: string, pool: string, token: string): Promise<boolean>;
  releaseLock(network: string, pool: string, token: string): Promise<void>;
}

const RECORD_TTL_SECONDS = 60 * 60 * 24 * 90;
const LOCK_TTL_SECONDS = 180;
const recordKey = (network: string, pool: string, txHash: string) =>
  `zbase:asp:auto:${network}:${pool.toLowerCase()}:tx:${txHash.toLowerCase()}`;
const lockKey = (network: string, pool: string) =>
  `zbase:asp:auto:${network}:${pool.toLowerCase()}:lock`;

/** Exported for deterministic offline regression tests. */
export class MemoryAspUpdateStateStore implements AspUpdateStateStore {
  private readonly records = new Map<string, DepositAspRecord>();
  private readonly locks = new Map<string, { token: string; expiresAt: number }>();

  async get(network: string, pool: string, txHash: `0x${string}`) {
    return this.records.get(recordKey(network, pool, txHash)) ?? null;
  }

  async put(network: string, pool: string, record: DepositAspRecord) {
    const key = recordKey(network, pool, record.txHash);
    const current = this.records.get(key);
    // A late request that lost the pool-wide lock must not downgrade a result
    // another worker already finalized.
    if (current?.status === "included" || current?.status === "rejected") return current;
    this.records.set(key, record);
    return record;
  }

  async acquireLock(network: string, pool: string, token: string) {
    const key = lockKey(network, pool);
    const current = this.locks.get(key);
    if (current && current.expiresAt > Date.now()) return false;
    this.locks.set(key, { token, expiresAt: Date.now() + LOCK_TTL_SECONDS * 1000 });
    return true;
  }

  async ownsLock(network: string, pool: string, token: string) {
    const current = this.locks.get(lockKey(network, pool));
    return Boolean(current && current.token === token && current.expiresAt > Date.now());
  }

  async releaseLock(network: string, pool: string, token: string) {
    const key = lockKey(network, pool);
    if (this.locks.get(key)?.token === token) this.locks.delete(key);
  }
}

class RedisAspUpdateStateStore implements AspUpdateStateStore {
  constructor(private readonly redis: Redis) {}

  async get(network: string, pool: string, txHash: `0x${string}`) {
    return (await this.redis.get<DepositAspRecord>(recordKey(network, pool, txHash))) ?? null;
  }

  async put(network: string, pool: string, record: DepositAspRecord) {
    // Keep terminal results monotonic atomically. A GET followed by SET is not
    // sufficient here: a lock loser could otherwise overwrite "included" with
    // "queued" after the winner completes.
    return await this.redis.eval<[string, string], DepositAspRecord>(
      `local current = redis.call('get', KEYS[1])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and (decoded.status == 'included' or decoded.status == 'rejected') then
    return current
  end
end
redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
return ARGV[1]`,
      [recordKey(network, pool, record.txHash)],
      [JSON.stringify(record), String(RECORD_TTL_SECONDS)],
    );
  }

  async acquireLock(network: string, pool: string, token: string) {
    const result = await this.redis.set(lockKey(network, pool), token, {
      ex: LOCK_TTL_SECONDS,
      nx: true,
    });
    return result !== null;
  }

  async ownsLock(network: string, pool: string, token: string) {
    return (await this.redis.get<string>(lockKey(network, pool))) === token;
  }

  async releaseLock(network: string, pool: string, token: string) {
    // Compare-and-delete: a worker whose lease expired must never delete a newer
    // worker's lock.
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [lockKey(network, pool)],
      [token],
    );
  }
}

const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const sharedRedis =
  UPSTASH_URL && UPSTASH_TOKEN
    ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN })
    : null;

const store: AspUpdateStateStore = sharedRedis
  ? new RedisAspUpdateStateStore(sharedRedis)
  : new MemoryAspUpdateStateStore();

export function aspUpdateSharedStateAvailable(): boolean {
  return sharedRedis !== null;
}

export function getDepositAspRecord(
  network: string,
  pool: string,
  txHash: `0x${string}`,
) {
  return store.get(network, pool, txHash);
}

export async function writeDepositAspRecord(args: {
  network: string;
  pool: string;
  txHash: `0x${string}`;
  status: DepositAspStatus;
  reason?: string;
  root?: string;
  aspTxHash?: `0x${string}`;
}): Promise<DepositAspRecord> {
  const existing = await store.get(args.network, args.pool, args.txHash);
  const now = new Date().toISOString();
  const record: DepositAspRecord = {
    txHash: args.txHash,
    status: args.status,
    reason: args.reason,
    root: args.root,
    aspTxHash: args.aspTxHash,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return store.put(args.network, args.pool, record);
}

export async function acquireAspUpdateLock(network: string, pool: string) {
  const token = crypto.randomUUID();
  return {
    token,
    acquired: await store.acquireLock(network, pool, token),
  };
}

export function releaseAspUpdateLock(network: string, pool: string, token: string) {
  return store.releaseLock(network, pool, token);
}

export function ownsAspUpdateLock(network: string, pool: string, token: string) {
  return store.ownsLock(network, pool, token);
}
