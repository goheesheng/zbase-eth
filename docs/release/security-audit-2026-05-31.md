# Pre-push Security Audit — 2026-05-31

| Field | Value |
| --- | --- |
| Date | 2026-05-31 |
| Branch | `docs/gitbook-shh-restructure-2026-05-31` |
| HEAD commit | `ac38c708a48443298be92e86c4168d6300b5cf09` |
| Target remote | `https://github.com/goheesheng/zBase` |
| Production branch | `main` (this push goes to the feature branch, not `main`) |
| Files in scope | 56 (22 modified + 34 untracked, after excluding the 5 dirs below) |
| Auditor | Claude Opus 4.7 (read-only sweep) |

---

## CRITICAL findings

**None.** No private keys, API tokens, real RPC keys with embedded credentials, OAuth tokens, AWS/GitHub/Stripe credentials, encryption keys, or 64-char-hex key material found in any file slated for this push.

The three known sensitive values from `.env.local` were checked individually and NOT found in any in-scope file:

| Secret | Pattern searched | Result |
| --- | --- | --- |
| Infura key | `<value redacted — key rotated 2026-07-25>` | Not present in pushed files |
| Seed-encryption key | `<value redacted>` | Not present |
| HyperSync token | `<value redacted>` | Not present |

> ⚠️ **Redaction note (2026-07-25):** the real secret values were originally recorded in the
> "Pattern searched" column above — which itself leaked them into this tracked file (the exact
> thing the audit was checking for). Values redacted. Audit docs must record only *that* a search
> ran and its result, never the secret value. These three secrets should be treated as exposed in
> Git history (private repo) and rotated on their own schedules; the Infura key already was.

Broader regex sweeps (`AKIA…`, `ghp_…`, `gho_…`, `github_pat_…`, `sk_live_…`, `sk_test_…`, `xoxb-…`, `Authorization: Bearer …`, `BEGIN (RSA\|OPENSSH\|EC) PRIVATE KEY`, `mnemonic`, 64-char hex outside known-event-hash) also returned no real-value hits in scope.

Recent commit history (`866d625`, `ac38c70`) reviewed — both clean. The literal word `secret` in `ac38c70` only appears as ZK protocol terminology (`Poseidon(nullifier, secret)`, etc.) and env-var *names* (`CDP_API_KEY_SECRET`), never as a value.

---

## Medium findings

### M-1 — `data/` directory will be partially committed (unintended scope)
The untracked `data/` dir is staged by `git status` as `?? data/`. Inside:

| File | Gitignored? | Sensitivity |
| --- | --- | --- |
| `data/seed-phase0-run-*.log` (3 files) | YES (matches `.gitignore:102`) | Would be skipped on `git add data/` |
| `data/pre-push-smoke-*.log` (3 files) | **NO** | Will be committed if `data/` is added |
| `data/providers.json` | NO | Will be committed |

The pre-push-smoke logs contain only boolean "is set / format valid" lines for `POSTMAN_PRIVATE_KEY`, `TREASURY_PRIVATE_KEY`, `ZBASE_SEED_ENCRYPTION_KEY` — **no actual key values are echoed**. They also contain the public treasury address, stealth-derived addresses, and chain tx hashes (all public on-chain).

`data/providers.json` contains one provider with `contactEmail: "live@example.com"` (placeholder) and a public ERC-5564 stealth meta-address (this is *meant* to be public — that's how the scheme works).

**Action:** Decide intent — if these were never meant to be committed, either `git add -p data/` selectively or extend `.gitignore` with `data/pre-push-smoke-*.log` and `data/providers.json` before staging. Low/no actual leak risk, but ephemeral logs in source control is usually unwanted.

### M-2 — Founder's commit email is already public
`866d625` and `ac38c70` are authored by `goheesheng <goheesheng@hotmail.com>`. This is already in the public git history; flagging only because it's PII per the inventory. No new exposure from this push. No action required unless founder wants to scrub author identity going forward (not in scope here).

---

## Low findings / context

- **L-1** Founder Twitter handle `@goheesheng_` appears in `src/app/demo/page.tsx:159,164` and `src/app/api/demo/run/route.ts:179` as a support contact. Intentional — public contact handle, no action.
- **L-2** Repo URL `github.com/goheesheng/zx402` appears in many docs and API responses. Public, brand-namespace per CLAUDE.md, no action.
- **L-3** Placeholder emails (`ops@example.com`, `ops+<ts>@example.test`, `eng@example.com`, `live@example.com`) appear in test scripts and onboarding helpers. All clearly synthetic per RFC 2606 reserved domains, no action.
- **L-4** `lib/forge-std/src/StdChains.sol:200` and the OZ-vendored copy contain `https://sepolia.infura.io/v3/b9794ad1ddf84dfb8c34d6bb5dca2001`. This is the *forge-std default* — vendored third-party library, already pinned in commits long before this push, not in scope. (Not flagged as a zBase finding; noting only because the inventory grep returned it.)
- **L-5** `docs/operations/stealth-provider-onboarding-2026-05-31.md:127` uses the word "mnemonic" — context is "treat the spending private key like an Ethereum mnemonic", which is guidance text, not key material.
- **L-6** `.env.example` and `.env.local.example` both ship with empty / `0x` placeholders for every PRIVATE field (`POSTMAN_PRIVATE_KEY=0x`, `TREASURY_PRIVATE_KEY=0x`, `ZBASE_SEED_ENCRYPTION_KEY=` empty, `DEMO_WALLET_PRIVATE_KEY=` empty, etc.). Verified line by line. No values leaked.
- **L-7** All `0x` addresses found in in-scope docs/scripts/contracts cross-reference to the public deployed-contract list in `CLAUDE.md` (entrypoint, pool, USDC, verifiers, Morpho Blue/IRM, admin/treasury, deprecated old pool, agentic-wallet payTo, 10 derived burn addresses with publicly verifiable preimage). No private addresses.
- **L-8** The only 64-char hex strings in scope are `0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549` — the `Deposited` event topic hash (keccak256 of the event signature). Not a private key. Appears in `scripts/test-full-flow.ts:38`, `scripts/seed-pools.ts:118`, `scripts/x402-test-agent.ts:39`, `src/app/api/demo/run/route.ts:55`.
- **L-9** Recent commits already on this branch (`ac38c70`, `866d625`) are clean per their diffs. Nothing here that needs URGENT rotation.

---

## Verdict

🟡 **PUSH WITH ONE CAVEAT** — no critical leaks, but decide whether `data/pre-push-smoke-*.log` and `data/providers.json` should be in version control before running `git add data/`. Two reasonable options:

1. **Extend `.gitignore`** with `data/pre-push-smoke-*.log` and `data/providers.json`, then `git add .gitignore data/` — Git will then commit nothing under `data/` (matches the spirit of the existing seed-pool ignores).
2. **Selective add**: `git add data/providers.json` only if the provider entry is meant to be a seed for production; otherwise skip the dir entirely.

Everything else is safe to push.

---

## Files scanned (in scope)

### Modified (22)
```
.env.example
.gitignore
CHANGELOG.md
STATUS.md
docs/gitbook/SUMMARY.md
docs/gitbook/anonymity-set-bootstrap.md
docs/gitbook/build-roadmap.md
docs/gitbook/configuration.md
docs/gitbook/decoy-scheduler.md
docs/gitbook/deploying-base-sepolia.md
docs/gitbook/faq.md
docs/gitbook/threat-model.md
docs/gitbook/threshold-asp.md
docs/gitbook/trust-model.md
docs/gitbook/trusted-setup-ceremony.md
foundry.toml
src/app/api/asp-update/route.ts
src/app/api/facilitator/supported/route.ts
src/app/api/health/route.ts
src/app/api/withdraw/route.ts
src/app/api/x402-pay/route.ts
src/lib/wagmi.ts
```

### Untracked (34, after exclusions)
```
.env.local.example
data/                                          (see M-1)
docs/competitive/why-not-an-l3-2026-05-31.md
docs/gitbook/anonymity-set-disclosure.md
docs/operations/anvil-fork-testing-runbook-2026-05-31.md
docs/operations/decoy-scheduler-runbook-2026-05-31.md
docs/operations/demo-page-runbook-2026-05-31.md
docs/operations/env-doctor-runbook-2026-05-31.md
docs/operations/seed-phase0-runbook-2026-05-31.md
docs/operations/staging-stack-runbook-2026-05-31.md
docs/operations/stealth-provider-onboarding-2026-05-31.md
docs/release/base-sepolia-push-readiness-2026-05-31.md
docs/release/base-sepolia-push-runbook-2026-05-31.md
docs/release/test-results-2026-05-31.md
docs/sales/                                    (only exposure-audit/ excluded; parent dir is otherwise empty)
docs/seed-pool/execution-checklist-2026-05-31.md
docs/seed-pool/funding-strategy-2026-05-31.md
docs/seed-pool/risk-analysis-2026-05-31.md
scripts/anvil-fork-sepolia.sh
scripts/decoy-scheduler-launcher.sh
scripts/decoy-scheduler.service
scripts/decoy-watchdog.cron
scripts/decoy-watchdog.sh
scripts/env-doctor.sh
scripts/forge-wrap.sh
scripts/onboard.sh
scripts/onboard.ts
scripts/pre-push-smoke-staging.sh
scripts/pre-push-smoke.sh
scripts/register-stealth-provider.ts
scripts/seed-phase0-local.sh
scripts/seed-phase0.sh
scripts/seed-pools.phase0.config.json
scripts/seed-pools.staging.config.json
scripts/seed-staging.sh
scripts/test-crash-resume-drill.sh
scripts/test-stealth-roundtrip.sh
src/app/anonymity-set/page.tsx
src/app/api/anonymity-set/route.ts
src/app/api/demo/run/route.ts
src/app/demo/page.tsx
src/lib/contracts.ts
zbase-protocol/pkg/contracts/script/DeployStaging.s.sol
zbase-protocol/pkg/contracts/script/DeployThresholdEntrypoint.s.sol
zbase-protocol/pkg/contracts/script/README-deploy-staging.md
zbase-protocol/pkg/contracts/script/README-deploy-threshold.md
zbase-protocol/pkg/contracts/test/DeployStaging.t.sol
zbase-protocol/pkg/contracts/test/DeployThresholdEntrypoint.t.sol
```

### Recent commit diffs reviewed
- `866d625` — fix(B.3): seed-pools.ts crash-restart no longer double-deposits — clean
- `ac38c70` — docs(gitbook): restructure to mirror shh.gg navigation format — clean (the matches for "secret" are crypto terminology + env-var names, never values)

---

## Files explicitly excluded per founder instruction

- `docs/ceremony/` (entire dir)
- `docs/bd/` (entire dir)
- `docs/trusted-setup-ceremony-options-2026-05-31.md`
- `docs/governance/` (entire dir)
- `docs/sales/exposure-audit/` (entire dir)
- `.claude/` (gitignored, agent state only)

Also untouched per scope: `node_modules/`, `lib/` (vendored Foundry deps), `.next/`, `artifacts/`.
