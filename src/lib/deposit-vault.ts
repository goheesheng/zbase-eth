"use client";

/**
 * Encrypted deposit vault — client side (Phase 1C).
 *
 * Deposit secrets (nullifier + secret) ARE the funds: lose them and the
 * USDC is stuck in the pool forever; leak them and anyone can withdraw.
 * Until now they lived in plaintext localStorage, which fails both ways —
 * "Clear browsing data" destroyed funds, and any XSS could read every
 * secret at rest.
 *
 * The vault model:
 *
 *   - Secrets are AES-GCM-256 encrypted IN THE BROWSER under a key derived
 *     from a deterministic wallet signature (vaultKeyMessage). The key
 *     signature never leaves the client, so the server stores ciphertext
 *     it cannot read.
 *   - A second deterministic signature (vaultAuthMessage) is the bearer
 *     token for /api/vault reads/writes — integrity without revealing the
 *     encryption key to the server.
 *   - Determinism is the recovery story: reconnect the wallet in ANY
 *     browser, sign the same two messages, and the vault decrypts. The
 *     "cleared localStorage = lost funds" failure mode is gone.
 *
 * Crash-safety invariants (in order of importance):
 *
 *   1. Secrets are NEVER memory-only. Every save writes localStorage
 *      synchronously BEFORE the async vault PUT; the localStorage copy is
 *      removed only after the server confirms a write on a DURABLE backend
 *      (`backend === "upstash"`). A memory-backed dev server never triggers
 *      local cleanup.
 *   2. Migration is union, not move: unlock merges vault contents with
 *      every localStorage variant (zbase/zx402 prefixes × raw/lowercased
 *      address — the two surfaces historically disagreed on casing), then
 *      persists the union before touching any local key.
 *   3. Concurrency is optimistic: the server rejects stale versions (409);
 *      we refetch, re-merge (spent-wins), retry once.
 *
 * Residual exposure, stated honestly: while a tab is unlocked, the derived
 * key + bearer sit in sessionStorage (gone when the tab closes). An XSS
 * running during an unlocked session can still reach secrets — what's
 * eliminated is the PERSISTENT at-rest copy and the fund-loss-on-clear
 * failure mode. Smart-contract wallets (ERC-1271) are unsupported in v1
 * and transparently stay on the localStorage path.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { keccak256, hexToBytes } from "viem";
import { useSignMessage } from "wagmi";
import {
  vaultKeyMessage,
  vaultAuthMessage,
  isVaultAuthTimestampFresh,
} from "./vault-messages";

// ─────────────────────────────────────────────────────────────────────────
// Module store (shared across every component using the hook)
// ─────────────────────────────────────────────────────────────────────────

export type VaultStatus = "no-wallet" | "locked" | "unlocking" | "unlocked" | "error";

// `authIssuedAt` is the millisecond timestamp baked into the signed auth message
// (F2): the bearer is only valid within the server's freshness window, so the
// session must re-sign when it expires (handled by the 401 → dropSession path).
type VaultSession = {
  keyHex: `0x${string}`;
  bearer: `0x${string}`;
  authIssuedAt: number;
};

const sessions = new Map<string, VaultSession>();
const cache = new Map<string, unknown[]>(); // unlocked deposit lists
/**
 * The unlocked note seed per address (BIP39 mnemonic). Held only in memory next to
 * `cache`; it is persisted ONLY inside the encrypted vault payload, never to
 * localStorage — the seed derives every note, so a plaintext copy on disk would be a
 * plaintext copy of the money.
 */
const seeds = new Map<string, string>();
const knownVersions = new Map<string, number>(); // last server version seen
const statuses = new Map<string, Exclude<VaultStatus, "no-wallet">>();
const durableBackend = new Map<string, boolean>();
const errors = new Map<string, string>();

let storeVersion = 0;
const listeners = new Set<() => void>();
function notify(): void {
  storeVersion += 1;
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const SESSION_KEY = (lower: string) => `zbase-vault-session-${lower}`;

// ─────────────────────────────────────────────────────────────────────────
// localStorage (legacy store + crash-safety fallback)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every key form a deposit may live under. `/app` historically keyed by the
 * checksummed address while `/test` lowercased, and both had pre-rename
 * `zx402-` keys — the union read heals all four.
 */
function allLocalKeys(address: string): string[] {
  const lower = address.toLowerCase();
  const keys = [`zbase-deposits-${lower}`, `zx402-deposits-${lower}`];
  if (address !== lower) {
    keys.push(`zbase-deposits-${address}`, `zx402-deposits-${address}`);
  }
  return keys;
}

function readLocal(address: string): unknown[] {
  if (typeof window === "undefined") return [];
  const lists: unknown[][] = [];
  for (const key of allLocalKeys(address)) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) lists.push(parsed);
    } catch {
      // Corrupt entry — skip it rather than blow up every reader.
    }
  }
  if (lists.length === 0) return [];
  return lists.reduce((acc, list) => mergeDeposits(acc, list), [] as unknown[]);
}

/** Write the canonical (lowercased zbase-) key; drop the other three forms. */
function writeLocalCanonical(address: string, deposits: unknown[]): void {
  if (typeof window === "undefined") return;
  const canonical = `zbase-deposits-${address.toLowerCase()}`;
  try {
    localStorage.setItem(canonical, JSON.stringify(deposits));
    for (const key of allLocalKeys(address)) {
      if (key !== canonical) localStorage.removeItem(key);
    }
  } catch {
    // Quota/security errors: nothing we can do beyond keeping memory state.
  }
}

function clearLocal(address: string): void {
  if (typeof window === "undefined") return;
  for (const key of allLocalKeys(address)) localStorage.removeItem(key);
}

// ─────────────────────────────────────────────────────────────────────────
// Merge semantics
// ─────────────────────────────────────────────────────────────────────────

function depositIdentity(d: unknown): string {
  const o = d as Record<string, unknown> | null;
  const commitment = o?.commitment;
  if (typeof commitment === "string" && commitment.length > 0 && commitment !== "0") {
    return `c:${commitment}`;
  }
  const txHash = o?.txHash;
  if (typeof txHash === "string" && txHash.length > 0) {
    return `t:${txHash}:${String(o?.nullifier ?? "")}`;
  }
  return `j:${JSON.stringify(d)}`;
}

function isSpent(d: unknown): boolean {
  const o = d as Record<string, unknown> | null;
  return o?.withdrawn === true || o?.status === "spent";
}

/**
 * Union of two deposit lists, deduped by identity. Order follows `primary`
 * with unseen `secondary` entries appended. On a duplicate, the spent-marked
 * copy wins (a spent flag must never be resurrected — retrying a spent
 * nullifier just burns the user's time on a guaranteed on-chain revert);
 * with equal spent-ness, primary wins.
 */
function mergeDeposits(primary: unknown[], secondary: unknown[]): unknown[] {
  const out: unknown[] = [];
  const index = new Map<string, number>();
  for (const d of primary) {
    index.set(depositIdentity(d), out.length);
    out.push(d);
  }
  for (const d of secondary) {
    const id = depositIdentity(d);
    const at = index.get(id);
    if (at === undefined) {
      index.set(id, out.length);
      out.push(d);
    } else if (isSpent(d) && !isSpent(out[at])) {
      out[at] = d;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Crypto envelope: base64(iv[12] || AES-GCM-256 ciphertext)
// ─────────────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function importAesKey(keyHex: `0x${string}`): Promise<CryptoKey> {
  // Copy: viem's ByteArray is typed against ArrayBufferLike, which WebCrypto's
  // BufferSource rejects under TS 5.7+ strict DOM types.
  const keyBytes = new Uint8Array(hexToBytes(keyHex));
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Vault plaintext, v2.
 *
 * v1 was a bare `unknown[]` of deposits. v2 wraps that and adds `seed` — the BIP39
 * mnemonic every note derives from. The seed is what makes notes RE-DERIVABLE: with
 * it, a wiped device rebuilds its balance by scanning the chain
 * (recoverForwardingNotes); without it, each note's secrets are the money and
 * dropping them locks the funds forever (0.985 USDC, 2026-07-16).
 *
 * Back-compat both ways:
 *  - Reading v1 (an array) yields `{seed: undefined, deposits: [...]}` — old vaults
 *    keep working, they just have no seed until one is generated.
 *  - An OLD client reading a v2 object gets null from its `Array.isArray` check and
 *    hits "Vault exists but cannot be decrypted… Refusing to overwrite it." That is
 *    an error, not data loss — the guard is why this migration is safe.
 */
export interface VaultPayload {
  /** BIP39 mnemonic all notes derive from. Absent on un-migrated v1 vaults. */
  seed?: string;
  deposits: unknown[];
}

type StoredPayload = { v: 2; seed?: string; deposits: unknown[] };

async function encryptVault(
  keyHex: `0x${string}`,
  payload: VaultPayload,
): Promise<string> {
  const key = await importAesKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const stored: StoredPayload = { v: 2, seed: payload.seed, deposits: payload.deposits };
  const plaintext = new TextEncoder().encode(JSON.stringify(stored));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const blob = new Uint8Array(iv.length + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, iv.length);
  return bytesToBase64(blob);
}

/** Returns null on auth failure (wrong key) or malformed blob. */
async function decryptVault(
  keyHex: `0x${string}`,
  blobB64: string,
): Promise<VaultPayload | null> {
  try {
    const blob = base64ToBytes(blobB64);
    if (blob.length < 12 + 16) return null;
    const key = await importAesKey(keyHex);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(0, 12) },
      key,
      blob.slice(12),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    // v1: bare array of deposits, no seed.
    if (Array.isArray(parsed)) return { deposits: parsed };
    // v2: { v, seed?, deposits }.
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as StoredPayload).deposits)) {
      const p = parsed as StoredPayload;
      return { seed: typeof p.seed === "string" ? p.seed : undefined, deposits: p.deposits };
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Session management
// ─────────────────────────────────────────────────────────────────────────

function restoreSession(lower: string): VaultSession | null {
  const inMemory = sessions.get(lower);
  if (inMemory) return inMemory;
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY(lower));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VaultSession;
    if (
      typeof parsed?.keyHex === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(parsed.keyHex) &&
      typeof parsed?.bearer === "string" &&
      /^0x[0-9a-fA-F]{130}$/.test(parsed.bearer) &&
      typeof parsed?.authIssuedAt === "number" &&
      // F2: drop a restored session whose time-boxed bearer is already stale,
      // so we never send a doomed bearer; the user re-signs on next unlock.
      isVaultAuthTimestampFresh(parsed.authIssuedAt, Date.now())
    ) {
      sessions.set(lower, parsed);
      return parsed;
    }
    // Stale or malformed → clear it so a fresh unlock re-signs.
    sessionStorage.removeItem(SESSION_KEY(lower));
  } catch {
    // fallthrough — treat as no session
  }
  return null;
}

function dropSession(lower: string): void {
  sessions.delete(lower);
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(SESSION_KEY(lower));
  }
}

export function hasVaultSession(address: string | undefined): boolean {
  if (!address || typeof window === "undefined") return false;
  return restoreSession(address.toLowerCase()) !== null;
}

// ─────────────────────────────────────────────────────────────────────────
// Server I/O
// ─────────────────────────────────────────────────────────────────────────

type VaultGetResponse = {
  exists: boolean;
  ciphertext?: string;
  version?: number;
  backend: "upstash" | "memory";
};

async function fetchVault(
  session: VaultSession,
  lower: string,
): Promise<VaultGetResponse> {
  const res = await fetch(`/api/vault?address=${lower}`, {
    headers: {
      Authorization: `Bearer ${session.bearer}`,
      "X-Vault-Auth-Timestamp": String(session.authIssuedAt),
    },
  });
  if (res.status === 401) {
    dropSession(lower);
    throw new Error("Vault session rejected — unlock again to re-sign.");
  }
  if (!res.ok) throw new Error(`Vault fetch failed (HTTP ${res.status})`);
  return (await res.json()) as VaultGetResponse;
}

/**
 * Encrypt + PUT the current cache. One 409 retry: refetch, re-merge with
 * spent-wins (our copy primary — it reflects the latest user action), bump
 * past the stored version, send again.
 */
async function persist(lower: string): Promise<boolean> {
  const session = sessions.get(lower);
  if (!session) return false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deposits = cache.get(lower) ?? [];
    const version = (knownVersions.get(lower) ?? 0) + 1;
    let res: Response;
    try {
      res = await fetch("/api/vault", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.bearer}`,
          "X-Vault-Auth-Timestamp": String(session.authIssuedAt),
        },
        body: JSON.stringify({
          address: lower,
          ciphertext: await encryptVault(session.keyHex, { seed: seeds.get(lower), deposits }),
          version,
        }),
      });
    } catch {
      return false; // network down — localStorage copy keeps the secrets safe
    }

    if (res.ok) {
      const data = (await res.json()) as { backend: "upstash" | "memory" };
      knownVersions.set(lower, version);
      durableBackend.set(lower, data.backend === "upstash");
      return true;
    }

    if (res.status === 409 && attempt === 0) {
      try {
        const remote = await fetchVault(session, lower);
        if (remote.exists && remote.ciphertext) {
          const remotePayload = await decryptVault(session.keyHex, remote.ciphertext);
          if (remotePayload) {
            cache.set(lower, mergeDeposits(cache.get(lower) ?? [], remotePayload.deposits));
            // Never let a concurrent writer's seed replace one we already hold: the
            // seed derives every note, so overwriting it would orphan every note
            // derived from ours. First seed wins; a genuine conflict is surfaced by
            // the balance, not silently resolved here.
            if (remotePayload.seed && !seeds.has(lower)) seeds.set(lower, remotePayload.seed);
            notify();
          }
          knownVersions.set(lower, remote.version ?? 0);
        }
        continue;
      } catch {
        return false;
      }
    }
    return false;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Note seed
// ─────────────────────────────────────────────────────────────────────────

/**
 * The BIP39 mnemonic this wallet's notes derive from, or undefined if the vault is
 * locked or hasn't got one yet (v1 vaults, or a fresh wallet).
 *
 * Synchronous, memory-only. NEVER write this to localStorage: it derives every note,
 * so a plaintext copy on disk is a plaintext copy of the money. It lives only inside
 * the encrypted vault payload, which the server cannot read.
 */
export function getNoteSeed(address: string | undefined): string | undefined {
  if (!address) return undefined;
  return seeds.get(address.toLowerCase());
}

/**
 * Get the note seed, generating and persisting one on first use.
 *
 * Why a seed at all: a note's nullifier/secret ARE the money, handed over once. Drop
 * them and the funds are locked in the pool forever — no ragequit, no recovery
 * (0.985 USDC, 2026-07-16). Derived notes make a wiped device recoverable: the seed
 * plus a chain scan rebuilds every note (recoverForwardingNotes).
 *
 * Requires an UNLOCKED vault: the seed must be persisted before it is used, or a
 * deposit derived from it would be unrecoverable — exactly the bug we are removing.
 * Returns undefined if the vault is locked or the persist fails, and the caller MUST
 * then fall back to random secrets rather than deposit against an unsaved seed.
 *
 * EOA-only, transitively: unlockVault requires a deterministic signature, which
 * ERC-1271 wallets may not provide (see vault-messages.ts). Smart-wallet users never
 * reach an unlocked vault, so they never get a seed and stay on the random path.
 */
export async function ensureNoteSeed(address: string | undefined): Promise<string | undefined> {
  if (!address || typeof window === "undefined") return undefined;
  const lower = address.toLowerCase();

  const existing = seeds.get(lower);
  if (existing) return existing;

  // A locked vault cannot persist, and an unpersisted seed is worse than no seed.
  if (statuses.get(lower) !== "unlocked") return undefined;

  const { generateNewMnemonic } = await import("@zbase-protocol/core/wallet");
  const mnemonic = generateNewMnemonic();
  seeds.set(lower, mnemonic);

  const pushed = await persist(lower);
  if (!pushed || !durableBackend.get(lower)) {
    // Roll back rather than hand out a seed we could not durably store. Deriving a
    // deposit from a seed that exists only in this tab reintroduces "close the tab,
    // lose the funds".
    seeds.delete(lower);
    return undefined;
  }
  notify();
  return mnemonic;
}

/**
 * The next free HD index for a derived deposit: `max(stored index) + 1`.
 *
 * Reads the EXPLICIT `index` recorded on each stored deposit — never the array
 * length. Length is meaningless here: the vault is a union-merge across four legacy
 * localStorage key forms and can shrink, so counting entries would eventually reuse
 * an index, mint a duplicate commitment, and leave the second deposit unspendable.
 * (`register/route.ts` calls its own nextIndex "advisory only" for the same reason.)
 *
 * Safe because the seed and the deposit list are ONE encrypted payload — they are
 * written together and cannot desync. If you hold the seed, you hold the list.
 *
 * THE EXCEPTION — a words-only restore. Recovering from the 12 words on a fresh
 * device gives a seed and an EMPTY list, so this returns 0 and would collide with
 * notes already on-chain. That path must run recoverForwardingNotes / getWalletBalance
 * FIRST to repopulate, then deposit. Callers on the restore path must not skip it.
 */
export function nextDepositIndex(address: string | undefined): number {
  const deposits = getVaultDeposits(address);
  let max = -1;
  for (const d of deposits) {
    const i = (d as { index?: unknown })?.index;
    if (typeof i === "number" && Number.isInteger(i) && i > max) max = i;
  }
  return max + 1;
}

// ─────────────────────────────────────────────────────────────────────────
// Public store API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Synchronous read for render paths. Unlocked → the vault cache; otherwise
 * the union of every localStorage variant (exactly what the old helpers
 * showed, healed across key forms).
 */
export function getVaultDeposits(address: string | undefined): unknown[] {
  if (!address || typeof window === "undefined") return [];
  const lower = address.toLowerCase();
  if (statuses.get(lower) === "unlocked") return cache.get(lower) ?? [];
  return readLocal(address);
}

/**
 * Unlock: establish (or silently restore) the session, pull + decrypt the
 * vault, merge in any localStorage stragglers, push the union, and only
 * then — given a durable backend — remove the plaintext local copies.
 */
export async function unlockVault(
  address: string,
  sign: (message: string) => Promise<string>,
): Promise<boolean> {
  const lower = address.toLowerCase();
  const current = statuses.get(lower);
  if (current === "unlocked" || current === "unlocking") return current === "unlocked";

  statuses.set(lower, "unlocking");
  errors.delete(lower);
  notify();

  try {
    let session = restoreSession(lower);
    if (!session) {
      const keySig = (await sign(vaultKeyMessage(address))) as `0x${string}`;
      // F2: sign a TIME-BOXED auth message; store the issuedAt so requests can
      // send the matching X-Vault-Auth-Timestamp header. When it expires, the
      // server returns 401 → dropSession → the user re-signs on next unlock.
      const authIssuedAt = Date.now();
      const bearer = (await sign(vaultAuthMessage(address, authIssuedAt))) as `0x${string}`;
      session = { keyHex: keccak256(keySig), bearer, authIssuedAt };
      sessions.set(lower, session);
      try {
        sessionStorage.setItem(SESSION_KEY(lower), JSON.stringify(session));
      } catch {
        // Session-cache failure is non-fatal; user just re-signs next tab.
      }
    }

    const remote = await fetchVault(session, lower);
    durableBackend.set(lower, remote.backend === "upstash");

    let vaultDeposits: unknown[] = [];
    if (remote.exists && remote.ciphertext) {
      const decrypted = await decryptVault(session.keyHex, remote.ciphertext);
      if (decrypted === null) {
        // Ciphertext exists but our key can't open it. Do NOT overwrite —
        // that would destroy someone's (possibly our own, differently keyed)
        // secrets. Surface the error and leave everything untouched.
        throw new Error(
          "Vault exists but cannot be decrypted with this wallet's key. Refusing to overwrite it.",
        );
      }
      vaultDeposits = decrypted.deposits;
      // v1 vaults have no seed; one is generated lazily on first derived deposit.
      if (decrypted.seed) seeds.set(lower, decrypted.seed);
      knownVersions.set(lower, remote.version ?? 0);
    } else {
      knownVersions.set(lower, 0);
    }

    const local = readLocal(address);
    const merged = mergeDeposits(vaultDeposits, local);
    cache.set(lower, merged);
    statuses.set(lower, "unlocked");
    notify();

    // Push when localStorage contributed anything or no vault exists yet.
    const needsPush = local.length > 0 || !remote.exists;
    const pushed = needsPush ? await persist(lower) : true;

    if (pushed && durableBackend.get(lower)) {
      clearLocal(address);
    } else if (needsPush && !pushed) {
      // Keep local copies; vault stays best-effort until the next save.
      writeLocalCanonical(address, cache.get(lower) ?? []);
    }
    notify();
    return true;
  } catch (err) {
    statuses.set(lower, "error");
    errors.set(
      lower,
      err instanceof Error ? err.message : "Vault unlock failed",
    );
    notify();
    return false;
  }
}

/**
 * Save deposits (full array or functional update against the latest state).
 *
 * Crash-safety order: localStorage synchronously FIRST, then the async vault
 * PUT, then — durable backend confirmed — drop the localStorage copy. A tab
 * killed mid-flight always leaves a readable copy somewhere.
 */
export function saveVaultDeposits(
  address: string,
  next: unknown[] | ((current: unknown[]) => unknown[]),
): void {
  const lower = address.toLowerCase();
  const resolved =
    typeof next === "function" ? next(getVaultDeposits(address)) : next;

  writeLocalCanonical(address, resolved);

  if (statuses.get(lower) === "unlocked") {
    cache.set(lower, resolved);
    notify();
    void persist(lower).then((ok) => {
      if (ok && durableBackend.get(lower)) {
        clearLocal(address);
      } else if (!ok) {
        console.warn(
          "[zBase vault] save did not reach the vault — secrets kept in localStorage fallback",
        );
      }
    });
  } else {
    notify();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// React hook
// ─────────────────────────────────────────────────────────────────────────

export function useDepositVault<T = unknown>(address: string | undefined): {
  deposits: T[];
  status: VaultStatus;
  error: string | null;
  /** True once the server confirmed a durable (Upstash) backend. */
  durable: boolean;
  unlock: () => Promise<boolean>;
  save: (next: T[] | ((current: T[]) => T[])) => void;
} {
  const { signMessageAsync } = useSignMessage();
  const version = useSyncExternalStore(
    subscribe,
    () => storeVersion,
    () => 0,
  );
  const lower = address?.toLowerCase();

  // Silent resume: if this tab already holds a session (sessionStorage),
  // re-unlock without prompting — no signature popups on reload.
  useEffect(() => {
    if (!address || !lower) return;
    const s = statuses.get(lower);
    if (s === "unlocked" || s === "unlocking") return;
    if (restoreSession(lower)) {
      void unlockVault(address, () =>
        Promise.reject(new Error("unexpected sign during silent resume")),
      );
    }
  }, [address, lower]);

  const deposits = useMemo(
    () => getVaultDeposits(address) as T[],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the store clock
    [address, version],
  );

  const unlock = useCallback(async () => {
    if (!address) return false;
    return unlockVault(address, (message) => signMessageAsync({ message }));
  }, [address, signMessageAsync]);

  const save = useCallback(
    (next: T[] | ((current: T[]) => T[])) => {
      if (!address) return;
      saveVaultDeposits(address, next as unknown[] | ((c: unknown[]) => unknown[]));
    },
    [address],
  );

  const status: VaultStatus = !lower ? "no-wallet" : statuses.get(lower) ?? "locked";
  return {
    deposits,
    status,
    error: lower ? errors.get(lower) ?? null : null,
    durable: lower ? durableBackend.get(lower) ?? false : false,
    unlock,
    save,
  };
}
