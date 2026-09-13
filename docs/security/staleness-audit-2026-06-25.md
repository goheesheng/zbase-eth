# Staleness audit — DELETE / UPDATE / KEEP decision list (2026-06-25)

Repo-wide audit (3 parallel agents + deterministic checks) of 115 docs + 79 src
files + 46 scripts. Nothing here has been actioned — this is a decision list.
Verified against this session's ground truth: live pool = plain 0xbow PrivacyPool
(NO yield/Morpho); fees now 1%/3% (was 0.30%/1%); StealthPay/AgentVault/escrow/
evaluator/service-route deleted; UTXO deferred; SDK packages unpublished.

---

## 🔴 MUST-FIX (your standing rules — not optional)

- **Personal email in 2 PUBLIC-facing files** (rule: never personal email in
  public files → use @zbase__):
  - `docs/grants/base-ecosystem-fund-application.md:4,159` (`<redacted>`)
  - `docs/sales/exposure-audit/stripe-setup.md`
  (The `history-scrub-checklist.md` hits are intentional — documenting what to scrub.)

## 🗑️ SAFE-TO-DELETE — code/scripts (high confidence, zero-ref verified)

| Path | Conf | Reason |
|---|---|---|
| `scripts/deploy.ts` | HIGH | Deploys `zx402Escrow` (AgentVault-era contract, source deleted). NOT the package.json `deploy` (that's the Cloudflare site build). True orphan. |
| `packages/core/src/scanner.ts` (+ `index.ts:73` re-export) | HIGH | `analyzeTransfers` has zero importers; live scanner is `src/lib/privacy-scanner.ts`. |
| `scripts/demo-agent-payment.ts` | MED | Zero refs; superseded by `x402-test-agent` / `demo:bootstrap`. |
| `scripts/svm-devnet-redeploy-preflight.sh` | MED | Zero refs; the redeploy checklist doesn't invoke it. |

## 🗑️ SAFE-TO-DELETE — docs (mostly optional/forensic)

| Path | Conf | Reason |
|---|---|---|
| `docs/gitbook/testing-release.md` | MED | Self-declared mirror of canonical `docs/TESTING_RELEASE.md`. |
| `docs/marketing/x-proof-screenshot-mock.md` | LOW | Throwaway screenshot-staging note; useful only until the X post ships. |
| `docs/operations/staging-stack-{deploy,runbook}-*.md` | LOW | Abandoned-feature runbooks; STATUS.md keeps staging as forensic record — delete only if pruning forensics. |
| `docs/security/cso-audit-2026-06-08-rerun.md` | LOW | Most-redundant of 3 same-day CSO variants; dated snapshot, deletion optional. |

> NOTE: `docs/strategy/revenue-model-recommendation-2026-06-18.md` — the agent
> flagged it superseded, but it holds the 27-agent derivation + this session's
> moat-update was added to it. RECOMMEND KEEP (update its 30bps mention instead).

## ✏️ UPDATE-NEEDED (still useful; stale facts) — the real work, ~20 files

**Theme A — stale fee (0.30%/30bps → 1% standard / 3% compliance):**
- `README.md:59`
- `docs/gitbook/use-zbase-as-facilitator.md` (WORST — L16/42/43/136-137, every worked example)
- `docs/strategy/competitive-revenue-comparison-2026-06-22.md` (pervasive; annotate as pre-raise)
- `docs/release/prove-paid-settle-sepolia.md` (L3/91/102; $0.70 example → $0.007 not ~$0.002)
- `docs/strategy/revenue-model-recommendation-2026-06-18.md` (L33/112, if kept)
- `src/lib/facilitator-authz.ts` (comments L22/L36 cite old 0.30% rationale — CODE is correct 1%/3%)

**Theme B — Morpho/yield shown as LIVE (live pool has none):**
- `INTRO.md` (WORST — "~3.2% APY from Morpho Blue", Layer-2 diagram)
- `docs/ARCHITECTURE.md` (comparison row + deposit diagram "earns yield while waiting")
- `docs/gitbook/contracts-reference.md:9`, `build-roadmap.md:11`, `how-the-money-flows.md:25`,
  `why-base-facilitator.md:49`, `README.md:43↔55` (self-contradiction), `architecture-overview.md:74` caption
- `docs/grants/base-ecosystem-fund-application.md:51,150` (sells ~3.2% APY as live destination)
- `docs/bd/{anthropic-claude-code,coinbase-agentcore}-outreach.md` (DRAFTs — fix before sending)
- `docs/competitive/why-not-an-l3-2026-05-31.md:77,94`

**Theme C — npm packages marked published but aren't:**
- `README.md:36-39,50` (`npm install @zbase-protocol/sdk` would 404 today)

## 🔀 DUPLICATE / OVERLAP (canonical noted; consolidation optional)

- `docs/gitbook/anonymity-set-disclosure.md` (canonical) vs `docs/anonymity-set-disclosure.md`
- `docs/gitbook/base-sepolia-private-x402.md` (canonical) vs `docs/BASE_SEPOLIA_PRIVATE_X402_GITBOOK.md` (legacy all-caps)
- `docs/TESTING_RELEASE.md` (canonical) vs `docs/gitbook/testing-release.md` (mirror → delete)
- `docs/ARCHITECTURE.md` vs gitbook `architecture-overview.md` / `system-architecture.md` (distinct TOC roles — low priority)

## 🔧 DEDUP (code quality — DEFERRED 2026-06-25, decided not to action)

Decision: **skip for now.** Risk/reward doesn't justify touching working money-path
code:
- `SNARK_FIELD` (9×) + `DEPOSITED_TOPIC` (9×) are **immutable constants** (BN254
  field order; a fixed event-topic hash). 9 identical copies are ugly but **cannot
  drift**, so deduping is cosmetic — and 2 SNARK_FIELD sites (`privacy.ts`,
  `demo/run`) don't currently import core, so it would add a dependency to
  money-path files purely to share a constant.
- `buildMerkleTree`/`generateMerkleProof` duplicated in `packages/core/src/merkle.ts`
  AND `src/lib/privacy.ts` — this is the only one that *could* drift, but it's the
  withdrawal proof-tree path; a subtle consolidation diff could break withdrawals.
  Revisit only with byte-identical-root tests proving equivalence first.
Revisit if drift ever actually bites (it hasn't). Shared core export
`SNARK_SCALAR_FIELD` already exists (`packages/core/src/account.ts:17`,
re-exported at `index.ts:46`) for any future opt-in.

## ✅ KEEP (verified live / intentional / dated-snapshot)

- All `docs/security/*`, `docs/ceremony/*`, `docs/governance/*`, `docs/seed-pool/*`
  (audit + governance records). `CHANGELOG.md`, `CIRCUIT_FROZEN_FOR_AUDIT.md`,
  `STATUS.md` (accurate), all dated release/runbook docs.
- 42 of 46 scripts (16 in package.json, rest cross-referenced by runbooks/cron/SDK).
- All src routes/libs/components (zero dead found); `proofs.ts` (REFUTED as dead —
  imported by svm pool + privacy.ts); UTXO/note/vault/transfer scaffolds (future, gated).
- `zx402` references everywhere = rename-in-flight (intentional, NOT bugs).
- `artifacts/` stale build-cache for deleted contracts = gitignored, self-clears on `forge build`.

---

## Tally
- **Clean deletes: 4 code/scripts + ~1-5 docs** (rest of doc deletes are optional/forensic).
- **Updates: ~20 docs** (fee 1%/3% + Morpho-parked + npm-unpublished) — the bulk of the work.
- **Dedup: 3 consolidations** (SNARK_FIELD, DEPOSITED_TOPIC, merkle).
- **1 must-fix:** personal email in 2 public docs.
