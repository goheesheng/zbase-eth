/**
 * POST /api/transfer  —  shielded-to-shielded UTXO note transfer.
 *
 * Phase 1B counterpart to `src/app/api/withdraw/route.ts:handleUtxoSpend`.
 * The difference between the two routes is intentionally narrow:
 *
 *   - withdraw (`?pool=utxo`)  →  UTXOPool.spend()    →  USDC LEAVES the pool
 *   - transfer (this file)     →  UTXOPool.transfer() →  notes hop INSIDE the pool
 *
 * Same Groth16 circuit (`note_spend.circom` — Agent CIRCUIT unified the two
 * paths by removing the dispatch flag). Same v1 8-public-signal layout. The
 * only proof-level difference is:
 *
 *   - v1 removed `withdrawnAmount` from the public signals, so the old
 *     `TransferMustBeZeroAmount` check is gone — a transfer is structurally
 *     zero-unshield (no USDC moves), enforced via the transfer-context tag.
 *   - pubSignals[7] (`context`) binds to the transfer-context tag instead of
 *     the recipient struct. The contract computes
 *       expectedContext = uint256(keccak256(abi.encode(
 *         TRANSFER_CONTEXT_TAG, SCOPE
 *       ))) % SNARK_FIELD
 *     where `TRANSFER_CONTEXT_TAG = keccak256("zbase.utxo.transfer.v1")`,
 *     and `transferContext()` is exposed as a view for off-chain mirroring.
 *
 * On-chain payload is `CommitmentCiphertext[2]` instead of `bytes[2]`. The
 * per-ciphertext AAD field MUST equal `keccak256(abi.encode(outputCommitment[i]))`
 * (Phase 1B Fix 3 — relayer ciphertext-shuffle defense). The SDK helper
 * `encryptNoteForTransfer(note, recipientPub, commitment)` derives the AAD
 * automatically; we call it via a thin local shim (the SDK barrel re-export
 * has not landed yet — see "SDK BARRER GAP" note below).
 *
 * REQUEST BODY:
 *   {
 *     inputs: UtxoNoteShape[];           // sender's two input notes (≥1 real)
 *     outputAmounts: [string, string];   // sum MUST equal sum(inputs.amount)
 *     recipientViewingPubKey: number[]   // 32-byte X25519 pubkey (JSON array)
 *                          | string;     // OR 0x-prefixed 32-byte hex
 *     unsafeTestMode?: boolean;          // dev-only mock-proof submission
 *   }
 *
 * RESPONSE (success):
 *   { success: true, pool: "utxo", txHash, blockNumber, gasUsed,
 *     unsafeTestMode, proofTimeMs }
 *
 * Privacy posture matches handleUtxoSpend / handleWithdraw: no echoing of
 * input amounts, no publicSignals in the response, no ciphertext bytes.
 * Callers that need to track the new output notes must persist them
 * client-side at request time (since the response intentionally omits them).
 *
 * STATUS (2026-06-10):
 *   * Mock-proof / unsafeTestMode path: WIRED + tsc-clean.
 *   * Real-proof path: 501-blocked on the `note_spend.circom` trusted-setup
 *     ceremony, same blocker as handleUtxoSpend. Mirror that branch when the
 *     ceremony lands.
 *   * Depends on Agent CONTRACT's UTXOPool.transfer() (signature locked in
 *     this file matches src/contracts/UTXOPool.sol:458-509 of Phase 1B).
 *   * Depends on Agent SDK exposing `encryptNoteForTransfer` from the
 *     `@zbase-protocol/core` barrel. As of write-time the function exists in
 *     `packages/core/src/notes.ts` (Agent SDK landed it) but `index.ts`
 *     barrel re-export has not landed. We compose the equivalent locally
 *     from `encryptNote` + a small AAD helper to avoid blocking ourselves;
 *     when the barrel ships, replace `encryptForTransferShim` below with
 *     a direct import of `encryptNoteForTransfer`.
 */

import { NextResponse } from "next/server";
import {
  createPublicClient,
  http,
  keccak256,
  type Hex,
} from "viem";
import { existsSync } from "fs";
import { join } from "path";
import { getActiveStack, getActiveChain, type ContractStack } from "@/lib/contracts";
import { sendPostmanTx, postmanSignerKind } from "@/lib/postman-signer";
// UTXO primitives live on the /experimental subpath (SDK audit 2026-07-09) —
// the transfer route is the 501-gated UTXO path; not the deployed public surface.
import {
  commitmentOf,
  createDummyNote,
  createNote,
  encryptNote,
  encryptNoteForTransfer,
  commitmentAAD,
  packCiphertext,
  deriveRecipientNPK,
  nullifierHashOf,
  planSpend,
  type EncryptedNote,
  type Note,
} from "@zbase-protocol/core/experimental";
import { randomBytes } from "@noble/hashes/utils";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Mirror of UTXOPool.sol:140
//   bytes32 internal constant TRANSFER_CONTEXT_TAG =
//       keccak256("zbase.utxo.transfer.v1");
// Recompute here so we don't take a hard build-time dep on a compiled
// contract ABI; the literal string is the canonical source of truth.
const TRANSFER_CONTEXT_TAG: Hex = keccak256(
  new TextEncoder().encode("zbase.utxo.transfer.v1"),
);

// ── UTXO note request shape (mirrors handleUtxoSpend's parseUtxoNote) ──────
interface UtxoNoteShape {
  amount: string | number | bigint;
  label: string | number | bigint;
  // C3: NPK inputs (v1 commitment recipe). Optional in the wire shape — default
  // to 0 when absent. Deriving these from the recipient's viewing key is the
  // auditor-scoped gap; this route just threads through whatever the SDK sends.
  spendingPK?: string | number | bigint;
  viewingPKBlind?: string | number | bigint;
  nullifier: string | number | bigint;
  secret: string | number | bigint;
}

function parseUtxoNote(raw: UtxoNoteShape, position: string): Note {
  const toBig = (v: string | number | bigint, fieldName: string): bigint => {
    if (v === undefined || v === null || v === "") {
      throw new Error(`UTXO note ${position}.${fieldName} is empty`);
    }
    return BigInt(v);
  };
  const toBigOptional = (v: string | number | bigint | undefined): bigint =>
    v === undefined || v === null || v === "" ? 0n : BigInt(v);
  return {
    amount: toBig(raw.amount, "amount"),
    label: toBig(raw.label, "label"),
    spendingPK: toBigOptional(raw.spendingPK),
    viewingPKBlind: toBigOptional(raw.viewingPKBlind),
    nullifier: toBig(raw.nullifier, "nullifier"),
    secret: toBig(raw.secret, "secret"),
  };
}

function parseViewingPubKey(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) {
    if (raw.length !== 32) throw new Error("viewing pubkey must be 32 bytes");
    return raw;
  }
  if (Array.isArray(raw)) {
    if (raw.length !== 32) throw new Error("viewing pubkey array must be 32 bytes");
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      const v = raw[i];
      if (typeof v !== "number" || v < 0 || v > 255 || !Number.isInteger(v)) {
        throw new Error(`viewing pubkey[${i}] not a byte: ${String(v)}`);
      }
      out[i] = v;
    }
    return out;
  }
  if (typeof raw === "string") {
    const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
    if (hex.length !== 64) {
      throw new Error("viewing pubkey hex must be 64 hex chars (32 bytes)");
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  throw new Error("viewing pubkey must be Uint8Array, number[], or 0x-hex string");
}

// AAD recipe helper — matches UTXOPool.transfer()'s on-chain check verbatim:
//   expectedAAD = keccak256(abi.encode(outputCommitment[i]))
// `abi.encode(uint256)` is a 32-byte big-endian buffer. Used by
// `aadHexFromCommitment`; the SDK's `commitmentAAD`/`encryptNoteForTransfer`
// (now barrel-exported) own the encryption side.
function uint256ToBE32(v: bigint): Uint8Array {
  if (v < 0n) throw new Error("uint256ToBE32: negative");
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x > 0n) throw new Error("uint256ToBE32: exceeds 256 bits");
  return out;
}


// ── CommitmentCiphertext packing ───────────────────────────────────────────
// RESOLVED 2026-07-04: the on-chain `CommitmentCiphertext.ciphertext` is now a
// variable-length `bytes` (widened from Railgun's fixed `bytes32[4]`, which
// could not hold zBase's ~208-byte XChaCha20 envelope — see UTXOPool.sol). The
// SDK now ships `packCiphertext`/`unpackCiphertext` (packages/core/src/notes.ts)
// that frame the `EncryptedNote` blob with a version byte + BE length prefix.
// So we produce a REAL, scanner-decodable ciphertext in both mock and real
// mode; only the PROOF (ceremony artifacts) still gates the real path.
const ZERO_BYTES32 = ("0x" + "00".repeat(32)) as Hex;

function aadHexFromCommitment(commitment: bigint): Hex {
  return keccak256(uint256ToBE32(commitment));
}

// ── Route ──────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const unsafeTestMode = url.searchParams.get("unsafeTestMode") === "true";

  // ── Production safety gate (same pattern as handleUtxoSpend) ─────────────
  // Even WITH unsafeTestMode in the URL, refuse unless the operator has
  // explicitly opted in via ALLOW_UNSAFE_UTXO_TEST_MODE=true. Fail-closed
  // default protects production Vercel deploys against accidental enablement.
  if (unsafeTestMode && process.env.ALLOW_UNSAFE_UTXO_TEST_MODE !== "true") {
    return NextResponse.json(
      {
        error:
          "unsafeTestMode is disabled. Set ALLOW_UNSAFE_UTXO_TEST_MODE=true " +
          "(dev/test env only — NEVER in prod) to enable the mock-proof path.",
      },
      { status: 400 },
    );
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch (e) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${(e as Error).message}` },
      { status: 400 },
    );
  }

  // ── Rate-limit gate ──────────────────────────────────────────────────────
  // Same nullifier-keyed pattern as handleUtxoSpend, separately namespaced
  // so transfer abuse doesn't burn the spend bucket and vice versa.
  // PHASE 3 TODO (matches handleUtxoSpend's note): when real-proof path
  // lands, also enforce nullifier-was-authorized via getAuthorizedTier
  // before forwarding. Direct callers bypass /api/facilitator/settle's
  // upstream check.
  const rawInputs = body.inputs as UtxoNoteShape[] | undefined;
  const rateLimitNullifier =
    Array.isArray(rawInputs) && rawInputs.length > 0
      ? String(rawInputs[0]?.nullifier ?? "")
      : "";
  const rateLimitKey = rateLimitNullifier
    ? `eip155:84532:utxo-transfer:${rateLimitNullifier.toLowerCase()}`
    : undefined;
  const rl = await checkRateLimit(request, "settle", rateLimitKey);
  if (!rl.success) return rateLimitResponse(rl);

  // ── Validate inputs[] ────────────────────────────────────────────────────
  if (!Array.isArray(rawInputs) || rawInputs.length === 0) {
    return NextResponse.json(
      { error: "transfer requires `inputs: UtxoNote[]` (≥1 spendable note)" },
      { status: 400 },
    );
  }
  let inputs: Note[];
  try {
    inputs = rawInputs.map((n, i) => parseUtxoNote(n, `inputs[${i}]`));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // ── Validate outputAmounts ──────────────────────────────────────────────
  // Optional: if the caller pre-computed a split they can pass it. Otherwise
  // we infer (whole-input transfer to recipient + dummy change). The contract
  // re-verifies conservation via the proof — we still validate here for fast
  // failure + clearer error messages than `InvalidProof` 5s later.
  const rawOutputs = body.outputAmounts;
  let providedOutputs: [bigint, bigint] | null = null;
  if (Array.isArray(rawOutputs)) {
    if (rawOutputs.length !== 2) {
      return NextResponse.json(
        { error: "outputAmounts must be a length-2 array" },
        { status: 400 },
      );
    }
    try {
      providedOutputs = [
        BigInt(rawOutputs[0] as string | number),
        BigInt(rawOutputs[1] as string | number),
      ];
    } catch (e) {
      return NextResponse.json(
        { error: `Invalid outputAmounts: ${(e as Error).message}` },
        { status: 400 },
      );
    }
    if (providedOutputs[0] < 0n || providedOutputs[1] < 0n) {
      return NextResponse.json(
        { error: "outputAmounts must be non-negative" },
        { status: 400 },
      );
    }
    const inputSum = inputs.reduce((acc, n) => acc + n.amount, 0n);
    const outputSum = providedOutputs[0] + providedOutputs[1];
    if (inputSum !== outputSum) {
      return NextResponse.json(
        {
          error:
            "transfer conservation: sum(outputAmounts) must equal sum(inputs.amount) " +
            `(in=${inputSum.toString()}, out=${outputSum.toString()})`,
        },
        { status: 400 },
      );
    }
  }

  // ── Validate recipient viewing pubkey ───────────────────────────────────
  // No `recipient: 0x...` here by design — UTXOPool.transfer moves NO USDC.
  // The receiver is identified solely by their X25519 viewing pubkey, which
  // we bind into the AEAD ciphertext via AAD = keccak256(commitment).
  let recipientViewingPub: Uint8Array;
  try {
    recipientViewingPub = parseViewingPubKey(body.recipientViewingPubKey);
  } catch (e) {
    return NextResponse.json(
      { error: `recipientViewingPubKey: ${(e as Error).message}` },
      { status: 400 },
    );
  }

  // Recipient's long-lived spending pubkey (field element) — the second NPK
  // input (npk.ts). Until zBase ships a spending-key HD scheme, the recipient
  // MAY publish a stable field element (e.g. a hash of their viewing pubkey);
  // we default to that when the caller omits it so a transfer is still
  // recipient-addressable rather than silently NPK=0.
  let recipientSpendingPubKey: bigint;
  try {
    if (
      body.recipientSpendingPubKey !== undefined &&
      body.recipientSpendingPubKey !== null &&
      body.recipientSpendingPubKey !== ""
    ) {
      recipientSpendingPubKey =
        BigInt(body.recipientSpendingPubKey as string | number) % SNARK_FIELD;
    } else {
      // Interim default: reduce the recipient's viewing pubkey into the field as
      // a stable spendingPK. Deterministic per recipient, so their notes share a
      // spendingPK (the per-note unlinkability still comes from viewingPKBlind).
      let v = 0n;
      for (const byte of recipientViewingPub) v = (v << 8n) | BigInt(byte);
      recipientSpendingPubKey = v % SNARK_FIELD;
    }
  } catch {
    return NextResponse.json(
      { error: "recipientSpendingPubKey must be a base-10 field element" },
      { status: 400 },
    );
  }

  // ── Plan the spend ───────────────────────────────────────────────────────
  // If caller supplied outputAmounts we use those directly; otherwise we
  // route through planSpend with `payAmount = sum(inputs)` (whole-balance
  // transfer to recipient, zero change). This matches the simplest UI flow.
  let inputA: Note;
  let inputB: Note;
  let outAmount0: bigint;
  let outAmount1: bigint;
  if (providedOutputs) {
    if (inputs.length === 1) {
      inputA = inputs[0];
      inputB = createDummyNote();
    } else {
      // Pick the two largest real notes; the rest sit out (operator should
      // batch additional notes into a separate transfer call).
      const sorted = [...inputs].sort((a, b) =>
        a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0,
      );
      inputA = sorted[0];
      inputB = sorted[1] ?? createDummyNote();
    }
    [outAmount0, outAmount1] = providedOutputs;
  } else {
    const payAmount = inputs.reduce((acc, n) => acc + n.amount, 0n);
    try {
      const plan = planSpend(inputs, payAmount);
      [inputA, inputB] = plan.inputs;
      [outAmount0, outAmount1] = plan.outputAmounts;
    } catch (e) {
      return NextResponse.json(
        { error: `planSpend failed: ${(e as Error).message}` },
        { status: 400 },
      );
    }
  }

  // The output notes inherit the ASP label of the originating real input
  // (matches handleUtxoSpend's invariant — labels never cross pools).
  const inheritedLabel = inputA.amount > 0n ? inputA.label : inputB.label;

  // C3 NPK derivation: output0 is the PAYMENT leg addressed to the recipient, so
  // its NPK must be derived from the recipient's published key material (the
  // commitment is Poseidon3(amount, Poseidon2(spendingPK, viewingPKBlind),
  // secret) — see packages/core npk.ts). Without this the commitment carries
  // NPK=0 and the recipient can never recover/prove it. output1 is change back
  // to the spender, so it stays NPK=0 here (self-spend scaffold).
  //
  // The ephemeral key is shared with the note encryption below so the on-chain
  // note carries ONE ephemeral pubkey the recipient uses to recover the blind.
  const npkEphemeralPriv = randomBytes(32);
  const derivedNpk = deriveRecipientNPK({
    recipientViewingPubKey: recipientViewingPub,
    recipientSpendingPubKey,
    ephemeralPrivateKey: npkEphemeralPriv,
  });
  const output0: Note = createNote(outAmount0, inheritedLabel, {
    spendingPK: derivedNpk.spendingPK,
    viewingPKBlind: derivedNpk.viewingPKBlind,
  });
  const output1: Note =
    outAmount1 === 0n ? createDummyNote() : createNote(outAmount1, inheritedLabel);

  // ── Load contract stack ─────────────────────────────────────────────────
  const stack: ContractStack = getActiveStack({ stack: "utxo" });
  // UTXO is Sepolia-only by design (getStackByName throws on mainnet UTXO until
  // the ceremony + C4 fix). Pin the chain to sepolia via getActiveChain rather
  // than hardcoding baseSepolia / the public RPC (B6 residual fix, mirrors the
  // withdraw UTXO branch). When UTXO mainnet ever ships, switch to getActiveChain().
  const utxoChain = getActiveChain("sepolia");
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  if (stack.usdcPool === ZERO_ADDR) {
    return NextResponse.json(
      {
        error:
          "UTXO pool is not deployed yet. Run `scripts/deploy-utxo-pool.sh` " +
          "and update src/lib/contracts.ts UTXO_STACK.usdcPool.",
      },
      { status: 503 },
    );
  }

  const rpcUrl = utxoChain.readRpcUrl;
  // EOA postman needs POSTMAN_PRIVATE_KEY; CDP postman (POSTMAN_SIGNER=cdp) uses
  // CDP-managed keys instead (validated inside sendPostmanTx).
  if (!rpcUrl || (postmanSignerKind() === "eoa" && !process.env.POSTMAN_PRIVATE_KEY)) {
    return NextResponse.json(
      { error: "Missing server config (BASE_SEPOLIA_RPC or POSTMAN_PRIVATE_KEY)" },
      { status: 500 },
    );
  }

  // ── Compute public signals expected by UTXOPool.transfer ────────────────
  // v1 8-signal layout (same circuit as spend(); see UTXOPool.sol uint256[8]):
  //   [0..1] nullifierHashes  [2..3] outputCommitments  [4] stateRoot
  //   [5] stateTreeDepth  [6] aspRoot  [7] context
  // v1 dropped `withdrawnAmount` from the public set, so the old
  // `pubSignals[4] === 0 / TransferMustBeZeroAmount` check is GONE — a transfer
  // is structurally zero-unshield, enforced via the transfer-domain context tag:
  //   pubSignals[7] === keccak256(TRANSFER_CONTEXT_TAG, SCOPE) % SNARK_FIELD
  const nullHash0 = nullifierHashOf(inputA);
  const nullHash1 = nullifierHashOf(inputB);
  const outCom0 = commitmentOf(output0);
  const outCom1 = commitmentOf(output1);

  const publicClient = createPublicClient({
    chain: utxoChain.chain,
    transport: http(rpcUrl),
  });

  // Read SCOPE from the deployed pool so context is deterministic against
  // whatever the constructor was wired with. The pool also exposes a
  // `transferContext()` view — we could use it directly, but recomputing
  // locally lets us fail-fast in the response on RPC trouble (rather than
  // discovering SCOPE mismatch via ContextMismatch revert seconds later).
  let scope: bigint;
  try {
    scope = (await publicClient.readContract({
      address: stack.usdcPool,
      abi: [
        {
          name: "SCOPE",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "SCOPE",
    })) as bigint;
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read SCOPE from UTXOPool: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  // Solidity-equivalent of:
  //   uint256(keccak256(abi.encode(TRANSFER_CONTEXT_TAG, SCOPE))) % SNARK_FIELD
  // abi.encode(bytes32, uint256) = 32 bytes (tag) || 32 bytes (scope BE)
  const ctxPreimage = new Uint8Array(64);
  ctxPreimage.set(hexToBytes(TRANSFER_CONTEXT_TAG), 0);
  ctxPreimage.set(uint256ToBE32(scope), 32);
  const context = BigInt(keccak256(ctxPreimage)) % SNARK_FIELD;

  type PubSignals = readonly [
    bigint, bigint, bigint, bigint,
    bigint, bigint, bigint, bigint,
  ];
  let pubSignals: PubSignals;
  let proof: {
    pA: readonly [bigint, bigint];
    pB: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
    pC: readonly [bigint, bigint];
  };

  if (unsafeTestMode) {
    // ── Mock-proof path ──────────────────────────────────────────────────
    // The mock verifier accepts any proof bytes; pubSignals are still read
    // by UTXOPool BEFORE the verify call (for nullifier-spent check, context
    // match, root checks, AAD check). v1 8-signal layout — no withdrawnAmount
    // slot (the zero-unshield property is enforced via the context tag).
    pubSignals = [
      nullHash0,
      nullHash1,
      outCom0,
      outCom1,
      0n,         // stateRoot — UnknownStateRoot unless deploy-script seeds
      0n,         // stateTreeDepth
      0n,         // aspRoot — IEntrypoint.latestRoot() must match
      context,
    ];
    proof = {
      pA: [0n, 0n],
      pB: [
        [0n, 0n],
        [0n, 0n],
      ],
      pC: [0n, 0n],
    };
    console.log(
      "[Transfer UTXO] unsafeTestMode: submitting zero-proof. Pool MUST be " +
      "deployed with UnsafeMockVerifier — see scripts/deploy-utxo-pool.sh.",
    );
  } else {
    // ── Real proof path ──────────────────────────────────────────────────
    // Blocker (b) — the CommitmentCiphertext packing helper — is now RESOLVED
    // (packCiphertext ships in @zbase-protocol/core; the ciphertext build below
    // produces a real scanner-decodable payload). The ONLY remaining blocker is
    // (a): the note_spend.circom trusted-setup ceremony has not run, so the
    // proving artifacts (public/circuits/note_spend/{wasm,zkey}) don't exist and
    // no real Groth16 proof can be generated. Gate on artifact presence — the
    // instant the ceremony publishes them, wire the snarkjs fullProve here
    // (mirror handleUtxoSpend) and drop this 501.
    const wasmPath = join(process.cwd(), "public/circuits/note_spend/note_spend.wasm");
    const zkeyPath = join(process.cwd(), "public/circuits/note_spend/groth16_pkey.zkey");
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      return NextResponse.json(
        {
          error:
            "UTXO transfer proof generation is blocked on the trusted-setup " +
            "ceremony for note_spend.circom (proving artifacts absent). The " +
            "ciphertext packing helper is shipped. Pass `?unsafeTestMode=true` " +
            "against a UTXOPool deployed with UnsafeMockVerifier to exercise the codepath.",
          source: "ceremony_pending",
          hint: "See CIRCUIT_FROZEN_FOR_AUDIT.md + docs/security/c4-amount-binding-design-2026-07-04.md.",
        },
        { status: 501 },
      );
    }
    // (Ceremony artifacts present → real proof generation goes here — mirror
    // handleUtxoSpend's snarkjs.groth16.fullProve. Not reachable until ceremony.)
    return NextResponse.json(
      { error: "Real-proof transfer generation not yet wired post-ceremony.", source: "ceremony_pending" },
      { status: 501 },
    );
  }

  // ── Build CommitmentCiphertext[2] ────────────────────────────────────────
  // Even in unsafeTestMode we MUST set ciphertexts[i].aad to the correct
  // value (= keccak256(abi.encode(outputCommitment[i]))) — UTXOPool's
  // transfer() re-derives + compares, reverts CiphertextAADMismatch on
  // mismatch (Phase 1B Fix 3). The encrypted payload itself is unused by
  // the on-chain check; placeholder zeros are fine for the mock path.
  //
  // Side-effect: we DO build the real encrypted-note blob via the SDK shim
  // even in test mode, just to verify the SDK path is callable + the AAD
  // helper agrees with our on-chain AAD calc. Discarded after.
  // Build the REAL encrypted-note envelope (AAD-bound to the output commitment)
  // and pack it into the on-chain variable `bytes` ciphertext. Now produces a
  // scanner-decodable payload in both mock and real mode.
  const encNote0 = encryptNoteForTransfer(output0, recipientViewingPub, outCom0);
  const encNote1 = encryptNoteForTransfer(output1, recipientViewingPub, outCom1);

  type CiphertextStruct = {
    ciphertext: Hex; // packed bytes (was bytes32[4])
    blindedSenderViewingKey: Hex;
    blindedReceiverViewingKey: Hex;
    memo: Hex;
    aad: Hex;
  };
  const ciphertexts: readonly [CiphertextStruct, CiphertextStruct] = [
    {
      ciphertext: packCiphertext(encNote0),
      blindedSenderViewingKey: ZERO_BYTES32,
      blindedReceiverViewingKey: ZERO_BYTES32,
      memo: ZERO_BYTES32,
      aad: aadHexFromCommitment(outCom0),
    },
    {
      ciphertext: packCiphertext(encNote1),
      blindedSenderViewingKey: ZERO_BYTES32,
      blindedReceiverViewingKey: ZERO_BYTES32,
      memo: ZERO_BYTES32,
      aad: aadHexFromCommitment(outCom1),
    },
  ];

  // ── Submit on-chain ──────────────────────────────────────────────────────
  // Same RPC split as handleUtxoSpend: dedicated `writeRpcUrl` for the tx
  // submission because the configured BASE_SEPOLIA_RPC is sometimes a
  // logs-only endpoint that doesn't accept eth_sendRawTransaction.
  // Through the postman-signer adapter (EOA default / CDP sponsored).
  // waitForReceipt:false so this handler keeps its own receipt-wait below (it
  // reads gasUsed off the receipt); the adapter only submits + returns the hash.
  // Prefer a dedicated write RPC if configured; else the network-correct default
  // (B6 residual fix — was hardcoded "https://sepolia.base.org").
  const writeRpcUrl = process.env.BASE_SEPOLIA_WRITE_RPC ?? "https://sepolia.base.org";

  try {
    const txHash = await sendPostmanTx({
      address: stack.usdcPool,
      abi: [
        {
          name: "transfer",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            {
              name: "proof",
              type: "tuple",
              components: [
                { name: "pA", type: "uint256[2]" },
                { name: "pB", type: "uint256[2][2]" },
                { name: "pC", type: "uint256[2]" },
                { name: "pubSignals", type: "uint256[8]" },
              ],
            },
            {
              name: "ciphertexts",
              type: "tuple[2]",
              components: [
                { name: "ciphertext", type: "bytes" },
                { name: "blindedSenderViewingKey", type: "bytes32" },
                { name: "blindedReceiverViewingKey", type: "bytes32" },
                { name: "memo", type: "bytes32" },
                { name: "aad", type: "bytes32" },
              ],
            },
          ],
          outputs: [],
        },
      ],
      functionName: "transfer",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: [{ ...proof, pubSignals }, ciphertexts] as any,
      gas: 1_500_000n,
      chain: utxoChain.chain,
      writeRpcUrl,
      readRpcUrl: rpcUrl,
      waitForReceipt: false,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const gasUsed = receipt.gasUsed.toString();

    // CSO-P2 parity (same posture as handleUtxoSpend): no input echo, no
    // publicSignals, no ciphertext bytes. The caller already has the
    // inputs they sent; the receiver decrypts off-chain by scanning
    // Transferred events directly. Internal /api/facilitator/* consumers
    // (if added later) should forward their own input rather than read
    // back from this response.
    return NextResponse.json({
      success: true,
      pool: "utxo",
      op: "transfer",
      txHash,
      status: receipt.status,
      gasUsed,
      blockNumber: receipt.blockNumber.toString(),
      unsafeTestMode,
      proofTimeMs: Date.now() - startTime,
    });
  } catch (e) {
    const msg = (e as Error).message || "Unknown transfer error";
    console.error("[Transfer UTXO] transfer reverted/failed:", msg.slice(0, 300));
    return NextResponse.json(
      {
        error: `UTXO transfer failed: ${msg.slice(0, 300)}`,
        unsafeTestMode,
      },
      { status: 500 },
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function hexToBytes(h: Hex): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 !== 0) throw new Error("hexToBytes: odd-length hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
