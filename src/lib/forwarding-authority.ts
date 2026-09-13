/**
 * Forwarding rail — B1 DepositAuthority (live wiring). Phase 2.
 *
 * The concrete DepositAuthority the daemon uses in --live mode. It deposits into
 * the pool via the SAME postman signer withdrawals already use (key custody
 * decided 2026-07-09 — no new key surface). Bounded to depositing: it is handed a
 * precommitment + amount and calls the Entrypoint's `deposit()`; it cannot spend
 * the resulting note (that needs the user's seed / D3).
 *
 * Deposit path (identical to scripts/decoy-scheduler.ts's deposit):
 *     Entrypoint.deposit(USDC_ASSET, amountAtomic, precommitment)  gas ~1M
 * signed through sendPostmanTx (EOA or CDP backend), awaiting the receipt.
 *
 * ── DISARMED 2026-07-16 — READ BEFORE RE-ENABLING ────────────────────────────
 * `Entrypoint.deposit()` pulls funds from `msg.sender`
 * (vendor/0xbow/contracts/Entrypoint.sol:123) — the POSTMAN. There is no
 * depositFor / depositWithAuthorization variant. So this authority, as originally
 * written, deposited the postman's OWN USDC and never touched the watched
 * address: it destructured `watchedAddress` away and dropped it. The user's
 * inbound funds stayed put while the treasury paid for their note.
 *
 * Run --live against a provisioned stack with a pre-approved postman and that is
 * a treasury drain, bounded only by ZBASE_FORWARDING_MAX_SPEND_USDC (default $50
 * — scripts/forwarding-engine.ts:53), which reads like a sizing knob rather than
 * the last line of defence it actually was. It also records the postman as
 * `depositors[_label]` (Entrypoint.sol:336 hardcodes `msg.sender`), which
 * permanently disables ragequit for the resulting note (PrivacyPool.sol:132-135).
 *
 * Until the Phase-3 EIP-3009 sweep lands (user signs receiveWithAuthorization →
 * postman receives the funds → postman approves + deposits), this authority
 * REFUSES to deposit. It is not a working rail with a missing optimisation; it
 * moves the wrong person's money. Fail closed.
 *
 * This module is separated from the daemon script so it is importable + unit-
 * testable (the arg-building is verified without a live chain).
 */

import type { Abi } from "viem";
import { sendPostmanBatch, type PostmanCall } from "./postman-signer";
import { getActiveStack, getActiveChain } from "./contracts";
import type { DepositAuthority } from "./forwarding-engine";

/** ERC-20 `deposit(address,uint256,uint256)` — the Entrypoint deposit overload. */
export const DEPOSIT_ERC20_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_asset", type: "address" },
      { name: "_amount", type: "uint256" },
      { name: "_precommitment", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * Build the deposit call parameters for a given (amount, precommitment) against
 * the ACTIVE stack. Pure — no side effects, no chain. Exposed for tests so we can
 * assert the exact args without sending a tx.
 */
export function buildDepositCall(args: { amount: bigint; precommitment: string }) {
  const stack = getActiveStack();
  const chain = getActiveChain();
  // The Entrypoint deposit takes the ASSET (USDC), amount, precommitment.
  const asset = stack.usdc;

  // Provisioning guards: refuse to build a deposit against an un-provisioned
  // stack (0x0 entrypoint/pool means mainnet addresses haven't been wired yet —
  // MAINNET_STACK is all-0x0 until the operator pastes real addresses post-deploy).
  if (!asset || /^0x0{40}$/i.test(asset)) {
    throw new Error(
      "buildDepositCall: active stack has no USDC token — provision the stack before --live deposits.",
    );
  }
  if (!stack.entrypoint || /^0x0{40}$/i.test(stack.entrypoint)) {
    throw new Error(
      "buildDepositCall: active stack Entrypoint is 0x0 (un-provisioned). Deploy + wire MAINNET_STACK first.",
    );
  }
  if (!stack.usdcPool || /^0x0{40}$/i.test(stack.usdcPool)) {
    throw new Error(
      "buildDepositCall: active stack usdcPool is 0x0 (un-provisioned). Deploy + wire MAINNET_STACK first.",
    );
  }
  return {
    address: stack.entrypoint,
    abi: DEPOSIT_ERC20_ABI,
    functionName: "deposit" as const,
    args: [asset, args.amount, BigInt(args.precommitment)] as const,
    gas: 1_000_000n, // Poseidon + Merkle insertion; matches decoy scheduler
    chain: chain.chain,
    writeRpcUrl: chain.writeRpcUrl,
    readRpcUrl: chain.readRpcUrl,
  };
}

/** Thrown when the authority is asked to deposit without a completed sweep. */
export class ForwardingSweepMissingError extends Error {
  constructor(watchedAddress: string) {
    super(
      `Forwarding deposit REFUSED for ${watchedAddress}: no EIP-3009 sweep has moved the ` +
        "user's USDC to the postman. Entrypoint.deposit() pulls from msg.sender, so depositing " +
        "now would spend the POSTMAN's own funds while the user's balance sits untouched in " +
        "their own address — a treasury drain, not a forwarding rail. Land the Phase-3 sweep " +
        "(receiveWithAuthorization → postman → approve → deposit) before enabling --live.",
    );
    this.name = "ForwardingSweepMissingError";
  }
}

/**
 * Sweep hook: BUILDS (does not send) the calls that move `amount` USDC from the
 * watched address into the postman and let the Entrypoint pull it — so the authority
 * can append the deposit and submit all of it as ONE atomic transaction. Phase 3
 * implements it via EIP-3009 `receiveWithAuthorization` (front-run safe: only the
 * named recipient can submit it), signed by the wallet that owns the watched address
 * — no ETH needed there.
 *
 * Returns:
 *  - `calls`: [receiveWithAuthorization, (approve if the committed allowance is short)]
 *  - `depositAtomic`: the amount the authority must deposit — the signed authorization
 *    `value`. It is authenticated (the user's signature covers it) and, because the
 *    deposit rides in the SAME transaction as the receive, it is safe: if the receive
 *    moves less than `value` the whole batch reverts (the postman, holding no float,
 *    cannot cover the shortfall) rather than topping the deposit up out of treasury.
 *    This is why the old "measure the balance delta" step is gone — atomicity gives
 *    the same guarantee that measuring a separate receive tx used to, without the
 *    cross-userOp read that raced and stranded funds.
 *
 * WHY NOT SEND HERE: sending receive/approve/deposit as separate userOps is exactly
 * the race this rail kept hitting (see sendPostmanBatch). The sweep hands its calls
 * up so they go out atomically with the deposit.
 */
export interface SweepAuthority {
  buildSweepCalls(args: {
    watchedAddress: `0x${string}`;
    amount: bigint;
  }): Promise<{ calls: PostmanCall[]; depositAtomic: bigint }>;
}

/**
 * The live B1 authority. Builds the sweep calls, appends the deposit, and submits
 * ALL of it as one atomic batch (sendPostmanBatch → one CDP userOp). Returns the tx
 * hash after confirmation. Any revert rolls back every call, so the user's USDC
 * stays recoverable in the watched address — nothing strands mid-flow.
 *
 * `sweep` is REQUIRED. Without it this refuses to run: see the DISARMED note at the
 * top of this file. Passing no sweeper is not a degraded mode, it is the bug.
 */
export function createB1DepositAuthority(sweep?: SweepAuthority): DepositAuthority {
  return {
    async deposit({ watchedAddress, amount, precommitment }) {
      if (!sweep) throw new ForwardingSweepMissingError(watchedAddress);

      // 1. Build (do NOT send) the calls that move the USER's funds to the postman
      //    and ensure the Entrypoint can pull them.
      const { calls: sweepCalls, depositAtomic } = await sweep.buildSweepCalls({
        watchedAddress,
        amount,
      });
      if (depositAtomic <= 0n) {
        throw new Error(
          `Forwarding sweep for ${watchedAddress} moved 0 atomic USDC — refusing to deposit ` +
            "the postman's own funds in its place.",
        );
      }

      // 2. Append the deposit and submit the whole thing atomically. The deposit
      //    rides in the SAME transaction as the receive+approve, so its simulation
      //    sees their state (no cross-userOp lag) and a revert strands nothing.
      const call = buildDepositCall({ amount: depositAtomic, precommitment });
      const txHash = await sendPostmanBatch(
        [
          ...sweepCalls,
          {
            address: call.address,
            abi: call.abi as unknown as Abi,
            functionName: call.functionName,
            args: call.args as unknown as readonly unknown[],
            gas: call.gas,
          },
        ],
        { chain: call.chain, writeRpcUrl: call.writeRpcUrl, readRpcUrl: call.readRpcUrl },
      );
      return { txHash };
    },
  };
}
