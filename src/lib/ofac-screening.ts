/**
 * Deposit screening for the zBase ASP (Association Set Provider).
 *
 * Shared primitive used by BOTH the live single-operator ASP root updater
 * (`src/app/api/asp-update/route.ts`) and the future 3-of-5 threshold daemon
 * (`scripts/threshold-postman/`). Replaces the 6-address hardcoded `OFAC_SDN_SEED`
 * stub that previously lived privately inside `risk-pipeline.ts`.
 *
 * What screening achieves (the Privacy Pools compliance mechanism): a deposit
 * from a flagged depositor still lands on-chain, but its LABEL is excluded from
 * the ASP Merkle tree — so it can never satisfy the withdrawal circuit's
 * association proof, i.e. it can never be PRIVATELY withdrawn. Funds are not
 * seized; the depositor can still ragequit/reclaim publicly. Clean deposits stay
 * anonymous inside a provably-clean set. This mirrors 0xbow's production model:
 * an off-chain operator screens, then publishes only the root on-chain.
 *
 * Two local layers, combined into one provider. A paid KYT provider can be
 * composed on top through ASP_SCREENING_PROVIDER=chainalysis:
 *
 *   L1 — OFAC SDN floor. The legal baseline: addresses directly on the US
 *        Treasury SDN list. Fetched at runtime from a maintained extraction
 *        (pinned to a commit), cached to disk, with a vendored fallback. NOTE:
 *        OFAC delisted Tornado Cash in March 2025, so the live list correctly no
 *        longer contains the Tornado pools.
 *   L2 — risk overlay (`risk-overlay.json`). zBase's curated blocklist, BROADER
 *        than OFAC — keeps the Tornado pools + known hack addresses as policy
 *        even though OFAC delisted them. Replicates 0xbow's "without helping the
 *        hackers" stance. Hand-curated, honestly NOT comprehensive.
 *   L3 — graph-taint / KYT. Blocking addresses CONNECTED to L1/L2 (received
 *        mixer funds, N hops from a hack) needs a paid provider. The configured
 *        provider hook is fail-closed and composes with the OFAC+overlay floor.
 *
 * Determinism: the live route is a SINGLE operator, so cross-signer determinism
 * does not bind — runtime fetch + cache is fine. For the threshold quorum
 * (Path B), all signers must pin the same `snapshotVersion`; it is a content hash
 * of the combined L1∪L2 set, so divergence is detectable and the pipeline's
 * existing version-mismatch-abstain logic engages. Path B should pass a snapshot
 * explicitly rather than letting each signer fetch independently.
 *
 * Fail-closed-to-known-good: if the network fetch fails AND no fresh cache
 * exists, the loader falls back to the vendored snapshot + overlay. It NEVER
 * degrades to an empty set (which would silently re-enable approve-all).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import fallbackSnapshot from "./ofac-snapshot.fallback.json";
import riskOverlay from "./risk-overlay.json";

// ── Types (kept compatible with scripts/threshold-postman/risk-pipeline.ts) ──

export type ReasonCode =
  | "ofac-sdn-direct"
  | "policy-mixer"
  | "policy-hack"
  | "operator-pin"
  | "chainalysis-risk";

export interface SanctionsProvider {
  /** Content-derived version string; all quorum signers must agree on this. */
  snapshotVersion: string;
  isSanctioned(address: `0x${string}`): Promise<boolean>;
  /** Reason an address is blocked, or null if it is not. */
  reasonFor(address: `0x${string}`): ReasonCode | null;
  /** Optional async screen for paid KYT providers. Falls back to reasonFor. */
  screenAddress?(address: `0x${string}`): Promise<ReasonCode | null>;
}

export interface OfacSnapshot {
  /** Lowercased, sorted, de-duplicated L1 (OFAC) addresses only. */
  addresses: string[];
  /** "ofac-eth-" + first 12 hex chars of sha256(sorted L1 addresses). */
  version: string;
  /** Where L1 came from, for logging/auditing. */
  source: "network" | "cache" | "fallback";
}

export interface LoadOfacOptions {
  /** Override the upstream raw URL. Default: env OFAC_LIST_URL or the pinned default. */
  url?: string;
  /** Disk cache dir. Default: env OFAC_CACHE_DIR or <tmpdir>/zbase-ofac. */
  cacheDir?: string;
  /** Cache freshness window in ms. Default: env OFAC_CACHE_TTL_MS or 6h. */
  cacheTtlMs?: number;
  /** Force-skip the network fetch (tests / offline). */
  noNetwork?: boolean;
  /** Inject a fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type ScreeningSource = OfacSnapshot["source"] | `${OfacSnapshot["source"]}+chainalysis`;

export interface ConfiguredScreeningProvider {
  provider: SanctionsProvider;
  source: ScreeningSource;
}

// ── L1 source config ─────────────────────────────────────────────────────────
//
// Pinned to a specific commit (not `main`) for supply-chain safety: the list is
// code we trust, so we don't let it move under us silently. Re-baseline by
// bumping both this SHA and ofac-snapshot.fallback.json's pinnedCommit.

// Re-baselined 2026-07-04 (was 74a24ed2…, 2026-05-26 — ~6 weeks stale). Bump via
// `npx tsx scripts/refresh-ofac-fallback.ts` (regenerates the fallback JSON too),
// then paste the printed commit here. For mainnet, re-baseline on a cadence
// (weekly) — a stale sanctions list lets post-pin-sanctioned addresses through.
const PINNED_COMMIT = "ac234519b1ff45e9beec3345d476a0a54dca7df8";
const DEFAULT_LIST_URL =
  `https://raw.githubusercontent.com/ultrasoundmoney/ofac-ethereum-addresses/${PINNED_COMMIT}/data.csv`;

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const CACHE_FILE = "ofac-eth-latest.json";

// ── L2 overlay (loaded once from the bundled JSON) ───────────────────────────

const OVERLAY: ReadonlyMap<string, ReasonCode> = (() => {
  const m = new Map<string, ReasonCode>();
  const add = (list: unknown, reason: ReasonCode) => {
    if (!Array.isArray(list)) return;
    for (const a of list) {
      if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) {
        m.set(a.toLowerCase(), reason);
      }
    }
  };
  add((riskOverlay as Record<string, unknown>)["policy-mixer"], "policy-mixer");
  add((riskOverlay as Record<string, unknown>)["policy-hack"], "policy-hack");
  add((riskOverlay as Record<string, unknown>)["operator-pin"], "operator-pin");
  return m;
})();

/** The L2 overlay as a reason-coded map. Exposed for tests + the route. */
export function loadOverlay(): ReadonlyMap<string, ReasonCode> {
  return OVERLAY;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Lowercase, de-dup, keep only 0x-address-shaped tokens, sort. */
function canonicalize(addresses: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const a of addresses) {
    const t = a.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(t)) set.add(t);
  }
  return [...set].sort();
}

function versionOf(sortedAddresses: string[]): string {
  const digest = bytesToHex(sha256(new TextEncoder().encode(sortedAddresses.join("\n"))));
  return `ofac-eth-${digest.slice(0, 12)}`;
}

/**
 * Format-tolerant parse: extract every 0x-address-shaped token, so the maintained
 * CSV (`address,name` header) or a bare one-address-per-line .txt both work.
 */
function parseAddresses(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/0x[0-9a-fA-F]{40}/g)) out.push(m[0]);
  return out;
}

function resolveCacheDir(opts?: LoadOfacOptions): string {
  return opts?.cacheDir ?? process.env.OFAC_CACHE_DIR ?? join(tmpdir(), "zbase-ofac");
}

function readCache(cacheDir: string, ttlMs: number): { addresses: string[]; version: string } | null {
  try {
    const path = join(cacheDir, CACHE_FILE);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      addresses: string[];
      version: string;
      fetchedAt: number;
    };
    if (
      !Array.isArray(parsed.addresses) ||
      parsed.addresses.length === 0 ||
      typeof parsed.fetchedAt !== "number" ||
      Date.now() - parsed.fetchedAt > ttlMs
    ) {
      return null;
    }
    return { addresses: parsed.addresses, version: parsed.version };
  } catch {
    return null;
  }
}

function writeCache(cacheDir: string, addresses: string[], version: string): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, CACHE_FILE),
      JSON.stringify({ addresses, version, fetchedAt: Date.now() }),
    );
  } catch {
    // Cache write failures are non-fatal — we still return the in-memory snapshot.
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load the L1 OFAC snapshot: fresh cache → network (pinned commit) → vendored
 * fallback. Never returns an empty set. `version` + `source` describe what backed
 * the result. (L2 overlay is merged in by `createScreeningProvider`, not here.)
 */
export async function loadOfacSnapshot(opts?: LoadOfacOptions): Promise<OfacSnapshot> {
  const url = opts?.url ?? process.env.OFAC_LIST_URL ?? DEFAULT_LIST_URL;
  const cacheDir = resolveCacheDir(opts);
  const ttlMs =
    opts?.cacheTtlMs ??
    (process.env.OFAC_CACHE_TTL_MS ? Number(process.env.OFAC_CACHE_TTL_MS) : DEFAULT_CACHE_TTL_MS);

  // 1. Fresh cache.
  const cached = readCache(cacheDir, ttlMs);
  if (cached) {
    return { addresses: cached.addresses, version: cached.version, source: "cache" };
  }

  // 2. Network (pinned commit).
  if (!opts?.noNetwork) {
    try {
      const fetchImpl = opts?.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      let raw: string;
      try {
        const res = await fetchImpl(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`OFAC fetch ${res.status}`);
        raw = await res.text();
      } finally {
        clearTimeout(timeout);
      }
      const live = canonicalize(parseAddresses(raw));
      if (live.length === 0) throw new Error("OFAC list parsed to zero addresses");
      const version = versionOf(live);
      writeCache(cacheDir, live, version);
      return { addresses: live, version, source: "network" };
    } catch {
      // fall through to fallback
    }
  }

  // 3. Vendored fallback (bundled in repo). Should never be empty — but if the
  //    bundled JSON were corrupted/empty, returning an empty L1 here would let
  //    createScreeningProvider approve everyone (fail-OPEN). The combined set
  //    still includes the in-repo L2 overlay, so the provider's own empty-set
  //    guard (createScreeningProvider) is the real fail-closed backstop; we
  //    still return whatever the fallback holds and let that guard decide.
  const fb = canonicalize(fallbackSnapshot.addresses as string[]);
  return { addresses: fb, version: versionOf(fb), source: "fallback" };
}

/**
 * Build a screening provider from an L1 snapshot + the L2 overlay. Blocks if an
 * address is in EITHER set. `reasonFor` prefers the L1 code (`ofac-sdn-direct`)
 * when an address is in both — the SDN status is the stronger statement.
 *
 * `snapshotVersion` is the content hash of the COMBINED L1∪L2 set, so it changes
 * when either the OFAC list or the overlay changes (matters for the quorum pin).
 */
export function createScreeningProvider(
  snapshot: OfacSnapshot,
  overlay: ReadonlyMap<string, ReasonCode> = OVERLAY,
): SanctionsProvider {
  const l1 = new Set(snapshot.addresses);
  const combined = canonicalize([...snapshot.addresses, ...overlay.keys()]);

  // FAIL-CLOSED (audit F1): an empty combined screening set would make
  // `reasonFor` return null for EVERY address — i.e. silently approve all
  // deposits, including sanctioned ones. That is the worst possible failure for
  // a compliance gate. The in-repo L2 overlay (Tornado pools + known hacks) is
  // non-empty by construction, so reaching here with zero addresses means the
  // bundled data is corrupted/misloaded. Refuse to build a provider rather than
  // build one that approves everyone. Callers (screenDeposits / the ASP route)
  // must treat a thrown provider as "do not publish a root", never as approve-all.
  if (combined.length === 0) {
    throw new ScreeningUnavailableError(
      "refusing to build a screening provider with an empty address set (fail-closed)",
    );
  }

  const version = versionOf(combined);

  const reasonFor = (address: `0x${string}`): ReasonCode | null => {
    const a = address.toLowerCase();
    if (l1.has(a)) return "ofac-sdn-direct";
    return overlay.get(a) ?? null;
  };

  return {
    snapshotVersion: version,
    isSanctioned: async (address) => reasonFor(address) !== null,
    reasonFor,
  };
}

function screeningProviderName(): "ofac" | "chainalysis" {
  const raw = String(process.env.ASP_SCREENING_PROVIDER ?? "ofac").trim().toLowerCase();
  if (raw === "" || raw === "ofac") return "ofac";
  if (raw === "chainalysis") return "chainalysis";
  throw new ScreeningUnavailableError(`Unsupported ASP_SCREENING_PROVIDER="${process.env.ASP_SCREENING_PROVIDER}"`);
}

function parseChainalysisReason(payload: unknown): ReasonCode | null {
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const candidates = [
    obj["risk"],
    obj["riskLevel"],
    obj["risk_level"],
    obj["category"],
    obj["status"],
    obj["decision"],
    obj["result"],
  ]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());
  if (
    candidates.some(
      (v) =>
        v.includes("sanction") ||
        v.includes("blocked") ||
        v.includes("illicit") ||
        v === "high" ||
        v === "severe",
    )
  ) {
    return "chainalysis-risk";
  }
  const score = typeof obj["riskScore"] === "number" ? obj["riskScore"] : typeof obj["score"] === "number" ? obj["score"] : null;
  const threshold = process.env.CHAINALYSIS_BLOCK_SCORE ? Number(process.env.CHAINALYSIS_BLOCK_SCORE) : 70;
  if (score !== null && Number.isFinite(score) && score >= threshold) return "chainalysis-risk";
  if (typeof obj["blocked"] === "boolean" && obj["blocked"]) return "chainalysis-risk";
  if (typeof obj["isSanctioned"] === "boolean" && obj["isSanctioned"]) return "chainalysis-risk";
  if (
    candidates.some(
      (v) =>
        v.includes("clear") ||
        v.includes("clean") ||
        v.includes("approved") ||
        v === "low" ||
        v === "none" ||
        v === "ok",
    ) ||
    obj["blocked"] === false ||
    obj["isSanctioned"] === false ||
    (score !== null && Number.isFinite(score) && score < threshold)
  ) {
    return null;
  }
  throw new ScreeningUnavailableError(
    "Chainalysis screening response did not include a recognized allow/block decision",
  );
}

function withChainalysisProvider(baseProvider: SanctionsProvider): SanctionsProvider {
  const url = process.env.CHAINALYSIS_SCREENING_URL;
  const apiKey = process.env.CHAINALYSIS_API_KEY;
  if (!url || !apiKey) {
    throw new ScreeningUnavailableError(
      "ASP_SCREENING_PROVIDER=chainalysis requires CHAINALYSIS_SCREENING_URL and CHAINALYSIS_API_KEY",
    );
  }
  const timeoutMs = process.env.CHAINALYSIS_API_TIMEOUT_MS ? Number(process.env.CHAINALYSIS_API_TIMEOUT_MS) : 5_000;

  const screenAddress = async (address: `0x${string}`): Promise<ReasonCode | null> => {
    const localReason = baseProvider.reasonFor(address);
    if (localReason) return localReason;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 5_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          address,
          chain: "base",
          network: activeScreeningNetwork(),
        }),
      });
      if (!res.ok) throw new Error(`Chainalysis screening returned HTTP ${res.status}`);
      const payload = await res.json();
      return parseChainalysisReason(payload);
    } catch (error) {
      throw new ScreeningUnavailableError(
        `Chainalysis screening unavailable for ${address}: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    snapshotVersion: `${baseProvider.snapshotVersion}+chainalysis`,
    reasonFor: baseProvider.reasonFor,
    screenAddress,
    isSanctioned: async (address) => (await screenAddress(address)) !== null,
  };
}

function activeScreeningNetwork(): "base" | "base-sepolia" | "ethereum-sepolia" {
  if (process.env.NEXT_PUBLIC_NETWORK === "mainnet") return "base";
  if (process.env.NEXT_PUBLIC_NETWORK === "eth-sepolia") return "ethereum-sepolia";
  return "base-sepolia";
}

export async function createConfiguredScreeningProvider(): Promise<ConfiguredScreeningProvider> {
  const snapshot = await loadOfacSnapshot();
  const baseProvider = createScreeningProvider(snapshot);
  if (screeningProviderName() === "ofac") {
    return { provider: baseProvider, source: snapshot.source };
  }
  return {
    provider: withChainalysisProvider(baseProvider),
    source: `${snapshot.source}+chainalysis`,
  };
}

/**
 * Thrown when a screening provider cannot be built safely (empty data set).
 * Callers MUST fail closed: do not approve deposits, do not publish an ASP root.
 */
export class ScreeningUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreeningUnavailableError";
  }
}

/**
 * Offline provider from the vendored L1 fallback + L2 overlay. Deterministic, no
 * network, no disk. Used by `risk-pipeline.ts` as the default when the coordinator
 * does not inject a network-loaded provider, and by tests.
 */
export function staticFallbackProvider(): SanctionsProvider {
  const fb = canonicalize(fallbackSnapshot.addresses as string[]);
  return createScreeningProvider({ addresses: fb, version: versionOf(fb), source: "fallback" });
}

/**
 * The canonical `snapshotVersion` of the offline fallback provider (vendored L1 +
 * L2 overlay). Use this as the coordinator's default `ofacSnapshotVersion` so its
 * version-pin check matches the static provider when no provider is injected.
 * Replaces the old hardcoded `"ofac-static-seed-v0"` literal.
 */
export const STATIC_FALLBACK_VERSION = staticFallbackProvider().snapshotVersion;
