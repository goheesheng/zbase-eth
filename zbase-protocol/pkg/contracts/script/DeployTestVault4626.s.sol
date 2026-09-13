// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestVault4626} from "@zbase-protocol/contracts/test/TestVault4626.sol";

/**
 * @title DeployTestVault4626
 * @notice Deploys a testnet ERC-4626-shaped vault to whitelist as the ExecutorProcessooor's
 *         v1 target on Base Sepolia. TESTNET ONLY (mainnet blocked).
 *
 * Env:
 *   VAULT_ASSET           = the underlying token (default: Base Sepolia USDC 0x036C…dCF7e)
 *   DEPLOYER_PRIVATE_KEY  = funded testnet key
 *
 * Usage:
 *   forge script script/DeployTestVault4626.s.sol:DeployTestVault4626 \
 *       --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
 *
 * The printed address becomes EXECUTOR_TARGET_1 (for the executor deploy) and both
 * CALL_E2E_VAULT and CALL_E2E_SHARE_TOKEN (the vault is its own share token).
 */
contract DeployTestVault4626 is Script {
    function run() external returns (TestVault4626 vault) {
        require(block.chainid != 8453, "mainnet blocked");
        address asset = vm.envOr("VAULT_ASSET", address(0x036CbD53842c5426634e7929541eC2318f3dCF7e));
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(pk);
        vault = new TestVault4626(IERC20(asset));
        vm.stopBroadcast();

        console2.log("=== TestVault4626 DEPLOYED ===");
        console2.log("Vault (target + share token):", address(vault));
        console2.log("Underlying asset:            ", asset);
        console2.log("deposit selector:            0x6e553f65");
        console2.log("");
        console2.log("--- next: deploy the executor whitelisting this vault ---");
        console2.log("EXECUTOR_TARGET_1=", address(vault));
        console2.log("CALL_E2E_VAULT=", address(vault));
        console2.log("CALL_E2E_SHARE_TOKEN=", address(vault));
        console2.log("==============================");
    }
}
