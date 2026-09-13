# Seed Phase 0 — Operator Runbook

**Date:** 2026-05-31
**Owner:** CEO (operator) / CTO (on-call)
**Scope:** Base Sepolia (chain 84532). Phase 0 = 30 deposits × ($10 + $50 + $100) = **$1,600 USDC + ~0.03 ETH gas**.
**Run time:** ~3 minutes end-to-end (regression tests + dry-run + live run).
**Related:** `docs/release/base-sepolia-push-runbook-2026-05-31.md` §3 (broader push context), `docs/seed-pool/execution-checklist-2026-05-31.md` (long-form checklist).

---

## 1-minute version (the happy path)

```bash
# 1. Make sure .env.local has TREASURY_PRIVATE_KEY, ZBASE_SEED_ENCRYPTION_KEY,
#    and BASE_SEPOLIA_RPC.  See §3 below for how to generate the encryption key.
# 2. Run:
./scripts/seed-phase0.sh
# 3. Confirm the plan when prompted, wait for the 5-second countdown to expire,
#    then watch ~30 deposits land over ~90 seconds.
# 4. Back up data/seed-notes.phase0.encrypted.json off-host.
```

That is the whole flow when nothing goes wrong. The rest of this doc is the
why and what-if.

---

## 5-minute version (with pre-flight)

### 2.1 What `seed-phase0.sh` does for you

1. Sources `.env.local` (without overriding any var you already have exported).
2. Verifies `TREASURY_PRIVATE_KEY`, `ZBASE_SEED_ENCRYPTION_KEY`, `BASE_SEPOLIA_RPC` are set, and that the encryption key is 64 hex chars.
3. Verifies `scripts/seed-pools.phase0.config.json` exists.
4. Runs `npm run test:seed-pools` (regression gate — refuses to proceed unless 10/10 pass; this catches a regression of the resume fix in commit `866d625`).
5. Runs `tsx scripts/seed-pools.ts --config <phase0> --dry-run` so the operator can see the plan before any tx fires.
6. Prompts for a literal `yes` confirmation, then waits 5 seconds (Ctrl-C to abort).
7. Runs the live seed, with all stdout/stderr captured to `data/seed-phase0-run-<UTC-timestamp>.log`.
8. Verifies the encrypted notes file was written.
9. Prints a summary: deposit count, first/last tx hashes, paths to the notes file and the log.

### 2.2 Flags

| Flag | When to use |
|---|---|
| `--dry-run-only` | You want to see the plan without committing — useful after editing the config, or before a CEO sign-off meeting |
| `--skip-tests` | Discouraged. Only if you cannot run tests on this host (e.g. CI runner that hasn't installed dev deps). The script prints a warning and proceeds |
| `--help` | Prints usage and exits |

### 2.3 Pre-flight env checks (manual, optional)

You can sanity-check before running the wrapper:

```bash
# Treasury matches config?  Expect: 0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843
node -e "
import('viem/accounts').then(({privateKeyToAccount}) => {
  const k = process.env.TREASURY_PRIVATE_KEY;
  const a = privateKeyToAccount(k.startsWith('0x') ? k : '0x'+k);
  console.log(a.address);
})"

# Encryption key is 64 hex?
node -e "console.log(/^[0-9a-fA-F]{64}$/.test(process.env.ZBASE_SEED_ENCRYPTION_KEY))"

# Generate a fresh encryption key (do this in a private shell, then store it in 1Password)
openssl rand -hex 32
```

### 2.4 Expected output

`seed-phase0.sh` will stream something like this:

```
[seed-phase0] sourcing /path/to/.env.local (existing env vars take precedence)
[seed-phase0] validating environment
[seed-phase0] OK: env vars present (treasury key, encryption key, RPC URL)
[seed-phase0] OK: config file present: scripts/seed-pools.phase0.config.json
[seed-phase0] running regression gate: npm run test:seed-pools (expect 10/10 PASS)
  PASS  loadConfig: 100 planned deposits
  ... (10 PASS lines) ...
  10 passed, 0 failed
[seed-phase0] OK: regression gate: 10/10 PASS
[seed-phase0] running DRY-RUN to print the plan (no on-chain tx)

== zBase Anonymity-Set Seeder — DRY RUN ==
  TOTAL DEPOSITS: 30
  Plan is valid. Re-run without --dry-run to execute.

[seed-phase0] OK: dry-run complete
[seed-phase0] PLAN ABOVE. This run will spend real Base Sepolia USDC + ETH.
Type 'yes' to confirm, anything else to abort: yes
[seed-phase0] operator confirmed. Starting 5-second countdown — Ctrl-C to abort.
  5...
  4...
  ...
[seed-phase0] GO.
[seed-phase0] logging to /path/to/data/seed-phase0-run-20260531T184500Z.log

== DEPOSITS ==
  [1/30] USDC 10 tx=0xabc... commit=12345...
  [2/30] USDC 10 tx=0xdef... commit=67890...
  ... (~3s between deposits) ...
  [30/30] USDC 100 tx=0xxyz... commit=99999...

== DONE ==
  Total deposits: 30
  Encrypted notes: data/seed-notes.phase0.encrypted.json

[seed-phase0] OK: encrypted notes file written: /path/to/data/seed-notes.phase0.encrypted.json

========== Phase 0 seed summary ==========
  Deposits executed (new):  30
  Deposits skipped (resumed): 0
  Encrypted notes path:     /path/to/data/seed-notes.phase0.encrypted.json
  Run log:                  /path/to/data/seed-phase0-run-20260531T184500Z.log
  First deposit tx:         0xabc...
  Last deposit tx:          0xxyz...
  Verify on BaseScan:       https://sepolia.basescan.org/tx/0xxyz...
```

### 2.5 After the run

1. **Back up the encrypted notes file** off-host. Phase 0 is $1,600 of testnet USDC, but practice the discipline now: upload to S3 with object lock, or paste into 1Password as a secure note. Record the SHA-256.
2. **Confirm the encryption key is backed up.** For mainnet, Shamir 3-of-5 per `docs/seed-pool/risk-analysis-2026-05-31.md` §5. For Sepolia Phase 0, even a 1Password entry is fine — but if you lose it, the $1,600 is unrecoverable.
3. **Refresh the ASP root** so the new deposits become withdrawable:
   ```bash
   curl -X POST http://localhost:3009/api/asp-update
   ```
4. **Update `STATUS.md`** with the new anonymity-set size (see push runbook §6.2).

---

## 3. Failure mode catalog

### (a) Regression tests fail

The wrapper exits before any tx fires. Symptom:

```
[seed-phase0] FATAL: regression tests failed. Refusing to proceed...
```

**What happened:** `npm run test:seed-pools` reported < 10/10. The most likely cause is that the resume fix in commit `866d625` regressed (tests 8/9/10 are the ones that protect it).

**Fix:**
1. Re-run the suite manually to see which test(s) failed:
   ```bash
   npm run test:seed-pools
   ```
2. Run the targeted drill for extra signal:
   ```bash
   ./scripts/test-crash-resume-drill.sh
   ```
3. If tests 8/9/10 are red, **STOP**. Page CTO. Do NOT proceed — running seed-pools.ts live in this state could double-deposit on any crash-restart.
4. If tests 1–7 are red but 8/9/10 are green, you can technically bypass with `--skip-tests`, but investigate first — it usually means a dependency drift (`yarn install` in the monorepo root, or `npm install` in this repo).

### (b) Treasury wallet has insufficient balance

The wrapper itself does NOT pre-check balance — the seed script will surface this as a revert mid-run. Symptom:

```
[N/30] USDC 10 tx=0x... commit=...
Deposit N+1 reverted. tx=0x...
```

**Fix:**
1. Open the failed tx on BaseScan (the script prints the hash). Look for `ERC20: transfer amount exceeds balance` or `insufficient funds for gas`.
2. Top up the treasury:
   - **USDC:** [faucet.circle.com](https://faucet.circle.com) (Base Sepolia)
   - **ETH:** any Base Sepolia faucet
3. Re-run `./scripts/seed-phase0.sh`. The resume logic will skip the N deposits already recorded in `data/seed-notes.phase0.encrypted.json` and continue from N+1.

Before re-running, sanity-check minimums: **≥ $1,600 USDC × 1.01** (1% vetting fee buffer) and **≥ 0.05 ETH** for 30 × ~1M gas deposits.

### (c) RPC rate-limits

Symptoms: `429 Too Many Requests`, `RPC timeout`, deposits hanging for > 30s with no progress.

**Fix:**
1. Stop the run (Ctrl-C). The encrypted notes file is updated after each successful deposit, so anything that landed on-chain is recorded.
2. Switch `BASE_SEPOLIA_RPC` in `.env.local` to a less-rate-limited endpoint:
   - Alchemy / Infura with your API key > `sepolia.base.org` public RPC
   - The seed script uses `BASE_SEPOLIA_RPC` for reads but **always uses `https://sepolia.base.org` for the wallet-client writes** (see `scripts/seed-pools.ts` line ~369). Heavy use may rate-limit even with a private read RPC. Add `depositGapMs: 5000` or higher to the config if rate-limited.
3. Re-run `./scripts/seed-phase0.sh`. Resume picks up where you left off.

### (d) A deposit reverts mid-run

Symptom:

```
Deposit N reverted. tx=0xabc...
```

**Do NOT re-run blindly.** First, check BaseScan for the tx hash:

- **If the tx truly reverted** (status: Failed): the encrypted notes file does NOT have an entry for it. Resume will retry it. Safe to re-run after fixing the root cause (gas, balance, allowance — see (b)).
- **If the tx actually succeeded** (status: Success) but the script saw a timeout/error: the encrypted notes file is missing this note. Resume will replay it = **DOUBLE DEPOSIT** of that $X. Two options:
  1. Manually patch the encrypted notes file with the missing note (CTO assistance recommended — the file is AES-256-GCM encrypted; you'll need to decrypt → append → re-encrypt). The note fields are derived from the on-chain `Deposited` event (commitment, label, value).
  2. Subtract the orphan deposit from the planned count in `seed-pools.phase0.config.json` (decrement one of the `denomCount` entries by 1), then re-run. You'll need to manually reclaim that orphan deposit later; record the nullifier/secret pair from the script's pre-revert log line.

Either path: **page CTO before touching the encrypted notes file.**

### (e) Encrypted notes file appears corrupted

Symptom on a resume run:

```
[seed-phase0] Refusing to resume: data/seed-notes.phase0.encrypted.json uses unsupported cipher ...
```
or
```
Refusing to resume: cannot decrypt prior notes file with the current ZBASE_SEED_ENCRYPTION_KEY
```

**Fix:**
1. **Do NOT delete the file.** It contains your treasury secrets even if it looks unreadable. Move it aside:
   ```bash
   mv data/seed-notes.phase0.encrypted.json data/seed-notes.phase0.encrypted.json.bak-$(date -u +%s)
   ```
2. Verify your `ZBASE_SEED_ENCRYPTION_KEY` is the **same key** you used for the original run. If you regenerated it, you cannot decrypt the old file — restore the original from your backup (1Password / S3).
3. If the key is correct and the file is genuinely corrupted (incomplete write from a kernel panic, disk full, etc.): the on-chain deposits in the corrupted file are unrecoverable to *you* but still in the anonymity set (so the set itself is fine — you just lose the ability to reclaim those treasury commitments).
4. If you must keep going without recovery: start fresh by removing the (moved-aside) file and re-running. Phase 0 plan will execute as a brand-new run. Document in `STATUS.md` that the prior partial run is treasury-locked-out.

---

## 4. Verifying the resume fix without running live

If you want a high-signal check that the resume-after-crash safety property is intact — without spending any USDC — run the offline drill:

```bash
./scripts/test-crash-resume-drill.sh
```

This is a thin wrapper over the 3 regression tests in `scripts/test-seed-pools.ts` that specifically cover the bug fixed in commit `866d625`:

- Test 8: `loadPriorNotesForResume` returns `[]` when no file exists
- Test 9: `loadPriorNotesForResume` round-trips a partial prior run
- Test 10: `loadPriorNotesForResume` refuses to clobber with a wrong key

The drill is purely offline (no RPC, no signing, synthetic notes) — safe to run anywhere, anytime. If it goes red, the resume safety has regressed; do not proceed with `seed-phase0.sh`.

---

## 5. Out of scope (intentional)

- **No mainnet.** Phase 0 is Sepolia-only. The wrapper validates `BASE_SEPOLIA_RPC` but does not check chain ID — the config does (`chainId: 84532`).
- **No automatic ASP root refresh.** The wrapper prints the curl command in its summary; the operator runs it manually so they can verify the postman service is healthy first.
- **No automatic STATUS.md update.** Manual per push-runbook §6.2 — the operator should review the run before claiming new commitments in the public anonymity-set disclosure.
- **No mainnet-style key custody enforcement.** The wrapper checks key format only, not whether it has been Shamir-sharded. That discipline lives in `docs/seed-pool/risk-analysis-2026-05-31.md` §5 and is enforced by checklist, not code.

---

*Companion scripts:*
- `scripts/seed-phase0.sh` — this runbook's main verb
- `scripts/test-crash-resume-drill.sh` — offline regression drill
- `scripts/seed-pools.ts` — the actual seeder (do not invoke directly unless you know why)
- `scripts/seed-pools.phase0.config.json` — Phase 0 plan (30 deposits, $1,600 total)
