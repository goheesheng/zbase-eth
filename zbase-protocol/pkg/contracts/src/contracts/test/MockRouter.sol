// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockMintableERC20} from "./MockMintableERC20.sol";

/**
 * @title MockRouter
 * @notice A Uniswap-V3-SwapRouter02-SHAPED mock for the ExecutorProcessooor
 *         swap-as-settlement E2E on Base Sepolia. `exactInputSingle` (selector
 *         0x04e45aaf) pulls `amountIn` of tokenIn from the caller and mints
 *         `amountIn * rateBps / 10000` of tokenOut to `params.recipient`.
 *
 *         Used because Base Sepolia Uniswap V3 pools are often illiquid — this mock
 *         ALWAYS fills, so the E2E deterministically proves the executor plumbing
 *         (proof-binding, F1 output-to-executor sweep, fee split, unlinkability)
 *         without depending on live testnet liquidity.
 *
 *         `tokenOut` MUST be a MockMintableERC20 (or any token this router can mint) —
 *         the router mints output rather than holding an inventory.
 *
 * ⚠️ TESTNET ONLY. Mirrors the inline mock in contracts/test/ExecutorProcessooor.t.sol;
 *    the on-chain deployable copy lets the E2E harness whitelist a real address.
 */
contract MockRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Output-per-input in bps. 10000 = 1:1. Settable to simulate price/slippage.
    uint256 public rateBps = 10_000;

    function setRate(uint256 _rateBps) external {
        rateBps = _rateBps;
    }

    /// @dev exactInputSingle(params) — selector 0x04e45aaf (SwapRouter02 shape, no deadline).
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = (params.amountIn * rateBps) / 10_000;
        // Mint the output to params.recipient (which — per audit F1 — the executor sets to
        // itself, so it can measure outDelta on its own balance and sweep to the seller).
        MockMintableERC20(params.tokenOut).mint(params.recipient, amountOut);
        require(amountOut >= params.amountOutMinimum, "MockRouter: slippage");
        return amountOut;
    }
}
