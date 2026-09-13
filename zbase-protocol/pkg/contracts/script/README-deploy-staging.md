# Staging Stack Deploy Runbook

**Date:** 2026-05-31
**Owner:** Eesheng Goh (founder)
**Target:** Full zBase staging stack on Base Sepolia
**Script:** `script/DeployStaging.s.sol`
**Companion docs:**
- `script/README-deploy-threshold.md` (sibling runbook, same Foundry-profile pattern)
- `CLAUDE.md` "Deployed Contracts (Base Sepolia)" — production stack (DO NOT touch)

---

## Why this stack exists

Production runs on real Circle USDC at:
- Entrypoint: `0x598ffaac79ae29b1aae571fd91899d4492183688`
- USDC Pool: `0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a`

The founder doesn't have ~$1,600 testnet USDC for Phase 0 seed deposits. This
staging stack deploys a **parallel** set of contracts pointing at a mintable
MockUSDC token, unblocking unlimited free testing. The math contracts
(Withdrawal Verifier + Commitment Verifier) are pure Groth16 — they are
chain-agnostic and asset-agnostic, so the staging app reuses the production
verifier addresses via env vars and does not redeploy them.

---

## What gets deployed (4 contracts, 1 broadcast)

| # | Contract              | Purpose                                                       |
|---|-----------------------|---------------------------------------------------------------|
| 1 | `MockUSDC`            | Mintable 6-decimal ERC20 — anyone can call `mint()`.          |
| 2 | `MockMorphoVault`     | `IMorphoYieldVault` stub against MockUSDC (see Morpho note).  |
| 3 | `PrivacyPoolMorpho`   | Fresh pool wired to the mocks + deployer as fee recipient.    |
| 4 | `ThresholdEntrypoint` | Stand-alone mode (no downstream forwarding), 3-of-5 quorum.   |

**Plus:** 100,000 MockUSDC minted to the deployer at the end of the script
(equivalent to ~$100k of test capital).

---

## Morpho integration: blocker resolved (Option A)

MockUSDC is not a Circle-issued asset and has **no Morpho Blue market**. The
`PrivacyPoolMorpho` constructor REQUIRES a non-zero vault address (it calls
`forceApprove(max)` in its constructor body). Three options were considered:

| Option | Approach                                  | Verdict      |
|--------|-------------------------------------------|--------------|
| A      | Deploy `MockMorphoVault` as on-chain stub | **CHOSEN**   |
| B      | Use a non-Morpho pool variant             | Doesn't exist in this repo. |
| C      | Point at real Morpho Blue (`0xBBBB...FFCb`) | Deploys, but first deposit reverts (no MockUSDC market). |

**Option A** uses the exact same `MockMorphoVault` contract the unit tests
exercise (`contracts/test/PrivacyPoolMorphoYield.t.sol`). It implements
`supply()` / `redeem()` / `previewRedeem()` against any ERC20, defaults to
0% yield (matching the production testnet path), and can be tuned to simulate
yield with `setYieldBps()`. This makes the staging stack a faithful
behavioral mirror of the production stack at the contract level.

**Production is NOT touched.** The real Morpho Blue pool at
`0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a` continues to back production with
real Circle USDC + real Morpho Blue + real IRM.

---

## Pre-flight checklist

Tick every box before running `--broadcast`.

### Environment
- [ ] Deployer EOA holds **≥ 0.05 ETH on Base Sepolia** (gas budget — see below)
- [ ] `BASE_SEPOLIA_RPC` env set (e.g. `https://sepolia.base.org` or an Infura/Alchemy URL)
- [ ] `DEPLOYER_PRIVATE_KEY` set to a freshly funded key (with or without `0x` prefix)
- [ ] `BASESCAN_API_KEY` exported (optional, only needed for `--verify`)
- [ ] You are on the correct git branch (NOT `main` — staging work goes on a feature branch)

### Sanity
- [ ] Latest `git pull` — no uncommitted changes to the deploy script
- [ ] Dry-run test passes: `FOUNDRY_PROFILE=threshold forge test --match-contract DeployStaging -vv`
- [ ] Production env vars in `.env.local` are commented out OR clearly separated
      (you do not want the app to accidentally point at staging on mainnet day-of)

---

## Dry run (no broadcast)

Always do this first. Confirms the script compiles, env vars resolve, and the
in-memory simulation produces sensible addresses:

```bash
FOUNDRY_PROFILE=threshold forge script \
    script/DeployStaging.s.sol:DeployStaging \
    --rpc-url $BASE_SEPOLIA_RPC
```

Expected log:

```
=== DeployStaging :: preflight ===
Date:                 2026-05-31
Deployer:             0x...
Chain ID:             84532
Reused verifiers (informational, not constructor-bound):
  WithdrawalVerifier: 0x5f5505242730DFc8A2C2637eB5258dC2C6622641
  CommitmentVerifier: 0x293400acCdEB0C1C2D419868303a8e96C09900AB
Staging mint:         100,000 MockUSDC -> deployer
==================================
...
=== STAGING STACK DEPLOYED ===
MockUSDC:             0x...
MockMorphoVault:      0x...
PrivacyPoolMorpho:    0x...
ThresholdEntrypoint:  0x...
Deployer balance:     100000000000
```

If the dry run logs `Chain ID: 84532` you're on Base Sepolia. Any other chain
ID — STOP, check your RPC URL.

---

## Broadcast

```bash
FOUNDRY_PROFILE=threshold forge script \
    script/DeployStaging.s.sol:DeployStaging \
    --rpc-url $BASE_SEPOLIA_RPC \
    --broadcast
```

Add `--verify` and ensure `BASESCAN_API_KEY` is set if you want auto-verification.

### Expected gas

| Contract              | Approx gas | Notes                                                |
|-----------------------|------------|------------------------------------------------------|
| MockUSDC              | ~600k      | Tiny ERC20 + override + open mint                    |
| MockMorphoVault       | ~500k      | Just `supply`/`redeem`/`previewRedeem` + 1 setter   |
| PrivacyPoolMorpho     | ~1,200k    | Pool storage layout + `forceApprove(max)` in ctor   |
| ThresholdEntrypoint   | ~900k      | 5 × SSTORE for signers + ECDSA lib bytecode          |
| `mockUSDC.mint(...)`  | ~50k       | Single mint to deployer                              |
| **Total**             | **~3.25M** | At Base Sepolia base fee ~0.01 gwei → **~$0.0001**.  |

At Base Sepolia base fees, the entire deploy costs well under one cent. The
0.05 ETH gas budget in the pre-flight is intentional overkill — it lets you
absorb a price spike and still have room for first-mint top-ups afterward.

If forge estimates significantly higher (>5M gas), abort — something has been
changed in one of the contracts since this runbook was written.

---

## Post-flight

### Immediate (< 5 minutes)
- [ ] Copy the `# === STAGING STACK ===` block from the script's stdout into
      `.env.local` (the script prints it ready to paste)
- [ ] For each of the 4 contracts, open the BaseScan link. If you didn't pass
      `--verify`, run:
      ```bash
      forge verify-contract --watch --chain base-sepolia <address> <ContractName>
      ```
- [ ] On the deployed `PrivacyPoolMorpho`, confirm:
      - `USDC()` returns the new MockUSDC address
      - `MORPHO_VAULT()` returns the new MockMorphoVault address (NOT `0xBBBB...FFCb`)
      - `PROTOCOL_FEE_RECIPIENT()` returns your deployer address
- [ ] On the deployed `ThresholdEntrypoint`, confirm:
      - `getSigners()` returns 5 distinct non-zero addresses (slot 0 = deployer)
      - `downstream()` returns `0x0000...0000` (stand-alone mode)
- [ ] On the deployed `MockUSDC`, confirm `balanceOf(deployer)` == `100000000000`
      (= 100,000 × 10⁶)

### Same day
- [ ] Record the 4 new addresses + the deploy tx hash in `STATUS.md` under a
      new "Staging Stack (Base Sepolia, 2026-05-31)" section
- [ ] Notify agent A2 to wire `NEXT_PUBLIC_STAGING=true` into the frontend
      provider/config layer (the env block at the bottom of the script's
      output gives them everything they need)
- [ ] Smoke test: from a second wallet, call `MockUSDC.mint(yourSecondWallet, 100000000)`
      to confirm open-mint works from a non-deployer EOA

---

## How to switch the app to staging

Agent A2 is responsible for the frontend wiring; the contract layer just
provides the env vars. The hand-off contract is:

```dotenv
# === STAGING STACK (2026-05-31) ===
NEXT_PUBLIC_STAGING=true
NEXT_PUBLIC_STAGING_USDC=0x...
NEXT_PUBLIC_STAGING_POOL=0x...
NEXT_PUBLIC_STAGING_ENTRYPOINT=0x...
STAGING_USDC=0x...
STAGING_MORPHO_VAULT=0x...
STAGING_POOL=0x...
STAGING_ENTRYPOINT=0x...
STAGING_WITHDRAWAL_VERIFIER=0x5f5505242730DFc8A2C2637eB5258dC2C6622641
STAGING_COMMITMENT_VERIFIER=0x293400accdeb0c1c2d419868303a8e96c09900ab
# === END STAGING STACK ===
```

When `NEXT_PUBLIC_STAGING === 'true'`, the app reads the `NEXT_PUBLIC_STAGING_*`
addresses instead of the production constants in `CLAUDE.md`. The server-side
routes (`/api/withdraw`, `/api/asp-update`, `/api/facilitator/*`) read the
non-prefixed `STAGING_*` variants. The verifier addresses are intentionally
reused from production — they're pure math and chain-agnostic.

---

## How to top up MockUSDC

The `MockUSDC.mint(to, amount)` function is permissionless. To credit $1,000 of
test capital to a treasury / second wallet:

```solidity
// Foundry script-style (any address can be msg.sender)
mockUSDC.mint(treasury, 1_000 * 1e6); // 1_000_000_000 raw units
```

Or via `cast`:

```bash
cast send $STAGING_USDC "mint(address,uint256)" \
    $TREASURY_ADDRESS 1000000000 \
    --rpc-url $BASE_SEPOLIA_RPC \
    --private-key $DEPLOYER_PRIVATE_KEY
```

There is no cap. To simulate a $10M Phase-0 seed, mint
`10_000_000_000_000` raw units. (Cap your imagination, not the supply.)

---

## Rollback

There is no rollback. These are fresh contracts at fresh addresses; production
is untouched. If a deploy goes wrong:

1. Don't update `.env.local` — the bad addresses don't enter the runtime path.
2. Fix the deploy script + tests on your branch.
3. Re-run `--broadcast` for fresh addresses.
4. Discard the bad addresses; they're inert on-chain forever but never get traffic.

The old staging contracts (if any from a prior run) continue to exist on-chain
forever but become unreferenced. That's the cost of staging being immutable —
no policy bookkeeping required.

---

## Test (offline)

Before any `--broadcast`, the bundled test simulates the script in-process and
asserts the resulting stack has the correct wiring:

```bash
FOUNDRY_PROFILE=threshold forge test --match-contract DeployStaging -vv
```

This test is what gives you confidence the script wires everything together
correctly. It does NOT verify gas costs or on-chain Morpho/USDC integrations —
those are out of scope for staging by design.

---

## Foundry profile note

This script + test live in `zbase-protocol/pkg/contracts/{script,test}` and
are discoverable under the `threshold` profile in the repo's `foundry.toml`.
Always invoke with `FOUNDRY_PROFILE=threshold` (or wrap with
`./scripts/forge-wrap.sh` if it's been extended to auto-pick the right
profile for the staging script).
