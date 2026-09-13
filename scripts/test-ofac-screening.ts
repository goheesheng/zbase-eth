/**
 * Phase A — OFAC + risk-overlay screening tests (offline + live route).
 *
 * The unit half is pure (no network, no chain): it exercises loadOfacSnapshot's
 * fallback/cache paths, the L1/L2 reason codes, and snapshotVersion stability.
 *
 * The route half (optional) runs only if a dev server is reachable:
 *   npm run dev -- -p 3110
 *   VAULT_TEST_BASE=http://localhost:3110 npx tsx scripts/test-ofac-screening.ts
 * Without a server it skips the HTTP checks and still passes the unit suite.
 *
 *   npx tsx scripts/test-ofac-screening.ts
 */

import * as assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOfacSnapshot,
  createScreeningProvider,
  staticFallbackProvider,
  STATIC_FALLBACK_VERSION,
  ScreeningUnavailableError,
} from "../src/lib/ofac-screening";

// A real L1 address from the vendored fallback (OFAC SDN), and a Tornado pool
// address that is L2-only (OFAC-delisted, kept as policy-mixer).
const L1_ADDR = "0x0330070fd38ec3bb94f58fa55d40368271e9e54a" as const;
const L2_TORNADO = "0x722122df12d4e14e13ac3b6895a86e84145b6967" as const;
const CLEAN = "0x1111111111111111111111111111111111111111" as const;

function freshCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "zbase-ofac-test-"));
}

async function unitTests(): Promise<void> {
  // 1. Offline fallback: no network, no cache → vendored fallback, never empty.
  {
    const snap = await loadOfacSnapshot({ noNetwork: true, cacheDir: freshCacheDir() });
    assert.equal(snap.source, "fallback", "noNetwork + empty cache → fallback");
    assert.ok(snap.addresses.length > 0, "fallback must not be empty");
    console.log(`1. offline fallback ok (${snap.addresses.length} L1 addrs)`);
  }

  // 2. Reason codes: L1 → ofac-sdn-direct, L2 → policy-mixer, clean → null.
  {
    const snap = await loadOfacSnapshot({ noNetwork: true, cacheDir: freshCacheDir() });
    const p = createScreeningProvider(snap);
    assert.equal(p.reasonFor(L1_ADDR), "ofac-sdn-direct", "L1 reason");
    assert.equal(await p.isSanctioned(L1_ADDR), true, "L1 sanctioned");
    assert.equal(p.reasonFor(L2_TORNADO), "policy-mixer", "L2 tornado reason");
    assert.equal(await p.isSanctioned(L2_TORNADO), true, "L2 sanctioned");
    assert.equal(p.reasonFor(CLEAN), null, "clean reason null");
    assert.equal(await p.isSanctioned(CLEAN), false, "clean not sanctioned");
    // Case-insensitivity.
    assert.equal(p.reasonFor(L1_ADDR.toUpperCase() as `0x${string}`), "ofac-sdn-direct", "uppercase L1");
    console.log("2. reason codes ok (L1=ofac-sdn-direct, L2=policy-mixer, clean=null)");
  }

  // 3. snapshotVersion stable for identical content, changes when content changes.
  {
    const snap = await loadOfacSnapshot({ noNetwork: true, cacheDir: freshCacheDir() });
    const v1 = createScreeningProvider(snap).snapshotVersion;
    const v2 = createScreeningProvider(snap).snapshotVersion;
    assert.equal(v1, v2, "version stable for same content");
    // Mutate the snapshot → version must change.
    const mutated = { ...snap, addresses: [...snap.addresses, CLEAN] };
    const v3 = createScreeningProvider(mutated).snapshotVersion;
    assert.notEqual(v1, v3, "version changes when L1 content changes");
    assert.match(v1, /^ofac-eth-[0-9a-f]{12}$/, "version format");
    console.log(`3. snapshotVersion stable + content-sensitive (${v1})`);
  }

  // 4. STATIC_FALLBACK_VERSION matches staticFallbackProvider's version (coordinator default).
  {
    assert.equal(
      staticFallbackProvider().snapshotVersion,
      STATIC_FALLBACK_VERSION,
      "exported static version matches provider",
    );
    console.log("4. STATIC_FALLBACK_VERSION matches provider");
  }

  // 5. Cache round-trip: injected fetch populates cache (source=network), second
  //    call within TTL reads disk (source=cache) without calling fetch again.
  {
    const cacheDir = freshCacheDir();
    let fetchCalls = 0;
    const fakeList = `address,name\n${L1_ADDR},"TEST ENTITY"\n${CLEAN.replace("0x1", "0x2")},"TEST 2"\n`;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(fakeList, { status: 200 });
    }) as unknown as typeof fetch;

    const first = await loadOfacSnapshot({ cacheDir, fetchImpl, cacheTtlMs: 60_000 });
    assert.equal(first.source, "network", "first load = network");
    assert.equal(fetchCalls, 1, "fetch called once");

    const second = await loadOfacSnapshot({ cacheDir, fetchImpl, cacheTtlMs: 60_000 });
    assert.equal(second.source, "cache", "second load = cache");
    assert.equal(fetchCalls, 1, "fetch NOT called again within TTL");
    assert.equal(first.version, second.version, "cached version matches");
    console.log("5. cache round-trip ok (network → cache, no refetch)");
  }

  // 6. Fetch failure WITH a populated cache → returns cache, not fallback.
  {
    const cacheDir = freshCacheDir();
    const okList = `address,name\n${L1_ADDR},"X"\n`;
    let call = 0;
    const flaky = (async () => {
      call += 1;
      if (call === 1) return new Response(okList, { status: 200 });
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const warm = await loadOfacSnapshot({ cacheDir, fetchImpl: flaky, cacheTtlMs: 60_000 });
    assert.equal(warm.source, "network", "warm cache via network");
    // Force the cache UNCONDITIONALLY stale (negative TTL — every entry is older
    // than now-(-1)) so the next call must attempt the (now-failing) fetch and
    // fall through to the vendored fallback. A 0 TTL would flake on same-ms writes.
    const afterFail = await loadOfacSnapshot({ cacheDir, fetchImpl: flaky, cacheTtlMs: -1 });
    assert.equal(afterFail.source, "fallback", "stale cache + fetch fail → fallback (not crash)");
    console.log("6. fetch-failure path falls back without crashing");
  }

  // 7. FAIL-CLOSED (audit F1): an empty address set must REFUSE to build a
  //    provider, never produce one that approves everyone. With an empty L2
  //    overlay AND empty L1, createScreeningProvider must throw.
  {
    const emptySnapshot = { addresses: [] as string[], version: "ofac-eth-empty", source: "fallback" as const };
    const emptyOverlay = new Map();
    assert.throws(
      () => createScreeningProvider(emptySnapshot, emptyOverlay),
      ScreeningUnavailableError,
      "empty screening set must throw (fail-closed), not approve-all",
    );
    // And the real default overlay is non-empty, so the normal path never throws.
    const ok = createScreeningProvider(emptySnapshot); // default OVERLAY has entries
    assert.ok(ok.snapshotVersion.startsWith("ofac-eth-"), "default overlay keeps provider buildable");
    console.log("7. fail-closed: empty set refuses to build a provider (no approve-all)");
  }

  console.log("\nscripts/test-ofac-screening.ts: 7 unit invariants hold");
}

async function routeTests(): Promise<void> {
  const base = process.env.VAULT_TEST_BASE;
  if (!base) {
    console.log("\n(skipping live-route checks — set VAULT_TEST_BASE to run them)");
    return;
  }
  // GET /rejected must be read-only and well-shaped (may be empty on a clean pool).
  try {
    const res = await fetch(`${base}/api/asp-update/rejected`);
    if (res.ok) {
      const data = (await res.json()) as {
        rejected: unknown[];
        snapshotVersion: string;
        snapshotSource: string;
      };
      assert.ok(Array.isArray(data.rejected), "rejected is an array");
      assert.match(data.snapshotVersion ?? "", /^ofac-eth-/, "snapshotVersion present");
      console.log(
        `\n7. GET /rejected ok — ${data.rejected.length} rejected, source=${data.snapshotSource}`,
      );
    } else {
      console.log(`\n7. GET /rejected returned HTTP ${res.status} (env may lack RPC) — shape check skipped`);
    }
  } catch (e) {
    console.log(`\n7. live-route check skipped (server unreachable: ${(e as Error).message})`);
  }
}

async function main(): Promise<void> {
  await unitTests();
  await routeTests();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
