// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {ThresholdEntrypoint} from "@zbase-protocol/contracts/ThresholdEntrypoint.sol";
import {DeployThresholdEntrypoint} from "../script/DeployThresholdEntrypoint.s.sol";

/**
 * @title DeployThresholdEntrypointTest
 * @notice Simulates the B.2 deploy script with mock signer env vars and asserts
 *         the resulting contract has the correct 5 signers + threshold of 3.
 *
 * Note on discovery: this file lives in `zbase-protocol/pkg/contracts/test/`,
 * which is NOT in the default Foundry `test` path. See
 * `script/README-deploy-threshold.md` ("Foundry profile note") for how to run
 * it (symlink into `contracts/test/` or extend `foundry.toml`).
 */
contract DeployThresholdEntrypointTest is Test {
    // Deterministic mock keys so the test is reproducible. NONE of these are
    // candidate signers from `docs/governance/signer-candidates-2026-05-31.md`
    // — they are scratch keys solely for testing env-var wiring.
    uint256 internal constant MOCK_DEPLOYER_PK = 0x4242;
    uint256 internal constant MOCK_PK_1 = 0x11111111;
    uint256 internal constant MOCK_PK_2 = 0x22222222;
    uint256 internal constant MOCK_PK_3 = 0x33333333;
    uint256 internal constant MOCK_PK_4 = 0x44444444;
    uint256 internal constant MOCK_PK_5 = 0x55555555;

    address internal mockDeployer;
    address internal mockSigner1;
    address internal mockSigner2;
    address internal mockSigner3;
    address internal mockSigner4;
    address internal mockSigner5;

    function setUp() public {
        mockDeployer = vm.addr(MOCK_DEPLOYER_PK);
        mockSigner1 = vm.addr(MOCK_PK_1);
        mockSigner2 = vm.addr(MOCK_PK_2);
        mockSigner3 = vm.addr(MOCK_PK_3);
        mockSigner4 = vm.addr(MOCK_PK_4);
        mockSigner5 = vm.addr(MOCK_PK_5);

        // Fund the mock deployer so vm.startBroadcast inside the script can
        // actually broadcast in the simulation.
        vm.deal(mockDeployer, 1 ether);
    }

    // ─── Env-var helpers ──────────────────────────────────────────────────────

    function _exportSigners(address s1, address s2, address s3, address s4, address s5) internal {
        vm.setEnv("THRESHOLD_SIGNER_1", vm.toString(s1));
        vm.setEnv("THRESHOLD_SIGNER_2", vm.toString(s2));
        vm.setEnv("THRESHOLD_SIGNER_3", vm.toString(s3));
        vm.setEnv("THRESHOLD_SIGNER_4", vm.toString(s4));
        vm.setEnv("THRESHOLD_SIGNER_5", vm.toString(s5));
    }

    function _exportDeployerKey(uint256 pk) internal {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(pk));
    }

    function _clearDownstream() internal {
        // Use an explicit 0x0 so the script's vm.envOr falls back deterministically
        // regardless of the developer's shell environment.
        vm.setEnv("DOWNSTREAM_ENTRYPOINT", vm.toString(address(0)));
    }

    // ─── Tests ────────────────────────────────────────────────────────────────

    /// @notice Happy path — the script reads 5 distinct signers from env vars
    ///         and produces a contract with exactly those signers + threshold 3.
    function test_DeployScript_HappyPath_BindsSignersAndThreshold() public {
        _exportSigners(mockSigner1, mockSigner2, mockSigner3, mockSigner4, mockSigner5);
        _exportDeployerKey(MOCK_DEPLOYER_PK);
        _clearDownstream();

        DeployThresholdEntrypoint script = new DeployThresholdEntrypoint();
        ThresholdEntrypoint deployed = script.run();

        // Threshold + signer-count are constants in the contract.
        assertEq(deployed.THRESHOLD(), 3, "THRESHOLD must be 3");
        assertEq(deployed.SIGNER_COUNT(), 5, "SIGNER_COUNT must be 5");

        // All 5 signers bound in declared order.
        address[5] memory got = deployed.getSigners();
        assertEq(got[0], mockSigner1, "signer 1 mismatch");
        assertEq(got[1], mockSigner2, "signer 2 mismatch");
        assertEq(got[2], mockSigner3, "signer 3 mismatch");
        assertEq(got[3], mockSigner4, "signer 4 mismatch");
        assertEq(got[4], mockSigner5, "signer 5 mismatch");

        // Stand-alone mode confirmed (no downstream wired).
        assertEq(deployed.downstream(), address(0), "downstream must be zero in stand-alone mode");

        // Fresh-deploy invariants.
        assertEq(deployed.nonce(), 0, "fresh contract must have nonce 0");
        assertEq(deployed.latestRoot(), bytes32(0), "fresh contract must have empty latestRoot");
    }

    /// @notice The script must refuse to deploy if any signer env var is zero.
    function test_DeployScript_RejectsZeroAddress() public {
        _exportSigners(mockSigner1, mockSigner2, address(0), mockSigner4, mockSigner5);
        _exportDeployerKey(MOCK_DEPLOYER_PK);
        _clearDownstream();

        DeployThresholdEntrypoint script = new DeployThresholdEntrypoint();
        vm.expectRevert(bytes("DeployThresholdEntrypoint: zero address in signer set"));
        script.run();
    }

    /// @notice The script must refuse to deploy if two signer env vars match.
    function test_DeployScript_RejectsDuplicateSigner() public {
        _exportSigners(mockSigner1, mockSigner2, mockSigner1, mockSigner4, mockSigner5);
        _exportDeployerKey(MOCK_DEPLOYER_PK);
        _clearDownstream();

        DeployThresholdEntrypoint script = new DeployThresholdEntrypoint();
        vm.expectRevert(bytes("DeployThresholdEntrypoint: duplicate signer in signer set"));
        script.run();
    }

    /// @notice When DOWNSTREAM_ENTRYPOINT is set, the script wires it through.
    function test_DeployScript_RespectsDownstreamEnvVar() public {
        address mockDownstream = address(0xBEEF);
        _exportSigners(mockSigner1, mockSigner2, mockSigner3, mockSigner4, mockSigner5);
        _exportDeployerKey(MOCK_DEPLOYER_PK);
        vm.setEnv("DOWNSTREAM_ENTRYPOINT", vm.toString(mockDownstream));

        DeployThresholdEntrypoint script = new DeployThresholdEntrypoint();
        ThresholdEntrypoint deployed = script.run();

        assertEq(deployed.downstream(), mockDownstream, "downstream env var not forwarded");
    }
}
