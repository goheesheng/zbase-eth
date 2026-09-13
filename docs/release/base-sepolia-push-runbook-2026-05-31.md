# Base Sepolia Push — Founder Runbook

**Date:** 2026-05-31
**Operator:** CEO (signing) + CTO (on-call)
**Target:** Base Sepolia testnet (chain 84532). **NOT mainnet.**
**Branch:** `integration-test` @ `866d625`
**Estimated total wall-clock:** ~60 minutes end-to-end
**Companion:** `base-sepolia-push-readiness-2026-05-31.md` (this directory)

> Status: PLANNING ARTIFACT. No command in this doc has been executed by Claude. The
> founder is expected to run each step manually and confirm output before proceeding
> to the next.

**Cardinal rules**
1. Do not push to `main`. `main` auto-deploys to `zbase.app`. Stay on `integration-test`.
2. Do not run any command in §3 (Seed pool) until §1 pre-flight is fully green.
3. If any step says **STOP**, page the CTO. Do not improvise.

---

## 0. Step-by-step overview

| § | Stage | Wall-clock | Blocking? |
|---|---|---|---|
| 1 | Pre-flight: env + balance + tests | 15 min | **MUST** |
| 2 | Smoke E2E (1 USDC) | 15 min | **MUST** |
| 3 | Seed pool Phase 0 (30 × ~$53 = $1,600) | 10 min | RECOMMENDED |
| 4 | Decoy scheduler bring-up | 5 min | NICE-TO-HAVE |
| 5 | Stealth provider smoke registration | 5 min | NICE-TO-HAVE |
| 6 | Post-flight: BaseScan verification + STATUS.md + announcement | 10 min | **MUST after §2; SHOULD after §3** |

---

## 1. Pre-flight (15 min)

### 1.1 Branch hygiene

```bash
cd /Users/eesheng_eth/Desktop/zx402
git status                              # expect: on integration-test, clean working tree
git fetch origin integration-test
git log --oneline -1                    # expect HEAD = 866d625 (seed-pools resume fix)
git rev-list --count HEAD..origin/integration-test
# expected output: 0   (you are current with the remote)
```

**Expected output:** branch `integration-test`, working tree clean, HEAD matches remote.
**Rollback if it fails:** stash uncommitted work (`git stash push -m "pre-push-$(date -u +%s)"`) and re-run. If still divergent, page CTO before continuing.

### 1.2 Env vars

Required in `/Users/eesheng_eth/Desktop/zx402/.env.local`:

| Var | Currently in `.env.local`? | Required for |
|---|---|---|
| `BASE_SEPOLIA_RPC` | YES (line 13) | every step |
| `POSTMAN_PRIVATE_KEY` | YES (line 12) | §2 E2E + §4 decoy + ASP root updates |
| `HYPERSYNC_TOKEN` | YES (line 14) | §2 E2E (deposit log scan) + §4 decoy |
| `TREASURY_PRIVATE_KEY` | **NOT PRESENT — MUST ADD** | §3 seed pool |
| `ZBASE_SEED_ENCRYPTION_KEY` | **NOT PRESENT — MUST ADD** | §3 seed pool |

Generate and add the missing two (do this in a terminal with shell history disabled,
or trust the `.env.local` permissions):

```bash
# In a private shell (e.g. zsh `setopt HIST_NO_STORE` first, or use a subshell):
openssl rand -hex 32      # this is your ZBASE_SEED_ENCRYPTION_KEY value (64 hex chars)
```

Then edit `.env.local` (do **NOT** use `sed -i ''` per `CLAUDE.md` — it can wipe the
file on failure; use a real editor):

```
TREASURY_PRIVATE_KEY=0x<private key of 0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843>
ZBASE_SEED_ENCRYPTION_KEY=<the openssl output above>
```

**Back up `ZBASE_SEED_ENCRYPTION_KEY` to 1Password / a hardware-backed store before
you continue.** Without it, every seed-deposit dollar is unrecoverable. See
`docs/seed-pool/risk-analysis-2026-05-31.md` §5 for the recommended Shamir 3-of-5
split — for Sepolia Phase 0 ($1,600 of testnet USDC) the calculus is much softer,
but practice the discipline now.

**Rollback if you can't generate / store keys safely:** skip §3 entirely. §2 + §4 + §5
do not require the treasury key. The push is still useful without the seed pool;
just defer the anonymity-set bootstrap.

### 1.3 Treasury balance

```bash
# Use any reliable Base Sepolia public balance read; example via curl:
TREASURY=0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843
RPC=$(grep '^BASE_SEPOLIA_RPC=' .env.local | cut -d= -f2-)

# ETH balance — need ≥ 0.05 ETH for ~30 deposits @ 1M gas
curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBalance\",\"params\":[\"$TREASURY\",\"latest\"],\"id\":1}"

# USDC balance — need ≥ 1,600 USDC for Phase 0
USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
DATA=$(printf '0x70a08231%064s' "${TREASURY:2}" | tr ' ' '0')
curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$USDC\",\"data\":\"$DATA\"},\"latest\"],\"id\":1}"
```

**Expected:** ETH ≥ 0.05 (hex `0xb1a2bc2ec50000`), USDC ≥ 1,600 × 10^6 = 1,600,000,000
(hex `0x5f5e1000` for 100 USDC reference).
**Rollback if balances are short:** top up from a Base Sepolia faucet (USDC:
[circle.com/usdc](https://faucet.circle.com), ETH: any Base Sepolia faucet). Skip §3
if topping up is not feasible today.

### 1.4 Foundry suite

```bash
cd /Users/eesheng_eth/Desktop/zx402
forge test -vv 2>&1 | tee runs/foundry-pre-push-$(date -u +%Y%m%dT%H%M%SZ).log
```

**Expected:** `Suite result: ok. 50 passed; 0 failed; 0 skipped` (or higher count if
new tests were added since `STATUS.md` was written).
**Rollback if any test fails:** **STOP.** Do not push. Investigate; rerun from §1.4.
A foundry regression means a `git pull` or stale lib state — `forge install` then
retry. If still red, page CTO.

### 1.5 Script test suites

```bash
npm run test:seed-pools              # expect 10/10 (after commit 866d625)
npx tsx scripts/test-stealth.ts      # expect 100/100 stealth invariants
npx tsx scripts/test-providers-route.ts   # expect 8/8 (provider registry)
npm run test:curl                    # expect 18/18 endpoints (needs no chain)
```

**Expected:** all green.
**Rollback if `test:seed-pools` is < 10/10:** the resume fix regressed. **STOP § 3**;
do not run any live seed-pool command. §2 + §4 + §5 are still safe.
**Rollback if other suites fail:** investigate before pushing. None of these need a
live chain, so a failure is a local-environment or code regression.

---

## 2. Smoke E2E (15 min)

This proves the existing deployed entrypoint + Morpho pool + ASP root cycle still
works end-to-end. It spends ~1 USDC (refundable via `withdraw`).

```bash
cd /Users/eesheng_eth/Desktop/zx402
npm run dev -- -p 3009   # in terminal A; wait for "Ready in Xs"
# in terminal B:
npm run test:e2e 2>&1 | tee runs/e2e-pre-push-$(date -u +%Y%m%dT%H%M%SZ).log
```

**Expected output:**
- Settle time ≤ 10,000 ms (recent runs: 7,086 ms and 7,414 ms — see `STATUS.md`)
- Anonymity set ≥ 77 (will grow after §3)
- One `deposit` tx hash + one `withdraw` tx hash printed; both confirmed
- No errors mentioning "ASP root stale" or "InvalidProof"

**Capture for the release notes:** both tx hashes + the settle time. Paste into
§6 STATUS.md update.

**Rollback if settle > 10s:** acceptable for the push (gate is ≤10s p95, single run
is not p95); note in the announcement that the set has grown. If > 30s, suspect RPC
slowness — switch RPC and retry once.
**Rollback if `InvalidProof`:** likely a stale ASP root. Call `/api/asp-update`
manually and retry once. If still red, **STOP** and page CTO. Do not proceed to §3.

---

## 3. Seed pool Phase 0 (10 min)

**RECOMMENDED but not blocking the push.** Skip this section entirely if §1.2 keys
are not in place — §2 + §4 + §5 alone are a coherent shippable push.

### 3.1 Dry-run

```bash
npx tsx scripts/seed-pools.ts \
  --config scripts/seed-pools.phase0.config.json \
  --dry-run
```

**Expected output:**
- "Phase 0" label in the banner
- 30 planned deposits across 3 denominations (10 × $10, 10 × $50, 10 × $100)
- Total = $1,600 USDC; ~90 second runtime estimate (depositGapMs = 3000)
- No on-chain tx printed

**Rollback if plan mismatches:** the config file may have been edited locally.
Check `scripts/seed-pools.phase0.config.json` vs git HEAD; revert if drifted.

### 3.2 Live run

```bash
mkdir -p runs data
npx tsx scripts/seed-pools.ts \
  --config scripts/seed-pools.phase0.config.json \
  2>&1 | tee runs/seed-phase0-$(date -u +%Y%m%dT%H%M%SZ).log
```

**Expected output:**
- `[N/30]` progress lines, one every ~3 seconds
- Each line: tx hash + first 14 chars of commitment
- `RESUMING:` line at the top only if a previous partial run left a file (clean run = absent)
- On completion: `data/seed-notes.phase0.encrypted.json` exists, AES-256-GCM ciphertext

### 3.3 Resume-safety smoke test (RECOMMENDED — proves `866d625` works under live conditions)

After ~5 deposits have appeared in the live run log, kill the process (Ctrl-C), then
re-run the exact same command:

```bash
# Ctrl-C in the running terminal, then:
npx tsx scripts/seed-pools.ts \
  --config scripts/seed-pools.phase0.config.json \
  2>&1 | tee runs/seed-phase0-resume-$(date -u +%Y%m%dT%H%M%SZ).log
```

**Expected output:**
- Line near top: `RESUMING: loaded N prior deposits from data/seed-notes.phase0.encrypted.json` where N matches the count you saw before Ctrl-C
- Subsequent loop iterations print `SKIP — already in encrypted notes` for each prior deposit
- New deposits resume from N+1, NOT from 1

**Rollback if the resume produces `[1/30]` instead of `SKIP`:** the patch regressed
or the encrypted notes file was deleted. **STOP.** Page CTO. Do not let the script
continue — it would double-deposit. Inspect `data/seed-notes.phase0.encrypted.json`;
restore from the partial file if it exists; verify `ZBASE_SEED_ENCRYPTION_KEY` is
unchanged between runs.

**Rollback if any individual deposit reverts mid-run:** the script exits. **DO NOT
RERUN BLINDLY** — first check BaseScan for the failed tx hash. If the tx actually
succeeded on-chain (timeout-after-confirmation), you must manually patch the
encrypted notes file with the missing note before re-running, or the resume logic
will replay it. Page CTO.

### 3.4 Post-seed ASP refresh

```bash
curl -X POST http://localhost:3009/api/asp-update
```

**Expected:** 200 OK, new ASP root hash. If 4xx/5xx, the postman key may have drifted
— check `POSTMAN_PRIVATE_KEY` env var.

---

## 4. Decoy scheduler bring-up (5 min)

```bash
# Dry run first — confirms 10 burn addresses load, Poisson interval computes
npx tsx scripts/decoy-scheduler.ts --dry-run --once

# Then live with $5/day budget cap
MAX_DAILY_BUDGET_USD=5 npx tsx scripts/decoy-scheduler.ts \
  2>&1 | tee runs/decoy-$(date -u +%Y%m%dT%H%M%SZ).log &
```

**Expected output (dry-run):** "10 burn addrs loaded", Poisson interval printed,
"--dry-run, no gas spent" message.
**Expected output (live):** decoy tx hash every ~4 minutes (mean), running total of
USD spent today.
**Rollback if dry-run errors:** `POSTMAN_PRIVATE_KEY` not funded for decoy deposits.
Skip §4 entirely — it's nice-to-have, not blocking.
**Rollback if live run exceeds budget:** the script self-caps at `MAX_DAILY_BUDGET_USD`
(default 5); if it doesn't, kill the background process (`kill %1`) and investigate.

---

## 5. Stealth provider smoke registration (5 min)

```bash
# Generate a meta-address client-side (uses packages/core/src/stealth.ts):
npx tsx -e "
import { generateMetaAddress } from './packages/core/src/stealth.ts';
const m = generateMetaAddress();
console.log(JSON.stringify({
  provider: 'smoke-test-' + Date.now(),
  payTo: '0x0000000000000000000000000000000000000001',
  metaAddress: m.metaAddress,
  scheme: 1,
}));
" > /tmp/zbase-stealth-smoke.json

# POST to the local dev server (terminal A is still running it from §2)
curl -X POST http://localhost:3009/api/providers/register \
  -H 'Content-Type: application/json' \
  -d @/tmp/zbase-stealth-smoke.json

# Verify it persisted
curl -s http://localhost:3009/api/providers/register | head -c 500
```

**Expected output:** POST returns 200 + `{ok: true, provider: ...}`. GET returns the
registered provider plus any prior providers in `data/providers.json`.
**Rollback if 5xx:** check dev server logs in terminal A — most common cause is a
schema validation failure. Skip §5 — the registry already shipped per `STATUS.md` and
this is a smoke test, not a blocker.

---

## 6. Post-flight (10 min)

### 6.1 BaseScan verification

Open in browser:

- Entrypoint: https://sepolia.basescan.org/address/0x598ffaac79ae29b1aae571fd91899d4492183688
- USDC Privacy Pool (plain 0xbow, no yield): https://sepolia.basescan.org/address/0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a
- Treasury: https://sepolia.basescan.org/address/0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843

**Expected:** new `Deposited` events from §2 (1) and §3 (30) visible in last hour;
treasury USDC balance decreased by ~1,601; ETH balance decreased by ~0.03–0.05.

### 6.2 STATUS.md update

Edit `/Users/eesheng_eth/Desktop/zx402/STATUS.md` and append a new dated row to the
live-test table near line 30. Template:

```markdown
| Push to Base Sepolia (PR #6 merge) | <date+time UTC> | E2E settle <N>ms · anon-set <M> · seed Phase 0 30 deposits · [e2e-deposit](https://sepolia.basescan.org/tx/<HASH>) · [e2e-withdraw](https://sepolia.basescan.org/tx/<HASH>) |
```

Commit (do **NOT** merge to `main` — user policy requires double-confirmation):

```bash
git add STATUS.md
git commit -m "$(cat <<'EOF'
docs: log Base Sepolia push 2026-05-31 — E2E + Phase 0 seed deposits

EOF
)"
git push origin integration-test
```

### 6.3 Announcement (draft)

> zBase is live on Base Sepolia for closed beta. Anonymity set: ~107 commitments
> (77 organic + 30 treasury Phase-0 seed; treasury commitments time-locked until
> 2026-12-01 and will be reclaimed transparently). E2E settle ≤10s. Sepolia
> entrypoint: `0x598ffa…3688`. Trust model: docs.zbase.app/trust-model.
> Threat model: docs.zbase.app/threat-model. Source: github.com/goheesheng/zx402.
>
> Not on mainnet. Not audited. Not for production funds.

**Channels:** X, Farcaster, Telegram (private builder channel first, then public).
**Timing:** post after §6.1 verifies clean.

### 6.4 Calendar entries (CEO)

- **2026-08-01:** mid-period reclaim drill (deposit $1, reclaim $1) to verify the
  encryption-key custody still works
- **2026-09-01:** seed Phase 1 decision (scale to $6K?)
- **2026-12-01:** Phase-0 reclaim window opens — execute per
  `docs/seed-pool/risk-analysis-2026-05-31.md` §4 (stagger ≥90 days, ≥10 fresh
  addresses, skip dust)

---

## Out of scope (intentional)

- **No `main` merge.** Per user policy (`feedback_main_branch_protection.md`),
  `main` auto-deploys to zbase.app and requires double-yes confirmation. This
  runbook stops at `integration-test`.
- **No mainnet contract deploys.** Yield (`PrivacyPoolMorpho.sol`), UTXO (A.1),
  and Threshold-ASP (B.2) all stay paused per the §0 readiness matrix.
- **No public-facing GTM beyond the announcement draft in §6.3.** Provider
  onboarding (SAN, etc.) is a separate work-stream.
- **No audit.** Explicitly accepted per founder direction.

---

*End of runbook. Owners: CEO (operator), CTO (on-call). If anything in this doc
contradicts `STATUS.md`, `STATUS.md` wins — it's the source of truth.*
