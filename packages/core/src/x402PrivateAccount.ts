/**
 * zBase as a viem `LocalAccount` — the drop-in for x402-fetch / x402-axios users.
 *
 *   import { wrapFetchWithPayment } from "x402-fetch";
 *   import { createZBasePrivateAccount } from "@zbase-protocol/core";
 *
 *   const account = createZBasePrivateAccount({ deposit: myNote, onNoteRotate: save });
 *   const fetchWithPay = wrapFetchWithPayment(fetch, account);
 *   await fetchWithPay("https://api.provider.ai/x");   // paid from the pool
 *
 * Why this exists alongside x402SchemeClient.ts: the ecosystem has TWO generations.
 * `@x402/core@2` exposes a SchemeNetworkClient seam (see x402SchemeClient.ts).
 * `x402-fetch@1` / `x402-axios@1` do not — they take `EvmSigner = SignerWallet |
 * LocalAccount`. So to reach them, zBase has to BE an account.
 *
 * ── How it works ─────────────────────────────────────────────────────────────
 * x402-fetch builds the EIP-3009 authorization with `from = account.address`,
 * then asks the account to sign it. So we cannot use /api/facilitator/settle-x402
 * here: that route derives its own payer EOA from (note, payTo), which would not
 * match the `from` x402-fetch already committed to. Instead this account:
 *
 *   1. owns a fixed payer EOA `E`, derived from the SEED note (deterministic, so
 *      a crash re-derives the same key and funds at `E` are never stranded);
 *   2. on signTypedData, reads `to`/`value` out of the authorization, withdraws
 *      exactly `value` from the pool to `E` via /api/withdraw (ZK; no on-chain
 *      link to the depositor), rotates the change note, then signs as `E`.
 *
 * ── The privacy trade-off, stated plainly ────────────────────────────────────
 * `E` is FIXED for the life of this account, because viem reads `.address` before
 * any 402 is seen. So every payment made through one account shares one payer
 * address: they are linkable TO EACH OTHER, though still not to your deposit.
 * settle-x402 (used by payAndFetch and the @x402/core scheme client) derives a
 * FRESH `E` per payTo and does not have this property.
 *
 * Rotate accounts to break the chain: construct a new account from a fresh note
 * (or a fresh `accountSalt`) whenever you want a new payer identity. If you need
 * per-payment unlinkability, prefer the @x402/core scheme client.
 *
 * ── Signing has side effects ─────────────────────────────────────────────────
 * signTypedData performs a real on-chain pool withdrawal and takes ~15s. That is
 * surprising for a "sign" call but unavoidable: it is the only hook x402-fetch
 * gives us, and `E` must be funded before its signature is worth anything.
 */
import { keccak256, encodePacked, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DepositSecrets, PaymentPrivacy } from "./facilitatorClient.js";
import {
  DEFAULT_FACILITATOR_URL,
  assertChangeRecoverable,
  assertSafeFacilitatorBaseUrl,
  isNoteRecoverable,
  nextNoteFrom,
} from "./facilitatorClient.js";

/** secp256k1 group order. Private keys must be in [1, n-1]. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Derive this account's fixed payer key from the SEED note (+ optional salt).
 *
 * Deliberately NOT keyed on payTo — unlike deriveX402PayerKey — because viem
 * exposes `.address` before any payTo is known. Keyed on the seed note (not the
 * current one) so the address survives note rotation.
 *
 * Deterministic ⇒ crash-recoverable: re-deriving reaches the same `E`, so funds
 * withdrawn to it are never stranded.
 */
export function deriveZBaseAccountKey(
  seed: { secret: string | bigint; nullifier: string | bigint },
  accountSalt = "",
): Hex {
  const raw = BigInt(
    keccak256(
      encodePacked(
        ["string", "uint256", "uint256", "string"],
        ["zbase-x402-account-v1", BigInt(seed.secret), BigInt(seed.nullifier), accountSalt],
      ),
    ),
  );
  const k = (raw % (SECP256K1_N - 1n)) + 1n;
  return `0x${k.toString(16).padStart(64, "0")}` as Hex;
}

export interface ZBasePrivateAccountConfig {
  /** Pool note to spend from. Rotates internally as change notes are produced. */
  deposit: DepositSecrets;
  /**
   * Persist the change note. Called and AWAITED before signTypedData returns; if it
   * throws, the signature throws. REQUIRED unless the note is recoverable (seed-derived
   * lineage) or `unsafeAllowUnrecoverableChange` is set — the spend-guard enforces it.
   *
   * Change notes are parent-keyed now (derived from the note being spent), so a lost
   * response re-derives; this callback is the durable copy across a full local wipe when
   * the lineage is not seed-rooted.
   */
  onNoteRotate?: (next: DepositSecrets) => void | Promise<void>;
  /**
   * Escape the recovery guard: spend a non-recoverable note with no persistence, owning
   * the loss risk. See `assertChangeRecoverable`.
   */
  unsafeAllowUnrecoverableChange?: boolean;
  /**
   * zBase deployment. SECURITY: fully trusted with your spend secrets until
   * client-side proving ships — it can withdraw your funds. Pin it.
   */
  baseUrl?: string;
  /** Refuse to sign an authorization above this (atomic units). */
  maxAmountAtomic?: string | bigint;
  /** Vary the payer identity without changing notes. */
  accountSalt?: string;
  fetchImpl?: typeof fetch;
  /**
   * Called ONCE, before the first payment, if the facilitator reports that payments are
   * not private yet. Defaults to a console.warn.
   *
   * This account funds via /api/withdraw rather than /settle-x402, so it never meets that
   * route's server-side readiness gate — see warnIfNotPrivate() for why withdraw is
   * deliberately left ungated. That makes this the only disclosure on this path.
   */
  onPrivacyDisclosure?: (privacy: PaymentPrivacy) => void;
}

const TRANSFER_WITH_AUTHORIZATION = "TransferWithAuthorization";

/**
 * A viem LocalAccount that funds each x402 payment from a zBase pool note.
 * Accepted anywhere `EvmSigner = SignerWallet | LocalAccount` is (x402-fetch,
 * x402-axios).
 */
export function createZBasePrivateAccount(cfg: ZBasePrivateAccountConfig) {
  const base = (cfg.baseUrl ?? DEFAULT_FACILITATOR_URL).replace(/\/+$/, "");
  assertSafeFacilitatorBaseUrl(base);

  const doFetch = cfg.fetchImpl ?? fetch;
  const maxAmount = cfg.maxAmountAtomic === undefined ? undefined : BigInt(cfg.maxAmountAtomic);

  // Fixed for the account's life — see the trade-off note in the header.
  const payerKey = deriveZBaseAccountKey(cfg.deposit, cfg.accountSalt ?? "");
  const inner = privateKeyToAccount(payerKey);

  let note: DepositSecrets | undefined = cfg.deposit;
  let privacyChecked = false;

  /**
   * Warn ONCE if the facilitator is not customer-ready — i.e. if these payments are not
   * private.
   *
   * This path needs its own check because it does NOT go through /settle-x402, and so it
   * never meets that route's server-side readiness gate. It funds via /api/withdraw,
   * which is deliberately NOT gated: withdraw is how money LEAVES the pool, and refusing
   * it on a thin anonymity set would strand every depositor's funds until launch. Locking
   * people out of their own money to protect them from a weak privacy claim is a bad
   * trade; letting them out while telling them the truth is the right one.
   *
   * So the disclosure has to happen client-side here. It warns rather than throws — the
   * caller may be deliberately testing, and this account's fixed-payer design already
   * carries a weaker privacy property than settle-x402 (see the header).
   */
  async function warnIfNotPrivate(): Promise<void> {
    if (privacyChecked) return;
    privacyChecked = true; // set first: a failed check must not retry on every payment
    try {
      const res = await doFetch(`${base}/api/facilitator/supported`);
      const s = (await res.json()) as {
        customerReady?: boolean;
        pilot?: { enabled?: boolean; anonymitySet?: number | null; minimumForPrivacy?: number };
      };
      if (s?.customerReady === false) {
        const set = s.pilot?.anonymitySet;
        const min = s.pilot?.minimumForPrivacy;
        cfg.onPrivacyDisclosure
          ? cfg.onPrivacyDisclosure({
              private: false,
              anonymitySet: set ?? null,
              minimumForPrivacy: min,
              disclosure:
                `The zBase facilitator at ${base} reports customerReady:false — these payments are NOT private. ` +
                (typeof set === "number" && typeof min === "number"
                  ? `The pool has ${set} independent depositor(s); privacy requires ${min}. `
                  : "") +
                "The withdrawal that funds your payer address is linkable to your deposit.",
            })
          : console.warn(
              `[zBase] NOT PRIVATE: the facilitator at ${base} reports customerReady:false` +
                (typeof set === "number" && typeof min === "number"
                  ? ` (${set} independent depositor(s); privacy requires ${min})` : "") +
                ". Your payments will settle, but the withdrawal is linkable to your deposit.",
            );
      }
    } catch {
      // A discovery failure must never break a payment — the caller's funds and the
      // provider call matter more than the warning. Stays silent rather than guessing.
    }
  }

  async function fundFromPool(amountAtomic: bigint): Promise<void> {
    await warnIfNotPrivate();
    const current = note;
    if (!current) {
      throw new Error(
        "zBase: no spendable note left. The last payment consumed it without change; deposit more USDC into the pool.",
      );
    }
    if (maxAmount !== undefined && amountAtomic > maxAmount) {
      throw new Error(
        `zBase: authorization is for ${amountAtomic} atomic but maxAmountAtomic is ${maxAmount}. Refusing to sign.`,
      );
    }

    // Recovery guard BEFORE spending: refuse if the change could be lost.
    assertChangeRecoverable(current, {
      hasPersist: Boolean(cfg.onNoteRotate),
      unsafe: cfg.unsafeAllowUnrecoverableChange,
    });

    // Change note secrets, parent-keyed from the note being spent — always derivable, no
    // mnemonic, never random. A lost /api/withdraw response re-derives from `current`.
    const nextNote = nextNoteFrom(current);

    const res = await doFetch(`${base}/api/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nullifier: current.nullifier,
        secret: current.secret,
        value: current.value,
        label: current.label,
        commitment: current.commitment,
        recipient: inner.address,
        amountAtomic: amountAtomic.toString(),
        nextNullifier: nextNote.nullifier,
        nextSecret: nextNote.secret,
      }),
    });

    const data = (await res.json()) as { error?: string; nextDeposit?: DepositSecrets };
    if (!res.ok || data.error) {
      throw new Error(
        `zBase: pool withdrawal to the payer EOA failed: ${data.error ?? `HTTP ${res.status}`}. ` +
          "The note is unspent; retrying re-derives the same payer EOA, so no funds are stranded.",
      );
    }

    // Propagate recoverability down the lineage (recoverable iff the spent note was). No
    // HD index — change notes are parent-keyed, which removed the deposit/change collision.
    const rotated = data.nextDeposit
      ? { ...data.nextDeposit, recoverable: isNoteRecoverable(current) }
      : data.nextDeposit;

    // Persist BEFORE returning. A signature we hand back while having dropped the
    // change note means the seller gets paid and the remainder is lost silently.
    if (rotated && cfg.onNoteRotate) await cfg.onNoteRotate(rotated);
    note = rotated;
  }

  return {
    ...inner,
    source: "zbase-private" as const,

    /** The note funding the next payment (undefined once fully spent). */
    get currentNote(): DepositSecrets | undefined {
      return note;
    },

    async signTypedData(params: any): Promise<Hex> {
      // Only fund the x402 `exact` authorization. Anything else is not ours to pay
      // for, and silently funding an unknown message would be a real footgun.
      if (params?.primaryType !== TRANSFER_WITH_AUTHORIZATION) {
        return inner.signTypedData(params);
      }

      const message = params.message ?? {};
      const from = String(message.from ?? "").toLowerCase();
      if (from && from !== inner.address.toLowerCase()) {
        throw new Error(
          `zBase: authorization.from (${message.from}) is not this account (${inner.address}). ` +
            "The payer EOA must be the account the pool funds.",
        );
      }

      await fundFromPool(BigInt(message.value));
      return inner.signTypedData(params);
    },
  };
}
