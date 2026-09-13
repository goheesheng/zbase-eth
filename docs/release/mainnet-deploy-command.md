# Base mainnet deploy — the exact command + checklist (2026-07-01)

Turnkey deploy of the single-value 0xbow pool to Base mainnet. Everything is
prepped + verified (vendored contracts build green, deploy script internally reviewed
[NOT externally audited — see SECURITY.md:68 + MAINNET_READINESS.md; external audit is
still OPEN and required before real-money use], ragequit
dry-run passed on Sepolia). The deploy tx is OPERATOR-RUN (your funded key) —
Claude never runs on-chain txs. After it lands, paste the addresses back and the
app-side wiring is ~15 min.

## THE THREE ADDRESSES — who needs mainnet ETH (read this first)

Three distinct roles. In **CDP postman mode (recommended)** only the deployer needs
real mainnet ETH, and only once.

| Role | Address | Needs mainnet ETH? | Signs |
|---|---|---|---|
| **Deployer** | your funded deploy key (== `ENTRYPOINT_OWNER`) | ✅ **YES**, one-time ~0.01–0.02 ETH | verifiers + Entrypoint + proxy + pool + registerPool (~5 txs). Forge can't use CDP → plain key. |
| **Postman** | CDP smart account `0xd411f68a53F5698d05c840C52065a624F9CC5769` | ❌ **NO** — sponsored | `updateRoot` + `relay` (the withdrawal/settle money path), gaslessly via CDP Paymaster. |
| **Owner** | `ENTRYPOINT_OWNER` (== deployer at deploy) | ⚠️ only if kept as a plain EOA | `withdrawFees` (fee collection), `windDown`, `registerPool`. Move to CDP post-deploy to make these gasless too (§OPTIONAL). |

Buyers/depositors pay their own gas from their own wallets (no server deposit route).
So: **fund the deployer, nothing else of yours needs mainnet ETH** in CDP mode.

⚠️ **Mainnet is NOT auto-sponsored like Base Sepolia.** The CDP postman only signs
gaslessly on mainnet once a **Paymaster policy** exists for `0xd411f68a…` in the CDP
Portal. Because that policy allowlists the (not-yet-deployed) Entrypoint + pool
addresses, the ordering is: **deploy → get addresses → set Paymaster policy → THEN
flip `POSTMAN_SIGNER=cdp` on Vercel.** Flip it before the policy is live and every
`updateRoot`/`relay` user-op reverts unsponsored. See §"THEN (you)" step order below.

## PRE-FLIGHT (do ALL before running — each one prevents a wasted/failed deploy)

- [ ] **Funded mainnet deployer wallet** — real ETH for gas (~0.01–0.02 ETH covers
      verifiers + Entrypoint + proxy + pool + registerPool = ~5 txs). **This is the
      ONLY address of yours that needs mainnet ETH in CDP postman mode.**
- [ ] **ENTRYPOINT_OWNER == the deployer address.** The script enforces
      `require(owner == deployer)` — the one-shot path registers the pool in the
      same broadcast, and registerPool is onlyOwner. (Multisig owner? → needs the
      split deploy/register flow; ask first.)
- [ ] **ENTRYPOINT_POSTMAN** — the address that will sign ASP-root updates on
      mainnet. Two options:
      - **CDP sponsored postman (recommended, `POSTMAN_SIGNER=cdp`):** the CDP
        ERC-4337 smart account **already created + proven on Sepolia** —
        `0xd411f68a53F5698d05c840C52065a624F9CC5769`. Same address works on mainnet
        (it's an AA account address). **No ETH funding needed.** Pass it as
        `ENTRYPOINT_POSTMAN` here → the deploy grants it `ASP_POSTMAN` in the same
        broadcast, so no separate grant tx (the role grant is per-chain). Full
        steps + the mainnet Paymaster requirement: `docs/release/cdp-postman-setup.md`.
      - **EOA postman (`POSTMAN_SIGNER=eoa`):** emergency fallback only on
        mainnet. The app blocks it unless `ZBASE_ALLOW_MAINNET_EOA_POSTMAN=true`;
        if you use the override, fund the EOA with a little ETH.
- [ ] **BASE_MAINNET_RPC** — a real mainnet RPC (public mainnet.base.org works but
      rate-limits; a paid RPC is safer for the deploy + later log scans).
- [ ] **forge installed** ✅ (1.5.1) and vendored build green ✅
      (`FOUNDRY_PROFILE=vendor forge build`).
- [ ] Decide fees (defaults are fine): vetting 1% (100 bps), maxRelay 10% (1000 bps).

## THE COMMAND (you run — funded key)

```bash
cd ~/Desktop/zx402

ENTRYPOINT_OWNER=<your-mainnet-deployer-address> \
ENTRYPOINT_POSTMAN=0xd411f68a53F5698d05c840C52065a624F9CC5769 \
FOUNDRY_PROFILE=vendor forge script \
  zbase-protocol/pkg/contracts/src/vendor/0xbow/script/DeployMainnetPool.s.sol:DeployMainnetPool \
  --rpc-url <BASE_MAINNET_RPC> \
  --private-key <DEPLOYER_PRIVATE_KEY> \
  --broadcast --verify
```

Notes:
- `ENTRYPOINT_POSTMAN` above is the proven CDP smart account. If you instead run
  an EOA postman, put that EOA address here and set `POSTMAN_SIGNER=eoa` plus
  `ZBASE_ALLOW_MAINNET_EOA_POSTMAN=true` in Vercel as a temporary emergency path.
- USDC defaults to Base-mainnet `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (no need to set).
- The script DEPLOYS fresh `WithdrawalVerifier` + `CommitmentVerifier` on mainnet
  (the Sepolia verifier addresses have NO code on mainnet — do not reuse them).
- `--verify` needs an Etherscan/Basescan API key configured for forge, or drop it
  and verify separately.
- Do a `--rpc-url ... ` WITHOUT `--broadcast` first (a dry-run/simulation) to catch
  reverts before spending gas.

## CAPTURE FROM THE OUTPUT (the script prints these)
- Entrypoint (proxy) address
- PrivacyPoolComplex address
- WithdrawalVerifier address (fresh)
- Commitment/Ragequit Verifier address (fresh)
- **Deploy block** — read the REAL block from `broadcast/.../run-latest.json`,
  NOT the logged `block.number` (simulation block ≠ mined block).

## THEN (operator wires env, ~15 min) — paste the addresses into Vercel
`src/lib/contracts.ts` reads the mainnet stack from env. Set:
- `BASE_MAINNET_ENTRYPOINT` + `NEXT_PUBLIC_BASE_MAINNET_ENTRYPOINT`
- `BASE_MAINNET_POOL` + `NEXT_PUBLIC_BASE_MAINNET_POOL`
- `BASE_MAINNET_WITHDRAWAL_VERIFIER` + `NEXT_PUBLIC_BASE_MAINNET_WITHDRAWAL_VERIFIER`
- `BASE_MAINNET_COMMITMENT_VERIFIER` + `NEXT_PUBLIC_BASE_MAINNET_COMMITMENT_VERIFIER`
- `BASE_MAINNET_POOL_DEPLOY_BLOCK` + `NEXT_PUBLIC_BASE_MAINNET_POOL_DEPLOY_BLOCK`

Then run:

```bash
NEXT_PUBLIC_NETWORK=mainnet npm run preflight:mainnet
```

## THEN (you) — mainnet infra + go-live (ORDER MATTERS)

The CDP Paymaster policy references the deployed addresses, so it can only be set
AFTER the deploy — and `POSTMAN_SIGNER=cdp` must not go live until that policy
exists. Follow this order:

1. [ ] **Set base Vercel env** (everything except the postman flag):
      `NEXT_PUBLIC_NETWORK=mainnet`, `UPSTASH_*` (mandatory — code throws on
      mainnet without it), `CDP_API_KEY_ID/_SECRET`, `ZBASE_SEED_ENCRYPTION_KEY`,
      `CRON_SECRET`, `BASE_MAINNET_RPC`, and the `BASE_MAINNET_*` contract env
      vars from the previous section.
2. [ ] **Confirm ASP_POSTMAN is held by the postman.** If you passed
      `ENTRYPOINT_POSTMAN=0xd411f68a…` (the CDP smart account) at deploy → done. If
      you change signers later, the owner grants it:
      `grantRole(_ASP_POSTMAN, <new postman addr>)`.
3. [ ] **Set the CDP mainnet Paymaster policy** in the CDP Portal for
      `0xd411f68a…`: allowlist the deployed Entrypoint + pool (from the deploy
      output) + set a spend cap. **Mainnet is NOT auto-sponsored — without this,
      sponsored user-ops revert.** (Skip if running an EOA postman instead.)
4. [ ] **Now set the postman flag on Vercel:**
      - **CDP (recommended):** `POSTMAN_SIGNER=cdp` + `CDP_WALLET_SECRET`
        + `CDP_POSTMAN_SMART_ACCOUNT` (reuses `CDP_API_KEY_ID/_SECRET`). No
        `POSTMAN_PRIVATE_KEY`, no ETH on the postman.
      - **EOA emergency fallback:** `POSTMAN_SIGNER=eoa` +
        `ZBASE_ALLOW_MAINNET_EOA_POSTMAN=true` + `POSTMAN_PRIVATE_KEY` (mainnet
        postman key); fund it with ETH.
5. [ ] **Set the initial ASP root:** POST /api/asp-update (signs via the configured
      postman) — or every withdrawal reverts IncorrectASPRoot.
6. [ ] **Seed a few treasury deposits** so the anonymity set isn't empty.
7. [ ] `vercel --prod` (or merge to main — **double-yes required**) → zbase.app on
      mainnet.
8. [ ] **Re-run the paid-settle proof on mainnet once** (small amount) — confirms
      the sponsored relay works end-to-end with the mainnet Paymaster policy live.

## OPTIONAL — owner role via a CDP wallet (post-deploy, reversible)
The one-time deploy MUST use a standard key (`--private-key`; forge can't broadcast
through CDP). But ongoing OWNER ops (`withdrawFees` — how you collect earned fees,
`registerPool`, `windDown`) can go through a CDP wallet AFTER deploy:
1. Create/choose a CDP account, note its address.
2. Current owner grants it: `grantRole(_OWNER_ROLE, <cdp owner addr>)` (and, if you
   want to fully hand off, revoke the deployer's owner role — but keep at least one
   owner you control at all times).
This is a one-line role op, not a deploy-script change. The deploy path stays a
standard key; only the *ongoing* owner identity moves to CDP.

## The honest gate
Mainnet costs real ETH + Upstash/CDP + real money at risk, and earns $0 without a
seller. Every adversarial review this session: the bottleneck is a paying seller,
not being on mainnet. Deploy FOR a committed seller, not before.
