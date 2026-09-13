/**
 * GET /api/cron/decoy-transfer
 *
 * Phase 1B mirror of /api/cron/decoy (the unshield-side decoy cron from PR #31).
 * Drives Poisson-jittered shielded-to-shielded transfer traffic so timing
 * analysis cannot distinguish a real wallet-to-wallet hop from background
 * noise on the UTXO pool.
 *
 * Why a SEPARATE cron rather than extending /api/cron/decoy:
 *   - Different on-chain surface: /api/withdraw (spend → USDC out) vs
 *     /api/transfer (transfer → notes hop in-pool).
 *   - Different working set: transfer outputs are spendable indefinitely;
 *     unshield outputs spend down a change-note chain. Keeping the working
 *     sets disjoint (decoy:transfer:notes vs decoy:notes) prevents the two
 *     loops from clobbering each other's state.
 *   - Different budget: transfer has near-zero USDC cost (only gas), unshield
 *     burns the decoy amount as a sunk cost. Separate budget counters.
 *
 * Cron capacity (Vercel Hobby tier):
 *   Max 2 crons per project. Current usage:
 *     1. /api/cron/decoy          @ 0 12 * * *  (unshield decoys)
 *     2. /api/cron/decoy-transfer @ 0 18 * * *  (transfer decoys — THIS ROUTE)
 *   We are AT THE HOBBY TIER CAP. Adding any third cron requires upgrading
 *   to Pro tier (or absorbing it into an existing route's logic). The 18:00
 *   slot is chosen to spread load across the day; the unshield cron fires
 *   at noon. See vercel.json.
 *
 * Status (2026-06-10): partial port. Reuse-existing-note path IS wired here.
 * The seed-new-deposit path is NOT wired — same reasoning as the unshield
 * cron (CLI tops up the working set; this route reuses it). Operator must
 * pre-seed `decoy:transfer:notes` in Upstash with at least one usable note
 * before the cron does anything.
 *
 * Failure modes (all graceful):
 *   - No CRON_SECRET set → unauthenticated callers blocked (401)
 *   - ZBASE_DECOY_TRANSFER_DISABLED=true → return {disabled: true}
 *   - Upstash unreachable → return {fired: false, reason: "no-state-backend"}
 *   - No usable notes in transfer working set → {reason: "no-usable-note"}
 *   - Daily budget exceeded → {reason: "budget-exceeded"}
 *   - /api/transfer fails → log + return {reason: <upstream-error>}
 */

import { NextRequest, NextResponse } from "next/server";
import { x25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  isDecoyStateAvailable,
  loadDecoyTransferBudget,
  loadDecoyTransferNotes,
  recordDecoyTransferFire,
  saveDecoyTransferNotes,
} from "@/lib/decoy-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Same shape as the unshield cron — see comments in /api/cron/decoy:60.
const DECOY_BASE_PROBABILITY = (() => {
  const v = Number.parseFloat(
    process.env.ZBASE_DECOY_TRANSFER_FIRE_PROBABILITY ||
      process.env.ZBASE_DECOY_FIRE_PROBABILITY ||
      "0.4",
  );
  if (!Number.isFinite(v) || v < 0 || v > 1) return 0.4;
  return v;
})();

// "Amount" for budget accounting only. A transfer does NOT move USDC out
// of the pool, so the actual sunk USD cost is roughly = (gas × gwei × ETH
// price). We bookkeep a small placeholder so the daily-budget cap still
// rate-limits transfer-decoy traffic; tune via env var if your gas profile
// changes meaningfully.
const DECOY_TRANSFER_COST_USD = Number.parseFloat(
  process.env.ZBASE_DECOY_TRANSFER_COST_USD || "0.05",
);

const MAX_DAILY_BUDGET_USD = Number.parseFloat(
  process.env.ZBASE_DECOY_TRANSFER_MAX_DAILY_USD || "5",
);

/**
 * Derive a deterministic X25519 viewing pubkey from a burn-address-style
 * seed string. We can't use the burn ADDRESSES directly (they're not keys
 * with secrets); instead we hash a stable label into 32 bytes and treat
 * those as an X25519 private key. The corresponding public key is what
 * we encrypt the decoy ciphertext to.
 *
 * No real recipient ever learns to scan these keys — the decoy is fired
 * AT THE POOL, not AT A USER. The encrypted payload is just noise that
 * looks like real transfer traffic on-chain. (Real users only scan their
 * own viewing keys, so decoy ciphertexts don't pollute their decryption
 * loop.)
 */
function burnViewingPubKey(slot: number): Uint8Array {
  const seed = keccak_256(
    new TextEncoder().encode(`zbase-decoy-transfer-burn-vk-${slot}`),
  );
  return x25519.getPublicKey(seed);
}

function pickBurnViewingPubKey(): { pub: Uint8Array; slot: number } {
  const slot = Math.floor(Math.random() * 10); // matches decoy-burn-addresses.ts cardinality
  return { pub: burnViewingPubKey(slot), slot };
}

export async function GET(req: NextRequest) {
  // Auth — Vercel cron sends `Authorization: Bearer <CRON_SECRET>`.
  // CRITICAL C2 fix (2026-07-09): FAIL CLOSED in production (mirror indexer-sync).
  const cronSecret = process.env.CRON_SECRET;
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && !cronSecret) {
    return NextResponse.json(
      { error: "decoy-transfer cron is locked: set CRON_SECRET in the production env." },
      { status: 503 },
    );
  }
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // Kill switch — independent from unshield's kill switch so ops can
  // disable one path without affecting the other.
  if (process.env.ZBASE_DECOY_TRANSFER_DISABLED === "true") {
    return NextResponse.json({
      fired: false,
      reason: "disabled",
      note: "ZBASE_DECOY_TRANSFER_DISABLED=true",
    });
  }

  // Poisson-style jitter.
  if (Math.random() > DECOY_BASE_PROBABILITY) {
    return NextResponse.json({
      fired: false,
      reason: "jitter",
      probability: DECOY_BASE_PROBABILITY,
    });
  }

  // State backend must be available — fall back is unsafe (same reasoning
  // as the unshield cron — budget accounting would be per-instance instead
  // of global, allowing N-instance overspend).
  if (!isDecoyStateAvailable()) {
    return NextResponse.json({
      fired: false,
      reason: "no-state-backend",
      note: "Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to enable.",
    });
  }

  try {
    const budget = await loadDecoyTransferBudget();

    if (budget.spentTodayUsd + DECOY_TRANSFER_COST_USD > MAX_DAILY_BUDGET_USD) {
      return NextResponse.json({
        fired: false,
        reason: "budget-exceeded",
        spentTodayUsd: budget.spentTodayUsd,
        cap: MAX_DAILY_BUDGET_USD,
      });
    }

    const notes = await loadDecoyTransferNotes();
    if (notes.length === 0) {
      return NextResponse.json({
        fired: false,
        reason: "no-usable-note",
        note:
          "Operator: seed `decoy:transfer:notes` in Upstash with at least one " +
          "spendable UTXO note (nullifier/secret/value/label/commitment) from " +
          "a postman-controlled wallet. See packages/core/src/notes.ts:createNote.",
      });
    }

    // Pick the first usable note. Production wallet would do randomised
    // coin-selection for anonymity-set reasons; for decoy traffic the
    // selection doesn't matter — every fire is indistinguishable noise.
    const noteIdx = 0;
    const note = notes[noteIdx]!;

    const { pub: recipientViewingPub } = pickBurnViewingPubKey();
    // Serialize as a plain number[] so the JSON survives the wire. The
    // route accepts both number[] and 0x-hex via parseViewingPubKey.
    const pubAsArray = Array.from(recipientViewingPub);

    // Hit OUR OWN /api/transfer so a decoy is bit-identical to a real
    // user transfer on-chain — that's the whole point of the defense.
    const apiBase = process.env.ZBASE_API ?? "http://localhost:3000";

    // Decoy mode: transfer the whole input to two equal output halves
    // (split the value in two; pick whichever half is non-zero as primary).
    // Conservation is enforced by the proof + the route; we just supply
    // a valid partition.
    const noteValue = BigInt(note.value);
    const half = noteValue / 2n;
    const remainder = noteValue - half;
    const outputAmounts = [half.toString(), remainder.toString()];

    // unsafeTestMode is the only path that works pre-ceremony. The route
    // gates on ALLOW_UNSAFE_UTXO_TEST_MODE=true at the env level, so the
    // cron honestly forwards the request and lets the route reject if
    // the env opt-in is missing (same posture as the unshield cron).
    const transferUrl = new URL(`${apiBase}/api/transfer`);
    transferUrl.searchParams.set("unsafeTestMode", "true");

    const transferRes = await fetch(transferUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: [
          {
            amount: note.value,
            label: note.label,
            nullifier: note.nullifier,
            secret: note.secret,
          },
        ],
        outputAmounts,
        recipientViewingPubKey: pubAsArray,
      }),
    });

    const transferData = (await transferRes.json()) as {
      success?: boolean;
      txHash?: string;
      error?: string;
      retryAfter?: number;
    };

    if (
      transferRes.status === 429 &&
      transferData.error === "delay_window_active"
    ) {
      return NextResponse.json({
        fired: false,
        reason: "delay-window-active",
        retryAfterSec: transferData.retryAfter ?? null,
      });
    }

    if (!transferRes.ok || !transferData.success) {
      console.error(
        "[cron/decoy-transfer] /api/transfer failed:",
        transferData.error ?? transferRes.statusText,
      );
      return NextResponse.json({
        fired: false,
        reason: "transfer-failed",
        upstreamError: transferData.error ?? transferRes.statusText,
      });
    }

    // After a successful transfer, the original note is spent (its
    // nullifier is now consumed on-chain). Drop it from the working set.
    // The new output notes are NOT added back: only the recipient (the
    // burn viewing key) can decrypt them, and we don't track their
    // nullifier/secret (those were generated server-side inside the
    // route and intentionally dropped — decoy outputs are unspendable
    // by design, matching decoy-burn-addresses.ts's sunk-cost posture).
    notes.splice(noteIdx, 1);
    await saveDecoyTransferNotes(notes);
    await recordDecoyTransferFire(budget, DECOY_TRANSFER_COST_USD);

    // Privacy: do not return txHash or burnViewingKeySlot — they identify the
    // decoy transfer on-chain (and narrow it to 1 of N slots), letting an
    // observer strip cover traffic out of the anonymity set.
    return NextResponse.json({
      fired: true,
      costUsd: DECOY_TRANSFER_COST_USD,
      notesRemaining: notes.length,
      spentTodayUsd: budget.spentTodayUsd + DECOY_TRANSFER_COST_USD,
      totalFires: budget.totalFires + 1,
    });
  } catch (err) {
    console.error("[cron/decoy-transfer] iteration failed:", err);
    return NextResponse.json(
      { error: "decoy-transfer iteration failed" },
      { status: 500 },
    );
  }
}
