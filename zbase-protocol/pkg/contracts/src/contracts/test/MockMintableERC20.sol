// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockMintableERC20
 * @notice A 6-decimal ERC20 with a PUBLIC `mint` — the seller's chosen "output token"
 *         for the ExecutorProcessooor swap-as-settlement E2E on Base Sepolia. Named to
 *         read as a cross-asset payout (e.g. "zBase Test EURC") so the demo shows an
 *         agent paying USDC and a seller receiving a DIFFERENT asset.
 *
 *         The public `mint` lets the paired MockRouter mint output on demand
 *         (MockRouter calls `MockMintableERC20(tokenOut).mint(recipient, amountOut)`).
 *
 * ⚠️ TESTNET ONLY. Anyone can mint — never deploy to mainnet. Constructor name/symbol
 *    are parameterized so one contract serves any mock output asset.
 */
contract MockMintableERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Unrestricted mint — testnet only. The MockRouter mints swap output here.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
