# Mainnet runbook — single-value private x402 facilitator (Base mainnet)

The full ordered road to charging real USDC on Base mainnet. Single-value pool
only (the revenue product) — **ceremony-free** (reuses 0xbow's audited verifiers).
UTXO is separate and not required (see project_utxo_testnet_state).

> Status legend: ✅ done · 🔧 code work · ⚙️ config/ops (you) · 🚦 your decision gate

---

## ✅ READ FIRST — the contract-source blocker is RESOLVED (2026-06-28)

The live Sepolia pool (`0x4ebcfeaf…`) is 0xbow's upstream `PrivacyPoolComplex` +
`Entrypoint` — NOT in this repo originally, NOT verified on BaseScan (checked
2026-06-26: Sourcify + BaseScan both unverified), and 0xbow is NOT on Base
mainnet. So mainnet requires deploying 0xbow's contract yourself.

**This is now done (commit ac3b3a7):** 0xbow's source is vendored at
`src/vendor/0xbow/` (Apache-2.0), builds green (`FOUNDRY_PROFILE=vendor forge
build`), with a ready deploy script `…/script/DeployMainnetPool.s.sol`. The effort
went from "unknown blocker" → "known: operator runs the deploy." Closes the
standing CSO-P1-3 audit finding (no source/test against the real pool ABI).

The remaining contract task is the operator deploy plus a Sepolia dry-run of the
ragequit path before broadcasting to mainnet (see Stage 2).

---

## Stage 0 — 🚦 Decision gate (you)
- Sepolia charge proven ✅ (done 2026-06-25, treasury split verified on-chain).
- Mainnet = real money on protected `main`. Per your rule, needs explicit
  double-confirm at the merge.
- Honest precondition: a reason to be on mainnet. Mainnet with no seller earns $0
  at real cost. Ideally a signed/committed first provider, or a launch plan.

## Stage 1 — ⚙️ Provision infrastructure (you, ~1h)
- **Upstash Redis** (prod) — MANDATORY. Code throws at startup if
  `NEXT_PUBLIC_NETWORK=mainnet` without it (facilitator-authz.ts:63, the B7 guard).
  Set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
- **CDP API keys** — `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` from
  portal.cdp.coinbase.com. The mainnet x402 facilitator is Coinbase's CDP
  (x402.org is Sepolia-only). These same keys also power the optional CDP
  sponsored postman (below).
- **Postman signer — use CDP for mainnet:** set `POSTMAN_SIGNER=cdp` +
  `CDP_WALLET_SECRET` + `CDP_POSTMAN_SMART_ACCOUNT` (reuses the CDP API keys). A
  CDP ERC-4337 smart account signs with sponsored gas — **no ETH to fund on the
  postman**, no raw key on the server. Configure the mainnet Paymaster policy in
  the CDP Portal. Full steps + Sepolia-first verification:
  `docs/release/cdp-postman-setup.md`.
  - **EOA emergency fallback:** `POSTMAN_SIGNER=eoa` + `POSTMAN_PRIVATE_KEY` is
    blocked when `NEXT_PUBLIC_NETWORK=mainnet` unless
    `ZBASE_ALLOW_MAINNET_EOA_POSTMAN=true`. If you use this override, fund the
    postman wallet with real ETH and treat it as a temporary break-glass path.
- **Fund the deployer wallet (real ETH):** deploy gas. (The postman only needs ETH
  in EOA mode; CDP mode is sponsored.) Keep keys in env, never in repo.
- **`CRON_SECRET`** set in Vercel (the indexer-sync cron fails closed in prod
  without it — see learning_vercel_hobby_cron_daily).
  - ✅ **DONE for testnet (2026-07-11):** the *Sepolia* `CRON_SECRET` +
    `ZBASE_SEED_ENCRYPTION_KEY` are now set on Vercel Production scope (health went
    `degraded → ok`). ⚠️ Those are the **testnet** values — prod currently serves
    Base Sepolia. At mainnet cutover, GENERATE FRESH mainnet values and swap them
    into Production scope (see key split below). Do NOT reuse the Sepolia enc key
    on mainnet.
- **`ZBASE_SEED_ENCRYPTION_KEY`** — 64-hex (32 bytes; `openssl rand -hex 32`).
  Found MISSING on live zbase.app during the 2026-06-25 SDK audit: `/api/health`
  returns **"degraded"** until it's set (its `allOk` requires `encKeyConfigured`),
  and `scripts/seed-pools.ts` (the anonymity-set seeding in Stage 4) **refuses to
  run without it** (AES-256-GCM for `data/seed-notes.encrypted.json`). Does NOT
  gate live settle, but set it before seeding + to clear the degraded health.
  Treat like a custody key. **WRITE-ONCE on mainnet** — rotating it after the first
  mainnet deposit orphans encrypted seed notes (funds unrecoverable). Full
  testnet-vs-mainnet key policy: `docs/security/key-management.md`.

## Stage 2 — 🔧 Contracts: vendor + deploy
✅ **Vendoring DONE (2026-06-28, commit ac3b3a7).** 0xbow's PrivacyPool +
Entrypoint + verifiers are vendored at `src/vendor/0xbow/` (Apache-2.0, slim:
oz/poseidon reuse existing lib/+node_modules; oz-upgradeable + lean-imt vendored).
Builds green via `FOUNDRY_PROFILE=vendor forge build` (the default suite is
untouched). Deploy script ready: `src/vendor/0xbow/script/DeployMainnetPool.s.sol`.
See `docs/release/0xbow-vendor-deploy-rehearsal-2026-06-26.md`.

What's left in Stage 2 = the operator deploy (funded key):
0. **⚠️ CORRECTED (audit 2026-06-28): verifiers are NOT reusable by address.** The
   Sepolia verifiers `0x5f5505…`/`0x293400…` have **NO CODE on Base mainnet**
   (verified on-chain — 0xbow deploys via CREATE2 with a deployer-namespaced salt,
   so addresses are per-chain). DeployMainnetPool.s.sol now **deploys fresh
   WithdrawalVerifier + CommitmentVerifier in-script** — no env addresses to get
   wrong. The ragequit verifier IS the CommitmentVerifier (resolved 2026-06-28).
1. **Ragequit `[8]` vs `[4]` overload — MUST Sepolia dry-run first.** `PrivacyPool
   .ragequit` calls the verifier with `uint256[8]`, but the deployed
   CommitmentVerifier implements only `[4]`. May revert at runtime → depositors
   can't self-exit a dead pool. PROVE it on a Sepolia dry-run (deposit→ragequit
   round-trip against the freshly-deployed verifier) BEFORE mainnet broadcast.
2. **One-shot vs split:** registerPool is `onlyRole(OWNER)`; the script enforces
   `owner == deployer` (else it reverts after paying deploy gas). For an
   owner-multisig, run deploy-only then registerPool separately.
   - USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Circle Base mainnet).
   - **NO Morpho / NO yield** (live pool is plain 0xbow — verified on-chain).
   - **Deploy block:** read from `broadcast/.../run-latest.json`, NOT the logged
     `block.number` (simulation block ≠ mined block → wrong eth_getLogs floor).
3. **Run the deploy** (operator, funded key — Claude never runs on-chain txs):
   ```
   ENTRYPOINT_OWNER=… ENTRYPOINT_POSTMAN=… POOL_MIN_DEPOSIT=1000000 \
   FOUNDRY_PROFILE=vendor forge script \
     zbase-protocol/pkg/contracts/src/vendor/0xbow/script/DeployMainnetPool.s.sol \
     --rpc-url $BASE_MAINNET_RPC --private-key $DEPLOYER_PRIVATE_KEY --broadcast --verify
   ```
   3-step: Entrypoint impl → ERC1967Proxy → initialize(owner,postman) →
   PrivacyPoolComplex → registerPool. Capture pool + entrypoint addresses + deploy block.

## Stage 3 — ⚙️ Wire mainnet env (you, ~15m)
`src/lib/contracts.ts` now reads the Base mainnet stack from env, so deployment
does **not** require a code change. Set these in Vercel / production env:
- `BASE_MAINNET_ENTRYPOINT` and `NEXT_PUBLIC_BASE_MAINNET_ENTRYPOINT`
- `BASE_MAINNET_POOL` and `NEXT_PUBLIC_BASE_MAINNET_POOL`
- `BASE_MAINNET_WITHDRAWAL_VERIFIER` and `NEXT_PUBLIC_BASE_MAINNET_WITHDRAWAL_VERIFIER`
- `BASE_MAINNET_COMMITMENT_VERIFIER` and `NEXT_PUBLIC_BASE_MAINNET_COMMITMENT_VERIFIER`
- `BASE_MAINNET_POOL_DEPLOY_BLOCK` and `NEXT_PUBLIC_BASE_MAINNET_POOL_DEPLOY_BLOCK`
- `BASE_MAINNET_RPC` (and optionally `BASE_MAINNET_WRITE_RPC`)

`BASE_MAINNET_USDC` defaults to Circle's canonical Base USDC
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; override it only if you know why.
Verify all deployed contracts on BaseScan, then run:

```bash
NEXT_PUBLIC_NETWORK=mainnet npm run preflight:mainnet
```

## Stage 4 — ⚙️ Initialize ASP + flip network (you, ~30m)

**How the ASP works (your ASP vs 0xbow's):** the on-chain ASP mechanism IS
0xbow's — `Entrypoint.updateRoot(root, ipfsCID)` gated by the `ASP_POSTMAN` role,
`latestRoot()` for withdrawals. 0xbow's contract is AGNOSTIC about what root you
post — it stores whatever the POSTMAN signs. The ASP *service* (deciding what's
"clean") is 100% YOURS: `/api/asp-update` fetches deposits → screens (OFAC SDN L1
+ curated risk overlay L2, `src/lib/ofac-screening.ts`) → builds a Poseidon Merkle
of APPROVED labels → posts via the POSTMAN key. So "getting the ASP" = run your
existing service against the mainnet pool. You don't acquire an ASP; you ARE one.

Steps:
- **Verify the on-chain minimum before accepting deposits:**
  `assetConfig(USDC).minimumDepositAmount` must be at least `1_000_000` atomic
  units (1 USDC). The deploy script now defaults to this and refuses zero, but
  the live proxy configuration is the source of truth.
- **Set the initial ASP root** on the mainnet entrypoint with authenticated POST
  `/api/asp-update`. Without this, withdrawals revert `IncorrectASPRoot`.
- Every confirmed, screened deposit should be included automatically. Clients
  submit only the public transaction hash to `/api/deposits/confirm`; signer and
  screening credentials remain server-side. Keep the protected host cron
  `* * * * * ... cron-hit.sh mainnet asp-update` as the repair/backstop. Multiple
  deposits may be batched into one root update; no transaction is sent when the
  root is already current.
- Customer discovery stays closed below 30 commitments and until
  `ZBASE_ANONYMITY_SET_PROVENANCE_VERIFIED=true`. Treasury seed deposits must be
  disclosed and do not count as 30 independent users merely because they create
  30 commitments. Use real user acquisition for meaningful crowd privacy.

**Two ASP DECISIONS to make for mainnet (not blockers, but real):**
1. **POSTMAN key custody.** Single key today (whoever holds it controls the ASP
   root — can censor approvals or push bad labels). The decentralized upgrade is
   `ThresholdEntrypoint.sol` (3-of-5 quorum) — built + tested but NOT deployed
   (needs 5 signers recruited). Single key is adequate for launch (same as
   Sepolia); 3-of-5 is a later trust upgrade for regulated providers.
2. **Screening data source.** Today = an OFAC SDN snapshot + curated overlay. For
   real-money credibility, decide whether to upgrade to a live OFAC/KYT provider.
   The code has a default-off Chainalysis adapter hook
   (`ASP_SCREENING_PROVIDER=chainalysis` plus `CHAINALYSIS_SCREENING_URL` and
   `CHAINALYSIS_API_KEY`) that fails closed if the provider is unavailable or
   returns an unrecognized decision. Do not set it until you have the actual
   account/API contract and response schema.
   (Per the differentiation review: ASP is inherited 0xbow plumbing, NOT a moat —
   the trust is in YOUR specific screening + key governance, not 0xbow's brand.)

## Stage 5 — ✅ Deferred fee-path security items fixed
The pre-merge audit (2026-06-24) gated these before fees-on. Current state:
- **`/api/user/upgrade` payer binding:** fixed. Premium is granted only to the
  address that paid the USDC upgrade tx (`Transfer.from`), preventing stolen
  upgrade claims.
- **tx-namespace invariant:** fixed and regression-tested. `/authorize` and
  `/user/upgrade` consume tx hashes in separate `authz` / `premium` namespaces.
- ~~**Provider registration auth**~~ ✅ DONE (2026-06-25, commit a707255):
  `providers/register` now requires an EIP-191 ownership signature over each
  claimed payout address, enforced on mainnet (`ZBASE_REQUIRE_PROVIDER_OWNERSHIP`
  / mainnet auto). Address-squatting payout-hijack closed. (Also done this session:
  the unauthenticated/unrate-limited `/api/withdraw` single-value path now has a
  nullifier-keyed rate limit.)

## Stage 6 — 🚦🔧 Flip fees + go live (you + merge)
- `FEE_REQUIRED=true` (or per-tier as decided).
- Launch safeguards: TVL cap (e.g.
  $500K for ≥90 days), honest disclosure ("mainnet, TVL-capped, internally
  audited, external audit on roadmap").
- Merge to `main` → Vercel deploys to zbase.app on mainnet. **Your explicit
  double-confirm per the main-branch rule.**
- Re-run the paid-settle proof on MAINNET (real $) once, small amount, to confirm
  the loop end-to-end before announcing.

---

## Effort summary (corrected)

| Stage | Type | Effort | Blocker |
|---|---|---|---|
| 0 decision | you | — | reason to be on mainnet (a seller) |
| 1 infra | config | ~1h | Upstash mandatory |
| 2 contracts | ✅ vendor DONE (ac3b3a7) | operator deploy only | funded deploy + Sepolia dry-run |
| 3 wire mainnet env + preflight | you | ~15m | deployed addresses |
| 4 ASP root + flip | you | ~30m | mandatory |
| 5 deferred security fixes | ✅ done | — | verify tests stay green |
| 6 flip + merge | you | — | double-confirm |

**Corrected total: ~2-3 days of code** (the 0xbow-vendoring is the surprise),
plus your config/deploy/decision actions. Still no ceremony.

## The honest bottom line
- **Ceremony-free: yes.** Single-value reuses 0xbow's audited verifiers.
- **The real blocker is NOT a missing script — it's that the live pool's contract
  source isn't in this repo.** Resolve that first (recover the 0xbow checkout, or
  vendor it). This also closes a standing audit finding (CSO-P1-3).
- **None of this earns a dollar without a seller.** Mainnet is the enabler; a
  paying customer is the revenue. Deploy mainnet FOR a specific seller, not before.

## Open question to resolve first (only you/your history know)
**How was the Sepolia pool `0x4ebcfeaf…` originally deployed?** From a separate
0xbow `privacy-pools-core` checkout? If you still have that, Stage 2 collapses to
"re-run that deploy against mainnet" (~½ day). If not, it's vendor-from-scratch
(~1-2 days). This single answer determines the whole mainnet timeline.
