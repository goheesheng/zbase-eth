// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {ExecutorProcessooor} from "@zbase-protocol/contracts/ExecutorProcessooor.sol";

/**
 * @title DeployExecutorProcessooor
 * @notice Forge deploy script for the B2 ExecutorProcessooor (private-funded DeFi access).
 *
 * Deploys the executor with a FROZEN whitelist of (callTarget, selector) pairs. The
 * whitelist is immutable after construction — to add a target, deploy a NEW executor.
 *
 * v1 target (Base Sepolia): an ERC-4626 vault `deposit(uint256,address)`.
 *   Env: EXECUTOR_TARGET_1  = the vault address
 *        EXECUTOR_SELECTOR_1 = the 4-byte selector (default: deposit(uint256,address) = 0x6e553f65)
 * Optionally a second pair via EXECUTOR_TARGET_2 / EXECUTOR_SELECTOR_2.
 *
 * Required to broadcast:
 *   DEPLOYER_PRIVATE_KEY  — hex (with or without 0x). Freshly funded testnet key. The
 *                           deployer has NO ongoing privilege (the executor has no admin).
 *
 * Usage (TESTNET ONLY — Base Sepolia):
 *   # dry run (no broadcast) — verify config + gas:
 *   forge script script/DeployExecutorProcessooor.s.sol:DeployExecutorProcessooor \
 *       --rpc-url $BASE_SEPOLIA_RPC
 *   # broadcast:
 *   forge script script/DeployExecutorProcessooor.s.sol:DeployExecutorProcessooor \
 *       --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
 *
 * DO NOT deploy to Base mainnet without an external audit (see plan §4b).
 */
contract DeployExecutorProcessooor is Script {
    /// @dev Default ERC-4626 deposit(uint256,address) selector.
    bytes4 internal constant DEFAULT_DEPOSIT_SELECTOR = bytes4(keccak256("deposit(uint256,address)"));

    address[] internal targets;
    bytes4[] internal selectors;

    uint256 internal deployerPrivateKey;
    address internal deployer;

    function run() external returns (ExecutorProcessooor deployed) {
        _loadConfig();
        _checkInputs();
        _printPreflight();

        vm.startBroadcast(deployerPrivateKey);
        deployed = new ExecutorProcessooor(targets, selectors);
        vm.stopBroadcast();

        _printResult(address(deployed));
        return deployed;
    }

    function _loadConfig() internal {
        // Pair 1 (required).
        address t1 = vm.envAddress("EXECUTOR_TARGET_1");
        bytes4 s1 = _selectorEnv("EXECUTOR_SELECTOR_1");
        targets.push(t1);
        selectors.push(s1);

        // Pair 2 (optional).
        address t2 = vm.envOr("EXECUTOR_TARGET_2", address(0));
        if (t2 != address(0)) {
            bytes4 s2 = _selectorEnv("EXECUTOR_SELECTOR_2");
            targets.push(t2);
            selectors.push(s2);
        }

        deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        deployer = vm.addr(deployerPrivateKey);
    }

    /// @dev Parse a 4-byte selector env var (e.g. "0x04e45aaf") correctly.
    ///      `vm.envOr(name, bytes32)` LEFT-pads a 4-byte hex input to bytes32, so
    ///      `bytes4()` of it takes the wrong (zero) leading bytes — silently mis-whitelisting
    ///      the target. Reading as a string + `vm.parseBytes` preserves byte order, and we
    ///      require exactly 4 bytes so a malformed selector fails loudly instead of deploying
    ///      a wrong whitelist. Falls back to the ERC-4626 deposit selector when unset.
    function _selectorEnv(string memory name) internal view returns (bytes4) {
        string memory raw = vm.envOr(name, string(""));
        if (bytes(raw).length == 0) return DEFAULT_DEPOSIT_SELECTOR;
        bytes memory b = vm.parseBytes(raw);
        require(b.length == 4, "DeployExecutorProcessooor: selector must be exactly 4 bytes");
        return bytes4(b);
    }

    function _checkInputs() internal view {
        require(block.chainid != 8453, "DeployExecutorProcessooor: mainnet blocked (audit-gated, see plan)");
        for (uint256 i = 0; i < targets.length; ++i) {
            require(targets[i] != address(0), "DeployExecutorProcessooor: zero target");
        }
    }

    function _printPreflight() internal view {
        console2.log("=== DeployExecutorProcessooor :: preflight ===");
        console2.log("Deployer:      ", deployer);
        console2.log("Chain ID:      ", block.chainid);
        console2.log("Target count:  ", targets.length);
        for (uint256 i = 0; i < targets.length; ++i) {
            console2.log("  target:      ", targets[i]);
            console2.logBytes4(selectors[i]);
        }
        console2.log("==============================================");
    }

    function _printResult(address deployed) internal pure {
        console2.log("");
        console2.log("=== ExecutorProcessooor DEPLOYED ===");
        console2.log("Address:       ", deployed);
        console2.log("");
        console2.log("--- ADD TO .env.local ---");
        console2.log("EXECUTOR_PROCESSOOOR=", deployed);
        console2.log("NEXT_PUBLIC_EXECUTOR_PROCESSOOOR=", deployed);
        console2.log("-------------------------");
        console2.log("Next: verify on BaseScan, then wire src/lib/contracts.ts executorProcessooor.");
        console2.log("====================================");
    }
}
