# zBase Infrastructure Test Results — 2026-05-31

- **Date:** 2026-05-31
- **Branch:** `docs/gitbook-shh-restructure-2026-05-31`
- **Commit:** `ac38c70 docs(gitbook): restructure to mirror shh.gg navigation format`
- **Runner:** local (Darwin 24.1.0), no live RPC, no signing keys, no chain interaction

## Test results

| # | Test | Status | Duration | Notes |
|---|---|---|---|---|
| 1 | `npm run test:seed-pools` | PASS | ~1.5s | 10/10 pass (incl. 3 resume regression tests) |
| 2 | `bash scripts/test-crash-resume-drill.sh` | PASS | ~1.3s | exits 0, all 3 resume tests PASS, commit 866d625 intact |
| 3 | `npx tsx scripts/test-stealth.ts` | PASS | ~1.1s | 100 derivations, view-tag scan 157.7ms, full scan 158.3ms, all keys recovered |
| 4 | `npx tsx scripts/test-providers-route.ts` | PASS | ~0.6s | route smoke green (script self-contained; does NOT require running dev server) |
| 5 | `npm run test:curl` | EXPECTED-FAIL | ~0.1s | aborts at step 0 because no dev server on :3009 — documented failure mode, not a regression |
| 6 | `forge test -vv` (full) | PASS | ~0.3s | 4 suites, 50/50 tests pass, 0 failed, 0 skipped |
| 7 | `forge test --match-contract ThresholdEntrypoint -vv` | PASS | ~0.2s | 7/7 pass |
| 8 | `forge test --match-contract PrivacyPoolMorphoYield -vv` | PASS | ~0.2s | 5/5 pass |
| 9 | seed-pools `--dry-run` (Phase 0 config) | PASS | ~1s | Plan valid: 30 deposits / 1,600 USDC (10×$10 + 10×$50 + 10×$100) |
| 10 | decoy-scheduler `--dry-run` | PASS | 10s (timeout expected) | Loaded 10 burn addresses, computed 492.5s Poisson sleep, no gas spent. **Note:** requires `POSTMAN_PRIVATE_KEY` (not `TREASURY_PRIVATE_KEY` as the runbook stated) |
| 11 | `bash -n` on all new shell scripts | PASS | <0.1s | `all-shell-ok` |
| 12 | JSON validity of `seed-pools.phase0.config.json` | PASS | <0.1s | parses cleanly, all 9 top-level keys present |
| 13 | `forge build` | PASS | <1s | `No files changed, compilation skipped` — no compile errors (only lint notes on legacy AgentVaultEscrow/MockUSDC) |

## Verdict

**GREEN — push-ready.** 13/13 test targets behave as expected. The only non-PASS row (test 5, curl) is the documented "no dev server" abort, which the test suite advertises explicitly. No source code was modified during this run.

## Last-5-lines evidence

<details>
<summary>1. <code>npm run test:seed-pools</code></summary>

```
  PASS  resume: loads prior partial run
  PASS  resume: wrong key refuses to clobber

10 passed, 0 failed
npm run test:seed-pools 2>&1  1.96s user 0.44s system 158% cpu 1.522 total
```
</details>

<details>
<summary>2. <code>bash scripts/test-crash-resume-drill.sh</code></summary>

```
Commit 866d625 (resume fix) is intact. Seed script will not double-deposit
on crash-restart.
================================================

bash scripts/test-crash-resume-drill.sh 2>&1  2.02s user 0.46s system 185% cpu 1.334 total
```
</details>

<details>
<summary>3. <code>npx tsx scripts/test-stealth.ts</code></summary>

```
Step 6: seeded meta-address — same 64-byte seed → same meta-address

────────────────────────────────────────────────────────────────────────
PASS — Shipment B.1 stealth SDK invariants hold for 100 payments
npx tsx scripts/test-stealth.ts 2>&1  1.13s user 0.10s system 111% cpu 1.102 total
```
</details>

<details>
<summary>4. <code>npx tsx scripts/test-providers-route.ts</code></summary>

```
  ✓ GET listing returns provider; email hidden
  ✓ findProviderByPayTo resolves meta-address, fallback (case-insensitive), and null on miss

PASS — providers/register route smoke test
npx tsx scripts/test-providers-route.ts 2>&1  0.74s user 0.16s system 159% cpu 0.566 total
```
</details>

<details>
<summary>5. <code>npm run test:curl</code> (expected failure mode)</summary>

```
╔══════════════════════════════════════════════════════╗
║          zBase API Test Suite (curl)                 ║
╚══════════════════════════════════════════════════════╝

[0] Checking server...
  Server not running at http://localhost:3009
  Start it with: npm run dev -- -p 3009
```
</details>

<details>
<summary>6. <code>forge test -vv</code></summary>

```
[PASS] test_walletMode_userPaysAndProviderGetsReleased() (gas: 436262)
Suite result: ok. 20 passed; 0 failed; 0 skipped; finished in 7.66ms (2.12ms CPU time)

Ran 4 test suites in 91.44ms (30.47ms CPU time): 50 tests passed, 0 failed, 0 skipped (50 total tests)
```
Suite breakdown: PrivacyPoolMorphoYield 5/5 · ThresholdEntrypoint 7/7 · StealthPay 18/18 · AgentVaultEscrow 20/20.
</details>

<details>
<summary>7. <code>forge test --match-contract ThresholdEntrypoint -vv</code></summary>

```
[PASS] test_RootDigestMatches() (gas: 11936)
Suite result: ok. 7 passed; 0 failed; 0 skipped; finished in 1.68ms (3.09ms CPU time)

Ran 1 test suite in 83.15ms (1.68ms CPU time): 7 tests passed, 0 failed, 0 skipped (7 total tests)
```
</details>

<details>
<summary>8. <code>forge test --match-contract PrivacyPoolMorphoYield -vv</code></summary>

```
[PASS] test_ZeroYieldZeroFee() (gas: 116139)
Suite result: ok. 5 passed; 0 failed; 0 skipped; finished in 1.33ms (1.60ms CPU time)

Ran 1 test suite in 86.42ms (1.33ms CPU time): 5 tests passed, 0 failed, 0 skipped (5 total tests)
```
</details>

<details>
<summary>9. seed-pools <code>--dry-run</code></summary>

```
======================================================================
DRY RUN — no on-chain tx submitted
======================================================================
Plan is valid. Re-run without --dry-run to execute.
```
Plan summary printed: 30 deposits, 1,600 USDC total (10×10 + 10×50 + 10×100), entrypoint `0x598ffaac79ae29b1aae571fd91899d4492183688`, lock until `2026-12-01T00:00:00Z`.
</details>

<details>
<summary>10. decoy-scheduler <code>--dry-run</code></summary>

```
[decoy] loaded 10 burn addresses
[decoy] loaded state: 0 notes, $0.0000 spent today, 0 decoys total
[decoy] cycle=1 skipped reason=dry-run: would create new decoy deposit
[decoy] cycle=1 sleeping 492.5s until next decoy
[decoy] shutdown signal received, finishing current cycle then exiting
```
Required env: `POSTMAN_PRIVATE_KEY` + `BASE_SEPOLIA_RPC` (NOT `TREASURY_PRIVATE_KEY` as the prompt stated). Exit 124 is timeout-as-designed.
</details>

<details>
<summary>11. shell syntax check</summary>

```
all-shell-ok
```
</details>

<details>
<summary>12. phase0 config JSON</summary>

```
keys: ['$schema', '_doc', 'treasury', 'pools', 'lockUntil', 'encryptedNotesPath', 'entrypoint', 'chainId', 'depositGapMs']
valid
```
</details>

<details>
<summary>13. <code>forge build</code></summary>

```
No files changed, compilation skipped
```
Followed by ~200 lines of forge-lint `note[…]` advisories on legacy contracts (`AgentVaultEscrow.sol`, `MockUSDC.sol`, `MockERC20.sol`) — all stylistic (unwrapped-modifier-logic, screaming-snake-case-immutable, unaliased-plain-import). Zero `Error:` lines. Build is clean.
</details>

## Discovered issues

1. **No real bugs found.** No source changes were required to make any test pass.
2. **Forge-lint advisories on legacy contracts.** `forge build` succeeds but emits notes on `AgentVaultEscrow.sol` (5 modifier-wrap notes), `MockUSDC.sol`, and `MockERC20.sol` (unaliased imports). Cosmetic, on contracts not in the current production path.

_Historical note: a runbook env-var mismatch (the decoy scheduler reads `POSTMAN_PRIVATE_KEY`, not `TREASURY_PRIVATE_KEY`) was caught and patched the same day via the "KEY ROLES — DO NOT CONFUSE" comment block in `.env.local.example`. Resolved; no longer an open finding._

## What's NOT tested (requires live RPC + funded wallet)

- **Live seed pool execution** — actual `seed-pools.ts` run without `--dry-run` (needs funded treasury on Base Sepolia, real `ZBASE_SEED_ENCRYPTION_KEY` ceremony, ~$1,600 USDC + gas)
- **Live decoy scheduler** — actual Poisson-cadence on-chain deposits (needs funded `POSTMAN_PRIVATE_KEY`)
- **Live x402 settle path** — `/api/facilitator/settle` against a real Base Sepolia transaction (requires running `npm run dev` + funded relayer + live USDC)
- **B.2 ThresholdEntrypoint deploy** — only unit-tested; no deployment script exercised on testnet
- **End-to-end deposit/withdraw on Base Sepolia** — `npm run test:e2e` (would burn 1 USDC + gas; not run here)
- **x402 agent flow** — `npm run test:x402-agent` (requires running x402 server + funded agentic wallet)
- **Ceremony tooling** — threshold-postman signer recruitment + key generation, ASP signer hardware-wallet flow, UTXO trusted-setup (`circuits/note_spend.circom`)
- **Curl API suite (18 endpoints)** — could not run; would need `npm run dev -- -p 3009` in another shell
- **ASP root update flow** — `/api/asp-update` round-trip against a fresh deposit
- **Provider stealth-address registration over HTTP** — only the in-process module path was smoked

## Reproducibility

Every command above is copy-pasteable from the task spec and runs from `/Users/eesheng_eth/Desktop/zx402`. The decoy scheduler row uses `POSTMAN_PRIVATE_KEY` instead of `TREASURY_PRIVATE_KEY` per the script's actual contract.
