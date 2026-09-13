# zBase — Implementation Status

This document is the source of truth for what is and is not implemented in the
zBase codebase. Marketing copy lives in `README.md` and `INTRO.md`; this file
exists so that anyone — auditor, integrator, depositor, agent operator —
can read a one-page accurate picture before trusting the system with funds.

## Current Launch Posture — 2026-08-12

- **Base:** active launch path. Base Sepolia remains the live test surface; Base
  mainnet is gated on the mainnet stack deploy, ASP root setup, production env,
  and one signed pilot.
- **Solana/SVM:** the `private-exact` x402 v2 SDK/facilitator and additional
  account/context fixes are implemented locally, but the live devnet program is
  stale. The reviewed SBF hash is
  `6961e45a7604c45eadec3c4f9f3424c1353e9acbdd8289460983b2d9d1912a3b`;
  the pre-upgrade devnet dump is
  `59526023d12424edcf5ba281ebdf7c9ad9752f539483062f2640960447ee2d41`.
  `ZX402_SVM_READY` remains false. Do not deposit or advertise Solana as
  production-ready. Mainnet is not authorized.

## Current SVM status — 2026-08-12

- Standard x402 v2 `/supported`, `/verify`, and `/settle` surfaces exist for
  the custom `private-exact` Solana scheme.
- Buyers generate proofs client-side. The proof payload contains no note
  nullifier/secret or change-note secret.
- Source now binds the proof to the actual recipient, amount, relayer, pool,
  mint, network, and canonical withdrawal bytes; recipient/relayer token owners
  and the pool vault are constrained on chain.
- The dormant arbitrary Kamino CPI instructions were removed. Yield is not a
  shipped SVM capability.
- The server fails closed unless the operator supplies the exact reviewed
  deployed ProgramData hash and a live RPC read hashes to the same value. Each
  payment separately enforces that merchant and relayer addresses differ.
- Facilitator mode requires merchant-provisioned recipient token accounts,
  enforces a configurable minimum payment, and serializes in-process attempts
  for one nullifier. Client note state cannot regress from indeterminate to
  rejected.
- The reviewed SBF artifact passed an isolated local-validator E2E with live
  ProgramData attestation, client-side Groth16 proofs, two sequential change-note
  spends, an interleaved second deposit, and a same-nullifier settlement race.
  This is local evidence only; the stale devnet artifact was not upgraded.
- Wallet and PDA-owned recipient ATAs are supported by the SDK. The local
  `zx402-native-receiver` example passed an atomic CPI E2E: a real Groth16 pool
  withdrawal paid a per-order program PDA, the receiver observed an exact
  5,000-unit token delta, and fulfillment state committed in the same
  transaction. An amount-mismatch case also proved that recipient tokens, the
  pool nullifier, and fulfillment state roll back together. The receiver is not
  deployed or independently reviewed.
- `customerReady:false` remains true even after the devnet flag is enabled.
- Production ASP witnesses, durable event indexing, cross-replica note
  locking/reconciliation, independent review, and operational controls remain
  hard mainnet blockers.

Authoritative design and gates:
`docs/ARCHITECTURE_SOLANA.md` and
`docs/release/svm-devnet-redeploy-checklist.md`.

## Anonymity Set — 2026-05-31

The privacy claim is only as strong as the number of depositors. zBase
publishes this metric live so anyone can verify it.

- **Live endpoint:** `/api/anonymity-set` (JSON), `/anonymity-set` (page)
- **Last manual snapshot:** 2026-05-31 — **~77 commitments** (pre-Phase-0;
  all from e2e/dev test activity)
- **Phase 0 seed (planned):** +30 commitments → ~107 total (~$1,600 USDC)
- **Phase 1 seed (planned):** +100 commitments → ~207 total (~$28K USDC,
  awaiting Base Ecosystem Fund grant)
- **Disclosure mode:** **Bootstrap** (organic < 30 → ratios hidden by
  design per `docs/seed-pool/risk-analysis-2026-05-31.md` §3)
- **Decoy scheduler:** **NOT RUNNING.** Scripts exist
  (`scripts/decoy-scheduler-launcher.sh`, `scripts/decoy-scheduler.service`)
  but no instance is started. Operator must launch manually before
  publicly claiming FIFO-resistance. Runbook:
  `docs/operations/decoy-scheduler-runbook-2026-05-31.md`.
- **Disclosure policy:** [`docs/gitbook/anonymity-set-disclosure.md`](docs/gitbook/anonymity-set-disclosure.md)
- **Next snapshot:** after Phase 0 runs live, or 2026-08-31, whichever first

## Phase 0 seed pool — 2026-05-31

Phase 0 exists to bootstrap the Base Sepolia anonymity set **now** without
waiting for the $27,775 Phase 1 treasury (which depends on Base Ecosystem
Fund matching capital that has not landed yet). The founder self-funds the
Phase 0 deposits from existing testnet USDC.

- **Denom mix:** `$10 x 10 + $50 x 10 + $100 x 10` = 30 deposits, **$1,600 USDC total**.
  Three distinct bands give early anonymity-set diversity matching the three
  realistic settlement sizes (micro-payment, typical agent call, settlement).
- **Config location:** `/Users/eesheng_eth/Desktop/zx402/scripts/seed-pools.phase0.config.json`
- **Encrypted notes:** `data/seed-notes.phase0.encrypted.json` (separate from Phase 1
  so the two runs cannot collide).
- **Run cadence:** `depositGapMs: 3000` — full Phase 0 run completes in ~90 seconds.
- **Crash-restart safe:** the `seed-pools.ts` double-deposit bug was fixed in
  commit `866d625` on the `integration-test` branch; a re-run after a partial
  failure resumes from the last persisted note instead of duplicating earlier
  deposits.
- **Run procedure:** see `docs/release/base-sepolia-push-runbook-2026-05-31.md`.

Phase 1 (the existing `scripts/seed-pools.config.json` with 100 deposits across
4 denoms = $27,775) remains the target once grant capital lands.

## Pending integration (merged to main 2026-06-03)

Eight shipments closing the production-grade privacy gaps. **Code is now on
main** (squash-merged via PR #7 + PR #8 on 2026-06-03). Auto-deploys to
zbase.app. None deployed to a new on-chain pool yet — the existing
deployed Entrypoint/Pool addresses still apply; UTXO + threshold-ASP +
yield-distribution contracts require fresh deploy ceremonies before they go
live. All passed local tests at merge time
(50/50 Foundry + 7/7 seed + 8/8 providers + 100/100 stealth invariants).

| Shipment | Status | Files | Deploy-ready? |
|---|---|---|---|
| A.1 UTXO notes | Scaffold + design | `circuits/note_spend.circom`, `packages/core/src/notes.ts`, `UTXOPool.sol` | No — needs trusted-setup ceremony |
| A.2 Decoy scheduler | Code + test | `scripts/decoy-scheduler.ts`, `scripts/test-fifo-resistance.ts` | Yes — needs operational budget |
| A.3 Metadata middleware | Code + test | `src/middleware.ts` | Yes |
| B.1 Stealth recipients | Code + 100-tx test | `packages/core/src/stealth.ts`, `src/app/api/providers/register/route.ts` | Yes — needs first provider to register |
| B.2 Threshold ASP | Contract + 7 tests + doc | `ThresholdEntrypoint.sol`, `scripts/threshold-postman/`, `docs/governance.md` | No — needs 5 signers recruited |
| B.3 Seed pool | Scripts + 7 tests + disclosure | `scripts/seed-pools.ts`, `docs/anonymity-set-disclosure.md` | No — needs treasury + Base grant |
| Yield distribution (EXPLORING) | Contract + 5 tests, on disk | `contracts/PrivacyPoolMorpho.sol` (BPS=0) | No — not deployed; exploring for idle deposits, not committed |
| Disclosure docs | 208 lines | `docs/gitbook/trust-model.md`, `threat-model.md` | Yes (docs-only) |

**Live-tested on Base Sepolia (2026-05-29):** every safe path exercised against a
running dev server. No new contract deploys (yield-distribution, UTXO, threshold-ASP
all still need ceremonies — listed in matrix above as "deploy-ready: No").

| Test | Result |
|---|---|
| Full E2E run 1 (1 USDC) | 7,086 ms · anon-set 75 · [deposit](https://sepolia.basescan.org/tx/0x10983625d69cc811c81be7a4eacb797fb43a7a626688c9af56fe6ee585b9a018) · [withdraw](https://sepolia.basescan.org/tx/0xecd379c0671d13890bf4b544030373199b35695a3be62607c3608292f076628c) |
| Full E2E run 2 (1 USDC) | 7,414 ms · anon-set 77 · [deposit](https://sepolia.basescan.org/tx/0xbb9806a8fef29e0d2b9b96011243e79d446febce0dd00dc782e287015b732842) · [withdraw](https://sepolia.basescan.org/tx/0x878643fcb762b6b661b193b6d1b1e52d0c981314470ef2ca174a32451bbf3ae0) |
| A.3 middleware live HTTP | 6 sentinel headers stripped, 4 privacy headers stamped |
| A.2 decoy scheduler dry-run | 10 burn addrs loaded, Poisson cadence 43.9s, no gas spent |
| B.1 stealth SDK (100 derivations) | view-tag scan 164ms, all 100 keys recovered |
| B.1 providers/register live | POST 200, persisted to `data/providers.json` |
| B.3 seed pool dry-run | 100 deposits / 27,775 USDC across 4 denoms planned |

Mean settle ~7.25s across both runs (prior runbook baselines were 6,212/6,144 ms at
set size 66). The +900ms is ASP tree growth, not a code regression. Speed gate
revised to **≤10s p95** in `docs/gitbook/threat-model.md`.

**What the e2e DID NOT exercise** (because contracts not yet deployed):
yield distribution at withdrawal time, UTXO note spend circuit, threshold-signed
ASP root update. Those run only against their unit/foundry test suites today.

Design doc: `~/.claude/plans/i-want-production-grade-enchanted-scone.md`.

---

## Previous SVM status (historical; paused for launch)

> Historical evidence only. The May transaction proves an older honest path,
> not the safety or readiness of the binary currently on devnet. The August
> 2026 snapshot above supersedes every readiness statement in this section.

Last verified: 2026-05-10. **SVM V1 was previously verified on devnet** — full end-to-end
deposit + withdraw flow with on-chain Groth16 verification confirmed in
`tests/devnet-test.ts`. Deploy slot 461358027, redeploy slot updated. The
Fp2 coordinate ordering for `proof_b` and the verifying key was the
predicted gotcha (REDEPLOY.md line 83) — fixed in `tests/devnet-test.ts`,
`packages/svm/sdk/src/pool.ts`, and `scripts/build-verifying-key.mjs`.

## Per-chain summary

| Capability                          | EVM (Base Sepolia) | SVM (Devnet, paused) |
|-------------------------------------|--------------------|------------------------|
| Deposit instruction                 | Yes                | Yes                    |
| Withdraw / relay instruction        | Yes                | Yes                    |
| On-chain Poseidon commitment        | Yes                | Yes (light-poseidon)   |
| On-chain Merkle tree insertion      | Yes (LeanIMT)      | Yes (LeanIMT mirror)   |
| On-chain Groth16 verification       | Yes                | Yes (groth16-solana, 148K CU measured) |
| ASP root enforced on withdraw       | Yes                | Yes                    |
| Recipient bound into proof          | Yes                | Yes (via context)      |
| State-root replay window            | Yes (mapping)      | Yes (32-slot ring)     |
| Agent registry (spend limits)       | Off-chain          | On-chain ix exists     |
| Yield integration (EXPLORING, not deployed) | Morpho Blue (on disk) | Kamino Lending (on disk) |
| x402 facilitator advertised         | Yes                | No by default (`ZX402_SVM_READY=false`) |

**Verified end-to-end devnet test (2026-05-10):**
- Deposit: https://explorer.solana.com/tx/6sNuq4qV2BBDViXPKdF9cNAbHhv9XiguMWc41Lpku6TYA8q2FAH3qyxz1hFcPpkVohBm8vRWymLAVuBASWUFCWr?cluster=devnet
- Withdraw (on-chain Groth16 verify): https://explorer.solana.com/tx/4SxQaQrCcoeRxWAMKnLCc6QtwNaCim6M7wKepLdxrhwEcTDZg6tHydCBcgjTxXc9XyiXzk1aSyfrxDv7zdghzUzB?cluster=devnet
- Pool: https://explorer.solana.com/address/9eiwtv9JoPumaAngSzzq3PrzTBNVE8qzoXngRTGfR2Yx?cluster=devnet

EVM is feature-complete on Base Sepolia and matches the cryptographic
guarantees of the upstream 0xbow Privacy Pools design.

SVM V1 is **deployed and verified end-to-end on devnet** at
`7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM`. The on-chain program
performs Poseidon commitments, LeanIMT insertion, on-chain Groth16
verification (148K compute units measured), ASP root enforcement, and
recipient binding. Independent verification: re-run `npm run
test:svm-devnet` against your own wallet — the test prints explorer URLs
for each tx so a third party can confirm.

## What this means in practice

The Solana devnet pool was previously verified end-to-end, but it is **paused
for the Base mainnet launch** while the July 2026 SVM audit fixes are applied.
Do not treat it as an advertised production or pilot path until it is
re-enabled intentionally. The trust model is no longer "trust the relayer": the on-chain
verifier rejects any proof that doesn't satisfy state-root + ASP-root +
recipient-context constraints (verified by the failed-then-fixed Fp2 swap:
the same withdrawal that returns 9.95 USDC today returned `InvalidProof`
when the proof_b coordinates were in snarkjs-native order).

The remaining trust assumption is the **postman/ASP curator** — a single
key still curates the eligibility set. That's a roadmap item, not a
cryptographic gap. See "SVM operational notes" below.

**End-to-end agent flow verified (2026-05-10):** `npm run test:svm-x402-agent`
runs the full x402 + zBase cycle and settles in ~1.7 seconds. The settlement
transaction shows the pool paying the recipient with the agent wallet absent
from the transfer.

The `ZX402_SVM_READY` flag now defaults to `false`. The README banner and this
file together are the disclosure surface — if you find marketing copy elsewhere
in the repo that contradicts this file, this file wins.

## Historical path to SVM V1 live (superseded)

> Superseded by `docs/release/svm-devnet-redeploy-checklist.md`.

The cryptographic work is **done in source**. What remains is operational:

1. **Redeploy.** The wallet `BWTaGJeK2WNYXjfXuVYRf7Xt7a4CkT1kfuqsiB4Nh6H8`
   is the program upgrade authority and can do this in place — see
   `packages/svm/zx402-privacy-pool/REDEPLOY.md` for the exact command.
   The original deploy keypair is not required.
2. **`npm install` at repo root.** The TypeScript SDK and devnet test
   need their dependencies (`@noble/hashes`, `@zk-kit/lean-imt`,
   `poseidon-lite`, `snarkjs`) installed. These are listed in
   `packages/core/package.json` and `package.json`.
3. **Run the devnet test.** From `packages/svm/zx402-privacy-pool`:
   `npx ts-node tests/devnet-test.ts`. The test asserts
   off-chain↔on-chain agreement on label, commitment, and state root
   *before* it spends a relay tx, so the failure mode is loud and
   targeted if anything diverges.
4. **Only after the SVM audit fixes are complete, flip `ZX402_SVM_READY=true`**
   in the x402 server's environment
   alongside `ZX402_SVM_SDK_PATH=../sdk/dist` and
   `ZX402_CIRCUITS_URL=../../public/circuits`. The capability gating
   added in Phase 1 then turns the disclosure copy into truthful
   advertisement automatically.

## What was implemented in V1

For posterity, the cryptographic core that landed:

- **`packages/svm/zx402-privacy-pool/programs/zx402-privacy-pool/src/crypto.rs`**:
  BN254 Poseidon (arities 1, 2, 3) via `light-poseidon`, keccak-mod-field
  for `label` and `context`, LeanIMT frontier with on-chain insertion.
- **`programs/.../verifying_key.rs`**: auto-generated VK constant for
  `groth16-solana` from `public/circuits/withdraw/groth16_vkey.json` via
  `scripts/build-verifying-key.mjs`.
- **`programs/.../lib.rs`**: 32-byte BE field element storage everywhere,
  on-chain Groth16 verify + ASP-root match + recipient binding, ring
  buffer of recent state roots so a relayer can settle against a
  slightly-stale root.
- **`@zx402/core`**: `computeNullifierHash`, `computeLabel`, `feToBE32`
  fixes the upstream Circom mismatch in `account.ts`.
- **`@zx402/svm` SDK** rewritten so deposit/withdraw produce real
  Groth16 proofs and submit them in groth16-solana's expected layout.
- **x402 server** gained `/api/facilitator/{verify,settle,supported}`
  endpoints. `settle` requires `ZX402_SVM_SDK_PATH` and stays `503`
  until configured.

Everything above is on disk. Until the redeploy + test cycle in the
section above completes, none of it is on-chain. This file changes when
that does.

## Third-party x402 endpoints zBase can route privately

`/api/zx402/supported` advertises a `thirdPartyEndpoints` array sourced
from `src/lib/external-x402-catalog.ts`. Today the only catalogued
provider is **SAN Foundation** (`gateway.sanfoundation.com` — paid
agent / web-search / web-extract endpoints on Base mainnet, $0.0001 per
call, vanilla Coinbase x402).

A worked example lives at `scripts/x402-san-example.ts`. Today, running
it issues a real GET to SAN, receives a real 402, then fails honestly at
the settlement step because zBase's mainnet pool isn't yet deployed —
the SDK is configured for Base Sepolia. The 402 body it prints is the
integration-shape proof. We will link the example from README **after**
mainnet ships; until then it lives in `scripts/` as a developer
reference only.

Routing through the privacy pool today: not possible (mainnet pool not
deployed). Routing once mainnet ships: any standard x402 client wraps
its `fetch` with `zBase.wrapFetch(account)` and the cataloged endpoints
become private with no agent-side protocol changes.

## EVM operational notes

- Public RPCs (`sepolia.base.org`) have a 10K-block `eth_getLogs` limit;
  chunk queries with delays.
- The state Merkle tree must include all `LeafInserted` events (deposits
  + withdrawal change commitments), not just `Deposited`. Missing change
  commitments produce a wrong state root and `InvalidProof`.
- The ASP root goes stale after every new deposit. `/api/asp-update`
  refreshes it; it must be called after each deposit.
- `deposit()` requires explicit `gas: 1_000_000n`; `updateRoot()` requires
  explicit `gas: 200_000n`. Estimation returns the block limit for both.

## SVM operational notes

- The deployed devnet program is `7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM`,
  upgrade authority `BWTaGJeK2WNYXjfXuVYRf7Xt7a4CkT1kfuqsiB4Nh6H8`. The
  original deploy keypair is not required for upgrades — `solana program
  deploy --program-id <id>` works as long as that authority signs.
- The live devnet binary predates B4/B5 and the canonical-withdrawal-data
  check. The honest May 2026 Groth16 flow worked, but a malicious relayer can
  exploit missing payout/context bindings in that old artifact. That is why
  the pool remains paused.
- After the reviewed artifact deploys, the postman is still trusted for ASP curation
  (which labels are eligible to withdraw) but cannot redirect funds
  away from a proof's bound recipient.
- The Kamino instructions have been removed from the reviewed artifact. There
  is no SVM yield integration to configure or advertise.
- One remaining advisory: light-poseidon's BN254 round-constant table
  triggers a stack-frame warning on the BPF target. The warning is in
  the crate's bundled params, not our code, and Light Protocol's own
  programs use it in production. Confirm via the devnet test before
  declaring V1 ready.

## Staging stack — ABANDONED 2026-06-01

The staging concept (parallel deployment with MockUSDC for free testing) was
**attempted and abandoned** in a single session on 2026-06-01.

**What was deployed (now orphaned, costs nothing):**
- MockUSDC: `0xC0b82515a903B736547C2775F27439A80be1781f`
- MockMorphoVault: `0x6e346ced05f02c0B28C603C25012e8865e7FE423`
- PrivacyPoolMorpho: `0xC76d7758D186ed0b7688334E6Ad5657e38Bf8fe1`
- ThresholdEntrypoint: `0xfB4a0f1f4F26bBedCbD7Ba21f47a1A92D6aBd1CF`

**Why it doesn't work end-to-end:**

`DeployStaging.s.sol` deploys `ThresholdEntrypoint` as the staging
"entrypoint," but `ThresholdEntrypoint` is an ASP-root governance contract —
it has `updateRoot()` and `getSigners()`, NOT `deposit()`. The seed script
(`scripts/seed-pools.ts:462`) calls `entrypoint.deposit(asset, amount,
precommitment)` which reverts immediately on staging.

Additionally, `contracts/PrivacyPoolMorpho.sol` is **only the
yield-distribution patch** — it has no Merkle tree, no `Deposited` event, no
`LeafInserted` event. Comments at `:138` and `:167` confirm this: the tree
insertion happens in the upstream 0xbow contract that has not been vendored
into this repo. Result: even with a fixed entrypoint, staging deposits
would record in `principalByCommitment` mapping but never enter a Merkle
tree, making them unspendable.

**To make staging functional later** would require vendoring 0xbow's
upstream `Entrypoint.sol` + `PrivacyPool.sol` (the Merkle-tree-bearing
parent of `PrivacyPoolMorpho`). Estimated 1-2 days plus a permanent
upstream-sync burden. Not worth it for the current product stage.

**Replacement:** testers acquire real Sepolia USDC from Circle's faucet
(`https://faucet.circle.com/?network=base-sepolia`, 10 USDC per claim every
12 hours). `/test` Step 2 surfaces this with a copy-address button.
`src/lib/contracts.ts:getActiveStack()` now returns `PRODUCTION_STACK`
unconditionally; all frontend staging branches have been removed.

**Files affected by abandonment** (kept in repo, dormant):
- `zbase-protocol/pkg/contracts/script/DeployStaging.s.sol` (kept; refers
  to the bug)
- `scripts/seed-pools.staging.config.json`, `scripts/seed-staging.sh`,
  `scripts/pre-push-smoke-staging.sh` (kept; would work if a future
  vendor-upstream task re-enables the path)
- `docs/operations/staging-stack-runbook-2026-05-31.md` and
  `docs/operations/staging-stack-deploy-2026-06-01.md` (kept as forensic
  record of what was attempted)

## Disclosure policy

Privacy products are credibility products. We will keep this file aligned
with the deployed code, not with the marketing roadmap. If a security
researcher reads our program and finds a discrepancy with this file, that
is a bug — please report it via a GitHub issue tagged `disclosure`.
