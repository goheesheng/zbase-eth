import { NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { Redis } from "@upstash/redis";
import { vaultAuthMessage, isVaultAuthTimestampFresh } from "@/lib/vault-messages";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

/**
 * GET/PUT /api/vault — encrypted deposit-secret vault (Phase 1C).
 *
 * Moves deposit secrets (nullifier + secret = the keys to pool funds) off
 * localStorage, closing two gaps from the 2026-06-09 operational audit:
 * browser-storage clear permanently destroyed access to funds, and any XSS
 * could exfiltrate every secret at rest.
 *
 * Trust model — the server is a dumb ciphertext shelf:
 *
 *   - The browser encrypts with AES-GCM-256 under a key derived from a
 *     wallet signature that NEVER leaves the client. This route cannot
 *     decrypt what it stores.
 *   - Reads and writes require a bearer signature over vaultAuthMessage
 *     (deterministic personal_sign), verified here with viem. Without it,
 *     anyone could overwrite (destroy) a stranger's vault — confidentiality
 *     comes from the encryption, but INTEGRITY needs auth.
 *   - EOA wallets only in v1: verifyMessage() does pure ECDSA recovery.
 *     ERC-1271 smart wallets fail verification and stay on the localStorage
 *     path (the client degrades gracefully).
 *
 * Durability contract: responses carry `backend: "upstash" | "memory"`.
 * The client only deletes its localStorage copy when the backend is
 * "upstash" — a memory-backed vault (local dev, missing env vars) is a
 * cache, not a custodian, and evaporates on redeploy. Vault keys carry NO
 * TTL: these are funds, not sessions.
 *
 * Optimistic concurrency: PUT requires version > stored version, else 409
 * with the stored version so the client can refetch, re-merge, and retry.
 * Two tabs racing can never silently clobber each other's deposits.
 */

// Same backend-selection pattern as facilitator-authz.ts — accept both
// Upstash standard names AND Vercel Marketplace's KV_REST_API_* names.
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const USE_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

const redis = USE_UPSTASH
  ? new Redis({ url: UPSTASH_URL!, token: UPSTASH_TOKEN! })
  : null;

type VaultRecord = {
  ciphertext: string; // base64(iv || AES-GCM ciphertext) — opaque to us
  version: number;
  updatedAt: number;
};

// In-memory fallback for local dev. NOT durable — see durability contract.
const memVaults = new Map<string, VaultRecord>();

const VAULT_KEY = (address: string) => `zbase:vault:${address.toLowerCase()}`;

// Generous for deposit lists (a deposit record is ~400 bytes; 256 KiB holds
// hundreds), tight enough that the vault can't be abused as blob storage.
const MAX_CIPHERTEXT_BYTES = 256 * 1024;

const backend = () => (USE_UPSTASH ? ("upstash" as const) : ("memory" as const));

async function readVault(address: string): Promise<VaultRecord | null> {
  if (redis) {
    return (await redis.get<VaultRecord>(VAULT_KEY(address))) ?? null;
  }
  return memVaults.get(VAULT_KEY(address)) ?? null;
}

async function writeVault(address: string, record: VaultRecord): Promise<void> {
  if (redis) {
    // No TTL — deposit secrets must outlive any session or deploy.
    await redis.set(VAULT_KEY(address), record);
    return;
  }
  memVaults.set(VAULT_KEY(address), record);
}

/**
 * Authenticate a request: the Authorization bearer must be the wallet's
 * signature over vaultAuthMessage(address). Returns the normalized address
 * on success, or a NextResponse error to return as-is.
 */
async function authenticate(
  request: Request,
  address: string | null,
): Promise<{ address: string } | NextResponse> {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json(
      { error: "Missing or malformed address" },
      { status: 400 },
    );
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const signature = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) {
    return NextResponse.json(
      { error: "Missing bearer signature (sign vaultAuthMessage with the wallet)" },
      { status: 401 },
    );
  }

  // F2: the auth signature is time-boxed. The client sends the issuedAt it signed
  // over (X-Vault-Auth-Timestamp); we reconstruct the exact message, verify the
  // signature, then reject stale/future timestamps so a captured bearer expires.
  const issuedAtRaw = request.headers.get("x-vault-auth-timestamp") ?? "";
  const issuedAt = Number(issuedAtRaw);
  if (!isVaultAuthTimestampFresh(issuedAt, Date.now())) {
    return NextResponse.json(
      { error: "Auth signature expired or missing timestamp — re-sign to continue" },
      { status: 401 },
    );
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message: vaultAuthMessage(address, issuedAt),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return NextResponse.json(
      { error: "Signature does not match address (EOA wallets only in v1)" },
      { status: 401 },
    );
  }

  return { address: address.toLowerCase() };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const addressParam = url.searchParams.get("address");

  // AUDIT MEDIUM #6 (2026-07-09): authenticate FIRST (a ~ms signature verify),
  // then rate-limit on the AUTHENTICATED address — so the per-address bucket
  // (which guards the expensive vault I/O) is only ever charged by the PROVEN
  // owner. The prior order charged the victim's bucket on the *claimed* address
  // before auth, letting an attacker who knows a public address lock the owner
  // out of their deposit secrets with 30 garbage-bearer requests/min. Keying the
  // post-auth bucket on `auth.address` makes victim-lockout impossible: a failed
  // bearer never reaches this line.
  const auth = await authenticate(request, addressParam);
  if (auth instanceof NextResponse) return auth;

  const limited = await checkRateLimit(request, "vault", auth.address.toLowerCase());
  if (!limited.success) return rateLimitResponse(limited);

  const record = await readVault(auth.address);
  if (!record) {
    return NextResponse.json({ exists: false, backend: backend() });
  }
  return NextResponse.json({
    exists: true,
    ciphertext: record.ciphertext,
    version: record.version,
    updatedAt: record.updatedAt,
    backend: backend(),
  });
}

export async function PUT(request: Request) {
  let body: { address?: string; ciphertext?: string; version?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // AUDIT MEDIUM #6: authenticate FIRST, then rate-limit on the AUTHENTICATED
  // address (see GET for the victim-lockout rationale). A failed bearer never
  // reaches the per-address bucket, so it cannot be used to lock out the owner.
  const auth = await authenticate(request, body.address ?? null);
  if (auth instanceof NextResponse) return auth;

  const limited = await checkRateLimit(request, "vault", auth.address.toLowerCase());
  if (!limited.success) return rateLimitResponse(limited);

  const { ciphertext, version } = body;
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    return NextResponse.json({ error: "Missing ciphertext" }, { status: 400 });
  }
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    return NextResponse.json(
      { error: `Ciphertext exceeds ${MAX_CIPHERTEXT_BYTES} byte cap` },
      { status: 413 },
    );
  }
  // Reject anything that isn't base64 — the value is opaque but this keeps
  // junk (and stored-XSS payload experiments) out of the store.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) {
    return NextResponse.json(
      { error: "Ciphertext must be base64" },
      { status: 400 },
    );
  }
  if (!Number.isInteger(version) || (version as number) < 1) {
    return NextResponse.json(
      { error: "version must be a positive integer" },
      { status: 400 },
    );
  }

  const existing = await readVault(auth.address);
  if (existing && (version as number) <= existing.version) {
    // Stale write — another tab (or an older session) advanced the vault.
    // Client refetches, re-merges deposits, and retries with a higher version.
    return NextResponse.json(
      {
        error: "Stale version",
        storedVersion: existing.version,
        backend: backend(),
      },
      { status: 409 },
    );
  }

  const record: VaultRecord = {
    ciphertext,
    version: version as number,
    updatedAt: Date.now(),
  };
  await writeVault(auth.address, record);

  return NextResponse.json({
    ok: true,
    version: record.version,
    backend: backend(),
  });
}
