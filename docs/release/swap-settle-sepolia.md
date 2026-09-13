# Swap-as-settlement — Base Sepolia deploy + E2E runbook

Prove the differentiated moat live on testnet: **an agent pays USDC, the seller receives a
DIFFERENT token (their choice), unlinkably, in one settlement.** This is private
*settlement* that crosses assets — NOT private trading (the executor hides WHO funded the
call, not what the call does). See `docs/strategy/xochi-competitive-analysis-2026-07-08.md` §7.

> **Deploys are OPERATOR-RUN** (funded Base Sepolia key). Claude never broadcasts on-chain
> txs or holds keys — it prepares commands, runs the key-less dry-runs, wires env after
> addresses land, and runs the E2E harness. Tip: run the broadcasts with the `!` prefix so
> output lands in-session and Claude verifies each before the next.

## Why a MockRouter (not real Uniswap)

Base Sepolia HAS a canonical Uniswap V3 SwapRouter02 (`0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4`),
but its V3 pools are frequently illiquid, so a real swap may not fill. The E2E uses a
self-hosted **MockRouter** that mints output on demand → the swap ALWAYS fills, proving the
full executor plumbing (proof-binding, F1 output-to-executor sweep, fee split, unlinkability)
deterministically. The contract path is identical to a real router (same `exactInputSingle`
selector `0x04e45aaf`), so the mock proves the mainnet integration shape.

## Prerequisites

- Funded Base Sepolia deployer key (faucet ETH) → `DEPLOYER_PRIVATE_KEY`.
- `BASE_SEPOLIA_RPC` set.
- `DEMO_WALLET_PRIVATE_KEY` (for the deposit helper) already in `.env.local`.
- `forge build` green; `forge test --match-contract "ExecutorProcessooor|ExecutorSwap"` = 26/26.

## Deploy order (router before executor — whitelist is constructor-frozen)

Dry-run each WITHOUT `--broadcast` first (Claude can run these; no key needed — a throwaway
key only satisfies the env read). Then broadcast with `--broadcast --verify`.

### 1. Output token (the seller's chosen asset, e.g. test EURC) — [you]
```bash
DEPLOYER_PRIVATE_KEY=<key> forge script \
  zbase-protocol/pkg/contracts/script/DeployMockMintableERC20.s.sol:DeployMockMintableERC20 \
  --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
# → capture MOCK_OUTPUT_TOKEN / CALL_E2E_OUTPUT_TOKEN
```

### 2. MockRouter — [you]
```bash
DEPLOYER_PRIVATE_KEY=<key> forge script \
  zbase-protocol/pkg/contracts/script/DeployMockRouter.s.sol:DeployMockRouter \
  --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
# → capture EXECUTOR_TARGET_1 / CALL_E2E_ROUTER (the router mints ANY MockMintableERC20 tokenOut)
```

### 3. Executor whitelisting the router + swap selector — [you]
```bash
EXECUTOR_TARGET_1=<router> EXECUTOR_SELECTOR_1=0x04e45aaf DEPLOYER_PRIVATE_KEY=<key> \
forge script \
  zbase-protocol/pkg/contracts/script/DeployExecutorProcessooor.s.sol:DeployExecutorProcessooor \
  --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
# → capture EXECUTOR_PROCESSOOOR
```

### 4. Wire `.env.local` — [Claude]
```
EXECUTOR_PROCESSOOOR=<executor>
CALL_E2E_ROUTER=<router>
CALL_E2E_OUTPUT_TOKEN=<output token>
CALL_E2E_RECIPIENT=<a fresh seller address>
CALL_E2E_SWAP_MINOUT=1
CALL_E2E_SWAP=1
```
`src/lib/contracts.ts:envExecutor()` reads `EXECUTOR_PROCESSOOOR` — no code change.

### 5. Create a funded pool deposit — [you]
```bash
npx tsx --env-file=.env.local scripts/prep-call-e2e-deposit.ts
# makes 1 real Sepolia USDC deposit + posts the ASP root; paste printed CALL_E2E_DEPOSIT into .env.local
```

### 6. Run the E2E — [Claude]
```bash
npm run dev -- -p 3110          # in one shell
CALL_E2E_SWAP=1 npx tsx --env-file=.env.local scripts/test-call-privately.ts
```

## Pass criteria

- **Seller receives `>= minOut` of the output token** (a DIFFERENT asset than USDC).
- **Seller's USDC balance stays 0** — they never touch the paid asset.
- **Submitter (`tx.from`) is the postman, not the depositor** — the payer↔payee link is absent
  on-chain. Deposit and seller are unlinkable.
- The 3 contracts verify on BaseScan (`--verify`).

That is the live moat demo: *cross-asset, private, one settlement.*

---

## Base MAINNET prep (Deploy B — AUDIT-GATED, do not broadcast yet)

The single-value pool (Deploy A) ships first and is unaffected. For the swap executor on
mainnet:

- **Real router**: Uniswap V3 SwapRouter02 on Base mainnet =
  `0x2626664c2603336E57B271c5C0b26F421741e481`, selector `0x04e45aaf`. On mainnet you whitelist
  THIS (not a mock) and swap real liquidity. `buildSwapCallPlan` (packages/core/src/swapPlan.ts)
  already targets exactly this shape.
- **The gate stays**: `DeployExecutorProcessooor.s.sol:76` `require(block.chainid != 8453)` is
  lifted ONLY after the external audit. Do not change it before then.
- **Stack wiring (deferred)**: add an `executorProcessooor` field to `MAINNET_STACK` in
  `src/lib/contracts.ts` + set `EXECUTOR_PROCESSOOOR` in Vercel — ONLY after audit + deploy.
- **Trigger**: Deploy B is gated on a real seller who wants a non-USDC payout. The Sepolia demo
  above is the artifact that recruits that seller.

### Audit scope memo (for the external auditor)

The mock cannot surface these — a real public router is a live adversarial surface:

1. **F1 recipient rule** — the ExecPlan calldata MUST name the executor (not the seller) as the
   swap recipient; the executor measures outDelta on its own balance then sweeps. `buildSwapCallPlan`
   enforces this, but the audit must confirm no bypass.
2. **MEV / sandwich exposure** — a public router swap is front-runnable. Review `minOut` sizing
   and whether the postman submission needs private-mempool / bundle protection.
3. **Router trust** — SwapRouter02 is trusted, but confirm the `forceApprove`→call→zero-approve
   sequence (ExecutorProcessooor.sol:240-243) leaves no standing allowance under any router path.
4. **Token exclusions** — fee-on-transfer / rebasing output tokens break the two-snapshot residual
   accounting (F5 + residual checks :258-260). Whitelist only standard ERC20 output assets.
5. **Slippage floor** — the executor's own `minOut` (:252) is independent of the router's internal
   `amountOutMinimum`; confirm both are set and the executor's is authoritative.
