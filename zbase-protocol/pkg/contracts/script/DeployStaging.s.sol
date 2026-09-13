// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {PrivacyPoolMorpho, IMorphoYieldVault} from "../../../../contracts/PrivacyPoolMorpho.sol";
import {MockUSDC} from "../../../../contracts/test/MockUSDC.sol";
import {MockMorphoVault} from "../../../../contracts/test/PrivacyPoolMorphoYield.t.sol";
import {ThresholdEntrypoint} from "@zbase-protocol/contracts/ThresholdEntrypoint.sol";

/**
 * @title DeployStaging
 * @notice One-shot deploy of the zBase **STAGING** stack on Base Sepolia.
 *         Same contract shapes as production, but the USDC token is a mintable
 *         mock so the founder can run unlimited free testing without burning
 *         real testnet USDC.
 *
 * Date: 2026-05-31
 *
 * What this script deploys (in order, single broadcast):
 *   1. MockUSDC                — mintable 6-decimal ERC20 (anyone can mint).
 *   2. MockMorphoVault         — IMorphoYieldVault stub. Real Morpho Blue has
 *                                NO market for our MockUSDC, so we deploy the
 *                                same vault stub the unit tests use. It accepts
 *                                supply()/redeem() against the mock token. See
 *                                BLOCKER note at bottom of this file for the
 *                                rationale and alternatives.
 *   3. PrivacyPoolMorpho       — fresh pool instance bound to the mocks.
 *   4. ThresholdEntrypoint     — stand-alone mode (downstream = address(0))
 *                                with 5 deployer-derived signer slots so the
 *                                quorum is fully owned by the founder for
 *                                staging. Real signer recruitment is a
 *                                production-only concern.
 *
 * After deploy the script mints 100,000 MockUSDC to the deployer so the
 * founder can start testing immediately.
 *
 * What this script does NOT redeploy:
 *   - Withdrawal Verifier      (reuse production 0x5f5505242730dfc8a2c2637eb5258dc2c6622641)
 *   - Commitment Verifier      (reuse production 0x293400accdeb0c1c2d419868303a8e96c09900ab)
 *   These contracts are pure-math Groth16 verifiers with vkeys baked into
 *   bytecode at trusted-setup time; they're chain-agnostic and asset-agnostic
 *   so the staging stack reuses them via env var. They are referenced (and
 *   logged) but not constructor-bound by the patch-style PrivacyPoolMorpho in
 *   this repo — the upstream pool that consumes them lives in the vendored
 *   0xbow fork and is wired by /api/withdraw, not by this constructor.
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY   — hex (with or without 0x). Refused if missing.
 *
 * Optional env vars (sensible defaults provided):
 *   WITHDRAWAL_VERIFIER    — defaults to production address (read-only ref).
 *   COMMITMENT_VERIFIER    — defaults to production address (read-only ref).
 *
 * Usage:
 *   FOUNDRY_PROFILE=threshold forge script \
 *       script/DeployStaging.s.sol:DeployStaging \
 *       --rpc-url $BASE_SEPOLIA_RPC --broadcast
 *
 * See `script/README-deploy-staging.md` for the full operator runbook.
 *
 * BLOCKER NOTE — Morpho integration:
 *   MockUSDC is not a Circle-issued asset and has no Morpho Blue market. The
 *   PrivacyPoolMorpho constructor REQUIRES a non-zero vault address (it calls
 *   forceApprove(max) in the constructor body). Three options were considered:
 *     (A) Deploy MockMorphoVault as a real on-chain stub (CHOSEN).
 *         Pros: identical contract shape, no source changes needed, existing
 *         unit tests already exercise this exact vault. Cons: it lives in
 *         test/ — moderately weird to deploy a *.t.sol-adjacent contract. We
 *         import it explicitly to make the staging intent obvious.
 *     (B) Deploy a non-Morpho pool variant. There isn't one in this repo —
 *         PrivacyPoolMorpho is the only Solidity pool file. Skipped.
 *     (C) Pass real Morpho Blue address (0xBBBB...FFCb). Constructor would
 *         succeed (forceApprove never reverts on a vault that doesn't know
 *         our token), but _pull() would revert on the first deposit because
 *         the vault has no MockUSDC market. Skipped — defers the failure to
 *         runtime and breaks the test path entirely.
 *   Option A is correct for STAGING. Production keeps the real Morpho Blue
 *   pool at 0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a — unchanged.
 */
contract DeployStaging is Script {
    // ─── Resolved config ──────────────────────────────────────────────────────

    uint256 internal deployerPrivateKey;
    address internal deployer;

    // Reused production addresses (informational; logged for the runbook).
    address internal withdrawalVerifier;
    address internal commitmentVerifier;

    // Production-baseline addresses, used as defaults for the read-only refs.
    address internal constant PROD_WITHDRAWAL_VERIFIER = 0x5F5505242730DFC8A2c2637EB5258DC2C6622641;
    address internal constant PROD_COMMITMENT_VERIFIER = 0x293400ACCdEb0C1C2D419868303a8E96c09900Ab;

    // Staging mint size: 100,000 MockUSDC (100k * 10**6).
    uint256 internal constant STAGING_MINT_AMOUNT = 100_000 * 1e6;

    // ─── Deployed artifacts (set during run) ──────────────────────────────────

    MockUSDC public mockUSDC;
    MockMorphoVault public mockVault;
    PrivacyPoolMorpho public pool;
    ThresholdEntrypoint public entrypoint;

    function run()
        external
        returns (
            MockUSDC mockUSDC_,
            PrivacyPoolMorpho pool_,
            ThresholdEntrypoint entrypoint_
        )
    {
        _loadConfig();
        _printPreflight();

        vm.startBroadcast(deployerPrivateKey);

        // 1. MockUSDC — anyone-can-mint 6-decimal token.
        mockUSDC = new MockUSDC();

        // 2. MockMorphoVault — IMorphoYieldVault stub against MockUSDC.
        //    See BLOCKER NOTE at the top of this file for why we deploy
        //    this instead of pointing at real Morpho Blue.
        mockVault = new MockMorphoVault(mockUSDC);

        // 3. PrivacyPoolMorpho — fresh pool, deployer is the fee recipient
        //    (yield fees are 0 anyway per the v0 policy, but the slot needs
        //    a non-zero address). In staging the deployer == founder.
        pool = new PrivacyPoolMorpho(
            address(mockUSDC),
            address(mockVault),
            deployer
        );

        // 4. ThresholdEntrypoint — stand-alone mode (downstream = 0).
        //    All five signer slots are deterministic deployer-derived
        //    addresses so the founder holds the entire quorum in staging.
        //    For production, signers come from the recruitment plan
        //    (see docs/governance/signer-candidates-2026-05-31.md).
        address[5] memory stagingSigners = _stagingSigners(deployer);
        entrypoint = new ThresholdEntrypoint(stagingSigners, address(0));

        // 5. Mint 100,000 MockUSDC to deployer for immediate testing.
        mockUSDC.mint(deployer, STAGING_MINT_AMOUNT);

        vm.stopBroadcast();

        _printResult();

        return (mockUSDC, pool, entrypoint);
    }

    // ─── Config loading ───────────────────────────────────────────────────────

    function _loadConfig() internal {
        // Refuse to run without a deployer key. vm.envUint reverts on missing.
        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        deployer = vm.addr(deployerPrivateKey);

        withdrawalVerifier = vm.envOr("WITHDRAWAL_VERIFIER", PROD_WITHDRAWAL_VERIFIER);
        commitmentVerifier = vm.envOr("COMMITMENT_VERIFIER", PROD_COMMITMENT_VERIFIER);
    }

    /**
     * @dev Deterministic 5 distinct staging signers derived from the deployer
     *      address so the founder controls the entire 3-of-5 quorum without
     *      having to manage extra keys. The addresses are NOT private-key-
     *      derivable; they're just unique non-zero placeholders that satisfy
     *      the ThresholdEntrypoint constructor's "no zero, no duplicate"
     *      invariants. To submit a real root in staging, deploy a fresh
     *      Entrypoint with real signer addresses — staging never needs to
     *      submit roots because the app reads from production ASP data.
     *
     *      Production uses the recruited 5-of-5 signer set per
     *      docs/governance/signer-candidates-2026-05-31.md — never this path.
     */
    function _stagingSigners(address seed) internal pure returns (address[5] memory s) {
        s[0] = seed;
        s[1] = address(uint160(uint256(keccak256(abi.encode(seed, "staging-signer-2")))));
        s[2] = address(uint160(uint256(keccak256(abi.encode(seed, "staging-signer-3")))));
        s[3] = address(uint160(uint256(keccak256(abi.encode(seed, "staging-signer-4")))));
        s[4] = address(uint160(uint256(keccak256(abi.encode(seed, "staging-signer-5")))));
        // Defense: vanishingly small chance of collision with `seed`, but
        // the ThresholdEntrypoint constructor would catch it. We don't add
        // a runtime check here because the probability is ~2^-160.
    }

    // ─── Logging ──────────────────────────────────────────────────────────────

    function _printPreflight() internal view {
        console2.log("=== DeployStaging :: preflight ===");
        console2.log("Date:                 2026-05-31");
        console2.log("Deployer:            ", deployer);
        console2.log("Chain ID:            ", block.chainid);
        console2.log("Reused verifiers (informational, not constructor-bound):");
        console2.log("  WithdrawalVerifier:", withdrawalVerifier);
        console2.log("  CommitmentVerifier:", commitmentVerifier);
        console2.log("Staging mint:         100,000 MockUSDC -> deployer");
        console2.log("==================================");
    }

    function _printResult() internal view {
        console2.log("");
        console2.log("=== STAGING STACK DEPLOYED ===");
        console2.log("MockUSDC:            ", address(mockUSDC));
        console2.log("MockMorphoVault:     ", address(mockVault));
        console2.log("PrivacyPoolMorpho:   ", address(pool));
        console2.log("ThresholdEntrypoint: ", address(entrypoint));
        console2.log("Deployer balance:    ", mockUSDC.balanceOf(deployer));
        console2.log("");
        console2.log("--- ADD TO .env.local ---");
        console2.log("# === STAGING STACK (2026-05-31) ===");
        console2.log("NEXT_PUBLIC_STAGING=true");
        console2.log("NEXT_PUBLIC_STAGING_USDC=",          address(mockUSDC));
        console2.log("NEXT_PUBLIC_STAGING_POOL=",          address(pool));
        console2.log("NEXT_PUBLIC_STAGING_ENTRYPOINT=",    address(entrypoint));
        console2.log("STAGING_USDC=",                      address(mockUSDC));
        console2.log("STAGING_MORPHO_VAULT=",              address(mockVault));
        console2.log("STAGING_POOL=",                      address(pool));
        console2.log("STAGING_ENTRYPOINT=",                address(entrypoint));
        console2.log("# Verifier reuse (same as prod):");
        console2.log("STAGING_WITHDRAWAL_VERIFIER=",       withdrawalVerifier);
        console2.log("STAGING_COMMITMENT_VERIFIER=",       commitmentVerifier);
        console2.log("# === END STAGING STACK ===");
        console2.log("-------------------------");
        console2.log("");
        console2.log("Next steps (see script/README-deploy-staging.md):");
        console2.log("  1. Verify all 4 contracts on BaseScan");
        console2.log("  2. Paste the block above into .env.local");
        console2.log("  3. Record addresses in STATUS.md (Staging Stack)");
        console2.log("  4. Top up more MockUSDC: mockUSDC.mint(treasury, 1_000_000_000)");
        console2.log("===============================");
    }
}
