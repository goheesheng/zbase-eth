# Seed-Pool Execution Checklist

**Date:** 2026-05-31
**Operator:** CEO (signing) + CTO (on-call)
**Estimated run time:** 8 minutes (100 deposits × 5s gap) + 5 min pre-flight + 10 min post-flight
**Abort policy:** any RED below = stop, page CTO

---

## Pre-flight (T-30 min)

- [ ] **Branch hygiene** — on a non-`main` branch, `git status` clean, no uncommitted changes to `scripts/seed-pools.ts` or `scripts/seed-pools.config.json`
- [ ] **Resumability patch applied** — script either resumes from existing encrypted notes file OR refuses to start when one is present (see risk-analysis §2). If not patched, **DO NOT PROCEED** with full plan; cap at Phase 0 ($1,500)
- [ ] **Network verified** — `BASE_SEPOLIA_RPC` reachable; `cast block-number --rpc-url $BASE_SEPOLIA_RPC` returns within 2s; chain ID matches `config.chainId` (84532)
- [ ] **Treasury balance check** — `cast call <USDC> "balanceOf(address)" <treasury>` ≥ planned total + 5% buffer; ETH balance for gas ≥ 0.05 (covers ~100 deposits at 1M gas each)
- [ ] **Approval pre-check** — `cast call <USDC> "allowance(address,address)" <treasury> <entrypoint>` ≥ planned total (if 0, script will auto-approve max; this is fine but adds 1 tx)
- [ ] **ASP curator on standby** — postman service running; threshold-postman signers reachable on Signal group; ASP root update will be needed after deposits complete
- [ ] **Encryption key generated & backed up** — `ZBASE_SEED_ENCRYPTION_KEY` set in env; key sharded via Shamir 3-of-5 per risk-analysis §5; *do not start script if backup not confirmed*
- [ ] **Dry-run completed within last 24h** — `tsx scripts/seed-pools.ts --dry-run` output reviewed; total deposits + total USDC matches expectation
- [ ] **Output path writeable** — `config.encryptedNotesPath` directory exists, is gitignored, and disk has ≥ 10MB free
- [ ] **Time-of-day** — execute during low-mempool window (Base Sepolia: any time; mainnet: avoid US business hours peak)
- [ ] **Disclosure post drafted** — `docs/anonymity-set-disclosure.md` PR is open with the post-ready language (k<30 ladder per risk-analysis §3), ready to merge immediately on completion

---

## During run (T+0 to T+8 min)

- [ ] **Log streaming** — `tsx scripts/seed-pools.ts 2>&1 | tee runs/seed-$(date -u +%Y%m%dT%H%M%SZ).log` to capture stdout for the run record
- [ ] **Watch for `[N/100]` progress** — every 5s; if 30s passes without progress, suspect RPC stall or pending tx
- [ ] **Abort signals (stop and page CTO):**
  - any "FATAL" in stdout
  - any `Deposit N reverted` (script will exit; do not re-run blindly — see resumability bug)
  - any `Deposited event not found` (on-chain success but log parsing failed — investigate before any further deposit)
  - basescan shows tx confirmed but script reports timeout (rerun risk — manually update encrypted notes from receipt before re-running)
  - treasury ETH balance drops below 0.01 (gas exhaustion incoming)
- [ ] **CTO contact** — Signal `@cto` direct, fallback phone. CTO has root SSH to operator host and copy of encryption key shard
- [ ] **Do not touch the encryption key env var mid-run** — re-encrypts on every deposit; corrupting it mid-run loses all subsequent notes
- [ ] **No parallel terminal** running anything that touches `config.encryptedNotesPath` (no editor saving the file, no `git status` polling in a watch loop)

---

## Post-flight (T+10 to T+30 min)

- [ ] **Verify total count** — `cat <encryptedNotesPath> | jq .totalNotes` equals planned total
- [ ] **Verify encryption integrity** — `cat <encryptedNotesPath> | jq -r .ciphertext | base64 -d | wc -c` returns non-zero; `jq .plaintextHash` is 64 hex chars
- [ ] **On-chain spot check** — pick 3 random deposits from the log; verify each tx on basescan; confirm `Deposited` event emitted by the configured pool address
- [ ] **Merkle root advanced** — `cast call <entrypoint> "latestRoot()(uint256)"` returns new value; record before/after
- [ ] **ASP root refreshed** — call `/api/asp-update` (or wait for cron); confirm new ASP root committed on-chain via threshold postman quorum
- [ ] **Treasury balance reconciliation** — ending USDC balance = starting − planned total (within 1 USDC for rounding); ending ETH = starting − gas spent
- [ ] **Encrypted notes file backed up off-host** — uploaded to S3 with object lock + versioning; SHA-256 of file recorded in the run log
- [ ] **Encryption key backup re-verified** — quarterly reclaim drill scheduled in calendar; key shards confirmed in their 5 locations
- [ ] **Disclosure post published** — merge `docs/anonymity-set-disclosure.md` PR; cross-post to X/Farcaster/GitBook with on-chain commitment count and the k<30 framing if applicable
- [ ] **Reclaim calendar entry** — calendar event for 2026-12-01 with link to `scripts/reclaim-seed-pools.ts` and the staggered reclaim plan from risk-analysis §4
- [ ] **Run log committed** — `runs/seed-*.log` to a private repo (NOT public; contains tx hashes that are public anyway but the operator's command-line history is not for sharing)
- [ ] **Retrospective scheduled** — 24h post-execution, review what surprised us; feed back into next phase
