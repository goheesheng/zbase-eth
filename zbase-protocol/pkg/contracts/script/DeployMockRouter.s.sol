// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {MockRouter} from "@zbase-protocol/contracts/test/MockRouter.sol";

/**
 * @title DeployMockRouter
 * @notice Deploys a Uniswap-V3-shaped MockRouter to Base Sepolia for the
 *         ExecutorProcessooor swap-as-settlement E2E. The router mints its output token
 *         (a MockMintableERC20) on demand, so the swap ALWAYS fills regardless of testnet
 *         liquidity. TESTNET ONLY (mainnet blocked).
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY  = funded testnet key
 *
 * (The router is stateless about which token it mints — it mints whatever `tokenOut` the
 *  ExecPlan names, which must be a MockMintableERC20. So MOCK_OUTPUT_TOKEN is NOT needed
 *  at deploy; it's supplied per-call by the harness via CALL_E2E_OUTPUT_TOKEN.)
 *
 * Usage:
 *   forge script script/DeployMockRouter.s.sol:DeployMockRouter \
 *       --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
 *
 * The printed address becomes EXECUTOR_TARGET_1 (for the executor deploy, with selector
 * 0x04e45aaf) and CALL_E2E_ROUTER (for the swap E2E harness).
 */
contract DeployMockRouter is Script {
    function run() external returns (MockRouter router) {
        require(block.chainid != 8453, "mainnet blocked");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(pk);
        router = new MockRouter();
        vm.stopBroadcast();

        console2.log("=== MockRouter DEPLOYED ===");
        console2.log("Router:           ", address(router));
        console2.log("exactInputSingle:  0x04e45aaf");
        console2.log("rateBps (1:1):     10000");
        console2.log("");
        console2.log("--- next: deploy the executor whitelisting this router ---");
        console2.log("EXECUTOR_TARGET_1=", address(router));
        console2.log("EXECUTOR_SELECTOR_1=0x04e45aaf");
        console2.log("CALL_E2E_ROUTER=", address(router));
        console2.log("===========================");
    }
}
