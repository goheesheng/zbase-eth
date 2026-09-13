/**
 * zBase Forwarding Engine daemon — Phase 2 (auto-privatize / payer-agnostic receive)
 *
 * Watches registered receiving addresses for inbound USDC, screens the payer
 * (compliance gate), and auto-deposits CLEAN inbound funds into the pool on the
 * user's behalf — at a commitment DERIVED FROM THE USER'S SEED (D3), so the
 * relayer can deposit but never spend. Immediate policy (no jitter, per rev-b:
 * on the single-value pool the amount already leaks the link, so jitter is
 * premature — unlinkability comes from the pool, at full speed).
 *
 * ALL fund-safety logic lives in the TESTED core (src/lib/forwarding-engine.ts).
 * This file is a thin wrapper: it supplies the real watcher, a postman-signer-
 * backed B1 authority (the SAME trusted-for-liveness relayer withdrawals use —
 * key custody decided 2026-07-09), and a registry-backed precommitment source,
 * then loops.
 *
 * Usage:
 *   tsx scripts/forwarding-engine.ts               # DRY-RUN by default (no txs)
 *   tsx scripts/forwarding-engine.ts --live        # actually deposit (real funds)
 *   tsx scripts/forwarding-engine.ts --once        # one pass then exit
 *
 * Env:
 *   POSTMAN_PRIVATE_KEY / POSTMAN_SIGNER  — the deposit signer (B1 authority)
 *   BASE_SEPOLIA_RPC / BASE_MAINNET_RPC   — read RPC for the inbound scan
 *   HYPERSYNC_TOKEN                       — fast log scan (optional)
 *   ZBASE_API                             — default http://localhost:3009 (registry read)
 *   ZBASE_FORWARDING_MAX_SPEND_USDC       — per-run budget cap (default 50)
 *   ZBASE_FORWARDING_MIN_USDC             — dust floor (default 0.01)
 *
 * SAFETY: defaults to DRY-RUN. The daemon never runs a mainnet deposit unless
 * `--live` is passed AND the operator has provisioned the postman key. Claude
 * does not run this against real funds — it is operator-run.
 */

import "./load-env";
import {
  processPendingDeposits,
  type DepositAuthority,
  type PrecommitmentSource,
  type EngineState,
} from "../src/lib/forwarding-engine";
import {
  screenInbound,
  decodeInboundTransfer,
  TRANSFER_TOPIC,
  type InboundTransfer,
} from "../src/lib/forwarding-watcher";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const RUN_ONCE = args.includes("--once");
const ZBASE_API = process.env.ZBASE_API || "http://localhost:3009";
const MAX_SPEND_USDC = Number.parseFloat(process.env.ZBASE_FORWARDING_MAX_SPEND_USDC || "50");
const MIN_USDC = Number.parseFloat(process.env.ZBASE_FORWARDING_MIN_USDC || "0.01");
const POLL_SECONDS = Number.parseFloat(process.env.ZBASE_FORWARDING_POLL_SECONDS || "30");

function info(m: string) {
  console.log(`[forwarding] ${m}`);
}
function err(m: string) {
  console.error(`[forwarding][err] ${m}`);
}

// ── AUDIT MEDIUM #7: persist engine state across restarts ────────────────────
// processedIds + depositedPrecommitments + lastScannedBlock MUST survive a
// restart. In-memory-only state meant a restart re-scanned from head-100 with an
// EMPTY dedupe set → already-deposited inbounds re-processed (wasted gas; and,
// before the reused-precommitment guard, a double-deposit fund-lock). Persist to
// the same data/ dir as the registry.
const STATE_PATH = process.env.ZBASE_FORWARDING_STATE_FILE
  ? process.env.ZBASE_FORWARDING_STATE_FILE
  : `${process.cwd()}/data/forwarding-engine-state.json`;

type PersistedState = {
  processedIds: string[];
  depositedPrecommitments: string[];
  lastScannedBlock: string | null;
};

/**
 * AUDIT HIGH (2026-07-09 regression pass): distinguish MISSING (first run) from
 * CORRUPT. A bare catch that returns empty state on ANY error re-opens the
 * HIGH-1 fund-lock: a truncated file (crash mid-write) reads as "empty" → the
 * dedupe + depositedPrecommitments sets reset → a re-scan re-deposits already-
 * processed inbounds at the SAME registry precommitment → nullifier collision →
 * permanent fund-lock. So: missing file → fresh empty state (fine); file exists
 * but won't parse → THROW (halt), never silently proceed with a wiped guard set.
 */
async function loadPersistedState(): Promise<{
  processedIds: Set<string>;
  depositedPrecommitments: Set<string>;
  lastScannedBlock: bigint | null;
}> {
  const { readFile } = await import("node:fs/promises");
  let raw: string;
  try {
    raw = await readFile(STATE_PATH, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Genuinely first run — no state file yet.
      return { processedIds: new Set(), depositedPrecommitments: new Set(), lastScannedBlock: null };
    }
    throw e; // permission / IO error — do NOT proceed with a blank guard set
  }
  // File EXISTS: a parse failure means corruption. HALT rather than reset the
  // fund-lock guard to empty (that is the exact regression this audit fix closes).
  let p: PersistedState;
  try {
    p = JSON.parse(raw) as PersistedState;
  } catch {
    throw new Error(
      `Forwarding engine state file is corrupt: ${STATE_PATH}. Refusing to start with an empty dedupe/precommitment set (would risk a reused-precommitment fund-lock). Inspect/repair the file or move it aside deliberately.`,
    );
  }
  return {
    processedIds: new Set(p.processedIds ?? []),
    depositedPrecommitments: new Set(p.depositedPrecommitments ?? []),
    lastScannedBlock: p.lastScannedBlock ? BigInt(p.lastScannedBlock) : null,
  };
}

/**
 * AUDIT HIGH: ATOMIC write (temp file + rename). A plain writeFile truncates
 * then writes, so a crash mid-write leaves a truncated/corrupt file. rename() is
 * atomic on the same filesystem, so a reader ever sees only the old-complete or
 * new-complete file — never a torn one.
 */
async function savePersistedState(
  state: EngineState,
  lastScannedBlock: bigint | null,
): Promise<void> {
  try {
    const { writeFile, mkdir, rename } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(STATE_PATH), { recursive: true });
    const p: PersistedState = {
      processedIds: [...state.processedIds],
      depositedPrecommitments: [...state.depositedPrecommitments],
      lastScannedBlock: lastScannedBlock !== null ? lastScannedBlock.toString() : null,
    };
    const tmp = `${STATE_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(p, null, 2));
    await rename(tmp, STATE_PATH); // atomic swap
  } catch (e) {
    err(`state save failed (continuing): ${(e as Error).message?.slice(0, 120)}`);
  }
}

/**
 * AUDIT HIGH: single-instance lock. Two concurrent --live daemons hold
 * independent in-memory dedupe sets → both deposit at the same precommitment in
 * one cycle → double-deposit fund-lock, and they tear each other's state writes.
 * Acquire an exclusive PID lockfile at startup; refuse to run if another live
 * instance holds it. Released on clean exit. Stale locks (dead PID) are reclaimed.
 */
async function acquireLock(): Promise<() => Promise<void>> {
  const { writeFile, readFile, unlink, open } = await import("node:fs/promises");
  const lockPath = `${STATE_PATH}.lock`;
  try {
    // O_EXCL: fails if the lockfile already exists (atomic create-or-fail).
    const fh = await open(lockPath, "wx");
    await fh.writeFile(String(process.pid));
    await fh.close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      // Lock exists — is the holder alive?
      let holderPid = 0;
      try {
        holderPid = Number.parseInt(await readFile(lockPath, "utf-8"), 10);
      } catch {
        /* unreadable → treat as stale */
      }
      let alive = false;
      if (holderPid > 0) {
        try {
          process.kill(holderPid, 0); // signal 0 = existence check
          alive = true;
        } catch {
          alive = false; // ESRCH → dead
        }
      }
      if (alive) {
        throw new Error(
          `Another forwarding engine instance is already running (pid ${holderPid}, lock ${lockPath}). Refusing to start a second --live daemon (would risk a double-deposit fund-lock).`,
        );
      }
      // Stale lock from a dead process — reclaim it.
      await unlink(lockPath).catch(() => {});
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
    } else {
      throw e;
    }
  }
  return async () => {
    await unlink(lockPath).catch(() => {});
  };
}

/** Load registered watched addresses + their precommitments from the registry route. */
async function loadRegistry(): Promise<
  Array<{ watchedAddress: `0x${string}`; precommitment: string }>
> {
  const res = await fetch(`${ZBASE_API}/api/forwarding/register`);
  if (!res.ok) throw new Error(`registry read failed (HTTP ${res.status})`);
  const data = (await res.json()) as {
    records: Array<{ watchedAddress: `0x${string}`; precommitment: string }>;
  };
  return data.records ?? [];
}

/** Registry-backed precommitment source. `advance` is the operator/user's job
 *  (they re-register a fresh precommitment after a deposit); here it's a no-op
 *  beyond logging, because recovery is scan-by-commitment and does not depend on
 *  a server-side index. */
function makeSource(
  registry: Array<{ watchedAddress: `0x${string}`; precommitment: string }>,
): PrecommitmentSource {
  const byAddr = new Map(registry.map((r) => [r.watchedAddress.toLowerCase(), r.precommitment]));
  return {
    async precommitmentFor(addr) {
      return byAddr.get(addr.toLowerCase()) ?? null;
    },
    async advance(addr, txHash) {
      info(`deposit landed for ${addr} tx=${txHash} — user should register a fresh precommitment`);
    },
  };
}

/** B1 authority: deposit via the SAME postman signer withdrawals use. In DRY-RUN
 *  it logs and no-ops; in --live it uses the real postman-backed deposit
 *  (src/lib/forwarding-authority.ts). Lazy-import so dry-run needs no key/stack. */
async function makeAuthority(): Promise<DepositAuthority> {
  if (!LIVE) {
    return {
      async deposit({ watchedAddress, amount, precommitment }) {
        info(
          `DRY-RUN would deposit ${amount} atomic USDC for ${watchedAddress} at precommitment=${precommitment.slice(0, 12)}…`,
        );
        return { txHash: `0x${"00".repeat(32)}` as `0x${string}` };
      },
    };
  }
  // LIVE: real deposit through the postman signer. buildDepositCall throws if the
  // active stack is un-provisioned (0x0), so we fail loudly rather than silently.
  //
  // DISARMED 2026-07-16: the B1 authority now REQUIRES a SweepAuthority.
  // Entrypoint.deposit() pulls from msg.sender, so without a sweep that first
  // moves the user's USDC to the postman, --live would deposit the POSTMAN's own
  // funds and leave the user's balance sitting in their address. Fail at STARTUP
  // rather than on the first inbound transfer — by then real money has arrived and
  // the operator is watching a queue back up instead of reading an error.
  //
  // To re-enable: implement the Phase-3 sweep (receiveWithAuthorization → postman
  // → approve → deposit), then
  //   const { createB1DepositAuthority } = await import("../src/lib/forwarding-authority");
  //   return createB1DepositAuthority(sweep);
  throw new Error(
    "--live is disabled: the B1 authority requires an EIP-3009 SweepAuthority that moves the " +
      "user's USDC to the postman BEFORE depositing. Entrypoint.deposit() pulls from msg.sender, " +
      "so running without it spends the treasury and strands user funds. See the DISARMED note " +
      "in src/lib/forwarding-authority.ts.",
  );
}

/**
 * Scan for inbound USDC Transfer logs to the watched addresses since `fromBlock`.
 * Uses the active chain's read RPC. Returns decoded InboundTransfers (only those
 * TO a watched address, non-zero). The caller tracks the last-scanned block.
 *
 * In DRY-RUN with no BASE_*_RPC set, returns [] so the loop is exercisable
 * offline. The decode/screen path is unit-tested in test-forwarding-watcher.ts.
 */
async function scanInbound(
  watched: `0x${string}`[],
  fromBlock: bigint,
): Promise<{ transfers: InboundTransfer[]; toBlock: bigint }> {
  if (watched.length === 0) return { transfers: [], toBlock: fromBlock };

  const { createPublicClient, http } = await import("viem");
  const { getActiveChain, getActiveStack } = await import("../src/lib/contracts");
  const chain = getActiveChain();
  const stack = getActiveStack();

  const client = createPublicClient({ chain: chain.chain, transport: http(chain.readRpcUrl) });
  const latest = await client.getBlockNumber();
  if (fromBlock > latest) return { transfers: [], toBlock: latest };

  const watchedSet = new Set(watched.map((a) => a.toLowerCase()));
  // Topic-filter: Transfer(from, to) where `to` is any watched address. `to` is
  // topic[2]; pass the watched set as the topic[2] filter so the RPC pre-filters.
  const toTopics = watched.map(
    (a) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as `0x${string}`,
  );

  // AUDIT MEDIUM #7 (2026-07-09): CHUNK the getLogs range. Public RPCs cap
  // eth_getLogs at ~10K blocks and rate-limit (429) — a single unbounded query
  // over a large window (long downtime / far-back FROM_BLOCK) would truncate or
  // error and SILENTLY DROP inbounds (funds sit unprivatized). Scan in ≤500-block
  // chunks with a delay, and advance `scannedTo` PER SUCCESSFUL CHUNK so a mid-way
  // RPC failure resumes from the last good block instead of skipping ahead.
  const CHUNK = 500n;
  const transfers: InboundTransfer[] = [];
  let scannedTo = fromBlock - 1n; // highest block fully scanned this call
  for (let start = fromBlock; start <= latest; start += CHUNK) {
    const end = start + CHUNK - 1n < latest ? start + CHUNK - 1n : latest;
    let logs;
    try {
      logs = await client.getLogs({
        address: stack.usdc,
        topics: [TRANSFER_TOPIC as `0x${string}`, null, toTopics],
        fromBlock: start,
        toBlock: end,
      });
    } catch (e) {
      // AUDIT LOW fix: a chunk failure (RPC 429 / range error) must NOT discard
      // the chunks already scanned. Return what we have with `scannedTo` at the
      // last GOOD block, so the caller advances only past confirmed-scanned
      // ranges and the next cycle resumes from `scannedTo + 1` — the per-chunk
      // resume the comment promises (previously the throw propagated out and
      // discarded all partial progress).
      err(`scan chunk [${start},${end}] failed: ${(e as Error).message?.slice(0, 120)} — resuming from ${scannedTo + 1n} next cycle`);
      return { transfers, toBlock: scannedTo };
    }
    for (const log of logs) {
      const decoded = decodeInboundTransfer(
        {
          topics: log.topics as string[],
          data: log.data,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        },
        watchedSet,
      );
      if (decoded) transfers.push(decoded);
    }
    scannedTo = end; // this chunk succeeded → safe to advance past it
    if (end < latest) await new Promise((r) => setTimeout(r, 500)); // rate-limit courtesy
  }
  return { transfers, toBlock: scannedTo };
}

async function main() {
  info(`starting — ${LIVE ? "LIVE" : "DRY-RUN"} mode, poll=${POLL_SECONDS}s, cap=$${MAX_SPEND_USDC}`);
  if (LIVE) info("⚠️  LIVE mode: real deposits. Ensure POSTMAN key + registry are provisioned.");

  // AUDIT HIGH: single-instance lock (LIVE only — dry-run moves no funds). Two
  // concurrent live daemons would double-deposit at the same precommitment.
  let releaseLock: (() => Promise<void>) | null = null;
  if (LIVE) {
    releaseLock = await acquireLock();
    info("acquired single-instance lock");
  }

  // AUDIT MEDIUM #7: restore persisted dedupe state + scan cursor so a restart
  // doesn't re-process already-deposited inbounds. HALTS on a corrupt state file
  // rather than silently resetting the fund-lock guard (audit HIGH).
  const persisted = await loadPersistedState();
  const state: EngineState = {
    processedIds: persisted.processedIds,
    depositedPrecommitments: persisted.depositedPrecommitments,
    spentThisRun: 0n,
  };
  info(
    `restored state: ${state.processedIds.size} processed, ${state.depositedPrecommitments.size} precommitments used`,
  );
  const maxSpendAtomic = BigInt(Math.round(MAX_SPEND_USDC * 1e6));
  const minAmountAtomic = BigInt(Math.round(MIN_USDC * 1e6));

  // Scan cursor: prefer the persisted cursor, then an operator override, then null
  // (first-run → head-lookback). Persisted wins so a restart resumes, not rescans.
  let lastScannedBlock: bigint | null =
    persisted.lastScannedBlock ??
    (process.env.ZBASE_FORWARDING_FROM_BLOCK
      ? BigInt(process.env.ZBASE_FORWARDING_FROM_BLOCK)
      : null);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    info("shutdown signal — finishing current pass then exiting");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let cycle = 0;
  while (!stopping) {
    cycle += 1;
    try {
      const registry = await loadRegistry();
      const watched = registry.map((r) => r.watchedAddress);
      info(`cycle=${cycle} watching ${watched.length} address(es)`);

      // In DRY-RUN with no RPC configured, skip the on-chain scan (offline loop).
      const rpcConfigured = !!(process.env.BASE_SEPOLIA_RPC || process.env.BASE_MAINNET_RPC);
      let inbound: InboundTransfer[] = [];
      if ((LIVE || rpcConfigured) && watched.length > 0) {
        const { getActiveChain } = await import("../src/lib/contracts");
        const startBlock =
          lastScannedBlock ??
          (await (async () => {
            // First cycle with no configured start: begin from the current head
            // minus a small lookback so we don't rescan all history.
            const { createPublicClient, http } = await import("viem");
            const c = createPublicClient({
              chain: getActiveChain().chain,
              transport: http(getActiveChain().readRpcUrl),
            });
            const head = await c.getBlockNumber();
            return head > 100n ? head - 100n : 0n;
          })());
        const scan = await scanInbound(watched, startBlock);
        inbound = scan.transfers;
        lastScannedBlock = scan.toBlock + 1n; // next cycle starts after this
      }

      const { pending, quarantined, screened } = await screenInbound(inbound, {
        seenIds: state.processedIds,
      });
      if (screened > 0) {
        info(`cycle=${cycle} screened=${screened} clean=${pending.length} quarantined=${quarantined.length}`);
        for (const q of quarantined) {
          err(`QUARANTINED tainted inbound from ${q.payer} (${q.reasonCode}) — NOT deposited`);
        }
      }

      const result = await processPendingDeposits(
        pending,
        await makeAuthority(),
        makeSource(registry),
        state,
        { maxSpendAtomic, minAmountAtomic },
      );
      if (result.deposited.length) info(`cycle=${cycle} deposited=${result.deposited.length}`);
      if (result.failed.length) err(`cycle=${cycle} failed=${result.failed.length} (will retry)`);

      // AUDIT MEDIUM #7: persist AFTER processing so a crash/restart resumes with
      // the dedupe set + scan cursor intact (no re-process, no dropped inbounds).
      await savePersistedState(state, lastScannedBlock);
    } catch (e) {
      err(`cycle=${cycle} error: ${(e as Error).message?.slice(0, 200)}`);
      // Persist the cursor even on a partial-cycle error so we don't lose progress.
      await savePersistedState(state, lastScannedBlock);
    }

    if (RUN_ONCE) {
      info("--once set, exiting");
      if (releaseLock) await releaseLock();
      return;
    }
    const end = Date.now() + POLL_SECONDS * 1000;
    while (!stopping && Date.now() < end) {
      await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
    }
  }
  if (releaseLock) await releaseLock();
  info("exited cleanly");
}

main().catch((e) => {
  err(`fatal: ${(e as Error).stack || (e as Error).message}`);
  process.exit(1);
});
