/**
 * forwarding-sweep.ts — move the USER's USDC into the pool, gaslessly.
 *
 * This is the plug for the SweepAuthority socket that forwarding-authority.ts refuses
 * to run without, and the reason it refuses: `Entrypoint.deposit()` pulls from
 * `msg.sender` (vendor/0xbow/contracts/Entrypoint.sol:123) and there is no depositFor
 * variant, so the postman can only deposit money it already holds. Without a sweep it
 * was depositing its OWN USDC while the user's balance sat untouched — a treasury
 * drain, not a forwarding rail.
 *
 * The flow, and why each step is shaped this way:
 *
 *   1. The user's wallet signs `receiveWithAuthorization(A → postman, value)`.
 *      RECEIVE, not TRANSFER: receiveWithAuthorization requires `msg.sender == to`,
 *      so only the postman can submit it. A transferWithAuthorization sitting in a
 *      request body could be front-run by anyone who saw it.
 *   2. The postman submits it and RECEIVES the USDC. This is the custody window: for
 *      the span of two transactions the postman holds the user's funds and could
 *      keep them. Bounded, but real, and not something to bury.
 *   3. Lazy max-approve USDC → Entrypoint, but ONLY when the committed allowance is
 *      short — and as a call in the SAME atomic batch, not a separate tx. (Approving
 *      from a raw wallet client, as scripts/decoy-scheduler.ts does, approves the EOA
 *      under POSTMAN_SIGNER=cdp — the mainnet default — leaving the CDP smart account
 *      unapproved.)
 *   4. Deposit the authorization's `value`, in that same atomic batch.
 *
 * ONE ATOMIC BATCH, not a measured delta. This authority BUILDS the receive+approve
 * calls; forwarding-authority appends the deposit and sends all of them in a single
 * transaction (sendPostmanBatch → one CDP userOp). Earlier builds instead sent the
 * steps as separate userOps and MEASURED how much the receive delivered before
 * depositing it — because trusting `value` across separate txs let a fee-on-transfer
 * token, a partial fill, or a lying client top the deposit up out of the treasury.
 * Atomicity gives that guarantee for free and without the racing read: the receive
 * and the deposit share one tx, so if the receive delivers less than `value` the
 * postman (which holds no float) cannot cover the deposit and the WHOLE batch reverts
 * — no over-deposit, no treasury top-up, nothing stranded. Depositing `value` is safe
 * because the user's signature authenticates it and Base USDC is not fee-on-transfer.
 * The measured-delta read is what raced the CDP userOp and stranded real deposits.
 *
 * ACCEPTED COSTS, stated rather than hidden:
 *  - Custody window (step 2).
 *  - Ragequit is DISABLED for swept notes. Entrypoint.sol:336 hardcodes
 *    `_pool.deposit(msg.sender, …)`, so `depositors[_label]` is the postman
 *    (PrivacyPool.sol:82-95). Not a theft risk — the postman cannot ragequit without
 *    the user's secrets (PrivacyPool.sol:132-135) — but the escape hatch is gone.
 *    Fixing it needs a depositFor on an audit-frozen vendored contract.
 *  - The postman address is a permanent correlation anchor (see getPostmanAddress).
 */
import { createPublicClient, http, type Abi, type Hex } from "viem";
import { getActiveStack, getActiveChain } from "./contracts";
import { getPostmanAddress, type PostmanCall } from "./postman-signer";
import { splitSignature } from "./x402-facilitator";
import type { SweepAuthority } from "./forwarding-authority";
import { usdcDomainFor } from "./usdc-domain";

/**
 * USDC EIP-3009 `receiveWithAuthorization(...)`. Same 9 args as
 * transferWithAuthorization; the difference is on-chain: USDC requires
 * `msg.sender == to`, which is what makes a sweep authorization safe to hand to a
 * server. Verified present on Base USDC (v2).
 */
export const USDC_RECEIVE_WITH_AUTHORIZATION_ABI = [
  {
    name: "receiveWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const ERC20_MIN_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/**
 * The EIP-712 types for ReceiveWithAuthorization. Identical field list to
 * TransferWithAuthorization — only the primaryType (and therefore the typehash)
 * differs, which is exactly what stops a signature for one being replayed as the
 * other.
 */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The wire shape of a sweep authorization (stringified scalars, hex nonce). */
export interface SweepAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

/**
 * The EIP-712 domain for the ACTIVE stack's USDC.
 *
 * HARDCODED from getActiveStack(), never taken from the request. The x402 verify path
 * reads name/version out of caller-supplied `accepts.extra` because the protocol
 * requires it (the seller declares its token) — a sweep has no such excuse, and
 * accepting a caller-supplied domain is a signature-confusion hole: an attacker
 * supplies a domain under which a signature the victim made over some unrelated
 * message recovers to the victim's address.
 */
export function sweepDomain() {
  const stack = getActiveStack();
  const chain = getActiveChain();
  return {
    ...usdcDomainFor(chain.chain.id),
    chainId: chain.chain.id,
    verifyingContract: stack.usdc as `0x${string}`,
  } as const;
}

/**
 * The postman's CURRENTLY-COMMITTED USDC → Entrypoint allowance. A plain read of
 * on-chain state (not a value we just wrote), so it does NOT race — we use it only to
 * DECIDE whether the batch needs an approve. After the first ever sweep it is 2^256-1
 * and no further approve is emitted. Self-heals if the signer backend flips (EOA ↔ CDP
 * resolve to different addresses, and an approval is per-address).
 */
async function committedAllowance(postman: `0x${string}`): Promise<bigint> {
  const stack = getActiveStack();
  const chain = getActiveChain();
  const client = createPublicClient({ chain: chain.chain, transport: http(chain.readRpcUrl) });
  return (await client.readContract({
    address: stack.usdc as `0x${string}`,
    abi: ERC20_MIN_ABI,
    functionName: "allowance",
    args: [postman, stack.entrypoint as `0x${string}`],
  })) as bigint;
}

/**
 * The live SweepAuthority: BUILD the calls that move the user's signed USDC into the
 * postman and let the Entrypoint pull it. It does NOT send — forwarding-authority
 * appends the deposit and submits everything as ONE atomic batch. That is what makes
 * the deposit's simulation see the receive+approve (no cross-userOp lag) and what
 * makes a revert strand nothing. See the atomic-batch note at the top of this file
 * for why we deposit the signed `value` rather than a measured delta.
 */
export function createEip3009SweepAuthority(args: {
  authorization: SweepAuthorization;
  signature: Hex;
}): SweepAuthority {
  return {
    async buildSweepCalls({ watchedAddress, amount }) {
      const stack = getActiveStack();
      const chain = getActiveChain();
      const postman = await getPostmanAddress(chain.chain);
      const auth = args.authorization;

      // The authorization must actually move THIS user's funds to THIS postman.
      // Without both checks a caller could have us broadcast someone else's
      // authorization, or one paying an address we don't control.
      if (auth.from.toLowerCase() !== watchedAddress.toLowerCase()) {
        throw new Error(
          `Sweep authorization.from (${auth.from}) is not the watched address (${watchedAddress}).`,
        );
      }
      if (auth.to.toLowerCase() !== postman.toLowerCase()) {
        throw new Error(
          `Sweep authorization.to is not the postman. receiveWithAuthorization requires msg.sender == to, so this could never be submitted.`,
        );
      }

      // The client's `amount` is advisory; the SIGNED value is what actually moves and
      // what we deposit. Loud if they disagree — the caller will be credited `value`.
      const value = BigInt(auth.value);
      if (value !== amount) {
        console.warn(
          `[Sweep] signed value ${value} != requested ${amount} — depositing the signed value.`,
        );
      }

      const { v, r, s } = splitSignature(args.signature);
      const calls: PostmanCall[] = [
        {
          address: stack.usdc as `0x${string}`,
          abi: USDC_RECEIVE_WITH_AUTHORIZATION_ABI as unknown as Abi,
          functionName: "receiveWithAuthorization",
          args: [
            auth.from,
            auth.to,
            value,
            BigInt(auth.validAfter),
            BigInt(auth.validBefore),
            auth.nonce,
            v,
            r,
            s,
          ],
        },
      ];

      // Include a max-approve ONLY when the committed allowance is short. It rides in
      // the same batch and executes BEFORE the deposit that spends it — so even a fresh
      // postman deposits on the first try. The read above is committed state (safe); the
      // approve→deposit ordering is guaranteed by being a single transaction.
      if ((await committedAllowance(postman)) < value) {
        calls.push({
          address: stack.usdc as `0x${string}`,
          abi: ERC20_MIN_ABI as unknown as Abi,
          functionName: "approve",
          args: [stack.entrypoint as `0x${string}`, 2n ** 256n - 1n],
        });
      }

      return { calls, depositAtomic: value };
    },
  };
}
