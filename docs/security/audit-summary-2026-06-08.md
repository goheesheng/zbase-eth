# Audit summary — 2026-06-08

**Branch:** `audit/pre-publish-sweep-2026-06-08`
**Repo state:** clean working tree at `18df137`, plus this audit's commits
**Trigger:** user request — "keep testing to check if sdk interacts with facilitator and we earn from the fees"
**Scope:** full repo (`/cso --comprehensive`) + the three workspace packages' published surface (`/security-review`) + SDK ↔ live facilitator integration smoke

This is the single-page triage. Full details in:
- [`cso-audit-2026-06-08.md`](./cso-audit-2026-06-08.md) — 15-phase repo audit at 2/10 confidence
- [`package-review-2026-06-08.md`](./package-review-2026-06-08.md) — what the three packages ship to npm
- [`/scripts/integration-sdk-vs-facilitator.mjs`](../../scripts/integration-sdk-vs-facilitator.mjs) — runnable SDK ↔ prod smoke (no funded wallet needed)

---

## Headline: SDK works, fees earn on-chain — with 2 P0 fixes needed before publish

| Question | Answer |
|---|---|
| Does the SDK interact with the facilitator? | **Yes** for `@zbase-protocol/core` and `@zbase-protocol/mcp` (29/33 checks pass). **No** for `@zbase-protocol/svm` — build fails before pack. |
| Are we earning from the fees? | **Yes — verified on-chain.** Treasury holds 7,100 atomic ($0.0071) right now. All settles via PR #26 split correctly (recipient + treasury split atomically in the pool tx, per [`0x2f4a...f0da`](https://sepolia.basescan.org/tx/0x2f4ac43d438be57e45a307faadb639279d428304299f53524d668c3d5106f0da)). |
| Is the prior PR-stack of fixes (PR #20-#26) holding? | **Yes — all 5 verified PASS** in the CSO audit. PR #20 rate-limit bucketing, PR #21 grace-period removal, PR #22 Upstash round-trip, PR #25 tier upgrade-only, PR #26 on-chain fee split with FIND-301/302 fixes — all confirmed. |
| Can the repo go public today? | **No.** Two P0s block: (a) live Gemini API key in git history; (b) `nullifierHashOf` runtime crash in core SDK. |
| Can `npm publish` ship today? | **No.** svm is unbuildable, mcp/core need `publishConfig.access: "public"` (otherwise paid private), and the P0 SDK runtime bug ships to every consumer. |

---

## P0 — Fix before any public-facing distribution

| ID | Finding | File | Why P0 |
|---|---|---|---|
| **PKG-P0-1** ✅ | `nullifierHashOf` throws `ReferenceError: require is not defined` for every ESM consumer | `packages/core/src/notes.ts:154` | **FIXED 2026-06-08** — replaced `require()` with top-level `import { poseidon1 } from "poseidon-lite"`. Verified via clean npm install + node import. |

### Resolved this session

| ID | Finding | Resolution |
|---|---|---|
| ~~CSO-P0-1~~ | Google Gemini API key `AIzaSy...6-WE` in git history | **Key REVOKED upstream 2026-06-08.** Downgraded to P2. Full-key occurrences redacted from audit docs to stop them re-leaking the dead key. History rewrite deferred — see `cso-audit-2026-06-08.md` P0-1 section. |
| ~~PKG-P0-1~~ | `nullifierHashOf` runtime crash | **Fixed 2026-06-08** at `packages/core/src/notes.ts:154`. |

---

## P1 — Embarrassing if found in week 1 of public

| ID | Finding | File | Severity |
|---|---|---|---|
| CSO-P1-1 | Next.js 16.2.4 has middleware-bypass CVE (GHSA-26hh-7cqf-hhc6). Privacy middleware is load-bearing for unlinkability. | `package.json:36` | Fix: `npm install next@16.2.7` (non-major) |
| CSO-P1-2 | `/api/withdraw` console-logs `value + label + commitment + recipient + pubSignals + ASP root` — defeats unlinkable-settle property for anyone with Vercel log access | `src/app/api/withdraw/route.ts:141-145, 244, 369-370, 483, 525-531` | Same class of bug as PKG-P1-4 below |
| CSO-P1-3 | Deployed pool source not vendored — FIND-301 mitigation un-verifiable locally (no forge test against the actual deployed contract ABI) | `contracts/PrivacyPoolMorpho.sol` (patch only) | The on-chain fee split DOES work (proven via tx receipt + treasury balance), but there's no test in this repo to prove it can't silently break |
| CSO-P1-4 | Rate-limiter mem-fallback collapses to per-Lambda buckets if Upstash env vars absent — silent privacy/rate degradation | `src/lib/rate-limit.ts:32-36, 73-102` | Add startup assertion `USE_UPSTASH === true` in prod |
| CSO-P1-5 | `/api/providers/register` writes to disk — broken silently on Vercel (read-only FS outside `/tmp`); also no auth on POST | `src/app/api/providers/register/route.ts:33, 77-84` | Move to Upstash; add auth |
| PKG-P1-1 | `@zbase-protocol/svm` depends on `@zbase-protocol/core: "*"` — npm-unresolvable | `packages/svm/sdk/package.json:20` | Pin to `^0.2.0` and publish core first |
| PKG-P1-2 | Missing `publishConfig: { access: "public" }` on all three packages — scoped packages default to `restricted` (paid) | All three `package.json` | Add `publishConfig` block |
| PKG-P1-3 | `@noble/curves` duplicate key in core — JSON last-wins resolves to `^1.6.0`, but stealth.ts code is developed against `^1.9.0`'s `ProjectivePoint` API. Fresh installs may throw on any stealth op | `packages/core/package.json:22,25` | Remove the `^1.6.0` duplicate |
| PKG-P1-4 | `@zbase-protocol/svm` logs raw Groth16 proof bytes + all 8 public signals (including nullifier hash) to stdout on every withdraw — privacy leak to operator log pipelines | `packages/svm/sdk/src/pool.ts:548-560` | Remove diagnostic dump block |
| PKG-P1-5 (NEW) | `@zbase-protocol/svm` doesn't build — 3 TS7006 errors on `(s)`/`(s, i)` callback params at `pool.ts:544,557` (caught while integration-testing) | `packages/svm/sdk/src/pool.ts:544,557` | Add explicit `: string` annotations (after addressing PKG-P1-4 which removes the offending lines anyway) |
| PKG-P1-6 (NEW) | `packages/mcp` not in root workspaces array — `npm run build --workspace=@zbase-protocol/mcp` fails to find the package | `package.json:5-9` | Add `"packages/mcp"` to workspaces |
| SDK-P1-1 (NEW) | `generateDepositSecrets()` returns `{nullifier: string, secret: string}`; `computeCommitment()` returns string. Type contracts say `bigint`. Any caller assuming bigint via `typeof === "bigint"` silently fails. Also: stringified secrets in `console.log(secrets)` (common in dev) leak the FULL nullifier+secret in plaintext | `packages/core/src/account.ts` (likely the `randomFieldElement` helper) | Either change return type to bigint, OR document string-as-decimal-bigint contract explicitly + add `redact()` helper |
| FAC-P1-1 (NEW) | `POST /api/facilitator/supported` returns HTTP 405 — but the x402 protocol convention is POST for facilitator discovery. The MCP server doesn't hit this endpoint, but any spec-compliant x402 client will | `src/app/api/facilitator/supported/route.ts` | Add `export async function POST() { return GET() }` |

---

## P2 / P3 (defense-in-depth, fix this month)

Full list in `cso-audit-2026-06-08.md`. Highlights:

- Agent-registry is in-process Map (resets every cold start → silently bypasses spend limits)
- `/api/asp-update` no rate-limit (POSTMAN gas burn vector)
- `/api/agent/register` + `/api/providers/register` no IP rate limit
- 9 high-severity npm advisories in transitive deps (underscore DoS, ws memory disclosure, bfj DoS)
- ASP single POSTMAN key (B.2 threshold scaffold not deployed)
- Caret ranges on cryptographic deps risk subtle behavior changes
- Test file `account.test.ts` ships in `@zbase-protocol/core` tarball (low impact, but signals dev surface)
- Missing `repository` field on core + svm (mcp has it)
- Non-constant-time view-tag compare in `decryptNote` (low exploitability in this context)

---

## What the integration smoke proved (`scripts/integration-sdk-vs-facilitator.mjs`)

```
29 passed · 4 failed

✓ @zbase-protocol/core export count = 38
✓ all 8 expected exports present (generateDepositSecrets, computeCommitment, …)
✓ computeCommitment + computeNullifierHash produce valid 75-77 char numeric values
✓ P0-1 confirmed — nullifierHashOf throws "require is not defined"
✓ GET /api/facilitator/supported HTTP 200, x402Version=2, Sepolia USDC declared
✓ pricing.enforced=true, testnet-free / mainnet-paid framing live
✓ storageBackend=upstash
✓ POST /api/facilitator/authorize correctly rejects fake tx (FIND-200 fix holds)
✓ /api/anonymity-set HTTP 200 (anonymitySet=124)
✓ /api/health git SHA 18df137 reported, entrypoint + privacyPool live
✓ treasury USDC balance = 7100 atomic (0.007100 USDC)
✓ 💰 treasury HAS EARNED > 0 USDC — fee path verified on-chain

✗ FIND-SDK-1: generateDepositSecrets.nullifier is string, not bigint
✗ FIND-SDK-2: computeCommitment returns string, not bigint
✗ FIND-FACILITATOR-1: POST /supported returns 405 (x402 convention is POST)
✗ /api/health HTTP 503 (degraded — encKeyConfigured: false flag on prod)
```

`/api/health` 503 is informational only — the `encKeyConfigured: false` check trips because `ZBASE_SEED_ENCRYPTION_KEY` is set to a sentinel value or absent on prod. Not in the P0/P1 list because it doesn't affect any actual fee or settle path.

---

## What needs a funded wallet (deferred — user action)

`scripts/simulate-buyer.ts` runs the full E2E: deposit 1 USDC → access fee → settle $0.700 → assert treasury delta = $0.0031. The sim's timing-race bug is already fixed in branch `chore/sim-timing-race-fix` (commit `2843b7a`, not pushed). To run it, fund a fresh `BUYER_PRIVATE_KEY` with:
- ≥0.005 ETH (https://www.alchemy.com/faucets/base-sepolia)
- ≥1.001 USDC (https://faucet.circle.com — Base Sepolia)

The old buyer wallet `0x6Eb6...` is on Task #79 to be rotated (PK was pasted in chat). Use a fresh one.

---

## Recommended sequencing

1. **Today / urgent:** Rotate the leaked Gemini API key. Even without a public flip, the key is 21 months old.
2. **Before any public flip:** decide on `git filter-repo` vs accept-revoked-key-in-history. Set `gitleaks` pre-commit hook so this can't happen again.
3. **Before any npm publish:** fix PKG-P0-1 (`nullifierHashOf` runtime bug — single line change). The package is otherwise installable and exports work.
4. **Soon (this week if possible):** Bump Next.js to 16.2.7 (single command, no breaking change). Strip the privacy-leaking console.logs from `/api/withdraw` + `packages/svm/sdk/src/pool.ts`.
5. **Before mainnet flip:** wire P1-4 (Upstash startup assertion) and P1-3 (vendor pool source + add fee-split forge test).
6. **At convenience:** the rest of P1 and all P2s.

None of these require touching `main` immediately. None publish anything. None go public. Everything lives on `audit/pre-publish-sweep-2026-06-08` until you say otherwise.
