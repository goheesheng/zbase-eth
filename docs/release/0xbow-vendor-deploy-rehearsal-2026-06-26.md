# 0xbow source — build + deploy rehearsal (2026-06-26)

**Goal proven:** confirm 0xbow's `privacy-pools-core` source *builds* and is
*deployable*, so the mainnet contract step is a known job (not an unknown). This
de-risks "deploy single-value to Base mainnet" — the one real mainnet blocker.

## ✅ What was confirmed

- **0xbow's source builds clean** (`solc 0.8.28`, 0 errors — only lint hints).
  Repo: `github.com/0xbow-io/privacy-pools-core`, Apache-2.0. Deployable artifacts
  produced: `PrivacyPoolComplex` (USDC/ERC20 pool), `Entrypoint`, `State`, verifiers.
- **The pool the live Sepolia stack uses is `PrivacyPoolComplex`** (ERC20), NOT
  `PrivacyPoolSimple` (which is ETH-only, `NATIVE_ASSET`). Mainnet USDC pool =
  `PrivacyPoolComplex`.

## ⚠️ The one build gotcha (will bite again on mainnet)

After `yarn install`, the `@zk-kit/lean-imt.sol` remapping is broken — it lacks a
trailing slash, so `lean-imt/InternalLeanIMT.sol` resolves to the malformed
`...lean-imt.solInternalLeanIMT.sol`. FIX: point the remapping at an absolute path
(relative `../../` didn't take):
```
forge build --skip 'test/**' \
  --remappings "lean-imt/=<repo>/node_modules/@zk-kit/lean-imt.sol/"
```
(The dep installs at REPO-ROOT `node_modules` via yarn workspace hoisting, not the
contracts package.) Test files have other remapping issues — build `--skip 'test/**'`
for deploy purposes.

## The deploy recipe (3-step wiring — matches the live stack shape)

0xbow ships `script/DeployComplexPool.s.sol`. It expects these env vars:
- `ENTRYPOINT_ADDRESS` — deploy `Entrypoint` first (proxy → `initialize(owner, postman)`)
- `WITHDRAWAL_VERIFIER_ADDRESS` — REUSE 0xbow's (`0x5f5505…`, chain-agnostic)
- `RAGEQUIT_VERIFIER_ADDRESS` — **0xbow has a ragequit verifier the zBase stack may
  not have wired** — confirm/deploy this (it's the depositor escape-hatch verifier)
- `DEPLOYER_ADDRESS` — the deployer
- Then `entrypoint.registerPool(...)` wires the pool in.

Constructor: `PrivacyPoolComplex(entrypoint, withdrawalVerifier, ragequitVerifier, USDC)`.
Mainnet USDC = `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

## ⚠️ "Deploy fresh + run current tests" is NOT a clean swap

A freshly-deployed pool is EMPTY (anonymity set = 0) and uses 0xbow's
`ragequitVerifier`. The existing tests' proofs are built against the
CURRENTLY-deployed pool/verifier + a seeded set. So repointing tests at a fresh
address needs: seed the new pool + match proof artifacts (wasm/zkey) to its
verifiers. Not a one-line address change. (The live Sepolia pool `0x4ebcfeaf…`,
221 deposits, already passes the tests — use it for testing; deploy-fresh is the
mainnet *dress rehearsal*, value = proving deploy mechanics, not a working pool.)

## Status / next

- BUILD: ✅ proven (this doc).
- DEPLOY: ⏳ operator-run (needs a funded key — Claude never runs on-chain txs).
  When ready: vendor 0xbow's `src/` into the repo (Apache-2.0 + NOTICE attribution),
  adapt `DeployComplexPool.s.sol` for Base, run `forge script … --broadcast --verify`.
- Closes audit finding CSO-P1-3 (no forge test against the real pool ABI) once vendored.
