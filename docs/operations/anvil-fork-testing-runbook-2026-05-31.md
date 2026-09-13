# Anvil Fork Testing — Operator Runbook

**Date:** 2026-05-31
**Owner:** Founder / CTO
**Scope:** Local rehearsal of Base Sepolia (chain 84532) via Foundry anvil fork.
**Cost:** $0. Resets on every anvil restart.
**Related:** `docs/operations/seed-phase0-runbook-2026-05-31.md` (the real-Sepolia runbook this rehearses).

---

## TL;DR

Run `./scripts/anvil-fork-sepolia.sh` to spin up a local fork of Base Sepolia
with $10K USDC + 100 ETH at the treasury. Then run
`./scripts/seed-phase0-local.sh` to test the full seed pipeline against the
fork. Costs $0. Resets on every anvil restart.

```bash
./scripts/anvil-fork-sepolia.sh              # one terminal, leave running
./scripts/seed-phase0-local.sh --dry-run-only # plan only
./scripts/seed-phase0-local.sh               # live run against the fork
./scripts/anvil-fork-sepolia.sh --stop       # tear down
```

---

## Why this exists

The founder doesn't have $1,600 testnet USDC yet. Phase 0 needs:

- ≥ 0.05 ETH for gas across 30 deposits
- ≥ $1,600 USDC across $10 + $50 + $100 denominations

This harness forks live Base Sepolia at the current block and **cheats** the
treasury's ETH + USDC balances via anvil RPC calls. Everything else
(contracts, IRM rates, Morpho pool state) is real, fetched lazily from the
upstream RPC.

### Use cases

- **Rehearse Phase 0 seed** end-to-end before requesting USDC from
  faucet.circle.com — verify dry-run, env loading, regression gate, the
  3000ms inter-deposit cadence, the encrypted notes file, summary block.
- **Test the resume-bug fix under realistic conditions:** start anvil, run
  seed-phase0-local.sh, kill seed with Ctrl-C after ~5 deposits, restart the
  seed — verify it picks up at deposit #6 with no double-deposits. (Detail
  in §5.)
- **Test the decoy scheduler** against forked state without burning Sepolia
  ETH or polluting the public anonymity set.
- **Test new contract deploys** (ThresholdEntrypoint, UTXOPool, future
  iterations) without spending Sepolia gas — `forge create --rpc-url
  http://localhost:8545` against the fork.
- **Reproduce a real-Sepolia bug** by forking at the bad block:
  `BLOCK_NUMBER=<n> ./scripts/anvil-fork-sepolia.sh` (anvil reads
  `--fork-block-number` from env if you wire it up; current script forks at
  head).

---

## Pre-flight

1. **Foundry installed.**
   ```bash
   anvil --version   # expect 1.5.x-stable
   cast --version    # expect 1.5.x-stable
   ```
   If missing: `curl -L https://foundry.paradigm.xyz | bash && foundryup`.

2. **`.env.local` has `BASE_SEPOLIA_RPC`.** The fork uses your existing
   upstream RPC URL (Infura/Alchemy/HyperSync). The fork-url is **read from
   `.env.local`** by the script and never echoed to stdout/stderr.

3. **Treasury address matches the Phase 0 config.** Default in both the
   script and `scripts/seed-pools.phase0.config.json`:
   `0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843`. If you've rotated the
   treasury, export `TREASURY_ADDRESS` before running.

4. **Port 8545 free.** Override with `ANVIL_PORT=8546 ...` if not.

---

## 5-step quick start

```bash
# 1. Spin up the fork + fund treasury (one terminal, leave running)
./scripts/anvil-fork-sepolia.sh

# 2. Verify balances landed
./scripts/anvil-fork-sepolia.sh --status
# expect: ETH: 100.0  /  USDC: 10000.000000

# 3. (Optional) preview the plan with no tx
./scripts/seed-phase0-local.sh --dry-run-only

# 4. Live seed against the fork (still $0 — no real chain)
./scripts/seed-phase0-local.sh

# 5. When done, stop anvil + clean up the pidfile
./scripts/anvil-fork-sepolia.sh --stop
```

That's it. The whole loop takes ~3 minutes the first time, ~90 seconds on
re-runs once you trust the cadence.

---

## How the funding works (slot-9 cheat)

USDC on Base Sepolia (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) is a
proxy that has no public `mint(address,uint256)` callable by random
addresses — only the bridge/issuer can mint. We side-step that with a
storage cheat:

- ETH: `anvil_setBalance(addr, 0x<wei>)` — first-class anvil RPC.
- USDC: `anvil_setStorageAt(usdc, keccak256(addr ++ slot=9), <balance>)`.
  Slot 9 holds the `balanceOf` mapping for Circle USDC on Base Sepolia
  (verified empirically by `cast storage 0x036CbD... $(cast index address
  <addr> 9)` on 2026-05-31).

This bypasses the minter ACL entirely — anvil writes directly to EVM state
on its forked copy. The upstream chain is never touched.

**Risk:** if Circle ever upgrades the USDC implementation and the storage
layout shifts (e.g. balanceOf moves to slot 51 in an OpenZeppelin upgrade,
or the contract adds a base-class field), this script will silently mint
**zero USDC** — the storage write succeeds against a slot that no longer
maps to balances. See "Failure modes" (c) below for the re-discovery
procedure.

---

## Re-funding between runs

The seed pipeline leaves the treasury at roughly `$10000 - $1600 = $8400
USDC + ~99.97 ETH`, so a second test run still has plenty of budget. But
if you want a clean slate without restarting anvil:

```bash
./scripts/anvil-fork-sepolia.sh --mint-only
```

This re-runs only the funding step (assumes anvil is already up). Same env
vars apply: `MINT_USDC=50000 MINT_ETH=200 ./scripts/anvil-fork-sepolia.sh
--mint-only` for a beefier top-up.

---

## §5. Testing the resume-bug fix specifically

Commit `866d625` fixed a bug where the seeder would replay already-landed
deposits if it was killed mid-run. The regression tests cover the unit-level
behaviour; this harness lets you test it end-to-end without spending USDC.

```bash
# Terminal A: fork up
./scripts/anvil-fork-sepolia.sh

# Terminal B: start the live seed run
./scripts/seed-phase0-local.sh
# When prompted, type 'yes' and wait through the 5s countdown.
# Watch the deposits land:  [1/30] USDC 10 tx=0x...  [2/30] ...

# After ~5 deposits land, slam Ctrl-C in terminal B.
# The encrypted notes file at data/seed-notes.phase0.encrypted.json
# should now contain 5 notes.

# Re-start the seed:
./scripts/seed-phase0-local.sh
# Expect the log to show:
#   [1/30] SKIP commit=...   (already in prior notes)
#   [2/30] SKIP ...
#   ...
#   [5/30] SKIP ...
#   [6/30] USDC 10 tx=0x... commit=...   <-- resumes here
#
# If you see [1/30] USDC 10 tx=0x... (no SKIP), the resume bug has regressed.
# Stop, do NOT touch real Sepolia, page CTO.

# Summary block should report:
#   Deposits executed (new):    25
#   Deposits skipped (resumed):  5
```

This is the highest-signal test for the regression — it exercises the same
RPC interface, the same encrypted-notes file format, the same wallet client,
and the same gap timer as the real run, all for $0.

---

## Failure modes

### (a) Anvil port already in use

Symptom on start:
```
[anvil-fork] anvil PID 12345 ... [exits immediately]
[anvil-fork] WARN: tail of .anvil-fork.log:
Address already in use
```

**Fix:** another anvil (or anything) is on port 8545. Either kill it
(`lsof -i :8545` then `kill <pid>`) or run on a different port:

```bash
ANVIL_PORT=8546 ./scripts/anvil-fork-sepolia.sh
ANVIL_PORT=8546 ./scripts/seed-phase0-local.sh
```

### (b) Upstream fork RPC down or rate-limited

Symptom: anvil starts but `cast block-number --rpc-url http://localhost:8545`
hangs or returns errors. The fork lazily fetches state, so a dead upstream
breaks every subsequent call.

**Fix:**
1. Stop anvil: `./scripts/anvil-fork-sepolia.sh --stop`.
2. Test the upstream directly: `cast block-number --rpc-url "$BASE_SEPOLIA_RPC"`.
3. If the upstream is dead, swap `BASE_SEPOLIA_RPC` in `.env.local` to a
   different provider (Alchemy, public `sepolia.base.org`) and re-start.

### (c) USDC slot 9 wrong (Circle upgraded the proxy)

Symptom: `--status` reports `USDC: 0.000000` even though the script said
"OK: treasury funded".

**Fix:** re-discover the balanceOf slot.

```bash
# Pick a known holder (e.g. the deployer wallet from BaseScan).
HOLDER=0x...
# Probe slots 0–20:
for slot in $(seq 0 20); do
  key=$(cast index address $HOLDER $slot)
  val=$(cast storage 0x036CbD53842c5426634e7929541eC2318f3dCF7e $key --rpc-url $BASE_SEPOLIA_RPC)
  # Whichever slot returns a nonzero value matching the holder's actual
  # balance is the right one.
  echo "slot=$slot val=$val"
done
```

Then patch `scripts/anvil-fork-sepolia.sh` — search for `cast index address
"$TREASURY_ADDRESS" 9` and replace `9` with the discovered slot. Document
the change in `CLAUDE.md` under "Critical Gotchas".

### (d) Stale `.anvil-fork.pid`

Symptom on start:
```
[anvil-fork] FATAL: anvil already running (PID 12345, pidfile .anvil-fork.pid)
```

…but `ps -p 12345` shows no such process (you killed it via Activity Monitor
or it was OOMed). The script's own start-check is conservative on purpose —
it only auto-removes the pidfile when it can confirm the PID is dead via
`kill -0`. If `kill -0` somehow gets confused (rare; usually means the PID
was recycled), force-cleanup:

```bash
rm -f .anvil-fork.pid
./scripts/anvil-fork-sepolia.sh
```

### (e) Seeder reports "not enough USDC" mid-run

Shouldn't happen with the default $10K mint, but if `MINT_USDC=1000` was
exported, the run will revert on deposit 17ish. The fix is just to top-up:

```bash
MINT_USDC=20000 ./scripts/anvil-fork-sepolia.sh --mint-only
./scripts/seed-phase0-local.sh   # resume from where it died
```

This also doubles as a deliberate way to test the seeder's resume behaviour
under "insufficient balance" failures.

---

## What this does NOT test

- **Real Sepolia gas pricing.** Anvil uses default gas params; the real
  chain has occasional spikes. You may discover a gas-related issue only on
  the real run.
- **Real Sepolia confirmation latency.** Anvil mines instantly; the real
  chain takes ~2s/block. Inter-deposit cadence (`depositGapMs: 3000`) is
  intentionally larger than real block time so this gap shouldn't matter,
  but a real run will feel slower.
- **Real Infura/Alchemy rate limits.** The fork RPC is hit only for state
  reads, not writes; the real run hits the write RPC much harder. If
  Phase 0 ever ratelimits in production, you'll need to verify on real
  Sepolia.
- **CDP/x402 facilitator interactions.** The fork is just the chain — the
  facilitator/postman services run separately and don't know about your
  local anvil. Don't try to test ASP root updates against the fork without
  pointing the postman at it too.
- **Actually getting USDC into a fresh withdrawer wallet.** Withdrawal
  flows do work against the fork (the verifier contract is forked along
  with everything else), but the "fresh wallet" gets fork-only USDC. Don't
  confuse fork ETH/USDC with real testnet ETH/USDC — they live in different
  state trees.

**Bottom line:** the fork harness gets you ~85% confidence the Phase 0 push
will go cleanly. The remaining 15% (real gas, real latency, real rate
limits) still requires the real Sepolia run with real testnet USDC. The
fork lets you fix the obvious mistakes (env-var typos, regression-test
failures, stale ASP root, encrypted notes file path) for $0, so you only
spend testnet USDC on bugs that genuinely require the real chain.

---

## Companion files

- `scripts/anvil-fork-sepolia.sh` — fork + fund + start/stop/status/mint-only
- `scripts/seed-phase0-local.sh` — thin wrapper that points seed-phase0 at the fork
- `scripts/seed-phase0.sh` — the real-Sepolia runbook (unchanged; this rehearses it)
- `docs/operations/seed-phase0-runbook-2026-05-31.md` — the real-Sepolia operator doc
- `scripts/seed-pools.phase0.config.json` — Phase 0 plan
- `.anvil-fork.pid` — runtime pidfile (gitignored)
- `.anvil-fork.log` — runtime anvil log (gitignored)
