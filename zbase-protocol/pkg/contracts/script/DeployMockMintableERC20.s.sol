// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {MockMintableERC20} from "@zbase-protocol/contracts/test/MockMintableERC20.sol";

/**
 * @title DeployMockMintableERC20
 * @notice Deploys the seller's mock "output token" (e.g. test EURC) to Base Sepolia for
 *         the ExecutorProcessooor swap-as-settlement E2E. The paired MockRouter mints
 *         this token as swap output. TESTNET ONLY (mainnet blocked).
 *
 * Env:
 *   MOCK_TOKEN_NAME       = display name (default "zBase Test EURC")
 *   MOCK_TOKEN_SYMBOL     = symbol       (default "tEURC")
 *   MOCK_TOKEN_DECIMALS   = decimals     (default 6, matches USDC)
 *   DEPLOYER_PRIVATE_KEY  = funded testnet key
 *
 * Usage:
 *   forge script script/DeployMockMintableERC20.s.sol:DeployMockMintableERC20 \
 *       --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
 *
 * The printed address becomes MOCK_OUTPUT_TOKEN (for the MockRouter deploy) and
 * CALL_E2E_OUTPUT_TOKEN (for the swap E2E harness).
 */
contract DeployMockMintableERC20 is Script {
    function run() external returns (MockMintableERC20 token) {
        require(block.chainid != 8453, "mainnet blocked");
        string memory name_ = vm.envOr("MOCK_TOKEN_NAME", string("zBase Test EURC"));
        string memory symbol_ = vm.envOr("MOCK_TOKEN_SYMBOL", string("tEURC"));
        uint256 decimals_ = vm.envOr("MOCK_TOKEN_DECIMALS", uint256(6));
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(pk);
        token = new MockMintableERC20(name_, symbol_, uint8(decimals_));
        vm.stopBroadcast();

        console2.log("=== MockMintableERC20 (output token) DEPLOYED ===");
        console2.log("Token:   ", address(token));
        console2.log("Name:    ", name_);
        console2.log("Symbol:  ", symbol_);
        console2.log("");
        console2.log("--- next: deploy the MockRouter that mints this token ---");
        console2.log("MOCK_OUTPUT_TOKEN=", address(token));
        console2.log("CALL_E2E_OUTPUT_TOKEN=", address(token));
        console2.log("=================================================");
    }
}
