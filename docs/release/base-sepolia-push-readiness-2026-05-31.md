# Base Sepolia Push — Readiness Checklist

**Date:** 2026-05-31
**Branch under audit:** `integration-test` (14 commits ahead of `main`, HEAD `866d625`)
**Target:** Base Sepolia testnet (chain 84532). **NOT mainnet.**
**Audit posture:** Read-only. No code modified. No commands executed.
**Source files:** `STATUS.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/seed-pool/*`, `docs/ceremony/*`, `docs/governance/*`, `scripts/seed-pools.ts`.

---

## Shipment matrix

| # | Shipment | In `integration-test`? | On Base Sepolia? | Tests passing? | Known bug? | Smallest action to land on Sepolia | Blocking? |
|---|---|---|---|---|---|---|---|
| **A.1** | UTXO notes (encrypted-value spend circuit) | YES — `circuits/note_spend.circom`, `packages/core/src/notes.ts` (414 lines), `zbase-protocol/.../UTXOPool.sol` (313 lines) | NO — no verifier deployed | YES — circuit tests + foundry green (50/50) | NO — scaffold-only, by design | Run trusted-setup ceremony per `docs/ceremony/ceremony-runbook-2026-05-31.md` (6 weeks, 15 contributors, ~$2K), then deploy verifier + UTXOPool | **NICE-TO-HAVE** — ship without it; current pool keeps working |
| **A.2** | Decoy withdrawal scheduler | YES — `scripts/decoy-scheduler.ts` (426 lines), `scripts/test-fifo-resistance.ts` (307 lines) | N/A — off-chain service | YES — dry-run verified (10 burn addrs, 43.9s Poisson cadence) | NO | `POSTMAN_PRIVATE_KEY` + `MAX_DAILY_BUDGET_USD=5` env, then `tsx scripts/decoy-scheduler.ts` against existing entrypoint | **NICE-TO-HAVE** — costs ~$5/day; start any time, harder is better |
| **A.3** | Metadata-stripping middleware | YES — `src/middleware.ts` (96 lines, 6 sentinel headers stripped, 4 privacy headers stamped) | YES — already in dev server | YES — `npx tsx scripts/test-metadata-strip.ts` (needs running dev server) | NO | None — active on next deploy of the Next.js app | **READY** — auto-active on push |
| **B.1** | ERC-5564 stealth recipients + provider registry | YES — `packages/core/src/stealth.ts` (446 lines), `src/app/api/providers/register/route.ts` (265 lines) | YES — registry route live; persisted to `data/providers.json` | YES — `npx tsx scripts/test-stealth.ts` (100/100), `npx tsx scripts/test-providers-route.ts` (8/8) | NO | None — onboarding first provider is GTM, not deploy | **READY** — auto-active on push |
| **B.2** | Threshold (3-of-5) ASP entrypoint | YES — `zbase-protocol/.../ThresholdEntrypoint.sol` (243 lines, 7/7 foundry), `scripts/threshold-postman/coordinator.ts` (395 lines) | NO — no `ThresholdEntrypoint` deployed; current pool still uses single-key entrypoint `0x598ffa…3688` | YES — `forge test --match-contract ThresholdEntrypoint -vv` (7/7) | NO | Recruit 4 external signers per `docs/governance/signer-candidates-2026-05-31.md` (priority: Soleimani, Kassandra, D. Wong, Cutler), then deploy + cut over | **NICE-TO-HAVE** — disclose single-key risk in trust-model.md (already done); cut over later |
| **B.3** | Anonymity-set seed pool | YES — `scripts/seed-pools.ts` (659 lines), Phase-0 config (`scripts/seed-pools.phase0.config.json`, 30×$10/$50/$100 = $1,600), resume-safety patch (commit `866d625`) | NO — never executed against the live entrypoint | YES — `npm run test:seed-pools` (10/10 after `866d625`, includes 3 regression tests for the resume fix) | RESOLVED — double-deposit bug fixed `866d625`; encrypted notes now loaded on restart, wrong-key refuses to clobber | Generate `ZBASE_SEED_ENCRYPTION_KEY`, fund treasury (`0xcDB447…b843`) with ~$1,600 USDC + ETH, run `npx tsx scripts/seed-pools.ts --config scripts/seed-pools.phase0.config.json` | **NICE-TO-HAVE for the push itself**, **BLOCKING for the "anonymity set ≥30" claim** — see runbook |
| **Historical yield variant** | `PrivacyPoolMorpho.sol` scaffold (not active) | YES — `contracts/PrivacyPoolMorpho.sol` (238 lines), `contracts/test/PrivacyPoolMorphoYield.t.sol` (5/5 foundry) | NO — current pool `0x4ebcfe…935a` is a plain 0xbow pool; off-chain parser is forward-compatible per `CHANGELOG.md` | YES — historical test suite | NO — strategic pause | **PAUSED PER CEO DECISION** — do not deploy without explicit founder go-ahead | **NICE-TO-HAVE** — explicitly skipped |
| **Docs** | Trust + threat model, GitBook restructure, governance/ceremony/seed-pool prep docs | YES — `docs/gitbook/trust-model.md`, `docs/gitbook/threat-model.md`, plus 8 new GitBook pages and the three `docs/{seed-pool,ceremony,governance}/` plan directories | YES — doc-only, no deploy | N/A | NO | None | **READY** |

---

## Aggregate gates

| Gate | Status | Evidence |
|---|---|---|
| 50/50 foundry suite green | ASSUMED green (last verified per `STATUS.md` 2026-05-29) | Re-run `forge test -vv` before push — see runbook pre-flight |
| Seed-pools regression suite green | YES (10/10) | `866d625` commit message + diff |
| Live E2E ≤10s p95 on Base Sepolia | YES — 7,086 ms + 7,414 ms across 2 runs 2026-05-29 | Tx hashes in `STATUS.md` lines 31-32 |
| `.env.local` has `BASE_SEPOLIA_RPC` | YES | line 13 |
| `.env.local` has `POSTMAN_PRIVATE_KEY` | YES | line 12 |
| `.env.local` has `HYPERSYNC_TOKEN` | YES | line 14 |
| `.env.local` has `TREASURY_PRIVATE_KEY` | **NO — MISSING** | Required by `scripts/seed-pools.ts`; must be set for B.3 |
| `.env.local` has `ZBASE_SEED_ENCRYPTION_KEY` | **NO — MISSING** | Required by `scripts/seed-pools.ts`; must be set for B.3 |
| `data/` gitignore covers `seed-notes*.encrypted.json` | YES | `.gitignore` lines 72-73 |
| Treasury reclaim lock | YES — `2026-12-01T00:00:00Z` in both configs, enforced by `scripts/reclaim-seed-pools.ts:110` | |

---

## Verdict

**The push to Base Sepolia is unblocked.** Everything that touches the chain (A.3 middleware, B.1 stealth registry) deploys atomically with the Next.js app. The existing entrypoint (`0x598ffa…3688`) is already in use; PR #6 does not require a new contract deployment.

**Three things are blocked-by-policy, not by code:** A.1 UTXO needs a ceremony, B.2 threshold needs signers, Yield is paused — and the team has already accepted shipping without them (CHANGELOG.md: "Still scaffold-only"). Mention them in the trust-model doc (already done) and move on.

**One thing the team likely wants but is gated on a 10-minute env-var add + a 90-second script run:** B.3 Phase-0 seed (30 deposits, $1,600). Without it the launch post anonymity-set claim is "we deployed an empty pool." With it, ~77 → ~107 commitments. Recommend executing it inside the push window.

**One latent risk worth re-confirming aloud:** the post-deploy ASP root needs to refresh after the seed deposits, or new organic deposits will fail with stale-root errors. `/api/asp-update` handles this but should be hit explicitly post-seed.
