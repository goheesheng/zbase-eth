/**
 * Re-baseline the OFAC L1 fallback snapshot (src/lib/ofac-snapshot.fallback.json)
 * and print the new PINNED_COMMIT to set in src/lib/ofac-screening.ts.
 *
 * WHY: the L1 list is pinned to a specific commit (supply-chain safety — the list
 * is trusted code, so it can't move under us silently). The trade-off is it must be
 * actively re-baselined or it goes stale — a stale sanctions list is a real
 * compliance gap on mainnet (addresses sanctioned after the pin pass screening).
 *
 * This is the `scripts/refresh-ofac-fallback` the code + fallback JSON reference.
 *
 *   npx tsx scripts/refresh-ofac-fallback.ts            # bump to latest upstream main
 *   npx tsx scripts/refresh-ofac-fallback.ts <commit>   # pin to a specific commit
 *
 * It:
 *   1. resolves the target commit (latest `main`, or the arg),
 *   2. fetches that commit's data.csv,
 *   3. canonicalizes addresses with the SAME rule as ofac-screening.ts
 *      (lowercase, keep 0x[0-9a-f]{40}, dedup, sort),
 *   4. writes src/lib/ofac-snapshot.fallback.json,
 *   5. prints the new PINNED_COMMIT + snapshotVersion so you update ofac-screening.ts.
 *
 * MANUAL step after running: set PINNED_COMMIT in src/lib/ofac-screening.ts to the
 * printed value (kept manual so the source-code pin is a reviewed, intentional change).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

const REPO = "ultrasoundmoney/ofac-ethereum-addresses";
const FALLBACK_PATH = join(process.cwd(), "src/lib/ofac-snapshot.fallback.json");

/** Same rule as ofac-screening.ts `canonicalize`: lowercase, 0x40-hex only, dedup, sort. */
function canonicalize(addresses: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const a of addresses) {
    const t = a.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(t)) set.add(t);
  }
  return [...set].sort();
}

/** Same as ofac-screening.ts `versionOf`. */
function versionOf(sortedAddresses: string[]): string {
  const digest = bytesToHex(sha256(new TextEncoder().encode(sortedAddresses.join("\n"))));
  return "ofac-eth-" + digest.slice(0, 12);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "zbase-ofac-refresh" } });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.text();
}

async function resolveCommit(arg?: string): Promise<{ sha: string; date: string }> {
  const ref = arg ?? "main";
  const json = JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/commits/${ref}`));
  return { sha: json.sha as string, date: json.commit?.committer?.date ?? "(unknown)" };
}

async function main() {
  const arg = process.argv[2];
  console.log(`[refresh-ofac] resolving commit (${arg ?? "latest main"})...`);
  const { sha, date } = await resolveCommit(arg);
  console.log(`[refresh-ofac] target commit ${sha} (${date})`);

  const csv = await fetchText(`https://raw.githubusercontent.com/${REPO}/${sha}/data.csv`);
  const raw = [...csv.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0]);
  const addresses = canonicalize(raw);
  if (addresses.length === 0) throw new Error("no addresses parsed — refusing to write an empty list");

  // NOTE: ofac-screening.ts recomputes snapshotVersion at runtime from the
  // COMBINED L1∪L2 set (canonicalize([...addresses, ...overlay])) — it reads only
  // `addresses` from this file. We record the L1-only version here as informational
  // provenance, but the authoritative version is always computed by the code.
  const l1Version = versionOf(addresses);
  const out = {
    source: REPO,
    pinnedCommit: sha,
    note: "Vendored L1 fallback for src/lib/ofac-screening.ts. OFAC SDN ETH addresses extracted at the pinned commit. Used only when runtime fetch fails AND no fresh cache exists. The code consumes `addresses` only (it recomputes the runtime snapshotVersion from L1∪L2). Re-baseline via scripts/refresh-ofac-fallback.ts.",
    pinnedCommitDate: date,
    addressCount: addresses.length,
    l1VersionInformational: l1Version,
    addresses,
  };
  writeFileSync(FALLBACK_PATH, JSON.stringify(out, null, 2) + "\n");

  console.log(`\n[refresh-ofac] wrote ${FALLBACK_PATH}`);
  console.log(`  addresses: ${addresses.length}`);
  console.log(`  L1 version (informational): ${l1Version}`);
  console.log("\n=== ACTION REQUIRED — set this in src/lib/ofac-screening.ts ===");
  console.log(`  const PINNED_COMMIT = "${sha}";`);
  console.log("================================================================");
}

main().catch((e) => {
  console.error("[refresh-ofac] FAILED:", e);
  process.exit(1);
});
