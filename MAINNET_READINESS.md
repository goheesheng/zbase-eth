# Base Mainnet Readiness — single-value pool (v1)

**Purpose:** ONE tracked dashboard for what stands between "works on Base Sepolia" and "safe on
Base mainnet." Not a runbook — the runbooks are `docs/release/mainnet-deploy-command.md` and
`docs/release/mainnet-runbook-single-value.md`; this is the status board that links them.

**Last verified:** 2026-07-04 (gap analysis, evidence cited to file:line below).

**One-line status:** the **code** side is nearly done (only fee-flip-gated items remain); **every
remaining hard blocker is operational/human or external audit.** `MAINNET_STACK` is still all
`0x0` (`src/lib/contracts.ts:211-212`) — there is no 0xbow pool on Base mainnet yet.

> **The single most important gate (from the runbook):** *"None of this earns a dollar without a
> seller. Deploy mainnet FOR a specific seller, not before."* — don't deploy mainnet as a milestone;
> deploy it for committed demand.

**Legend:** ✅ DONE · ⬜ OPEN · ⛔ BLOCKED (by audit/ceremony). Tags: **[code]** = an engineer can
do it · **[human]** = CEO decision/action (custody, keys, legal, deploy) · **[external]** = audit firm.

---

## A. Code — nearly complete

| # | Item | Status | Tag | Evidence |
|---|------|--------|-----|----------|
| A1 | B6 network-threading on money/ASP path (withdraw, asp-update, authorize, supported, verify) | ✅ | [code] | `contracts.ts:78-94`; `withdraw/route.ts:179`; audit-sweep-2026-06-17:155 |
| A2 | B6 residual — `transfer/route.ts` + `asp-screening.ts` HyperSync network-threaded | ✅ | [code] | fixed 2026-07-04 (commit fe870a5) |
| A3 | B7 — Upstash fail-closed startup assert on mainnet | ✅ | [code] | `facilitator-authz.ts:62-69` |
| A4 | Provider payout-hijack ownership proof (auto-on mainnet) | ✅ | [code] | `providers/register/route.ts:243` |
| A5 | Single-value `/api/withdraw` rate-limited | ✅ | [code] | `withdraw/route.ts:172` |
| A6 | 0xbow contracts vendored + `DeployMainnetPool.s.sol` ready | ✅ | [code] | mainnet-deploy-command.md |
| A7 | Stage-5 fee-flip fixes: `user/upgrade` ownership + tx-namespace invariant | ⬜ | [code] | mainnet-runbook-single-value.md:146-151 — **inert while FEE_REQUIRED=false**; do before flipping fees |

**Code verdict:** no open code blocker for a `FEE_REQUIRED=false` mainnet deploy. A7 is only needed
before turning fees on.

---

## B. Operational / human — the real gate (CEO)

| # | Item | Status | Tag | Evidence |
|---|------|--------|-----|----------|
| B1 | **Stage-0: a committed seller / concrete reason to be on mainnet** | ⬜ | [human] | mainnet-deploy-command.md:141 |
| B2 | Run the funded-key mainnet deploy (`DeployMainnetPool.s.sol`) — Claude never runs on-chain txs | ⬜ | [human] | mainnet-deploy-command.md:56 |
| B3 | Paste real mainnet addresses into `MAINNET_STACK` (entrypoint, usdcPool, poolDeployBlock, verifiers) | ⬜ | [code, after B2] | `contracts.ts:211-223` |
| B4 | Provision mainnet env: Upstash (mandatory), CDP keys, POSTMAN, ZBASE_SEED_ENCRYPTION_KEY, CRON_SECRET, BASE_MAINNET_RPC, TREASURY | ⬜ | [human] | mainnet-deploy-command.md:104-121 |
| B5 | CDP mainnet Paymaster policy (post-deploy, ORDERING-CRITICAL) | ⬜ | [human] | mainnet-deploy-command.md:23-28 |
| B6 | Set initial ASP root (`/api/asp-update`) — else every withdrawal reverts `IncorrectASPRoot` | ⬜ | [human] | mainnet-runbook-single-value.md:122 |
| B7 | Seed treasury deposits so the anonymity set isn't empty | ⬜ | [human] | mainnet-runbook-single-value.md:126 |
| B8 | POSTMAN/OWNER key custody: Ledger / CDP / 3-of-5 signers; grantRole→revokeRole handoff (keep ≥1 owner you control) | ⬜ | [human] | mainnet-deploy-command.md:130-139 |
| B9 | Screening data-source decision (snapshot → live OFAC/Chainalysis/TRM) | ⬜ | [human] | mainnet-runbook-single-value.md:136 |
| B10 | Legal/MSB read before `FEE_REQUIRED=true` + real money | ⬜ | [human] | seed-pool/risk-analysis-2026-05-31.md:14-16 |
| B11 | Flip `FEE_REQUIRED=true` (after B1+A7+B10) | ⬜ | [human] | mainnet-runbook-single-value.md:159 |
| B12 | Double-confirm merge to protected `main` (auto-deploys zbase.app) | ⬜ | [human] | project rule — never merge to main without explicit double-yes |
| B13 | Re-run the paid-settle proof on mainnet once (small amount) | ⬜ | [human] | mainnet-runbook-single-value.md:167 |

---

## C. External audit — mandatory before real money

| # | Item | Status | Tag | Evidence |
|---|------|--------|-----|----------|
| C1 | External audit of the deployed single-value pool instance | ⬜ | [external] | SECURITY.md:68 — *"external audit required before real money"* |
| C2 | BaseScan-verify the deployed pool (live Sepolia pool is currently unverified) | ⬜ | [human] | mainnet-runbook-single-value.md:14 |

> The single-value pool inherits 0xbow's *upstream* audit (ChainSecurity, Trail of Bits), but there
> is **no external audit of your specific deployed instance.** The standing documented posture is
> "internal review only; external audit required before real money" (SECURITY.md:68).

---

## D. Separately BLOCKED — do NOT gate single-value mainnet on these

| # | Item | Status | Tag | Evidence |
|---|------|--------|-----|----------|
| D1 | **ExecutorProcessooor** on mainnet (private-funded DeFi access, v1 executor) | ⛔ | [external]+[code gate] | `DeployExecutorProcessooor.s.sol:76` hard-blocks chainid 8453 until audited |
| D2 | **UTXO** (amount-hiding, v2) — trusted-setup ceremony not run | ⛔ | [human] | `getStackByName` throws on mainnet UTXO (`contracts.ts:261`) |
| D3 | UTXO circuit external audit — C4 amount binding + B3-residual per-input depth | ⛔ | [external] | `docs/security/c4-amount-binding-design-2026-07-04.md` |

D1/D2/D3 are their own tracks. The single-value pool is ceremony-free and ships independently.

---

## Critical path to a mainnet single-value launch (the short version)

1. **B1** — have a seller. (Everything below is wasted without this.)
2. **A7** + **B10** — fee-flip code + legal read (only if launching WITH fees; can launch fee-off first).
3. **C1** — external audit of the deployed instance.
4. **B2 → B3** — deploy the pool, wire the addresses.
5. **B4 → B8** — env, Paymaster, ASP root, seed, custody keys.
6. **B12 → B13** — double-confirm merge, mainnet settle proof.

**Note for future Claude sessions:** Claude does the [code] rows and (after B2) can paste addresses
into `MAINNET_STACK`. Claude does NOT run mainnet deploys, hold keys, merge to `main`, or flip
`FEE_REQUIRED` — those are [human] gates by rule. Mainnet realistically waits on C1 (audit).

---

## ⚠️ AUDIT STATUS — CORRECTED 2026-07-04

**There is NO external audit.** "Audited" in some docs refers to the **internal review (2026-06-11)**
only. Per `SECURITY.md:68`, the internal review **does NOT clear mainnet / real-money use** — an
external audit remains required. The `mainnet-deploy-command.md` line "deploy script audited" means
*internally* reviewed, not externally audited. **C1 (external audit) is OPEN.**

If the CEO chooses to deploy **pre-audit**, that is an explicit acceptance of the risk of running
unaudited fund-holding contracts with real user money, against the standing policy in `SECURITY.md`.
This box records that the gate was known and stepped over deliberately — not missed.

---

## 🚀 DEPLOY PREP (CEO runs it — "prep everything for me", 2026-07-04)

Deploy is OPERATOR-RUN with YOUR funded mainnet key + custody. Claude never runs mainnet txs and
never handles the key. Full runbook: **`docs/release/mainnet-deploy-command.md`** (turnkey; three-
address model, CDP Paymaster ordering, post-deploy wiring). This section is the short prep summary.

**Verified ready (2026-07-04):** the vendored deploy script **builds clean** (`FOUNDRY_PROFILE=vendor
forge build` → Compiler run successful) with correct safety asserts (`owner==deployer`, USDC-code
check, post-deploy invariant verification at `DeployMainnetPool.s.sol:128-133`).

**FORK REHEARSAL PASSED (2026-07-08):** full deploy executed against an anvil fork of live Base
mainnet (block 48327257) with a throwaway key — all 5 txs succeeded. Independently verified with
cast: `pool.ASSET()==mainnet USDC` ✅, `pool.ENTRYPOINT()==proxy` ✅, `SCOPE` nonzero + `dead()==false` ✅,
owner has `OWNER_ROLE` ✅, CDP smart account `0xd411f68a…` has `ASP_POSTMAN` ✅, `scopeToPool(SCOPE)==pool` ✅,
`assetConfig(USDC)` = (pool, minDeposit 0, vetting 100 bps, maxRelay 1000 bps) ✅, fresh verifiers have
code ✅. Impersonated the CDP postman and posted a test ASP root via `updateRoot` → `latestRoot()`
returned it ✅ (pre-root call correctly reverts `NoRootsAvailable()` — that's why go-live step
`/api/asp-update` is mandatory). Estimated real deploy cost: ~23.1M gas ≈ **0.00024 ETH (<$1)** at
0.0105 gwei; the 0.01–0.02 ETH funding guidance is headroom. Dry-run simulation needs NO gas and NO
private key (`--sender` alone works). Fork broadcast artifacts deleted to avoid confusion with a real
deploy's `run-latest.json`.

**Pre-flight you must do (each prevents a wasted deploy):**
1. **Funded mainnet deployer key** (~0.01–0.02 ETH). In CDP-postman mode this is the ONLY address of
   yours that needs mainnet ETH. **NOT the Sepolia demo key** — a real, custodied mainnet key.
2. `ENTRYPOINT_OWNER` == the deployer address (one-shot register requires it).
3. `ENTRYPOINT_POSTMAN` — the mainnet ASP-root signer (EOA or the CDP smart account `0xd411f68a…`).
4. USDC defaults to Base-mainnet Circle USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

**The command (you run; vendor profile):**
```
FOUNDRY_PROFILE=vendor \
ENTRYPOINT_OWNER=<your_deployer_addr> \
ENTRYPOINT_POSTMAN=<mainnet_postman_addr> \
forge script zbase-protocol/pkg/contracts/src/vendor/0xbow/script/DeployMainnetPool.s.sol:DeployMainnetPool \
  --rpc-url $BASE_MAINNET_RPC --broadcast --verify   # --verify needs BASESCAN_API_KEY
```

**After it lands (Claude can do the [code] part):**
1. Paste the printed addresses (entrypoint, usdcPool, poolDeployBlock, verifiers) into
   `MAINNET_STACK` (`src/lib/contracts.ts:211-223`). ← Claude does this.
2. Provision mainnet env (B4): Upstash (mandatory), CDP keys, POSTMAN, TREASURY, etc.
3. **Set the CDP Paymaster policy for the postman BEFORE flipping `POSTMAN_SIGNER=cdp`** (ordering-
   critical — else every relay/updateRoot reverts unsponsored).
4. Call `/api/asp-update` to set the initial ASP root (else all withdrawals revert `IncorrectASPRoot`).
5. Seed a few treasury deposits so the anonymity set isn't empty.
6. **Double-confirm** before merging to `main` (auto-deploys zbase.app).
7. Run ONE small paid-settle proof on mainnet.

**Still true regardless of the above:** the ExecutorProcessooor (private-funded DeFi access) stays
mainnet-blocked in code (D1) — this deploy is the plain single-value pool only.

---

## 🔒 ExecutorProcessooor — internal audit + fixes (2026-07-07)

Three independent adversarial audit passes (fund-theft, correctness/ERC-20, SDK integration). Crypto
binding verified SOUND (byte-identical context preimage across proof-gen/executor/pool). **6 findings
fixed + proven by tests** (commit b2e5954): F1/F2 (beneficiary/minOut → silent loss) require minOut>0
+ outDelta>0; F3 require(inputToken==pool.ASSET()); F5 reject same-token; F6 reject zero-selector +
short calldata; gas hint 1.5M→3M.

**Redeployed FIXED contract to Base Sepolia (2026-07-07):**
- ExecutorProcessooor (FIXED): **`0x58a27688A086f8E429Dbf294B0d12FC12623aC25`**
  (supersedes the pre-fix `0xFdC3…5Fc2` — do NOT use the old one).
- TestVault4626 (unchanged): `0x2FfAc66F5a43990Fe53C14eA4fec7057E7135e37`.
- **Corrected E2E PASSED** (tx `0x1d13e6…`): receiver=executor + minOut>0 (the earlier green was a
  false pass — old harness used receiver=recipient + minOut=0, never exercising the sweep). Recipient
  got shares; postman submitted (unlinkable). ✅
- **F4 gas BENCHMARK (real):** `executeFromPool` used **786,502 gas** against the real pool + mock
  vault. Well under the 3M hint (~2.2M headroom). CAVEAT: mock vault is trivial; a real ERC-4626 with
  reward/oracle accrual could add 100–400k — benchmark per-target before whitelisting on mainnet.

**Executor mainnet gate (D1) UNCHANGED:** still requires an EXTERNAL audit (this internal one does
not replace it) + removing the chainid-8453 deploy block. The internal audit means an external auditor
now starts from a clean contract.
