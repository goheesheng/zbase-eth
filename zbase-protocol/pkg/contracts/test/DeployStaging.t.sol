// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {DeployStaging} from "../script/DeployStaging.s.sol";
import {PrivacyPoolMorpho} from "../../../../contracts/PrivacyPoolMorpho.sol";
import {MockUSDC} from "../../../../contracts/test/MockUSDC.sol";
import {ThresholdEntrypoint} from "@zbase-protocol/contracts/ThresholdEntrypoint.sol";

/**
 * @title DeployStagingTest
 * @notice Simulates the staging deploy script in-process and asserts the
 *         resulting contracts have the expected wiring. NO network calls,
 *         NO broadcast, NO real keys.
 *
 * Note on discovery: this file lives in `zbase-protocol/pkg/contracts/test/`
 * and must be run via the `threshold` Foundry profile, identical to the
 * sibling DeployThresholdEntrypoint test:
 *
 *   FOUNDRY_PROFILE=threshold forge test --match-contract DeployStaging -vv
 */
contract DeployStagingTest is Test {
    // Deterministic mock deployer key — scratch only, never used on chain.
    uint256 internal constant MOCK_DEPLOYER_PK = 0xA11CE57A6;

    address internal mockDeployer;

    function setUp() public {
        mockDeployer = vm.addr(MOCK_DEPLOYER_PK);
        // Fund the mock deployer so vm.startBroadcast in the script succeeds.
        vm.deal(mockDeployer, 1 ether);
    }

    function _exportDeployerKey(uint256 pk) internal {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(pk));
    }

    // ─── Tests ────────────────────────────────────────────────────────────────

    /// @notice Happy path — script returns all 3 non-zero addresses, pool is
    ///         bound to the new MockUSDC, entrypoint is in stand-alone mode,
    ///         deployer holds the staging mint balance.
    function test_DeployScript_HappyPath_FullStack() public {
        _exportDeployerKey(MOCK_DEPLOYER_PK);

        DeployStaging script = new DeployStaging();
        (
            MockUSDC mockUSDC,
            PrivacyPoolMorpho pool,
            ThresholdEntrypoint entrypoint
        ) = script.run();

        // (1) All three primary addresses non-zero.
        assertTrue(address(mockUSDC) != address(0), "MockUSDC must be deployed");
        assertTrue(address(pool) != address(0), "PrivacyPoolMorpho must be deployed");
        assertTrue(address(entrypoint) != address(0), "ThresholdEntrypoint must be deployed");

        // (2) Pool's accepted asset == the new MockUSDC.
        assertEq(
            address(pool.USDC()),
            address(mockUSDC),
            "pool.USDC() must point at the new MockUSDC"
        );

        // (3) Pool is bound to the mock vault, not real Morpho Blue.
        //     We don't have the vault handle as a return value, but we
        //     can assert MORPHO_VAULT() is non-zero and is NOT real Morpho.
        address realMorphoBlue = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
        assertTrue(address(pool.MORPHO_VAULT()) != address(0), "MORPHO_VAULT must be deployed");
        assertTrue(
            address(pool.MORPHO_VAULT()) != realMorphoBlue,
            "MORPHO_VAULT must NOT be production Morpho Blue in staging"
        );

        // (4) Fee recipient is the deployer (staging policy).
        assertEq(
            pool.PROTOCOL_FEE_RECIPIENT(),
            mockDeployer,
            "fee recipient must be the deployer in staging"
        );

        // (5) Yield policy: BPS = 0 (carried over from production constant).
        assertEq(pool.PROTOCOL_FEE_BPS(), 0, "PROTOCOL_FEE_BPS must be 0");

        // (6) Entrypoint is in stand-alone mode (no downstream forwarding).
        assertEq(
            entrypoint.downstream(),
            address(0),
            "Entrypoint must be in stand-alone mode for staging"
        );

        // (7) Entrypoint threshold + signer count are the canonical 3-of-5.
        assertEq(entrypoint.THRESHOLD(), 3, "THRESHOLD must be 3");
        assertEq(entrypoint.SIGNER_COUNT(), 5, "SIGNER_COUNT must be 5");

        // (8) All 5 signers are distinct and non-zero (defense-in-depth: the
        //     constructor already enforces this; we re-check for the staging
        //     scaffold path specifically).
        address[5] memory signers = entrypoint.getSigners();
        for (uint256 i = 0; i < 5; ++i) {
            assertTrue(signers[i] != address(0), "no zero signer");
            for (uint256 j = 0; j < i; ++j) {
                assertTrue(signers[i] != signers[j], "no duplicate signers");
            }
        }
        // The first staging signer is the deployer itself (so the founder
        // owns at least 1 of 5 — enough for emergency root override during
        // staging in combination with two scripted scratch keys).
        assertEq(signers[0], mockDeployer, "signer slot 0 must be the deployer");

        // (9) Deployer received exactly 100,000 MockUSDC.
        assertEq(
            mockUSDC.balanceOf(mockDeployer),
            100_000 * 1e6,
            "deployer must receive 100,000 MockUSDC mint"
        );

        // (10) MockUSDC retains the 6-decimal contract (matches Circle USDC).
        assertEq(mockUSDC.decimals(), 6, "MockUSDC must keep 6 decimals");
    }

    /// @notice Anyone (not just deployer) can mint more MockUSDC post-deploy.
    ///         This is the "top up" path documented in the runbook.
    function test_DeployScript_MockUSDC_OpenMintWorks() public {
        _exportDeployerKey(MOCK_DEPLOYER_PK);
        DeployStaging script = new DeployStaging();
        (MockUSDC mockUSDC, , ) = script.run();

        address treasury = address(0xBEEF);
        uint256 topUp = 1_000 * 1e6; // 1,000 MockUSDC

        // Any random address can mint — that's the whole point of MockUSDC.
        vm.prank(address(0xDEAD));
        mockUSDC.mint(treasury, topUp);

        assertEq(mockUSDC.balanceOf(treasury), topUp, "open-mint must credit treasury");
    }
}
