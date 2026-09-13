// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestVault4626
 * @notice Minimal ERC-4626-SHAPED vault for Base Sepolia E2E testing of the
 *         ExecutorProcessooor "private-funded DeFi access" path. NOT a real ERC-4626
 *         (no rounding, no preview* fns) — just a `deposit(assets, receiver)` that pulls
 *         the underlying and mints 1:1 share tokens. TESTNET ONLY.
 *
 * The share token is THIS contract (it is itself an ERC20), so `outputToken` in the
 * ExecPlan = address(this).
 */
contract TestVault4626 is ERC20 {
    IERC20 public immutable asset;

    constructor(IERC20 _asset) ERC20("zBase Test Vault Share", "zTVS") {
        asset = _asset;
    }

    /// @notice ERC-4626-shaped deposit. Selector = deposit(uint256,address) = 0x6e553f65.
    /// @param assets   amount of underlying to pull from msg.sender
    /// @param receiver who receives the 1:1 shares
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(asset.transferFrom(msg.sender, address(this), assets), "pull failed");
        _mint(receiver, assets);
        return assets;
    }

    function decimals() public pure override returns (uint8) {
        return 6; // match USDC so 1:1 shares read cleanly
    }
}
