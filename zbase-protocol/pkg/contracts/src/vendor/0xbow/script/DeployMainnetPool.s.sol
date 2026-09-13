// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/*
 * DeployMainnetPool — deploy 0xbow's single-value Privacy Pool (USDC) to Base
 * (mainnet or a fresh Sepolia dry-run). Stage 1 of the zBase mainnet bring-up:
 * stand up our OWN deployment of 0xbow's audited PrivacyPoolComplex + Entrypoint
 * (0xbow is not on Base mainnet — nothing to point at). Contracts are vendored,
 * unmodified, at src/vendor/0xbow (Apache-2.0). Build under the `vendor` profile:
 *     FOUNDRY_PROFILE=vendor forge build
 *
 * Non-interactive (no vm.prompt) — fully env-driven. OPERATOR-RUN ONLY.
 * Do not --broadcast without a funded DEPLOYER key + the dry-run below.
 *
 * Flow: deploy WithdrawalVerifier + CommitmentVerifier (fresh, this chain)
 *       → Entrypoint impl → ERC1967Proxy → initialize(owner, postman)
 *       → PrivacyPoolComplex(entrypoint, withdrawalVerifier, ragequitVerifier, USDC)
 *       → registerPool(...) → POST-DEPLOY ASSERTIONS.
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY   — funded deployer (forge --private-key). MUST equal
 *                            ENTRYPOINT_OWNER for the one-shot path (registerPool
 *                            is onlyRole(OWNER) — see CRITICAL-2 guard below).
 *   ENTRYPOINT_OWNER       — owner role on the Entrypoint.
 *   ENTRYPOINT_POSTMAN     — postman role (ASP root updater).
 *   USDC_ADDRESS           — optional; default Base-mainnet USDC 0x833589fC…
 *                            (for a Sepolia dry-run, set Sepolia USDC 0x036CbD53…).
 *   POOL_MIN_DEPOSIT       — optional, default 1_000_000 (1 USDC)
 *   POOL_VETTING_FEE_BPS   — optional, default 100 (1% — matches live Sepolia; <10000)
 *   POOL_MAX_RELAY_FEE_BPS — optional, default 1000 (10%; a MAX, mutable later; <10000)
 *
 * WHY WE DEPLOY THE VERIFIERS HERE (CRITICAL-1, audit 2026-06-28):
 *   The Sepolia verifier addresses (0x5f5505…/0x293400…) are NOT chain-agnostic —
 *   they have NO CODE on Base mainnet (verified on-chain). 0xbow deploys verifiers
 *   via CREATE2 with a deployer-namespaced salt, so the address is per-deployer/
 *   per-chain, NOT reproducible. We therefore deploy our OWN WithdrawalVerifier +
 *   CommitmentVerifier from the vendored tree (pure Groth16, no constructor args).
 *   The ragequit verifier IS the CommitmentVerifier (0xbow's BaseDeploy wires
 *   `type(CommitmentVerifier)` into the ragequit slot).
 *
 * ⚠️ MUST DRY-RUN ON SEPOLIA FIRST (MED-1 — ragequit overload):
 *   IVerifier declares verifyProof with BOTH uint256[8] and uint256[4]. PrivacyPool
 *   .ragequit calls the verifier with uint256[8] (PrivacyPool.sol:138), but the
 *   deployed CommitmentVerifier only IMPLEMENTS the [4] overload. So a ragequit
 *   call may hit a missing selector and REVERT — depositors could not self-exit a
 *   dead pool. This must be proven on a Sepolia dry-run (deposit → ragequit
 *   round-trip against the freshly-deployed verifier) BEFORE any mainnet broadcast.
 *   Do NOT assume it works because 0xbow ships it — confirm against OUR deploy.
 *
 * Usage (operator — note the REAL path):
 *   FOUNDRY_PROFILE=vendor forge script \
 *     zbase-protocol/pkg/contracts/src/vendor/0xbow/script/DeployMainnetPool.s.sol:DeployMainnetPool \
 *     --rpc-url $RPC --private-key $DEPLOYER_PRIVATE_KEY --broadcast --verify
 *   Then read the REAL deploy block from broadcast/…/run-latest.json (NOT the
 *   logged block.number — see MED-2) and paste Entrypoint(proxy) + Pool + block
 *   into src/lib/contracts.ts MAINNET_STACK.
 */

import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {ERC1967Proxy} from '@oz/proxy/ERC1967/ERC1967Proxy.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PrivacyPoolComplex} from 'contracts/implementations/PrivacyPoolComplex.sol';
import {WithdrawalVerifier} from 'contracts/verifiers/WithdrawalVerifier.sol';
import {CommitmentVerifier} from 'contracts/verifiers/CommitmentVerifier.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

contract DeployMainnetPool is Script {
  // Base mainnet USDC (the one address that IS the same regardless of our deploy).
  address internal constant DEFAULT_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

  function run() external {
    address owner = vm.envAddress('ENTRYPOINT_OWNER');
    address postman = vm.envAddress('ENTRYPOINT_POSTMAN');
    address usdc = vm.envOr('USDC_ADDRESS', DEFAULT_USDC);

    // A zero floor lets anyone inflate the public commitment count for free and
    // makes the reported anonymity set meaningless. USDC has 6 decimals, so the
    // production-safe default is exactly 1 USDC.
    uint256 minDeposit = vm.envOr('POOL_MIN_DEPOSIT', uint256(1_000_000));
    uint256 vettingFeeBPS = vm.envOr('POOL_VETTING_FEE_BPS', uint256(100)); // 1%
    uint256 maxRelayFeeBPS = vm.envOr('POOL_MAX_RELAY_FEE_BPS', uint256(1000)); // 10%

    // The broadcasting address (msg.sender of the deploy txs).
    address deployer = msg.sender;

    // ---- Fail-fast preflight (BEFORE spending any deploy gas) ----------------
    require(owner != address(0), 'ENTRYPOINT_OWNER=0');
    require(postman != address(0), 'ENTRYPOINT_POSTMAN=0');
    require(usdc.code.length > 0, 'USDC not a contract on this chain');
    require(minDeposit > 0, 'POOL_MIN_DEPOSIT must be > 0');
    require(vettingFeeBPS < 10_000 && maxRelayFeeBPS < 10_000, 'fee BPS must be < 10000');
    // CRITICAL-2: registerPool is onlyRole(OWNER); initialize grants OWNER to
    // `owner`. The deploy+register run in ONE broadcast as `deployer`. If
    // owner != deployer, registerPool reverts AFTER deploying impl+proxy+pool
    // (orphaned contracts, wasted gas). Enforce the one-shot precondition here.
    // For an owner-multisig deploy, run deploy-only + registerPool separately.
    require(owner == deployer, 'owner must == deployer for one-shot (else registerPool reverts; split deploy/register)');

    vm.startBroadcast();

    // CRITICAL-1: deploy OUR OWN verifiers on this chain (Sepolia addresses have
    // no code on Base mainnet). Pure Groth16, no constructor args. ragequit == commitment.
    WithdrawalVerifier withdrawalVerifier = new WithdrawalVerifier();
    CommitmentVerifier commitmentVerifier = new CommitmentVerifier(); // == ragequit verifier
    address ragequitVerifier = address(commitmentVerifier);

    // 1. Entrypoint = UUPS upgradeable behind an ERC1967 proxy (impl disables
    //    initializers in its constructor; init runs on the proxy via initData).
    Entrypoint entrypointImpl = new Entrypoint();
    bytes memory initData = abi.encodeCall(Entrypoint.initialize, (owner, postman));
    ERC1967Proxy proxy = new ERC1967Proxy(address(entrypointImpl), initData);
    Entrypoint entrypoint = Entrypoint(payable(address(proxy)));

    // 2. PrivacyPoolComplex (USDC/ERC20 pool — NOT PrivacyPoolSimple, which is ETH).
    PrivacyPoolComplex pool = new PrivacyPoolComplex(
      address(entrypoint), address(withdrawalVerifier), ragequitVerifier, usdc
    );

    // 3. Register the pool (requires OWNER role — guaranteed by the owner==deployer
    //    precondition above).
    entrypoint.registerPool(
      IERC20(usdc), IPrivacyPool(address(pool)), minDeposit, vettingFeeBPS, maxRelayFeeBPS
    );

    vm.stopBroadcast();

    // ---- HIGH-1: post-deploy assertions (catch a silently-misconfigured pool) -
    require(address(pool.ENTRYPOINT()) == address(entrypoint), 'pool.ENTRYPOINT mismatch');
    require(pool.ASSET() == usdc, 'pool.ASSET mismatch');
    require(address(entrypoint.scopeToPool(pool.SCOPE())) == address(pool), 'scope not registered to pool');
    (IPrivacyPool registered,,,) = entrypoint.assetConfig(IERC20(usdc));
    require(address(registered) == address(pool), 'assetConfig pool mismatch');
    require(!pool.dead(), 'pool is dead');

    console.log('--- zBase Base single-value deploy (verified) ---');
    console.log('Entrypoint (proxy):', address(entrypoint));
    console.log('Entrypoint impl   :', address(entrypointImpl));
    console.log('PrivacyPoolComplex:', address(pool));
    console.log('WithdrawalVerifier:', address(withdrawalVerifier));
    console.log('Commit/RagequitVf :', ragequitVerifier);
    console.log('USDC              :', usdc);
    // MED-2: this is the SIMULATION block, NOT necessarily the mined block. Read
    // the real deploy block from broadcast/.../run-latest.json for poolDeployBlock.
    console.log('block.number (NOT canonical - use run-latest.json):', block.number);
    console.log('>> MAINNET_STACK: paste Entrypoint(proxy) + Pool + the REAL block.');
    console.log('>> Verifiers are NEW addresses (not 0x5f5505/0x293400) - update those too.');
  }
}
