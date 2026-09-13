/**
 * zBase as a drop-in `exact`-scheme client for @x402/core.
 *
 * The point: an existing x402 buyer switches to private payments with ONE line,
 * instead of rewriting call sites onto our payAndFetch:
 *
 *   import { x402Client } from "@x402/core/client";
 *   import { createZBaseExactClient } from "@zbase-protocol/core";
 *
 *   const client = x402Client.fromConfig({ schemes: [...] });
 *   client.register("eip155:8453", createZBaseExactClient({
 *     deposit: myNote,
 *     onNoteRotate: (n) => db.save(n),   // REQUIRED in practice — see below
 *   }));
 *
 * `register()` and `SchemeNetworkClient` are public @x402/core API, so this needs
 * no upstream PR and no cooperation from anyone. The seller is unaffected: it
 * still picks its own facilitator and still receives a bog-standard EIP-3009
 * `exact` payload. It never learns zBase exists — the unlinkability was already
 * established upstream, when the pool funded a single-use payer EOA.
 *
 * ── onNoteRotate is not optional in practice ──────────────────────────────────
 * Paying from a note of value V for a price P leaves a change note worth V-P.
 * Its nullifier/secret are generated RANDOMLY server-side and returned exactly
 * ONCE. They are never persisted server-side and never logged. If you drop them,
 * the remaining balance is locked in the pool forever — ragequit needs those same
 * secrets and nothing re-derives them. This is not theoretical: 0.985 USDC was
 * lost that way on 2026-07-16 by a caller that threw before saving.
 *
 * So onNoteRotate fires BEFORE createPaymentPayload returns. If it throws, the
 * whole payment throws — deliberately. A payment whose change note we failed to
 * persist is worse than no payment: the seller gets paid, and you silently eat
 * the remainder. Better to fail loudly while the note is still unspent.
 */
import type {
  DepositSecrets,
  FacilitatorBlockingReason,
  FacilitatorReadiness,
  PaymentPrivacy,
} from "./facilitatorClient.js";
import {
  DEFAULT_FACILITATOR_URL,
  FacilitatorNotReadyError,
  assertChangeRecoverable,
  assertSafeFacilitatorBaseUrl,
  isNoteRecoverable,
  nextNoteFrom,
} from "./facilitatorClient.js";

/** Minimal structural copy of @x402/core's PaymentRequirements (avoids a hard dep). */
export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** Minimal structural copy of @x402/core's PaymentPayloadResult. */
export interface X402PaymentPayloadResult {
  x402Version: number;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface ZBaseExactClientConfig {
  /** The pool note to spend. Rotates to the change note after each payment. */
  deposit: DepositSecrets;
  /**
   * Persist the change note. Called and AWAITED before the payload is returned; if it
   * throws, the payment throws. REQUIRED unless the note is recoverable (a seed-derived
   * deposit or its descendant) or `unsafeAllowUnrecoverableChange` is set — the
   * spend-guard enforces this.
   *
   * Change notes are now parent-keyed (derived from the note being spent), so they are
   * re-derivable from the note you hold; this callback is the durable copy across a full
   * loss of local state when the lineage is not seed-rooted.
   */
  onNoteRotate?: (next: DepositSecrets) => void | Promise<void>;
  /**
   * Escape the recovery guard: spend a non-recoverable note with no persistence, owning
   * the loss risk. See `assertChangeRecoverable`.
   */
  unsafeAllowUnrecoverableChange?: boolean;
  /**
   * zBase deployment. Defaults to the public one.
   *
   * SECURITY: this host is FULLY TRUSTED WITH YOUR SPEND SECRETS until
   * client-side proving ships — it can withdraw your funds. Pin it to a host you
   * trust; never point it at one you don't control or don't know.
   */
  baseUrl?: string;
  /** Refuse to pay more than this (atomic units) — guards against a hostile 402. */
  maxAmountAtomic?: string | bigint;
  fetchImpl?: typeof fetch;
  /**
   * Acknowledge that payments through a PILOT facilitator are NOT private, and pay anyway.
   *
   * No key is involved — the facilitator's pilot is open to anyone who has deposited. This
   * is consent, not permission: with a small anonymity set the withdrawal is linkable to
   * your deposit, and @x402/core's SchemeNetworkClient has nowhere to return that
   * disclosure (it wants a payment payload and discards the rest). So this adapter
   * surfaces it on `lastPrivacy` and pushes it to `onPrivacyDisclosure`.
   */
  acceptNotPrivate?: boolean;
  /**
   * Called once per payment with the facilitator's privacy verdict. The ONLY push-based
   * way to see it through this interface — @x402/core discards everything but the
   * payload. Defaults to a console.warn when the payment is not private, because
   * silence here is indistinguishable from privacy.
   */
  onPrivacyDisclosure?: (privacy: PaymentPrivacy) => void;
}

/**
 * A `SchemeNetworkClient` (structurally — @x402/core's interface) that funds each
 * payment from a zBase pool note instead of from the caller's wallet.
 */
export class ZBaseExactClient {
  readonly scheme = "exact" as const;

  #note: DepositSecrets | undefined;
  #base: string;
  #onNoteRotate?: (next: DepositSecrets) => void | Promise<void>;
  #unsafeAllowUnrecoverableChange = false;
  #maxAmountAtomic?: bigint;
  #fetch: typeof fetch;
  #acceptNotPrivate = false;
  /** Cached: readiness is a launch gate, not per-payment state. */
  #privacyAccepted = false;
  #onPrivacyDisclosure?: (privacy: PaymentPrivacy) => void;
  #lastPrivacy?: PaymentPrivacy;

  constructor(cfg: ZBaseExactClientConfig) {
    this.#base = (cfg.baseUrl ?? DEFAULT_FACILITATOR_URL).replace(/\/+$/, "");
    assertSafeFacilitatorBaseUrl(this.#base);
    this.#note = cfg.deposit;
    this.#onNoteRotate = cfg.onNoteRotate;
    this.#unsafeAllowUnrecoverableChange = cfg.unsafeAllowUnrecoverableChange === true;
    this.#maxAmountAtomic =
      cfg.maxAmountAtomic === undefined ? undefined : BigInt(cfg.maxAmountAtomic);
    this.#fetch = cfg.fetchImpl ?? fetch;
    this.#acceptNotPrivate = cfg.acceptNotPrivate === true;
    this.#onPrivacyDisclosure = cfg.onPrivacyDisclosure;
  }

  /** The note that will fund the next payment (undefined once fully spent). */
  get currentNote(): DepositSecrets | undefined {
    return this.#note;
  }

  /**
   * The facilitator's privacy verdict for the most recent payment, or undefined before
   * the first one / from a facilitator too old to publish it.
   *
   * Check `lastPrivacy?.private` before relying on privacy. A pilot payment is
   * indistinguishable from a private one everywhere else: same Groth16 proof, same fresh
   * payer EOA, same provider response. This is the only place the difference appears.
   */
  get lastPrivacy(): PaymentPrivacy | undefined {
    return this.#lastPrivacy;
  }

  /**
   * Throw unless the facilitator can deliver privacy or the caller has accepted that it
   * cannot. Checked once and cached — it is a launch gate, not per-payment state, and a
   * /supported round-trip before every payment would be a real cost for no new answer.
   *
   * Fails OPEN on a discovery error, matching FacilitatorClient.readiness(): older
   * deployments predate the gate entirely, and treating "no answer" as "closed" would
   * brick every one of them. The server enforces its own gate regardless — this check
   * exists to inform the caller, not to be the gate.
   */
  async #assertPrivacyAccepted(): Promise<void> {
    if (this.#acceptNotPrivate || this.#privacyAccepted) return;
    let readiness: FacilitatorReadiness;
    try {
      const res = await this.#fetch(`${this.#base}/api/facilitator/supported`);
      const raw = (await res.json()) as {
        customerReady?: boolean;
        description?: string;
        blockingReasons?: FacilitatorBlockingReason[];
        pilot?: { enabled?: boolean };
      };
      if (raw?.customerReady !== false) { this.#privacyAccepted = true; return; }
      readiness = {
        customerReady: false,
        description: raw.description,
        blockingReasons: raw.blockingReasons,
        pilot: raw.pilot ? { enabled: raw.pilot.enabled === true } : undefined,
      };
    } catch {
      this.#privacyAccepted = true; // discovery failed — do not invent a refusal
      return;
    }
    throw new FacilitatorNotReadyError(readiness, this.#base);
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<X402PaymentPayloadResult> {
    const note = this.#note;
    if (!note) {
      throw new Error(
        "zBase: no spendable note left. The last payment consumed it without change; deposit more USDC into the pool.",
      );
    }
    if (paymentRequirements.scheme !== "exact") {
      throw new Error(`zBase funds the "exact" scheme only; got "${paymentRequirements.scheme}".`);
    }

    // Guard BEFORE spending: a hostile or misconfigured 402 must not drain the note.
    const amount = BigInt(paymentRequirements.amount);
    if (this.#maxAmountAtomic !== undefined && amount > this.#maxAmountAtomic) {
      throw new Error(
        `zBase: 402 asks ${amount} atomic but maxAmountAtomic is ${this.#maxAmountAtomic}. Refusing to pay.`,
      );
    }

    // Consent BEFORE spending, for the same reason as the amount guard above: a refusal
    // must cost the caller nothing and leave the note unspent.
    //
    // This adapter is the one most likely to be wired in and forgotten — it disappears
    // into `client.register(...)` and every later payment flows through @x402/core, which
    // never surfaces our disclosure. So if the facilitator cannot deliver privacy, the
    // caller has to have said so in their own code. Without this check `acceptNotPrivate`
    // would be decorative, which is worse than not offering it.
    await this.#assertPrivacyAccepted();

    // Recovery guard BEFORE spending: refuse if the change could be lost. This adapter is
    // the one most likely to be wired in and forgotten, so the guard matters most here.
    assertChangeRecoverable(note, {
      hasPersist: Boolean(this.#onNoteRotate),
      unsafe: this.#unsafeAllowUnrecoverableChange,
    });

    // Change note secrets, parent-keyed from the note being spent — always derivable, no
    // mnemonic, never random. A lost response is re-derived from `note`.
    const nextNote = nextNoteFrom(note);

    const res = await this.#fetch(`${this.#base}/api/facilitator/settle-x402`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accepts: paymentRequirements,
        zbaseDeposit: note,
        nextNullifier: nextNote.nullifier,
        nextSecret: nextNote.secret,
        x402Version,
      }),
    });

    const settle = (await res.json()) as {
      settled?: boolean;
      error?: string;
      xPayment?: string;
      nextDeposit?: DepositSecrets;
      privacy?: PaymentPrivacy;
    };

    if (!settle.settled || !settle.xPayment) {
      throw new Error(`zBase private settlement failed: ${settle.error ?? "unknown error"}`);
    }

    // Surface the privacy verdict as early as possible, and before anything can throw:
    // this interface returns only a payment payload, so if we drop the disclosure here it
    // is gone for good and a pilot payment becomes indistinguishable from a private one.
    this.#lastPrivacy = settle.privacy;
    if (settle.privacy) {
      if (this.#onPrivacyDisclosure) this.#onPrivacyDisclosure(settle.privacy);
      else if (settle.privacy.private === false) {
        // Default to warning rather than staying quiet. A caller who wired zBase in for
        // privacy and got none should not have to opt in to being told.
        console.warn(
          `[zBase] This payment is NOT private. ${settle.privacy.disclosure ?? ""}`.trim(),
        );
      }
    }

    // Propagate recoverability down the lineage (the change is recoverable iff the note
    // we spent was). No HD index to stamp — change notes are parent-keyed, which is what
    // removed the deposit/change index collision. Rotation to the next payment works
    // regardless: the next change is deriveChangeNote(this change).
    const rotated = settle.nextDeposit
      ? { ...settle.nextDeposit, recoverable: isNoteRecoverable(note) }
      : settle.nextDeposit;

    // Persist the change note BEFORE returning. If this throws, the payment throws
    // — see the header. The note is spent either way, but failing loudly here beats
    // silently forfeiting the remainder.
    if (rotated && this.#onNoteRotate) {
      await this.#onNoteRotate(rotated);
    }
    this.#note = rotated;

    // settle-x402 returns the full base64 X-PAYMENT header; @x402/core wants only
    // the inner payload ({signature, authorization}) and rebuilds the rest itself.
    const decoded = JSON.parse(
      typeof Buffer !== "undefined"
        ? Buffer.from(settle.xPayment, "base64").toString("utf8")
        : atob(settle.xPayment),
    ) as { x402Version?: number; payload?: Record<string, unknown> };

    if (!decoded?.payload) {
      throw new Error("zBase: settle-x402 returned an X-PAYMENT header with no payload.");
    }

    return { x402Version: decoded.x402Version ?? x402Version, payload: decoded.payload };
  }
}

/** Convenience factory. Register with `client.register(network, createZBaseExactClient({...}))`. */
export function createZBaseExactClient(cfg: ZBaseExactClientConfig): ZBaseExactClient {
  return new ZBaseExactClient(cfg);
}
