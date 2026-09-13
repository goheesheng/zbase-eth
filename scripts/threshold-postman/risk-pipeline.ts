/**
 * risk-pipeline.ts — deterministic ASP screening for the threshold postman.
 *
 * All five signers run this independently against the same input (Deposited events
 * since `sinceBlock`) and must arrive at byte-identical output. Any non-determinism
 * here breaks quorum.
 *
 * Determinism rules:
 *   - No `Date.now()`, no `Math.random()`, no clock-dependent decisions.
 *   - Sort everything by (block, logIndex) BEFORE scoring.
 *   - Risk-score thresholds are constants, not env-driven.
 *   - External lookups (OFAC, Chainalysis) cache to disk and signers MUST share
 *     the same snapshot version (see `OFAC_SNAPSHOT_VERSION`). On a snapshot
 *     mismatch a signer abstains rather than signing a possibly-divergent root.
 *
 * v0 implementation status (Shipment B.2 scaffold per the plan):
 *   - OFAC SDN list: static seed snapshot bundled in this repo. Re-baseline before
 *     each ceremony. Chainalysis Sanctions API integration is stubbed behind a
 *     `provider` parameter so each signer can wire in their own credentials, and
 *     the function falls back to the static list when no provider is configured.
 *   - Mixer / drainer counterparty graph: out of scope for the v0 scaffold. The
 *     interface accepts a `counterpartyResolver` so a future integration with
 *     TRM / Chainalysis Reactor / our own GraphDB can drop in without changing
 *     the caller. Until that lands, every deposit screens against the OFAC set
 *     alone, which is the same surface the current single-key postman covers.
 */

import { keccak256, toHex } from "viem";
import {
  staticFallbackProvider,
  type SanctionsProvider,
} from "../../src/lib/ofac-screening";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DepositEvent {
  blockNumber: bigint;
  logIndex: number;
  txHash: `0x${string}`;
  depositor: `0x${string}`;
  /** ABI-decoded `_label` from the 0xbow Deposited event (uint256). */
  label: bigint;
  /** Post-fee USDC value in pool's base units (6 decimals). */
  value: bigint;
}

export type Decision = "approve" | "reject" | "pending";

export interface ScreeningResult {
  label: bigint;
  depositor: `0x${string}`;
  decision: Decision;
  reasonCode: string;
  /** Per-event risk score (0–100). >=80 reject, 40–79 pending, <40 approve. */
  score: number;
}

export interface PipelineInput {
  events: readonly DepositEvent[];
  /** Snapshot version string. All five signers must use the same value. */
  ofacSnapshotVersion: string;
  /** Optional injected provider (Chainalysis adapter, etc.). */
  provider?: SanctionsProvider;
  /** Optional counterparty resolver for future mixer-graph integration. */
  counterpartyResolver?: CounterpartyResolver;
}

// SanctionsProvider is now defined in src/lib/ofac-screening.ts (shared with the
// live ASP route) and re-exported here so existing importers of this module are
// unaffected. It gained an optional `reasonFor` for the rejected-deposits surface.
export type { SanctionsProvider } from "../../src/lib/ofac-screening";

export interface CounterpartyResolver {
  /** Returns up to N most-recent counterparty addresses. */
  recentCounterparties(address: `0x${string}`, depth: number): Promise<`0x${string}`[]>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const REJECT_THRESHOLD = 80;
const PENDING_THRESHOLD = 40;
const COUNTERPARTY_DEPTH = 100;

/**
 * Default offline provider. Hoisted to src/lib/ofac-screening.ts — now the full
 * vendored OFAC SDN fallback (~97 addrs) PLUS the curated L2 risk overlay
 * (Tornado pools + DPRK/hack), instead of the old 6-address inline seed. The old
 * 6 are preserved inside the overlay, so this is strictly broader, not a
 * regression. The coordinator's snapshot-version pin + abstain logic is unchanged
 * (versions still compare by string equality below).
 */
const STATIC_PROVIDER: SanctionsProvider = staticFallbackProvider();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Score every deposit event, deterministically, in event order.
 * Returns the ordered list AND a deterministic root hash over the decisions so
 * each signer can hash-compare before signing the on-chain root.
 */
export async function runRiskPipeline(input: PipelineInput): Promise<{
  results: ScreeningResult[];
  decisionDigest: `0x${string}`;
}> {
  const provider = input.provider ?? STATIC_PROVIDER;

  if (provider.snapshotVersion !== input.ofacSnapshotVersion) {
    throw new Error(
      `Snapshot version mismatch: provider=${provider.snapshotVersion} ` +
        `coordinator=${input.ofacSnapshotVersion}. Signer abstains to preserve quorum determinism.`
    );
  }

  // Sort events deterministically — never trust input ordering.
  const ordered = [...input.events].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber < b.blockNumber ? -1 : 1;
    }
    return a.logIndex - b.logIndex;
  });

  const results: ScreeningResult[] = [];

  for (const evt of ordered) {
    let score = 0;
    let reason = "ok";

    if (await provider.isSanctioned(evt.depositor)) {
      score = 100;
      reason = "ofac-sdn-direct";
    } else if (input.counterpartyResolver) {
      const hops = await input.counterpartyResolver.recentCounterparties(
        evt.depositor,
        COUNTERPARTY_DEPTH
      );
      for (const cp of hops) {
        if (await provider.isSanctioned(cp)) {
          score = Math.max(score, 85);
          reason = "ofac-sdn-counterparty";
          break;
        }
      }
    }

    let decision: Decision;
    if (score >= REJECT_THRESHOLD) decision = "reject";
    else if (score >= PENDING_THRESHOLD) decision = "pending";
    else decision = "approve";

    results.push({
      label: evt.label,
      depositor: evt.depositor,
      decision,
      reasonCode: reason,
      score,
    });
  }

  return {
    results,
    decisionDigest: digestOfDecisions(results),
  };
}

/**
 * Order-stable, byte-exact digest over the decision list. Two signers that
 * processed the same events must produce identical digests; otherwise they
 * MUST NOT sign the same on-chain root.
 */
export function digestOfDecisions(results: readonly ScreeningResult[]): `0x${string}` {
  // Canonicalize: lowercase addresses, decimal label, single-character decision.
  const canonical = results
    .map(
      (r) =>
        `${r.label.toString(10)}|${r.depositor.toLowerCase()}|${r.decision}|${r.reasonCode}|${r.score}`
    )
    .join("\n");
  return keccak256(toHex(canonical));
}
