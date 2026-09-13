// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {ThresholdEntrypoint} from "@zbase-protocol/contracts/ThresholdEntrypoint.sol";

/**
 * @title DeployThresholdEntrypoint
 * @notice Forge deploy script for the B.2 ThresholdEntrypoint (3-of-5 ASP gateway).
 *
 * Reads the five signer addresses from environment variables:
 *   THRESHOLD_SIGNER_1 .. THRESHOLD_SIGNER_5
 * Refuses to deploy if any address is the zero address or duplicated.
 *
 * Optional:
 *   DOWNSTREAM_ENTRYPOINT  — existing 0xbow Entrypoint to forward roots into.
 *                            Defaults to address(0) (stand-alone bookkeeper mode).
 *
 * Required to broadcast:
 *   DEPLOYER_PRIVATE_KEY   — hex (with or without 0x prefix). Use a freshly funded
 *                            key; the deployer has NO ongoing privilege over the
 *                            contract (it is signer-controlled post-deploy).
 *
 * Usage:
 *   forge script script/DeployThresholdEntrypoint.s.sol:DeployThresholdEntrypoint \
 *       --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
 *
 * See `script/README-deploy-threshold.md` for the full operator runbook.
 *
 * Reference signer recruitment plan:
 *   docs/governance/signer-candidates-2026-05-31.md (do NOT hardcode addresses
 *   from that file — every address comes from env vars at run time).
 */
contract DeployThresholdEntrypoint is Script {
    /// @notice The five signer addresses, read from env at run time.
    address[5] internal signers;

    /// @notice Optional downstream forwarding target.
    address internal downstream;

    /// @notice Resolved deployer.
    uint256 internal deployerPrivateKey;
    address internal deployer;

    function run() external returns (ThresholdEntrypoint deployed) {
        _loadConfig();
        _checkInputs();
        _printPreflight();

        vm.startBroadcast(deployerPrivateKey);
        deployed = new ThresholdEntrypoint(signers, downstream);
        vm.stopBroadcast();

        _printResult(address(deployed));
        return deployed;
    }

    // ─── Config loading ───────────────────────────────────────────────────────

    function _loadConfig() internal {
        signers[0] = vm.envAddress("THRESHOLD_SIGNER_1");
        signers[1] = vm.envAddress("THRESHOLD_SIGNER_2");
        signers[2] = vm.envAddress("THRESHOLD_SIGNER_3");
        signers[3] = vm.envAddress("THRESHOLD_SIGNER_4");
        signers[4] = vm.envAddress("THRESHOLD_SIGNER_5");

        // Optional: defaults to address(0) (stand-alone mode) if unset.
        downstream = vm.envOr("DOWNSTREAM_ENTRYPOINT", address(0));

        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        deployer = vm.addr(deployerPrivateKey);
    }

    /**
     * @dev Defense-in-depth — the constructor already rejects zero addresses and
     *      duplicates, but bailing early in the script avoids burning gas on a
     *      doomed deploy and gives a friendlier error in CI logs.
     */
    function _checkInputs() internal view {
        for (uint256 i = 0; i < 5; ++i) {
            require(signers[i] != address(0), "DeployThresholdEntrypoint: zero address in signer set");
            for (uint256 j = 0; j < i; ++j) {
                require(
                    signers[i] != signers[j],
                    "DeployThresholdEntrypoint: duplicate signer in signer set"
                );
            }
        }
    }

    // ─── Logging ──────────────────────────────────────────────────────────────

    function _printPreflight() internal view {
        console2.log("=== DeployThresholdEntrypoint :: preflight ===");
        console2.log("Deployer:         ", deployer);
        console2.log("Chain ID:         ", block.chainid);
        console2.log("Threshold:        ", uint256(3));
        console2.log("Signer count:     ", uint256(5));
        console2.log("Signer 1:         ", signers[0]);
        console2.log("Signer 2:         ", signers[1]);
        console2.log("Signer 3:         ", signers[2]);
        console2.log("Signer 4:         ", signers[3]);
        console2.log("Signer 5:         ", signers[4]);
        console2.log("Downstream:       ", downstream);
        if (downstream == address(0)) {
            console2.log("  (stand-alone mode: no forwarding to a live Entrypoint)");
        }
        console2.log("================================================");
    }

    function _printResult(address deployed) internal pure {
        console2.log("");
        console2.log("=== ThresholdEntrypoint DEPLOYED ===");
        console2.log("Address:          ", deployed);
        console2.log("");
        console2.log("--- ADD TO .env.local ---");
        console2.log("NEXT_PUBLIC_THRESHOLD_ENTRYPOINT=", deployed);
        console2.log("THRESHOLD_ENTRYPOINT=", deployed);
        console2.log("-------------------------");
        console2.log("");
        console2.log("Next steps (see script/README-deploy-threshold.md):");
        console2.log("  1. Verify on BaseScan (forge verify-contract --watch ...)");
        console2.log("  2. Post tx hash + address in STATUS.md");
        console2.log("  3. Point src/app/api/asp-update/route.ts at the new address");
        console2.log("  4. Update docs/governance.md with the live address");
        console2.log("====================================");
    }
}
