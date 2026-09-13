/**
 * Build a `CallPlan` for private swap-as-settlement: an agent pays the pool asset
 * (USDC) and the seller receives a DIFFERENT token, unlinkably, in one settlement.
 *
 * This is NOT a private trading venue — it is private SETTLEMENT that happens to
 * cross assets. The ExecutorProcessooor hides WHO funded the swap; the swap itself
 * is public on-chain. See the zBase threat model + docs/strategy/xochi-competitive-
 * analysis-2026-07-08.md §7.
 *
 * The executor whitelists a swap router `(target, selector)` at construction. This
 * helper produces the exact `exactInputSingle` calldata for that router.
 *
 * ── The load-bearing constraint (audit F1) ───────────────────────────────────────
 * The executor measures the produced output on ITS OWN balance and then sweeps to
 * the final recipient. So the router's `recipient` field MUST be the executor, NOT
 * the seller. If you point the router at the seller directly, the executor sees
 * outDelta == 0 and reverts `NoOutputProduced`. This helper hardcodes
 * `recipient = executor` so a caller cannot get it wrong — the seller is carried in
 * the CallPlan's own `recipient` field, which the executor sweeps to afterward.
 */

import { encodeFunctionData, getAddress } from "viem";
import type { CallPlan } from "./facilitatorClient.js";

/** Uniswap V3 SwapRouter02 `exactInputSingle` selector — the whitelisted selector. */
export const EXACT_INPUT_SINGLE_SELECTOR = "0x04e45aaf" as const;

/**
 * Minimal ABI for Uniswap V3 SwapRouter02 `exactInputSingle`. SwapRouter02 drops the
 * `deadline` field that the original SwapRouter carried, so the params tuple is 7
 * fields. `amountOutMinimum` is the on-chain slippage floor; we set it equal to the
 * CallPlan `minOut` the executor independently enforces (belt and suspenders).
 */
const EXACT_INPUT_SINGLE_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface BuildSwapCallPlanOpts {
  /** The whitelisted Uniswap V3 SwapRouter02 address (executor's frozen whitelist). */
  router: string;
  /** The deployed ExecutorProcessooor — the swap recipient MUST be this (audit F1). */
  executor: string;
  /** Pool asset spent into the swap (USDC). Must equal the pool's ASSET. */
  inputToken: string;
  /** Token the seller wants to receive (e.g. EURC). Must differ from inputToken (F5). */
  outputToken: string;
  /** The Uniswap V3 pool fee tier (e.g. 500, 3000, 10000). */
  poolFee: number;
  /** Atomic amount of inputToken to swap (post-fee spend). */
  amountIn: bigint;
  /** Slippage floor on outputToken (atomic). MUST be > 0 (audit F2). */
  minOut: bigint;
  /** The final seller/recipient of outputToken — the executor sweeps here after the swap. */
  recipient: string;
}

/**
 * Build a well-formed `CallPlan` for a Uniswap-V3-style single-hop swap.
 *
 * Enforces the executor's invariants up front so a malformed plan is caught here,
 * not at a wasted on-chain revert:
 *  - `recipient` in the router calldata = the executor (F1)
 *  - `inputToken != outputToken` (F5)
 *  - `minOut > 0` (F2)
 *  - `amountOutMinimum` in calldata == the CallPlan `minOut` (consistency)
 */
export function buildSwapCallPlan(opts: BuildSwapCallPlanOpts): CallPlan {
  const inputToken = getAddress(opts.inputToken);
  const outputToken = getAddress(opts.outputToken);
  const executor = getAddress(opts.executor);
  const router = getAddress(opts.router);
  const recipient = getAddress(opts.recipient);

  if (inputToken === outputToken) {
    throw new Error("buildSwapCallPlan: inputToken must differ from outputToken (executor audit F5)");
  }
  if (opts.minOut <= 0n) {
    throw new Error("buildSwapCallPlan: minOut must be > 0 (executor audit F2)");
  }
  if (opts.amountIn <= 0n) {
    throw new Error("buildSwapCallPlan: amountIn must be > 0");
  }

  const callData = encodeFunctionData({
    abi: EXACT_INPUT_SINGLE_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: inputToken,
        tokenOut: outputToken,
        fee: opts.poolFee,
        // ★ audit F1: the swap output goes to the EXECUTOR, which then sweeps to
        //   the CallPlan `recipient` (the seller). Pointing this at the seller
        //   directly makes outDelta == 0 → NoOutputProduced revert.
        recipient: executor,
        amountIn: opts.amountIn,
        amountOutMinimum: opts.minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  return {
    target: router,
    inputToken,
    outputToken,
    minOut: opts.minOut.toString(),
    recipient, // the seller — the executor sweeps outputToken here after the swap
    callData,
  };
}
