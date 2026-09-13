/**
 * facilitatorClient.ts — the buildable-on-top-of surface for zBase as private-
 * facilitator infrastructure (facilitator-infra-architecture-2026-06-24.md).
 *
 * Three primitives a builder (or a trading agent, or you dogfooding) needs to make
 * a private payment through zBase, with NO knowledge of the internal routes:
 *
 *   prepareDeposit(amount)            → deposit calldata + the secrets to keep
 *   verifyPayment({ payTo, amount })  → can this settle?
 *   settlePrivately({ payTo, amountAtomic, deposit }) → execute the private payment
 *
 * This is a thin, typed HTTP client over the facilitator API. The heavy ZK work
 * (proof generation) currently runs server-side inside /settle; a future revision
 * can move proving client-side here (proofs.ts already generates Groth16 proofs)
 * so the payer's secrets never leave their machine — see NOTE on settlePrivately.
 *
 * Chain-agnostic: pass the CAIP-2 network ("eip155:84532" Sepolia / "eip155:8453"
 * mainnet). Zero new dependencies — fetch only.
 */

import { generateDepositSecrets, computePrecommitment } from "./account.js";
import { deriveChangeNote } from "./forwardingNotes.js";

export type FacilitatorNetwork = "eip155:84532" | "eip155:8453";

/** Default facilitator: the public zBase deployment. Used when no baseUrl is given. */
export const DEFAULT_FACILITATOR_URL = "https://zbase.app";

/**
 * On-chain deposit config for a network — the addresses an SDK consumer needs to
 * build the pool `deposit()` call themselves (approve USDC to the entrypoint,
 * call Entrypoint.deposit(asset, amount, precommitment)). These are the LIVE
 * deployed contracts; there is no runtime discovery required, but you can also
 * fetch/verify them via `getDepositConfig()` against a specific deployment.
 */
export interface DepositConfig {
  network: FacilitatorNetwork;
  chainId: number;
  /** USDC (the pool asset). */
  asset: string;
  /** Entrypoint proxy — approve() this + call its deposit(). */
  entrypoint: string;
  /** PrivacyPool (reads: SCOPE/currentRoot; Deposited event source). */
  privacyPool: string;
  /** First block to scan for pool events (eth_getLogs floor). */
  deployBlock: number;
}

/** Base MAINNET (eip155:8453) — deployed 2026-07-13. */
export const BASE_MAINNET: DepositConfig = {
  network: "eip155:8453",
  chainId: 8453,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Circle USDC
  entrypoint: "0x275fAA86e2E316Abe46807453c1D95f101d36431",
  privacyPool: "0x46753CED1E87871eA1aaF24Aed47DFA2D95855Dd",
  deployBlock: 48571589,
};

/** Base SEPOLIA (eip155:84532) — testnet. */
export const BASE_SEPOLIA: DepositConfig = {
  network: "eip155:84532",
  chainId: 84532,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Circle test USDC
  entrypoint: "0x598ffaac79ae29b1aae571fd91899d4492183688",
  privacyPool: "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a",
  deployBlock: 40668000,
};

/** Look up the static deposit config for a network. */
export function depositConfigFor(network: FacilitatorNetwork): DepositConfig {
  return network === "eip155:8453" ? BASE_MAINNET : BASE_SEPOLIA;
}

export interface FacilitatorClientConfig {
  /**
   * Base URL of the zBase deployment. Defaults to `https://zbase.app` (the public
   * zBase facilitator) — so `createFacilitatorClient()` with no config just works.
   *
   * ⚠️ SECURITY (CRITICAL, 2026-07-09): `baseUrl` is FULLY TRUSTED WITH YOUR SPEND
   * SECRETS. In the current server-side-proving model, `settlePrivately` sends the
   * deposit's `{nullifier, secret}` — the COMPLETE spend authority for the pool
   * note — to this URL. A malicious or man-in-the-middle'd `baseUrl` can withdraw
   * your funds. Therefore:
   *   - `https:` is REQUIRED (an on-path attacker cannot read an HTTPS body).
   *   - `http://localhost` / `http://127.0.0.1` is allowed for local dev only.
   *   - any other `http:` URL is REJECTED unless you explicitly set
   *     `allowInsecureHttp: true` (do this ONLY on a trusted private network).
   *   - When you OVERRIDE the default, PIN this URL to a deployment you
   *     control/trust; never take it from an untrusted discovery response or input.
   */
  baseUrl?: string;
  /** CAIP-2 network. Defaults to Base **mainnet** (eip155:8453), matching zbase.app. */
  network?: FacilitatorNetwork;
  /** Optional fetch override (for tests / non-browser runtimes). */
  fetchImpl?: typeof fetch;
  /**
   * Explicitly allow a non-localhost `http://` baseUrl. Only for trusted private
   * networks — this transmits spend secrets in cleartext. Default false.
   */
  allowInsecureHttp?: boolean;
  /**
   * Acknowledge that payments through a PILOT facilitator are NOT private, and pay anyway.
   *
   * This is a consent flag, not a capability. The facilitator's pilot is open to anyone
   * who deposits — no key, no allowlist — so this does not unlock anything server-side.
   * What it does is stop the SDK from paying on your behalf through a facilitator that has
   * told us, in `/supported`, that it cannot deliver privacy yet.
   *
   * The reason it exists: a pilot payment succeeds identically to a private one — same
   * proof, same fresh payer EOA, same 200. If the SDK just went ahead, someone who wired
   * zBase in FOR privacy would get none and never know. Setting this means you have read
   * that and accept it. Every result still carries `privacy.private:false`.
   *
   * Not needed once the facilitator is customer-ready; it is ignored there.
   */
  acceptNotPrivate?: boolean;
}

/**
 * Validate the facilitator baseUrl before we ever send spend secrets to it.
 * Throws on a URL that would leak secrets to an on-path attacker. Exported for
 * testing the guard.
 */
export function assertSafeFacilitatorBaseUrl(baseUrl: string, allowInsecureHttp = false): URL {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`FacilitatorClient: baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:") {
    const host = u.hostname.toLowerCase();
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    if (isLocal || allowInsecureHttp) return u;
    throw new Error(
      `FacilitatorClient: refusing an insecure http:// baseUrl (${baseUrl}). settlePrivately sends your spend secrets to this host — use https, or set allowInsecureHttp:true only on a trusted private network.`,
    );
  }
  throw new Error(`FacilitatorClient: unsupported baseUrl protocol '${u.protocol}' — use https.`);
}

/**
 * One reason the facilitator is closed, as `/api/facilitator/supported` publishes it:
 * `{ code, message, blocks }` — NOT a bare string.
 */
export interface FacilitatorBlockingReason {
  code: string;
  message?: string;
  /** Which capabilities this blocks, e.g. ["customer"] or ["verification","customer"]. */
  blocks?: string[];
}

/** What `/api/facilitator/supported` says about whether this deployment is open. */
export interface FacilitatorReadiness {
  customerReady: boolean;
  blockingReasons?: FacilitatorBlockingReason[];
  description?: string;
   /**
   * The facilitator is running an open PILOT: it settles real payments for anyone who has
   * deposited, but the payments are NOT private yet and every response says so. Never
   * implies customerReady — it is the opposite of a privacy claim.
   */
  pilot?: {
    enabled: boolean;
    /** Independent depositors right now. null/undefined = not published. */
    anonymitySet?: number | null;
    /** What the set must reach before privacy is claimed. */
    minimumForPrivacy?: number;
    howToJoin?: string | null;
  };
}

/**
 * The privacy verdict for ONE settled payment, echoed from the facilitator.
 *
 * Read `private` before you rely on privacy. The facilitator settles pilot payments with
 * the full Groth16 + fresh-payer-EOA machinery, so a payment succeeding tells you nothing
 * about whether it was anonymous — the mechanism hides you in a crowd and cannot hide you
 * when there is no crowd. This block is the facilitator stating which case you got.
 */
export interface PaymentPrivacy {
  /** Whether THIS payment is actually private. False in pilot mode. */
  private: boolean;
  /** Inverse of `private`: whether the withdrawal is linkable to the deposit. */
  linkable?: boolean;
  anonymitySet?: number | null;
  minimumForPrivacy?: number;
  /** Plain-language statement from the facilitator. Worth surfacing to a human. */
  disclosure?: string;
  method?: string;
  /** The amount is on-chain visible regardless of set size. */
  amountVisible?: boolean;
}

/**
 * Thrown when the facilitator says it is NOT ready for customer use and the caller
 * did not opt in. Carries the facilitator's own reasons so the caller can act on them
 * rather than guess.
 */
export class FacilitatorNotReadyError extends Error {
  /** The raw reasons, for programmatic handling. */
  readonly blockingReasons: FacilitatorBlockingReason[];
  /** Just the codes, e.g. ["ANONYMITY_SET_BELOW_MINIMUM"] — the common case. */
  readonly codes: string[];
  /** True when `acceptNotPrivate:true` would let this call through, not-private. */
  readonly pilotAvailable: boolean;

  constructor(readiness: FacilitatorReadiness, baseUrl: string) {
    const reasons = readiness.blockingReasons ?? [];
    // Render code + message, not the object. A caller reading "[object Object]" learns
    // nothing, and this string is the entire diagnostic most people will ever see.
    const rendered = reasons
      .map((r) => (r.message ? `${r.code} (${r.message})` : r.code))
      .join("\n    ");
    const pilot = readiness.pilot;
    // Tell a refused caller the path that exists rather than let them guess — but only
    // when it exists. Advertising a pilot on a facilitator that has not opened one sends
    // them to ask for a key that would change nothing.
    const pilotHint = pilot?.enabled
      ? `\n  This facilitator is running an open PILOT: pass acceptNotPrivate:true to settle\n` +
        `  anyway. No key is needed — the pilot is open to anyone who has deposited. The flag\n` +
        `  is your acknowledgement, not a permission: the payment is permitted and DISCLOSED\n` +
        `  as not private (privacy.private will be false). It is not a privacy claim; it is\n` +
        `  how the anonymity set grows to where privacy becomes real.`
      : "";
    super(
      `zBase facilitator ${baseUrl} reports customerReady:false — it is NOT ready for customer use.\n` +
        (readiness.description ? `  ${readiness.description}\n` : "") +
        (rendered ? `  Blocking:\n    ${rendered}\n` : "") +
        `  Your payment would SUCCEED but would not be private: an anonymity set below the\n` +
        `  launch minimum means the withdrawal is linkable to the deposit. Pass\n` +
        `  allowUnready:true to proceed anyway (testing the plumbing, not the privacy).` +
        pilotHint,
    );
    this.name = "FacilitatorNotReadyError";
    this.blockingReasons = reasons;
    this.codes = reasons.map((r) => r.code).filter(Boolean);
    this.pilotAvailable = pilot?.enabled === true;
  }
}

/** Normalize whatever /supported returned into reasons. Tolerates strings (older shapes). */
function normalizeBlockingReasons(raw: unknown): FacilitatorBlockingReason[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((r) =>
    typeof r === "string"
      ? { code: r }
      : {
          code: String((r as FacilitatorBlockingReason)?.code ?? "UNKNOWN"),
          message: (r as FacilitatorBlockingReason)?.message,
          blocks: (r as FacilitatorBlockingReason)?.blocks,
        },
  );
}

/** Deposit secrets the payer keeps locally; the input to every later settle. */
export interface DepositSecrets {
  nullifier: string;
  secret: string;
  value: string; // post-fee atomic value, learned from the on-chain Deposited event
  label: string; // computed on-chain (keccak(SCOPE, nonce)); learned from the event
  commitment: string;
  /**
   * HD derivation index, present only on a SEED-DERIVED DEPOSIT
   * (`deriveForwardingNote`). It marks the note as recoverable from the seed words
   * alone (rescan the chain, re-derive index 0..N). Change notes do NOT carry an
   * index — they are keyed on their parent's secrets (`deriveChangeNote`), not on
   * the HD index space, which is what makes them collision-proof.
   */
  index?: number;
  /**
   * True when this note is recoverable without its saved copy. A seed-derived
   * deposit is recoverable (from the words); its change notes inherit it, because
   * the whole rotation chain re-derives from the root via `deriveChangeNote`. A
   * legacy random deposit is NOT recoverable and neither are its descendants — the
   * saved record is the only copy. The spend-guard reads this.
   */
  recoverable?: boolean;
}

/**
 * The change-note secrets for the note being spent, derived from its OWN secrets
 * (`deriveChangeNote`). Always succeeds — no mnemonic, no index, never null.
 *
 * Why this exists: /api/withdraw generates change-note secrets randomly unless the
 * caller supplies them, returns them exactly once, and never persists or logs them
 * (correctly — they are spend authority). A caller that dies between the response and
 * its own write loses the remainder FOREVER; ragequit needs those same secrets. That
 * cost 0.985 USDC on 2026-07-16.
 *
 * Parent-keying turns that permanent loss into a re-derivation: the change note is a
 * pure function of the note you are already holding to spend it, so a lost response is
 * recomputed, not lost. The SDK now ALWAYS supplies these, so the server never
 * randomises a change note again. Recoverability from the SEED (across a full
 * words-only restore) additionally holds whenever the note's lineage roots in a
 * seed-derived deposit — see `recoverChangeNotes`.
 */
export function nextNoteFrom(
  note: Pick<DepositSecrets, "nullifier" | "secret">,
): { nullifier: string; secret: string } {
  const c = deriveChangeNote(note);
  return { nullifier: c.nullifier, secret: c.secret };
}

/**
 * True when a note can be recovered without its saved copy — a seed-derived deposit
 * (`index` present) or any change note descended from one (`recoverable` propagated).
 * The whole rotation chain re-derives from the root via `deriveChangeNote`, so this
 * one boolean carries down the lineage. Read by the spend-guard and stamped onto each
 * change note the SDK produces.
 */
export function isNoteRecoverable(
  note: Pick<DepositSecrets, "index" | "recoverable">,
): boolean {
  return note.index !== undefined || note.recoverable === true;
}

/**
 * The RECOVERY GUARD. Refuse to spend a note whose change could be lost — asserted
 * before any note is spent, so a refusal costs nothing.
 *
 * A change note survives a crash if EITHER of these holds:
 *   - the note's lineage is seed-recoverable (`isNoteRecoverable`) — a words-only
 *     restore rebuilds the whole chain via `deriveChangeNote`, so no save is needed; OR
 *   - a persist callback is wired (`onNoteRotate`) — the change is written the instant
 *     it exists.
 *
 * With neither, a legacy random note's change lives only in the one response the server
 * hands back, and a crash between response and write locks it forever. That is the exact
 * pattern that cost 0.985 USDC, and this guard makes it impossible to run by accident.
 *
 * `unsafeAllowUnrecoverableChange` overrides it — for a caller who genuinely persists
 * `nextDeposit` from the return value themselves. Named to be unmissable in a diff.
 */
export function assertChangeRecoverable(
  note: Pick<DepositSecrets, "index" | "recoverable">,
  opts: { hasPersist: boolean; unsafe?: boolean },
): void {
  if (opts.unsafe || opts.hasPersist || isNoteRecoverable(note)) return;
  throw new Error(
    "zBase: refusing to spend — the change note would not be recoverable. This note is not " +
      "seed-derived (no recoverable lineage) and no onNoteRotate persist callback was given, so " +
      "a crash before you save the change would lock the remainder forever (this is what cost " +
      "0.985 USDC on 2026-07-16). Fix: pass onNoteRotate to persist the change note, or spend a " +
      "seed-derived note. To override deliberately, set unsafeAllowUnrecoverableChange:true and " +
      "persist nextDeposit yourself.",
  );
}

export interface PreparedDeposit {
  /** Precommitment to pass to the pool's deposit() call. */
  precommitment: string;
  /** Secrets to KEEP — value+label are filled in after the deposit tx from its event. */
  secrets: Pick<DepositSecrets, "nullifier" | "secret">;
  /** The on-chain amount to deposit (atomic USDC). */
  amountAtomic: string;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  privacy?: { method: string; pool: string; anonymitySet: number };
}

export interface SettleResult {
  settled: boolean;
  txHash?: string;
  network?: string;
  error?: string;
  pricing?: { tier: string; perSettleFeeAtomic: string; feeModel: string };
  /** Present when the recipient is a registered provider (stealth routing). */
  stealth?: { ephemeralPubkey: string; viewTag: string };
  /** Change note to use for the NEXT settle, if the deposit had leftover value. */
  nextDeposit?: DepositSecrets;
}

/**
 * Result of settlePrivatelyX402 — a STANDARD x402 payment produced from pool
 * funds. Unlike SettleResult (which pays the provider directly and yields a
 * proprietary txHash), this returns the spec `X-PAYMENT` header the caller
 * attaches to the provider request; the provider's OWN facilitator verifies +
 * broadcasts it. Interoperable with any x402 provider (Nansen, CDP, etc.).
 */
export interface SettleX402Result {
  settled: boolean;
  /**
   * Tri-state safety flag. `settled:false` alone means PROVEN unspent (safe to retry with the
   * SAME note). `settled:false, uncertain:true` means the withdrawal MAY have happened (a lost
   * response, an ambiguous post-broadcast failure, or a store-lost note already spent on-chain):
   * the note may be spent, so a caller must NOT re-pay from a different note — only retry THIS
   * settlement (idempotent on the nullifier) or inspect the chain.
   */
  uncertain?: boolean;
  /** Set with `uncertain` when the note is already spent on-chain but the settlement is unrecoverable. */
  alreadySpent?: boolean;
  error?: string;
  /** base64 `X-PAYMENT` header to send to the provider. */
  xPayment?: string;
  /** Single-use payer EOA the pool funded (no on-chain link to the depositor). */
  payer?: string;
  network?: string;
  amount?: string;
  /** Pool withdrawal that funded the payer EOA. */
  fundingTxHash?: string;
  /** Change note for the next settle. */
  nextDeposit?: DepositSecrets;
  /** Unix seconds after which the authorization is no longer valid. */
  expiresAt?: number;
  /** Present only when `url` was supplied for the one-shot provider proxy. */
  providerStatus?: number;
  providerResponse?: unknown;
  /** The facilitator's privacy verdict for THIS payment. See PaymentPrivacy. */
  privacy?: PaymentPrivacy;
}

/** One entry from a provider's 402 `accepts` array (x402 v1/v2). */
export interface X402AcceptsEntry {
  scheme: string;
  network: string;
  asset: string;
  amount?: string;
  maxAmountRequired?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; [k: string]: unknown };
}

/** A parsed 402 Payment Required (body `accepts`, or the base64 header). */
export interface X402PaymentRequired {
  x402Version?: number;
  accepts: X402AcceptsEntry[];
}

/**
 * Read the payment requirements out of a 402 response. Handles both the JSON
 * body form (`{ x402Version, accepts: [...] }`, what Nansen/CDP return) and the
 * base64 `X-PAYMENT-REQUIRED` / `PAYMENT-REQUIRED` header form. Returns null if
 * nothing parseable is present.
 */
export async function parsePaymentRequired(
  res: Response,
): Promise<X402PaymentRequired | null> {
  // Header form first (cheap, no body consumption ambiguity).
  const hdr =
    res.headers.get("x-payment-required") ??
    res.headers.get("payment-required") ??
    res.headers.get("www-payment-required");
  if (hdr) {
    try {
      const json = JSON.parse(
        typeof atob === "function"
          ? atob(hdr)
          : Buffer.from(hdr, "base64").toString("utf8"),
      );
      if (Array.isArray(json?.accepts)) return json as X402PaymentRequired;
    } catch {
      /* fall through to body */
    }
  }
  try {
    const body = await res.clone().json();
    if (Array.isArray(body?.accepts)) return body as X402PaymentRequired;
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Select the `exact`-scheme entry this facilitator can settle: matching network,
 * matching asset (if `asset` given), and carrying the EIP-712 `extra.{name,
 * version}` needed to sign transferWithAuthorization. Throws a clear error if
 * the provider offers nothing this pool can pay.
 */
export function selectExactAccepts(
  pr: X402PaymentRequired,
  network: FacilitatorNetwork,
  asset?: string,
): X402AcceptsEntry {
  const candidates = pr.accepts.filter(
    (a) =>
      (a.scheme ?? "exact") === "exact" &&
      a.network === network &&
      (!asset || a.asset?.toLowerCase() === asset.toLowerCase()) &&
      !!a.extra?.name &&
      !!a.extra?.version &&
      !!a.payTo &&
      (a.amount != null || a.maxAmountRequired != null),
  );
  if (candidates.length === 0) {
    const offered = pr.accepts
      .map((a) => `${a.scheme}@${a.network}`)
      .join(", ");
    throw new Error(
      `No payable option: this facilitator settles the "exact" scheme on ${network} with EIP-712 token metadata, but the provider offered [${offered}]. Fund a pool on the provider's network, or the provider must expose extra.{name,version}.`,
    );
  }
  return candidates[0];
}

/** Parse a Response body as JSON when it looks like JSON, else as text. */
async function readBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return await res.text().catch(() => null);
    }
  }
  return res.text().catch(() => null);
}

/** Result of a free-probe: is a seller compatible with a standard zBase payment? */
export interface ProbeResult {
  /** True = safe to pay (or free); false = do NOT spend a note. */
  compatible: boolean;
  status: "compatible" | "incompatible" | "no-payment" | "inconclusive";
  reason: string;
  /** The seller's price for the selected Base-USDC offer (atomic USDC). */
  priceAtomic?: string;
  network?: string;
}

/**
 * Proof that the seller's facilitator actually VERIFIED our (invalid) payload — i.e. it
 * parsed a standard EIP-3009 payload and rejected the bad SIGNATURE/authorization. These
 * are specific x402/CDP verifier error phrases, NOT broad words: a bespoke facilitator (Otto)
 * that ignores the header returns its generic "payment_required" and matches none of these.
 *
 * FAIL CLOSED: this is the ONLY signal that authorizes settlement. A generic 402, a
 * transient 5xx/429, a redirect, or a 200 are all treated as NOT-verified (incompatible),
 * because none of them prove the seller will honor a real payment — and spending on a
 * false positive strands the funded payer EOA. (Codex review 2026-07-20, P1 x2.)
 *
 * WHY THESE PHRASES ARE SIGNATURE-SPECIFIC, NOT "a facilitator was reached" (learned the
 * expensive way, 2026-07-22): a live pay to CoinGecko's x402 gateway settled the note but
 * did NOT deliver — CoinGecko returned the SAME generic "Facilitator validation failed:
 * Invalid payment: Facilitator returned 400 Bad Request" to a REAL, properly-signed payment
 * as it did to the invalid dummy. So "the seller blamed its facilitator" does NOT imply "a
 * valid signature would pass" — it stranded $0.01. Deliverable sellers (BlockRun, onesource)
 * instead cite the SIGNATURE specifically ("invalid signature: R is 0", "isValid:false",
 * "invalid_exact_evm_payload_signature") — an error a REAL signature clears. Do NOT broaden
 * this to match generic "validation failed / 400 / facilitator" phrasing: that reopens the
 * false-positive that spends on a seller which rejects every zBase payment.
 */
const VERIFY_HINT =
  /invalid[^"a-z]{0,4}signature|invalid_exact_evm|verif(?:y|ication)[^"]{0,16}fail|payment[^"]{0,16}(?:verification failed|is invalid)|is\s*not\s*valid|"?isValid"?[\s":]+false|insufficient[^"]{0,12}payment|exceeds allowance|R is 0/i;

/**
 * MESSAGE-ONLY — never gates spending. Matches a SELLER-SIDE x402 facilitator FAULT: the
 * seller's own facilitator errored on the payment itself (e.g. CoinGecko's "Facilitator
 * validation failed: Facilitator returned 400 Bad Request with no error"). Anchored on the
 * literal word "facilitator" + a fault token, so it does NOT match a normal signature/verify
 * rejection ("Payment verification failed", "invalid_payload") — those are the seller correctly
 * rejecting our INVALID dummy, not the facilitator breaking on a valid payment.
 */
const SELLER_FACILITATOR_FAULT =
  /facilitator[^"]{0,64}(?:returned\s*\d{3}|bad\s*request|validation\s*failed|unavailable|misconfigur|is\s*down|error)/i;

/**
 * Explain a seller error to the user/agent WHEN it is the seller's facilitator faulting, not a
 * zBase problem. Returns a plain-English explanation string, or undefined if the error is not a
 * recognizable seller-facilitator fault (in which case say nothing rather than guess). zBase
 * sends the standard exact/EIP-3009 payload that the x402 reference facilitator and other sellers
 * (onesource, BlockRun) accept, so a facilitator-fault response points at the seller. This is a
 * pure, side-effect-free classifier used ONLY for messaging — it changes no decision.
 */
export function diagnoseSellerFacilitatorFault(response: unknown): string | undefined {
  let text: string;
  try {
    text = typeof response === "string" ? response : JSON.stringify(response ?? "");
  } catch {
    return undefined;
  }
  if (!SELLER_FACILITATOR_FAULT.test(text)) return undefined;
  return (
    "SELLER-SIDE ISSUE, NOT zBase: the seller's own x402 facilitator returned an error on the " +
    "payment. zBase sends the standard exact/EIP-3009 payload that the x402 reference facilitator " +
    "and other x402 sellers (e.g. onesource, BlockRun) accept and deliver, so this is the seller's " +
    "facilitator misbehaving — not a zBase, wallet, or payment problem. Use a different x402 seller."
  );
}

/** UTF-8-safe base64 for both Node and the browser. `btoa` alone throws on non-Latin1 (支付). */
function b64encode(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * A base64 x402 payment payload with an INVALID (all-zero) signature. It can never
 * settle — the seller's facilitator rejects the signature — so sending it costs nothing,
 * but the response reveals whether the seller PARSES a standard EIP-3009 payload
 * (CDP-style → compatible) or IGNORES it (bespoke facilitator → incompatible). Built
 * from the seller's own selected `accepts` entry, including the x402 v2 `accepted` field.
 */
export function dummyX402Payload(entry: X402AcceptsEntry): string {
  const amount = String(entry.amount ?? entry.maxAmountRequired ?? "0");
  const payload = {
    x402Version: 2,
    scheme: "exact",
    network: entry.network,
    accepted: {
      scheme: "exact",
      network: entry.network,
      amount,
      asset: entry.asset,
      payTo: entry.payTo,
      maxTimeoutSeconds: entry.maxTimeoutSeconds ?? 300,
      extra: entry.extra,
    },
    payload: {
      signature: "0x" + "00".repeat(65),
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: entry.payTo,
        value: amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0x" + "00".repeat(32),
      },
    },
  };
  return b64encode(JSON.stringify(payload));
}

/** JSON.parse `s`, or return it as a string if it is not JSON. */
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Result of a private buy: the provider's data plus the rotated change note. */
export interface PrivateFetchResult {
  /**
   * Discriminated outcome — `switch` on this for exhaustive handling. NOTE a
   * PROVABLY-unspent settlement is NOT one of these: it THROWS (the note is untouched
   * and safe to retry with the same note). The three RETURNED cases:
   * - `"free"`      — resource was not 402; nothing was paid.
   * - `"delivered"` — paid AND the provider returned a 2xx. NOTE: a 2xx proves the provider
   *                   responded, not that the returned payload is correct or usable.
   * - `"settled_not_delivered"` — the note IS SPENT but the provider did not return a 2xx
   *                   (no X-PAYMENT header, network failure, 402/4xx/5xx). Money left; value did
   *                   not arrive. Do NOT re-pay from a different note — this is the seller's
   *                   failure to deliver, and the spend is already final.
   * - `"refused"`   — free-probe found a bespoke/incompatible seller; nothing paid, note untouched.
   * - `"uncertain"` — settlement outcome unconfirmed; the note MAY be spent (`safeToRetry:true`).
   */
  outcome: "free" | "delivered" | "settled_not_delivered" | "refused" | "uncertain";
  /**
   * Set to `true` only on `outcome:"uncertain"`: retrying THIS exact call is safe because
   * settlement is idempotent on the note's nullifier. NEVER pay from a DIFFERENT note.
   */
  safeToRetry?: boolean;
  /** @deprecated use `outcome` — `true` exactly when `outcome === "delivered"`. */
  paid: boolean;
  /** Final HTTP status from the provider (after payment, if any). */
  status: number;
  /** Parsed provider response body (JSON object/array, or raw text). */
  response: unknown;
  /** base64 X-PAYMENT header that was sent (present when paid). */
  xPayment?: string;
  /** Single-use payer EOA the pool funded (present when paid). */
  payer?: string;
  /** Atomic amount paid (present when paid). */
  amount?: string;
  /** Pool withdrawal that funded the payer EOA (present when paid). */
  fundingTxHash?: string;
  /** Change note for the NEXT buy. Reuse it (createPrivateFetch does this for you). */
  nextDeposit?: DepositSecrets;
  /**
   * Whether this payment was actually PRIVATE, per the facilitator.
   *
   * Check `privacy.private` before you rely on privacy. A pilot payment succeeds exactly
   * like a private one — same proof, same fresh payer EOA, same provider response — and
   * differs only here. Undefined from a facilitator too old to publish it.
   */
  privacy?: PaymentPrivacy;
  /** Set when the free-probe ran: is the seller compatible with a standard payload? */
  compatible?: boolean;
  /** Why the probe refused (present when `paid:false` and `compatible:false`). */
  probeReason?: string;
  /**
   * MESSAGE-ONLY. Set when the seller's OWN x402 facilitator faulted on a standard, spec-correct
   * payment (e.g. CoinGecko's "Facilitator returned 400 Bad Request"). Surfaces "this is the
   * seller's fault, not zBase" to the user/agent. Never affects a spend/compatibility decision.
   */
  sellerFault?: string;
  /** @deprecated use `outcome === "uncertain"` (+ `safeToRetry`). Kept for back-compat. */
  uncertain?: boolean;
}

/**
 * Plan for callPrivately: release funds from the pool DIRECTLY into a whitelisted
 * contract call (e.g. an ERC-4626 vault deposit) from an unlinked position. The
 * server binds (target, callData, minOut, recipient) into the withdrawal `context`
 * so neither the relayer nor anyone else can alter the plan. Privacy = unlinkability
 * of WHO funded the call; the call itself is public on-chain. See the zBase threat model.
 */
export interface CallPlan {
  /** Whitelisted contract to call (must be on the executor's frozen whitelist). */
  target: string;
  /** The pool asset spent into the call (USDC). */
  inputToken: string;
  /** Token the call yields (vault shares / swap output). */
  outputToken: string;
  /** Slippage floor on the produced outputToken delta (atomic). */
  minOut: string | bigint;
  /** Who receives the outputToken. */
  recipient: string;
  /** Exact calldata for the target (0x-hex). Its selector must be whitelisted. */
  callData: string;
}

export interface CallResult {
  executed: boolean;
  txHash?: string;
  network?: string;
  error?: string;
  pricing?: { tier: string; perSettleFeeAtomic: string; feeModel: string };
  nextDeposit?: DepositSecrets;
}

/** Public CDP x402 bazaar discovery endpoint (same one the awal CLI searches). */
export const DEFAULT_BAZAAR_DISCOVERY_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

/** Raw bazaar item shape (tolerant — the catalog is third-party). */
interface RawBazaarItem {
  resource?: string;
  serviceName?: string;
  description?: string;
  tags?: string[];
  lastUpdated?: string;
  accepts?: Array<{
    scheme?: string;
    network?: string;
    amount?: string;
    maxAmountRequired?: string;
    asset?: string;
    payTo?: string;
    recipient?: string;
    extra?: { name?: string; version?: string; [k: string]: unknown };
  }>;
}

/** A discoverable x402 API — hand `resource` + an `accepts` entry to payAndFetch. */
export interface DiscoveredResource {
  resource: string;
  serviceName?: string;
  description?: string;
  tags?: string[];
  lastUpdated?: string;
  accepts: Array<{
    scheme: string;
    network: string;
    amount?: string;
    asset?: string;
    payTo?: string;
    extra?: { name?: string; version?: string; [k: string]: unknown };
  }>;
}

export class FacilitatorClient {
  private readonly base: string;
  private readonly network: FacilitatorNetwork;
  private readonly doFetch: typeof fetch;
  /** Cached /supported readiness — a launch gate, not per-payment state. */
  #readiness?: FacilitatorReadiness;
  /** Client-level acknowledgement that pilot payments are not private. */
  readonly #acceptNotPrivate: boolean = false;

  constructor(cfg: FacilitatorClientConfig = {}) {
    // Default to the public zBase facilitator on Base mainnet so the SDK works
    // with zero config. Override baseUrl/network to point elsewhere.
    const base = cfg.baseUrl ?? DEFAULT_FACILITATOR_URL;
    // CRITICAL C3 fix (2026-07-09): validate baseUrl BEFORE any secret is sent to
    // it. settlePrivately transmits the deposit spend secrets; an http:// or
    // malformed baseUrl would leak them to an on-path attacker → fund theft.
    assertSafeFacilitatorBaseUrl(base, cfg.allowInsecureHttp ?? false);
    this.base = base.replace(/\/$/, "");
    this.network = cfg.network ?? "eip155:8453";
    const f = cfg.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) throw new Error("FacilitatorClient: no fetch available — pass fetchImpl.");
    this.doFetch = f;
    this.#acceptNotPrivate = cfg.acceptNotPrivate === true;
  }

  /**
   * Step 1 (one-time): prepare a deposit. Returns the precommitment to send to the
   * pool's on-chain deposit() and the secrets to keep. After the deposit tx mines,
   * read its Deposited event to fill in `value` (post-fee) + `label`, producing a
   * full DepositSecrets you pass to settlePrivately.
   *
   * Pure/local — no network call. Uses the same secret derivation the rest of the
   * stack uses (account.ts), so the resulting commitment matches the circuit.
   */
  prepareDeposit(amountAtomic: string | bigint): PreparedDeposit {
    // generateDepositSecrets() returns decimal strings; computePrecommitment takes
    // + returns strings (account.ts). Keep everything as strings end-to-end.
    const { nullifier, secret } = generateDepositSecrets();
    const precommitment = computePrecommitment(nullifier, secret);
    return {
      precommitment,
      secrets: { nullifier, secret },
      amountAtomic: amountAtomic.toString(),
    };
  }

  /**
   * Step 2 (per payment): can this payment settle? Mirrors POST /api/facilitator/verify.
   */
  async verifyPayment(args: {
    payTo: string;
    amountAtomic: string | bigint;
    deposit?: DepositSecrets;
  }): Promise<VerifyResult> {
    const res = await this.doFetch(`${this.base}/api/facilitator/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentDetails: {
          scheme: "exact",
          networkId: this.network,
          payTo: args.payTo,
          maxAmountRequired: args.amountAtomic.toString(),
        },
        ...(args.deposit ? { zbaseDeposit: args.deposit } : {}),
      }),
    });
    return (await res.json()) as VerifyResult;
  }

  /**
   * Step 3 (per payment): execute the private payment. Mirrors POST
   * /api/facilitator/settle. The pool pays `payTo` (or a fresh stealth address if
   * payTo is a registered provider) from the anonymity set; there is no on-chain
   * link to the payer's wallet. Returns the tx + any change note for the next settle.
   *
   * NOTE (client-side proving roadmap): today the proof is generated server-side
   * inside /settle, so the deposit secrets are sent to the facilitator. The
   * privacy-maximal version generates the proof HERE with proofs.ts
   * (generateWithdrawalProof) and sends only the proof + public signals, so secrets
   * never leave the caller. That requires browser-portable wasm/zkey loading; until
   * then this client uses the server-proving path. The API surface below does NOT
   * change when that lands — callers keep calling settlePrivately().
   */
  async settlePrivately(args: {
    payTo: string;
    amountAtomic: string | bigint;
    deposit: DepositSecrets;
    agentId?: string;
  }): Promise<SettleResult> {
    const res = await this.doFetch(`${this.base}/api/facilitator/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentDetails: {
          scheme: "exact",
          networkId: this.network,
          payTo: args.payTo,
          maxAmountRequired: args.amountAtomic.toString(),
        },
        zbaseDeposit: args.deposit,
        ...(args.agentId ? { agentId: args.agentId } : {}),
      }),
    });
    return (await res.json()) as SettleResult;
  }

  /**
   * Step 3, STANDARD-provider variant: settle privately for ANY x402 provider
   * (Nansen, or anything on the CDP facilitator) — not just zBase-aware servers.
   * Mirrors POST /api/facilitator/settle-x402.
   *
   * The pool funds a fresh single-use EOA which signs a standard EIP-3009
   * `exact` authorization; the returned `xPayment` is the base64 `X-PAYMENT`
   * header the caller attaches to the provider request. The provider's own
   * facilitator verifies + broadcasts it. No on-chain link to the depositor.
   *
   * `accepts` is one entry from the provider's 402 `accepts` array (must be the
   * `exact` scheme on this pool's network/asset, with `extra.{name,version}`).
   * Pass `url` (+ optional method/body/headers) to have the facilitator proxy
   * the paid request in one round trip and return the provider's response.
   */
  async settlePrivatelyX402(args: {
    /** One `exact`-scheme entry from the provider's 402 (needs extra.{name,version}). */
    accepts: X402AcceptsEntry;
    deposit: DepositSecrets;
    x402Version?: number;
    url?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<SettleX402Result> {
    // ALWAYS supply the change secrets, derived from the note being spent
    // (deriveChangeNote). The server never randomises a change note again, so a lost
    // response is a re-derivation, not a loss. No mnemonic needed — the change is a
    // pure function of this note's own secrets.
    const next = nextNoteFrom(args.deposit);
    const payload = JSON.stringify({
      accepts: args.accepts,
      zbaseDeposit: args.deposit,
      nextNullifier: next.nullifier,
      nextSecret: next.secret,
      ...(args.x402Version ? { x402Version: args.x402Version } : {}),
      ...(args.url ? { url: args.url } : {}),
      ...(args.method ? { method: args.method } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.headers ? { headers: args.headers } : {}),
    });

    // settle-x402 is IDEMPOTENT on this note's nullifier (server keys the withdrawal on it),
    // so a network error or a 409 "in-flight" is SAFELY retryable: the server never withdraws
    // twice, and a retry re-serves the stored payment header. This is what turns a lost
    // settle response from a double-pay into a re-derivation. First try + 3 backoff retries.
    const backoffs = [0, 1500, 4000, 8000];
    let lastErr = "no response";
    for (let i = 0; i < backoffs.length; i++) {
      if (backoffs[i]) await new Promise((r) => setTimeout(r, backoffs[i]));
      let res: Response;
      try {
        res = await this.doFetch(`${this.base}/api/facilitator/settle-x402`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e); // network failure — retry (idempotent)
        continue;
      }
      if (res.status === 409) {
        lastErr = "settlement in progress (409)"; // a prior attempt is mid-withdrawal — poll
        continue;
      }
      const result = (await res.json().catch(() => null)) as SettleX402Result | null;
      if (!result) {
        // A parseable body is required to trust the outcome. An unparseable 5xx tells us NOTHING
        // about whether the note was spent — treat it as uncertain and retry (idempotent), never
        // return it as a proven no-op.
        lastErr = `unparseable settle response (HTTP ${res.status})`;
        continue;
      }
      // A server-declared UNCERTAIN outcome (ambiguous post-broadcast failure, or a note already
      // spent on-chain with no record). The note MAY be spent — keep retrying the idempotent
      // settlement to replay/resolve it; do NOT return it as a proven-unspent no-op.
      if (result.settled === false && result.uncertain) {
        lastErr = result.error ?? "settlement uncertain (server)";
        continue;
      }
      // Propagate recoverability down the lineage (guarded — a malformed nextDeposit must not
      // throw after the note was spent; it is also parent-key recoverable from args.deposit).
      if (result.nextDeposit && typeof result.nextDeposit === "object") {
        result.nextDeposit.recoverable = isNoteRecoverable(args.deposit);
      }
      // Either settled:true (replay-safe header) or a PROVEN settled:false (400/503 — note
      // definitively unspent, safe to retry with the same note). Return it.
      return result;
    }
    // Exhausted retries without a definitive outcome. The settlement is UNCERTAIN — the server may
    // have withdrawn. It is idempotent on the note, so RETRYING THE WHOLE CALL is safe (it replays
    // the header if it withdrew, or withdraws fresh if it didn't) — but the caller must NOT pay
    // from a DIFFERENT note. Flag uncertain so payAndFetch does not report a false "unspent".
    return {
      settled: false,
      uncertain: true,
      error: `settlement uncertain after retries — retry THIS settlement (idempotent on the note); do not re-pay from another note: ${lastErr}`,
    };
  }

  /**
   * ONE-CALL PRIVATE BUY. Point it at any standard x402 provider and it runs the
   * whole loop: request → 402 → pick the payable `exact` option → settle
   * privately from your pool note → retry with the standard `X-PAYMENT` header →
   * return the provider's data. The provider is paid by a single-use EOA funded
   * from the pool, so there is no on-chain link to your deposit.
   *
   * The provider's response is fetched by the SDK (this machine), not the
   * facilitator — only the PAYMENT goes through zBase. The spend secrets do go to
   * the facilitator baseUrl (server-side proving); pin baseUrl to a host you trust.
   *
   * @returns the provider data + `nextDeposit` (the change note) to reuse. For
   *          repeated buys that rotate the note automatically, use createPrivateFetch.
   */
  async payAndFetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    opts: {
      deposit: DepositSecrets;
      /** Refuse to pay more than this (atomic USDC) — guards against a hostile 402. */
      maxAmountAtomic?: string | bigint;
      /** Restrict which token to pay in (defaults to any USDC on the network). */
      asset?: string;
      /**
       * Persist the change note the instant it exists. Required UNLESS the note is
       * recoverable (a seed-derived deposit or its descendant) or you set
       * `unsafeAllowUnrecoverableChange`. See the spend-guard.
       */
      onNoteRotate?: (next: DepositSecrets) => void | Promise<void>;
      /**
       * Pay even when the facilitator reports customerReady:false.
       *
       * The payment works either way — that is the danger. A closed facilitator means
       * the anonymity set is below its launch minimum, so the withdrawal IS linkable
       * to the deposit: you would pay and get no privacy, silently. Set this only when
       * you are deliberately testing the plumbing.
       */
      allowUnready?: boolean;
      /**
       * Acknowledge that this payment will NOT be private, and make it anyway. Overrides
       * the client-level `acceptNotPrivate`. See FacilitatorClientConfig.
       */
      acceptNotPrivate?: boolean;
      /**
       * Escape the recovery guard: spend a non-recoverable note with no persistence.
       * The change note would then be lost on a crash. You own that risk. See the guard.
       */
      unsafeAllowUnrecoverableChange?: boolean;
      /**
       * Skip the pre-settlement free-probe (default: probe). The probe costs nothing (a
       * 402 read + an invalid-signature dummy that never settles) and refuses BEFORE
       * spending a note if the seller runs a bespoke facilitator that would settle but
       * not deliver. Only skip for a seller you have already proven.
       */
      skipProbe?: boolean;
    },
  ): Promise<PrivateFetchResult> {
    // Ask BEFORE the provider request: a closed facilitator should cost the caller
    // nothing, not a 402 round-trip and a note selection first.
    await this.#assertReady(opts.allowUnready, opts.acceptNotPrivate ?? this.#acceptNotPrivate);
    // The RECOVERY guard, also before spending. A refusal must cost nothing.
    assertChangeRecoverable(opts.deposit, {
      hasPersist: Boolean(opts.onNoteRotate),
      unsafe: opts.unsafeAllowUnrecoverableChange,
    });
    const first = await this.doFetch(url, init);
    if (first.status !== 402) {
      // Free (or an error) — no payment needed. Return the body as-is.
      return { paid: false, outcome: "free", status: first.status, response: await readBody(first) };
    }

    const pr = await parsePaymentRequired(first);
    if (!pr) {
      throw new Error(
        `Provider returned 402 but no parseable x402 payment requirements (checked JSON body + payment-required header).`,
      );
    }
    const entry = selectExactAccepts(pr, this.network, opts.asset);
    const amount = (entry.amount ?? entry.maxAmountRequired)!;
    if (opts.maxAmountAtomic != null && BigInt(amount) > BigInt(opts.maxAmountAtomic)) {
      throw new Error(
        `Provider wants ${amount} atomic but maxAmountAtomic is ${opts.maxAmountAtomic}. Refusing to pay.`,
      );
    }

    // FREE-PROBE (default, ADVISORY). zBase settles — funds a payer EOA via a ZK withdrawal —
    // BEFORE the seller delivers, so a seller that won't honor a standard EIP-3009 payload
    // (a bespoke facilitator like Otto) would leave the note spent and stranded. An
    // invalid-signature dummy never settles, so this refuses for free when the seller clearly
    // did NOT verify a standard payload.
    //
    // It is BEST-EFFORT, not a money-safety guarantee: the compatibility signal is a
    // heuristic over the seller's error response, so it can (a) miss a real verifier that
    // uses unusual wording — fail closed, blocking a valid pay — or (b) pass a seller that
    // emits verify-like prose without truly verifying. Case (b) is not a regression: it costs
    // exactly what paying WITHOUT a probe would (the note is spent, funds strand at the payer
    // EOA), so the probe never makes things worse — it only saves the obvious bespoke case.
    // Real money-safety lives in the settlement layer (note spent only on settled:true; change
    // seed-recoverable; settlement idempotency). `skipProbe` bypasses it for a proven seller.
    if (!opts.skipProbe) {
      const { compatible, body } = await this.#dummyProbe(url, init, entry);
      if (!compatible) {
        // Message-only: distinguish a seller whose facilitator FAULTED (CoinGecko-class) from one
        // that simply ignored a standard payload (bespoke). Both stay REFUSED — this only changes
        // what we tell the caller. Funds are untouched either way (refused before settling).
        const sellerFault = diagnoseSellerFacilitatorFault(body);
        return {
          paid: false,
          outcome: "refused",
          compatible: false,
          status: 402,
          response: safeJson(body),
          ...(sellerFault ? { sellerFault } : {}),
          probeReason: sellerFault
            ? `${sellerFault} Refused before spending — note untouched. Pass skipProbe:true to override.`
            : "seller did not verify a standard X-PAYMENT/Payment-Signature payload (advisory) " +
              "— likely a bespoke facilitator. Note untouched. Pass skipProbe:true to override.",
        };
      }
    }

    const settle = await this.settlePrivatelyX402({
      accepts: entry,
      deposit: opts.deposit,
      x402Version: pr.x402Version,
    });
    // Tri-state. `settled:false, uncertain:true` means the note MAY be spent (a lost/ambiguous
    // settlement, or a note already spent on-chain with no record). Throwing "note unspent" here
    // would invite the caller to re-pay from the change note — a double-pay. Return a distinct
    // NON-throwing result instead: paid:false, uncertain:true, so the caller retries THIS
    // settlement (idempotent) or inspects the chain, but never blindly pays from another note.
    if (!settle.settled && settle.uncertain) {
      return {
        paid: false,
        outcome: "uncertain",
        uncertain: true,
        safeToRetry: true,
        status: 0,
        response: {
          error:
            "settlement uncertain — the note may already be spent. Do NOT re-pay from a different note. " +
            "Retry this exact payment (idempotent on the note) or check the chain. " +
            (settle.error ?? ""),
        },
      };
    }
    // A PROVEN settled:false (400/503 — the withdrawal did NOT happen). The note is unspent and
    // safe to retry with the same note.
    if (!settle.settled) {
      throw new Error(`Private settlement failed (note unspent): ${settle.error ?? "unknown error"}`);
    }

    // settled:true means the note IS SPENT. From here NOTHING may throw out of payAndFetch —
    // a caller catching a throw would report "note unspent, retry safe" and could pay AGAIN
    // from the change note. Everything below returns paid:true. (Codex P1: throw-after-settle.)
    // NOTE: this only covers a settled:true RESPONSE. A settlePrivatelyX402 that spends the
    // note server-side but whose HTTP response is lost still throws above with an ambiguous
    // "unspent" — closing that needs an idempotent settlement-status endpoint (tracked).
    // `settledBase` describes SETTLEMENT ONLY — the note is spent. It deliberately carries NO
    // `outcome`: delivery is not known until the provider responds, and every return site below
    // must decide between "delivered" (2xx) and "settled_not_delivered" (anything else).
    // Previously this hardcoded outcome:"delivered", so a 500 from the seller still reported
    // "delivered" — the exact claim this product sells. (2026-08-03)
    const settledBase = {
      paid: true as const,
      compatible: true as const,
      xPayment: settle.xPayment,
      payer: settle.payer,
      amount: settle.amount ?? amount,
      fundingTxHash: settle.fundingTxHash,
      nextDeposit: settle.nextDeposit,
      // The facilitator's privacy verdict for THIS payment (pilot payments look identical to
      // private ones and differ only here — surface it so the caller can act on it).
      privacy: settle.privacy,
    };

    // Persist the change note. A failed save must NOT throw (the note is already spent), and
    // the change is parent-key recoverable from opts.deposit anyway — a lost save costs a
    // re-derive, not funds.
    if (settle.nextDeposit && opts.onNoteRotate) {
      try {
        await opts.onNoteRotate(settle.nextDeposit);
      } catch {
        /* recoverable from seed — never fail a settled payment on a persist error */
      }
    }

    // Settled but no payment header: the note is spent and we cannot pay the provider.
    if (!settle.xPayment) {
      // Note spent, provider never even called: settled, definitively not delivered.
      return {
        ...settledBase,
        outcome: "settled_not_delivered" as const,
        status: 0,
        response: { error: "settled, but the facilitator returned no X-PAYMENT header — the note IS spent" },
      };
    }
    const xPayment = settle.xPayment;

    // Retry the SAME request with BOTH transport headers: X-PAYMENT (x402 v1, e.g. BlockRun)
    // and Payment-Signature (x402 v2 transport, e.g. Nansen, which IGNORES X-PAYMENT). Same
    // base64 payload; the seller reads whichever it supports. Re-send with backoff on a
    // post-settlement 402 (the seller's facilitator may verify the payer balance against a
    // node that lags our just-confirmed withdrawal). The single-use EIP-3009 nonce means the
    // retry cannot double-charge; the loop stops at the first non-402 to avoid repeating a
    // non-idempotent provider POST.
    const sendPaid = () =>
      this.doFetch(url, { ...init, headers: { ...(init.headers ?? {}), "X-PAYMENT": xPayment, "Payment-Signature": xPayment } });
    let status: number;
    let response: unknown;
    try {
      let paidRes = await sendPaid();
      for (const delay of [3000, 6000]) {
        if (paidRes.status !== 402) break;
        await new Promise((r) => setTimeout(r, delay));
        paidRes = await sendPaid();
      }
      status = paidRes.status;
      response = await readBody(paidRes);
    } catch (e) {
      // Settled, but the provider request/read failed — note IS spent. Never rethrow. Extract
      // the message with a FULLY guarded conversion: a rejection need not be an Error, and even
      // String(e) can throw (Object.create(null), a throwing toString), which would re-escape
      // the catch (Codex P1). Fall back to a fixed message that never touches the rejection.
      let msg = "unknown error";
      try {
        const m = e instanceof Error ? e.message : String(e);
        if (typeof m === "string") msg = m;
      } catch {
        /* keep the fixed default */
      }
      status = 0;
      response = { error: `settled, but the provider request failed after payment: ${msg.slice(0, 200)}` };
    }

    // Delivery is decided HERE, by the provider's actual response — never assumed at settlement.
    // 2xx => delivered; anything else (incl. status 0 from a post-payment network failure) means
    // the money left and the value did not arrive.
    const deliveredOk = status >= 200 && status < 300;
    const outcome: "delivered" | "settled_not_delivered" = deliveredOk
      ? "delivered"
      : "settled_not_delivered";
    return { ...settledBase, outcome, status, response };
  }

  /**
   * Send an invalid-signature dummy payment for `entry` and report whether the seller
   * PARSED it (compatible — CDP-style verify reached) or IGNORED it (bespoke facilitator).
   * The dummy can never settle, so this costs nothing.
   */
  async #dummyProbe(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    entry: X402AcceptsEntry,
  ): Promise<{ compatible: boolean; body: string }> {
    const dummy = dummyX402Payload(entry);
    const res = await this.doFetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), "X-PAYMENT": dummy, "Payment-Signature": dummy },
    });
    const body = await res.text().catch(() => "");
    // FAIL CLOSED. Compatible ONLY when the seller rejected our dummy the way a real payment
    // verifier does: a 402/400 (payment-required / bad-request) carrying a specific
    // verifier-error signal. Gating on STATUS as well as the body closes the fail-open holes
    // Codex reproduced — a 500 "upstream payment verification failed" or a 200
    // {"isValid":false} matched the body regex alone and would have spent the note. Real CDP
    // sellers (BlockRun, Nansen) reject the dummy with 402 + a verify error, so this keeps
    // them compatible while refusing anything that did not demonstrably verify.
    const verifierStatus = res.status === 402 || res.status === 400;
    return { compatible: verifierStatus && VERIFY_HINT.test(body), body };
  }

  /**
   * Free-probe an x402 seller WITHOUT spending. Reads its 402 (never charges) and sends
   * an invalid-signature dummy (never settles) to learn whether a real pay would deliver:
   * does it offer Base-USDC exact/EIP-3009, and does it PARSE a standard payload (CDP →
   * compatible) or IGNORE it (bespoke → incompatible). Because zBase settles BEFORE the
   * seller delivers, probe an unknown seller before `payAndFetch` (which does this for
   * you by default).
   */
  async probe(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    opts: { asset?: string } = {},
  ): Promise<ProbeResult> {
    let first: Response;
    try {
      first = await this.doFetch(url, init);
    } catch (e) {
      return { compatible: false, status: "inconclusive", reason: `probe request failed: ${(e as Error).message.slice(0, 120)}` };
    }
    if (first.status !== 402) {
      return { compatible: true, status: "no-payment", reason: `endpoint returned ${first.status}, not 402 (free or non-x402)` };
    }
    const pr = await parsePaymentRequired(first).catch(() => null);
    if (!pr?.accepts?.length) {
      return { compatible: false, status: "incompatible", reason: "402 with no parseable x402 payment requirements" };
    }
    let entry: X402AcceptsEntry;
    try {
      entry = selectExactAccepts(pr, this.network, opts.asset);
    } catch (e) {
      return { compatible: false, status: "incompatible", reason: (e as Error).message.slice(0, 200) };
    }
    const priceAtomic = String(entry.amount ?? entry.maxAmountRequired);
    const { compatible, body } = await this.#dummyProbe(url, init, entry).catch(() => ({ compatible: false, body: "" }));
    if (compatible) {
      return { compatible: true, status: "compatible", reason: "seller parses a standard EIP-3009 payload (CDP-style verify reached)", priceAtomic, network: entry.network };
    }
    // Message-only: if the seller's facilitator FAULTED on the payment (CoinGecko-class), say so —
    // it is the seller's issue, not zBase. Otherwise it is a bespoke seller that ignored the payload.
    const sellerFault = diagnoseSellerFacilitatorFault(body);
    return {
      compatible: false,
      status: "incompatible",
      reason: sellerFault
        ? `${sellerFault} Your funds are untouched (refused before spending).`
        : "seller ignored a standard X-PAYMENT/Payment-Signature payload — bespoke facilitator; would settle but not deliver",
      priceAtomic,
      network: entry.network,
    };
  }

  /**
   * Stateful convenience: returns a `fetch`-like function bound to a pool note
   * that PAYS PRIVATELY on any 402 and AUTO-ROTATES to the change note between
   * calls, so an agent can make repeated private buys with one line of setup:
   *
   *   const buy = zbase.createPrivateFetch({ deposit, maxAmountAtomic: 100000n });
   *   const a = await buy("https://api.provider.ai/x", { method: "POST", body });
   *   const b = await buy("https://api.provider.ai/y");   // uses the change note
   *
   * Pass `mnemonic` and the change note is derived from your seed — recoverable, so
   * a crash costs a retry instead of the remaining balance. Without it the change
   * note is random and `onNoteRotate` is your ONLY chance to keep it.
   */
  createPrivateFetch(opts: {
    deposit: DepositSecrets;
    maxAmountAtomic?: string | bigint;
    asset?: string;
    /**
     * Persist the rotated change note. Called and AWAITED before the pointer advances.
     * A throwing save does NOT fail the call: by then the note is already spent, and
     * failing would invite the caller to re-pay from a different note (a double-spend)
     * to protect a change note that is parent-key recoverable from the seed. Read
     * `nextDeposit` off the result to re-persist. Optional only when the note is
     * recoverable (seed-derived lineage); otherwise the spend-guard requires it.
     */
    onNoteRotate?: (next: DepositSecrets) => void | Promise<void>;
    /** Pay even when the facilitator reports customerReady:false. See payAndFetch. */
    allowUnready?: boolean;
    /**
     * Acknowledge that these payments will NOT be private. Every result from the returned
     * fetch carries `privacy.private:false` — check it. See payAndFetch.
     */
    acceptNotPrivate?: boolean;
    /** Escape the recovery guard. See payAndFetch — you own the loss if you set it. */
    unsafeAllowUnrecoverableChange?: boolean;
    /** Skip the pre-settlement free-probe (default: probe). See payAndFetch. */
    skipProbe?: boolean;
  }): (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<PrivateFetchResult> {
    let current: DepositSecrets | undefined = opts.deposit;
    return async (url, init = {}) => {
      if (!current) {
        throw new Error(
          "No spendable note left. The last buy consumed the note without change; deposit more USDC.",
        );
      }
      const r = await this.payAndFetch(url, init, {
        deposit: current,
        maxAmountAtomic: opts.maxAmountAtomic,
        asset: opts.asset,
        allowUnready: opts.allowUnready,
        acceptNotPrivate: opts.acceptNotPrivate,
        onNoteRotate: opts.onNoteRotate,
        unsafeAllowUnrecoverableChange: opts.unsafeAllowUnrecoverableChange,
        skipProbe: opts.skipProbe,
      });
      if (r.paid) {
        // payAndFetch already persisted the change note (persist-first) and stamped its
        // `recoverable` flag — no HD index to re-stamp, which is what removed the
        // deposit/change index collision. Here we only advance the rotation pointer.
        current = r.nextDeposit; // may be undefined when the note is fully spent
      }
      return r;
    };
  }

  /**
   * Private-funded DeFi access: release pool funds DIRECTLY into a whitelisted
   * contract call from an unlinked position. Mirrors POST /api/facilitator/call.
   *
   * The server generates the ZK withdrawal proof, binds the ENTIRE call plan
   * (target, callData, minOut, recipient) into the proof's `context`, and submits
   * via the ExecutorProcessooor (NOT the plain relay path). The executor re-derives
   * the context on-chain and reverts on any mismatch, so the relayer is trustless.
   *
   * Privacy note: this hides WHO funded the call, not WHAT the call does. The
   * on-chain call (e.g. a swap or a vault deposit) is public. Do not market as
   * "private trading" — see the threat model.
   */
  async callPrivately(args: {
    plan: CallPlan;
    amountAtomic: string | bigint;
    deposit: DepositSecrets;
    agentId?: string;
  }): Promise<CallResult> {
    const res = await this.doFetch(`${this.base}/api/facilitator/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        networkId: this.network,
        amountAtomic: args.amountAtomic.toString(),
        callPlan: {
          target: args.plan.target,
          inputToken: args.plan.inputToken,
          outputToken: args.plan.outputToken,
          minOut: args.plan.minOut.toString(),
          recipient: args.plan.recipient,
          callData: args.plan.callData,
        },
        zbaseDeposit: args.deposit,
        ...(args.agentId ? { agentId: args.agentId } : {}),
      }),
    });
    return (await res.json()) as CallResult;
  }

  /** Discovery: what the facilitator accepts (networks, tokens, pricing). */
  async supported(): Promise<unknown> {
    const res = await this.doFetch(`${this.base}/api/facilitator/supported`);
    return res.json();
  }

  /**
   * Ask the facilitator whether it is open for customer use, and refuse to pay if it
   * says no.
   *
   * Why this exists: the facilitator publishes `customerReady:false` with its reasons,
   * but nothing enforced it. `settle-x402` is not readiness-gated, so a payment made
   * against a closed facilitator SUCCEEDS — the buyer gets their data, believes they
   * paid privately, and did not. The deployment was telling the truth and the SDK was
   * never asking. A privacy product that is silently not private is worse than one
   * that is honestly unavailable.
   *
   * Cached per client: the answer changes on the order of days (a launch gate), not
   * per payment, and re-fetching it on every buy would add a round-trip to the hot
   * path for no new information.
   */
  async readiness(): Promise<FacilitatorReadiness> {
    if (this.#readiness) return this.#readiness;
    const raw = (await this.supported()) as
      | {
          customerReady?: unknown;
          blockingReasons?: unknown;
          description?: unknown;
          pilot?: { enabled?: unknown; anonymitySet?: unknown; minimumForPrivacy?: unknown; howToJoin?: unknown };
        }
      | null;
    // Absent field => assume OPEN. Older deployments predate the gate entirely, and
    // treating "no answer" as "closed" would brick every one of them.
    this.#readiness = {
      customerReady: raw?.customerReady !== false,
      blockingReasons: normalizeBlockingReasons(raw?.blockingReasons),
      description: typeof raw?.description === "string" ? raw.description : undefined,
      // `enabled === true` only: an older facilitator has no `pilot` block at all, and a
      // truthy-coerced absent field would tell callers a pilot exists where none does.
      pilot: raw?.pilot
        ? {
            enabled: raw.pilot.enabled === true,
            anonymitySet: typeof raw.pilot.anonymitySet === "number" ? raw.pilot.anonymitySet : null,
            minimumForPrivacy:
              typeof raw.pilot.minimumForPrivacy === "number" ? raw.pilot.minimumForPrivacy : undefined,
            howToJoin: typeof raw.pilot.howToJoin === "string" ? raw.pilot.howToJoin : null,
          }
        : undefined,
    };
    return this.#readiness;
  }

  /**
   * Throws FacilitatorNotReadyError unless the facilitator is customer-ready or the caller
   * has explicitly accepted a not-private payment.
   *
   * `acceptNotPrivate` suppresses the throw and asserts NOTHING about privacy — the
   * facilitator still decides, and its response carries `privacy.private:false`. This is
   * the only thing standing between "I wired in zBase for privacy" and silently getting
   * none, so it is deliberately a decision the caller has to make in their own code.
   */
  async #assertReady(allowUnready?: boolean, acceptNotPrivate?: boolean): Promise<void> {
    if (allowUnready || acceptNotPrivate) return;
    const r = await this.readiness();
    if (!r.customerReady) throw new FacilitatorNotReadyError(r, this.base);
  }

  /**
   * Find sellable x402 APIs in the public x402 bazaar (CDP discovery). Fetches the
   * bazaar catalog and filters by `query` across service name / description /
   * resource URL / tags. Returns normalized entries a buyer can hand straight to
   * payAndFetch (resource URL + the accepts to pay).
   *
   * @param query free-text filter; "" or omitted returns everything (capped by pages).
   */
  async discover(query = "", opts?: { url?: string; limit?: number; maxPages?: number }): Promise<DiscoveredResource[]> {
    const base = opts?.url ?? DEFAULT_BAZAAR_DISCOVERY_URL;
    const limit = opts?.limit ?? 1000;
    const maxPages = opts?.maxPages ?? 5;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out: DiscoveredResource[] = [];

    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    for (let page = 0; page < maxPages && offset < total; page++) {
      const u = new URL(base);
      u.searchParams.set("type", "http");
      u.searchParams.set("limit", String(limit));
      u.searchParams.set("offset", String(offset));
      const res = await this.doFetch(u.toString(), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`bazaar discovery HTTP ${res.status}`);
      const body = (await res.json()) as { items?: RawBazaarItem[]; pagination?: { total?: number } };
      const items = body.items ?? [];
      total = Number(body.pagination?.total ?? items.length);
      for (const it of items) {
        const hay = `${it.serviceName ?? ""} ${it.description ?? ""} ${it.resource ?? ""} ${(it.tags ?? []).join(" ")}`.toLowerCase();
        if (terms.length > 0 && !terms.every((t) => hay.includes(t))) continue;
        const accepts = (it.accepts ?? []).map((a) => ({
          scheme: a.scheme ?? "exact",
          network: a.network ?? "",
          amount: a.amount ?? a.maxAmountRequired,
          asset: a.asset,
          payTo: a.payTo ?? a.recipient,
          extra: a.extra,
        }));
        out.push({
          resource: it.resource ?? "",
          serviceName: it.serviceName,
          description: it.description,
          tags: it.tags,
          lastUpdated: it.lastUpdated,
          accepts,
        });
      }
      if (items.length < limit) break;
      offset += limit;
    }
    return out;
  }

  /**
   * The on-chain deposit config (USDC + entrypoint + pool + deploy block) for
   * THIS client's network. Everything an SDK consumer needs to build the pool
   * deposit() call themselves. Static (the live deployed addresses) — no network
   * call. Pass the mainnet network at construction to get mainnet addresses:
   *
   *   const c = createFacilitatorClient({ baseUrl: "https://zbase.app",
   *                                       network: "eip155:8453" });
   *   const { entrypoint, asset } = c.getDepositConfig();  // Base mainnet
   */
  getDepositConfig(): DepositConfig {
    return depositConfigFor(this.network);
  }
}

/** Convenience factory. */
export function createFacilitatorClient(cfg?: FacilitatorClientConfig): FacilitatorClient {
  return new FacilitatorClient(cfg);
}
