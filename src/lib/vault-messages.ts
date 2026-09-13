/**
 * Deposit-vault signing messages (Phase 1C).
 *
 * Shared between the browser vault client (src/lib/deposit-vault.ts) and the
 * server route (src/app/api/vault/route.ts). The strings must be byte-identical
 * on both sides — the client derives keys from signatures over them, and the
 * server authenticates by verifying a signature over VAULT_AUTH_MESSAGE.
 *
 * Two SEPARATE messages by design:
 *
 *  - The KEY message's signature never leaves the browser. It derives the
 *    AES-GCM key that encrypts deposit secrets, so the server (which stores
 *    only ciphertext) can never decrypt what it stores.
 *  - The AUTH message's signature IS sent to the server (as a bearer token)
 *    so the server can verify wallet ownership before reads/writes. If one
 *    signature served both purposes, presenting it for auth would hand the
 *    server the encryption key.
 *
 * Both signatures are deterministic for EOA wallets (RFC 6979 ECDSA), which
 * is what makes the vault recoverable from the wallet alone: reconnect, sign
 * the same two messages, get the same key + bearer back. Smart-contract
 * wallets (ERC-1271) are not supported in v1 — they may sign
 * non-deterministically and verifyMessage() only covers EOAs; those users
 * stay on the localStorage path.
 *
 * NEVER change these strings once shipped: existing vaults would become
 * undecryptable (key message) or unreachable (auth message). Version bumps
 * require a migration path that re-encrypts under the new key.
 */

export function vaultKeyMessage(address: string): string {
  return (
    `zBase deposit vault v1 — encryption key\n` +
    `This signature derives the key that encrypts your deposit secrets. ` +
    `It never leaves your browser.\n` +
    `Only sign this message on zbase.app.\n` +
    `Wallet: ${address.toLowerCase()}`
  );
}

/**
 * AUTH message — now TIME-BOXED (audit F2).
 *
 * Previously this was a static, deterministic string, which made a captured
 * bearer signature replayable FOREVER (e.g. lifted from sessionStorage by an
 * in-session XSS, then reused from any IP indefinitely to read or overwrite the
 * vault). Binding the signed message to an `issuedAt` millisecond timestamp lets
 * the server reject signatures outside a short freshness window, so a stolen
 * bearer expires.
 *
 * The KEY message (vaultKeyMessage) stays deterministic — it derives the
 * encryption key and MUST be reproducible; timestamping it would change the key
 * on every sign and make vaults undecryptable. Only the AUTH path is time-boxed.
 *
 * The client signs vaultAuthMessage(address, issuedAt) and sends BOTH the
 * signature (Authorization: Bearer) and the issuedAt (X-Vault-Auth-Timestamp).
 * The server reconstructs the exact message from the supplied issuedAt, verifies
 * the signature, then checks issuedAt is recent (within VAULT_AUTH_TTL_MS) and
 * not in the future.
 */
export const VAULT_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** Small allowance for client/server clock skew. */
export const VAULT_AUTH_SKEW_MS = 60 * 1000; // 1 minute

export function vaultAuthMessage(address: string, issuedAt: number): string {
  return (
    `zBase deposit vault v1 — storage access\n` +
    `This signature authorizes reading and writing your encrypted deposit ` +
    `vault. It cannot decrypt anything.\n` +
    `Only sign this message on zbase.app.\n` +
    `Issued: ${issuedAt}\n` +
    `Wallet: ${address.toLowerCase()}`
  );
}

/**
 * Server-side freshness check for the auth timestamp. Returns true iff issuedAt
 * is a plausible recent millisecond timestamp (not stale, not future-dated).
 */
export function isVaultAuthTimestampFresh(issuedAt: number, now: number): boolean {
  if (!Number.isFinite(issuedAt)) return false;
  if (issuedAt > now + VAULT_AUTH_SKEW_MS) return false; // future-dated
  if (now - issuedAt > VAULT_AUTH_TTL_MS) return false; // stale
  return true;
}
