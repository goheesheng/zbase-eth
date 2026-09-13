/**
 * GET /api/cron/decoy
 *
 * Vercel cron entry point for the decoy-traffic timing-correlation defense
 * (shipment A.2, mechanism 2). The route is invoked by Vercel cron at a
 * fixed base cadence (see vercel.json); the route itself injects Poisson-
 * style jitter by probabilistically returning early. The result: actual
 * decoy fires arrive at random intervals rather than the predictable cron
 * tick — which is what's needed to defeat FIFO temporal de-anon
 * (arXiv 2510.09433).
 *
 * Why a cron + jitter instead of the long-running CLI?
 *   scripts/decoy-scheduler.ts is a Node CLI with a `while (!stopping)`
 *   main loop, blocking sleeps, and local JSON state files. Vercel
 *   serverless functions can't host a long-lived process, so the CLI
 *   shape doesn't fit. The right architecture is: extract the
 *   per-iteration logic into a stateless route + register a Vercel cron.
 *
 * Status (2026-06-09): partial port. The reuse-existing-note path IS
 * wired here. The seed-new-deposit path is NOT wired — that branch in
 * the CLI does an on-chain USDC approval + deposit + 60s block sleep
 * which is a poor fit for a serverless function. Recommended: keep
 * the postman wallet topped up with reusable notes via the local CLI
 * (`tsx scripts/decoy-scheduler.ts --once`) once a week. The cron
 * route reuses those notes for the actual timing-defense fires.
 *
 * Production wiring required (see plan file Phase 0.6):
 *   - CRON_SECRET in Vercel env (`openssl rand -hex 32`)
 *   - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN already in env
 *   - POSTMAN_PRIVATE_KEY already in env
 *   - Seed initial notes via local CLI before enabling
 *
 * Failure modes (all graceful):
 *   - No CRON_SECRET set → unauthenticated callers blocked (401)
 *   - ZBASE_DECOY_DISABLED=true → return immediately with {disabled: true}
 *   - Upstash unreachable → return {fired: false, reason: "no-state-backend"}
 *   - No usable notes in state → return {fired: false, reason: "no-usable-note"}
 *   - Daily budget exceeded → return {fired: false, reason: "budget-exceeded"}
 *   - /api/withdraw fails → log + return {fired: false, reason: <upstream-error>}
 */

import { NextRequest, NextResponse } from "next/server";
import { parseUnits } from "viem";
import { pickBurnAddress } from "@/lib/decoy-burn-addresses";
import {
  isDecoyStateAvailable,
  loadDecoyBudget,
  loadDecoyNotes,
  recordDecoyFire,
  saveDecoyNotes,
  type DecoyNote,
} from "@/lib/decoy-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Probability per cron hit that we actually fire a decoy.
//   Base cron cadence (vercel.json): every 20 minutes (3/hr).
//   Effective fires: 3/hr × 0.40 = 1.2/hr → ~50 min mean inter-arrival.
//   Variance is geometric (each hit is independent), which approximates a
//   Poisson process well enough to defeat naive FIFO timing correlation.
//   Tune via ZBASE_DECOY_FIRE_PROBABILITY (0..1, default 0.4).
const DECOY_BASE_PROBABILITY = (() => {
  const v = Number.parseFloat(process.env.ZBASE_DECOY_FIRE_PROBABILITY || "0.4");
  if (!Number.isFinite(v) || v < 0 || v > 1) return 0.4;
  return v;
})();

const DECOY_AMOUNT_USDC = process.env.ZBASE_DECOY_AMOUNT_USDC || "0.01";
const MAX_DAILY_BUDGET_USD = Number.parseFloat(
  process.env.ZBASE_DECOY_MAX_DAILY_USD || "5",
);

export async function GET(req: NextRequest) {
  // Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>` when
  // CRON_SECRET is set in Vercel project env. If it's set locally too we
  // enforce it; if not set we skip auth so local `curl` works.
  // See: https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
  // CRITICAL C2 fix (2026-07-09): FAIL CLOSED in production (mirror indexer-sync).
  // Previously a missing CRON_SECRET skipped auth entirely → anyone could trigger
  // decoy withdrawals and burn the daily decoy budget / DoS the decoy defense.
  const cronSecret = process.env.CRON_SECRET;
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && !cronSecret) {
    return NextResponse.json(
      { error: "decoy cron is locked: set CRON_SECRET in the production env." },
      { status: 503 },
    );
  }
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // Kill switch — flip in Vercel env without redeploying.
  if (process.env.ZBASE_DECOY_DISABLED === "true") {
    return NextResponse.json({
      fired: false,
      reason: "disabled",
      note: "ZBASE_DECOY_DISABLED=true",
    });
  }

  // Poisson-style jitter: probabilistic firing on each cron tick.
  if (Math.random() > DECOY_BASE_PROBABILITY) {
    return NextResponse.json({
      fired: false,
      reason: "jitter",
      probability: DECOY_BASE_PROBABILITY,
    });
  }

  // Pre-flight: state backend must be available. We do NOT fall back to
  // an in-memory shim because that would make decoy budget accounting
  // wrong (multiple Vercel instances would each think they had the full
  // budget). Better to skip the tick honestly.
  if (!isDecoyStateAvailable()) {
    return NextResponse.json({
      fired: false,
      reason: "no-state-backend",
      note: "Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to enable.",
    });
  }

  try {
    const budget = await loadDecoyBudget();

    // Daily-budget check (same rule as the CLI's MAX_DAILY_BUDGET_USD).
    const amountUsd = Number.parseFloat(DECOY_AMOUNT_USDC);
    if (budget.spentTodayUsd + amountUsd > MAX_DAILY_BUDGET_USD) {
      return NextResponse.json({
        fired: false,
        reason: "budget-exceeded",
        spentTodayUsd: budget.spentTodayUsd,
        cap: MAX_DAILY_BUDGET_USD,
      });
    }

    // Reuse-existing-note path. The seed-new-deposit branch from the CLI
    // is not ported here — see file header for the reasoning. Operator
    // tops up the working set via `tsx scripts/decoy-scheduler.ts --once`
    // periodically.
    const notes = await loadDecoyNotes();
    const amountAtomic = parseUnits(DECOY_AMOUNT_USDC, 6);
    const noteIdx = notes.findIndex((n) => BigInt(n.value) >= amountAtomic);

    if (noteIdx === -1) {
      return NextResponse.json({
        fired: false,
        reason: "no-usable-note",
        note:
          "Operator: run `tsx scripts/decoy-scheduler.ts --once` to top up " +
          "the working set (creates a fresh decoy deposit from POSTMAN_PRIVATE_KEY).",
        notesAvailable: notes.length,
      });
    }

    const note = notes[noteIdx]!;
    const burnAddress = pickBurnAddress();

    // Same payload shape as scripts/decoy-scheduler.ts:fireDecoy uses.
    // Hitting our OWN /api/withdraw means a decoy is bit-identical to a
    // real user payment on-chain — that's the whole point.
    const apiBase = process.env.ZBASE_API ?? "http://localhost:3000";
    const withdrawRes = await fetch(`${apiBase}/api/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nullifier: note.nullifier,
        secret: note.secret,
        value: note.value,
        label: note.label,
        commitment: note.commitment,
        recipient: burnAddress,
        amountAtomic: amountAtomic.toString(),
      }),
    });

    const withdrawData = (await withdrawRes.json()) as {
      success?: boolean;
      txHash?: string;
      error?: string;
      retryAfter?: number;
      nextDeposit?: DecoyNote;
    };

    if (
      withdrawRes.status === 429 &&
      withdrawData.error === "delay_window_active"
    ) {
      return NextResponse.json({
        fired: false,
        reason: "delay-window-active",
        retryAfterSec: withdrawData.retryAfter ?? null,
      });
    }

    if (!withdrawRes.ok || !withdrawData.success) {
      console.error(
        "[cron/decoy] /api/withdraw failed:",
        withdrawData.error ?? withdrawRes.statusText,
      );
      return NextResponse.json({
        fired: false,
        reason: "withdraw-failed",
        upstreamError: withdrawData.error ?? withdrawRes.statusText,
      });
    }

    // Roll over to change note if returned; else drop the spent note.
    if (withdrawData.nextDeposit) {
      notes[noteIdx] = {
        nullifier: withdrawData.nextDeposit.nullifier,
        secret: withdrawData.nextDeposit.secret,
        value: withdrawData.nextDeposit.value,
        label: withdrawData.nextDeposit.label,
        commitment: withdrawData.nextDeposit.commitment,
        depositTxHash: note.depositTxHash,
        depositTimestamp: note.depositTimestamp,
      };
    } else {
      notes.splice(noteIdx, 1);
    }
    await saveDecoyNotes(notes);
    await recordDecoyFire(budget, amountUsd);

    // Privacy: NEVER return the decoy's txHash or burnAddress. This response
    // (and any log that captures it) would let an observer identify exactly
    // which on-chain withdrawal is a decoy and subtract it from the anonymity
    // set — defeating the cover-traffic purpose. Return only non-identifying
    // counters.
    return NextResponse.json({
      fired: true,
      notesRemaining: notes.length,
      spentTodayUsd: budget.spentTodayUsd + amountUsd,
      totalFires: budget.totalFires + 1,
    });
  } catch (err) {
    console.error("[cron/decoy] iteration failed:", err);
    return NextResponse.json(
      { error: "decoy iteration failed" },
      { status: 500 },
    );
  }
}
