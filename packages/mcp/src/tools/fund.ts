/**
 * fund.ts — "where do I send USDC?" and "put what arrived into the pool".
 *
 * This is the user's ask, literally: send USDC to your wallet, and it lands in the
 * pool. No contract call, no ETH, no approve — anything that can send USDC works
 * (awal `send`, an exchange withdrawal, MetaMask).
 *
 * Two tools because it is two events separated by an unknown amount of time:
 *   - `fund_address` → the address to send to. Derived from the seed, so it survives
 *     a wipe.
 *   - `fund_sweep`   → once the USDC has landed, sign it into the pool.
 *
 * The signing happens HERE, not on the server. The wallet holds the key; the
 * facilitator only submits. That is what keeps the server from holding a standing
 * claim on anyone's funds — see src/app/api/forwarding/sweep/route.ts.
 */
import { z } from "zod";
import { createPublicClient, http, parseUnits, formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, sepolia } from "viem/chains";
import { deriveFundingAccount } from "../account.js";
import { ZBASE_FACILITATOR_URL } from "../config.js";

export const fundAddressSchema = z.object({});

export const fundSweepSchema = z.object({
  amount: z
    .string()
    .optional()
    .describe(
      "USDC amount to sweep, e.g. '1.50'. Omit to sweep the FULL balance sitting at the funding address (the usual case).",
    ),
});

const ERC20_BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface PostmanInfo {
  postman: `0x${string}`;
  asset: `0x${string}`;
  chainId: number;
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
}

async function fetchPostman(): Promise<PostmanInfo> {
  const res = await fetch(`${ZBASE_FACILITATOR_URL}/api/forwarding/postman`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`Facilitator has no usable postman: ${body.error ?? `HTTP ${res.status}`}`);
  }
  return (await res.json()) as PostmanInfo;
}

function chainFor(chainId: number) {
  if (chainId === 8453) return base;
  if (chainId === 84532) return baseSepolia;
  if (chainId === 11155111) return sepolia; // Ethereum Sepolia (ETHONLINE-2026)
  throw new Error(`Unsupported chainId ${chainId}`);
}

/** Where to send USDC. Derived, so a wiped machine recovers it from the seed. */
export async function fundAddress(): Promise<string> {
  const info = await fetchPostman();
  const account = deriveFundingAccount();
  return JSON.stringify(
    {
      fundingAddress: account.address,
      asset: info.asset,
      chainId: info.chainId,
      instructions: [
        `Send USDC on chain ${info.chainId} to ${account.address}.`,
        "Any wallet works — it is an ordinary transfer. You do NOT need ETH.",
        "Then call fund_sweep to move it into the privacy pool.",
      ],
      note: "This address is derived from your seed. It is a way-station, not a balance: funds sitting here are NOT private yet.",
    },
    null,
    2,
  );
}

/**
 * Sweep whatever is sitting at the funding address into the pool.
 *
 * Signs an EIP-3009 `receiveWithAuthorization` — gasless, so the funding address
 * never needs ETH, and front-run-safe because USDC requires msg.sender == to and we
 * name the postman.
 *
 * The pool note is derived at the next free index and credited to its precommitment.
 * We send the facilitator the PRECOMMITMENT only — never the note secrets — so it can
 * deposit for us without being able to spend the result.
 */
export async function fundSweep(
  args: z.infer<typeof fundSweepSchema>,
  /** The note slot to credit. Resolved by the caller from the chain, not a counter. */
  slot: { precommitment: string; index: number },
): Promise<string> {
  const info = await fetchPostman();
  const account = deriveFundingAccount();
  const chain = chainFor(info.chainId);
  const client = createPublicClient({ chain, transport: http() });

  const balance = (await client.readContract({
    address: info.asset,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  const value = args.amount ? parseUnits(args.amount, 6) : balance;

  if (value <= 0n) {
    return JSON.stringify({
      swept: false,
      reason: "Nothing to sweep — the funding address holds 0 USDC.",
      fundingAddress: account.address,
    });
  }
  if (value > balance) {
    return JSON.stringify({
      swept: false,
      reason: `Asked to sweep ${formatUnits(value, 6)} but the funding address holds ${formatUnits(balance, 6)} USDC.`,
      fundingAddress: account.address,
    });
  }

  const { precommitment, index } = slot;

  const nonce = ("0x" +
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")) as Hex;
  const message = {
    from: account.address,
    to: info.postman,
    value,
    validAfter: 0n,
    // 10 minutes. Long enough for a slow relay, short enough that an authorization
    // lifted from a log is worthless soon after.
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
    nonce,
  } as const;

  const signature = await account.signTypedData({
    // Domain rebuilt from the facilitator's published values; the server hardcodes its
    // own side from the active stack and will reject a mismatch rather than trust us.
    domain: info.domain,
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message,
  });

  const res = await fetch(`${ZBASE_FACILITATOR_URL}/api/forwarding/sweep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authorization: {
        from: message.from,
        to: message.to,
        value: value.toString(),
        validAfter: "0",
        validBefore: message.validBefore.toString(),
        nonce,
      },
      signature,
      precommitment,
    }),
  });

  const data = (await res.json()) as { swept?: boolean; depositTxHash?: string; error?: string };
  if (!res.ok || !data.swept) {
    return JSON.stringify({
      swept: false,
      error: data.error ?? `HTTP ${res.status}`,
      hint: "Your USDC is still at the funding address and the authorization has expired unused. Safe to retry.",
      fundingAddress: account.address,
    });
  }

  return JSON.stringify(
    {
      swept: true,
      amount: formatUnits(value, 6),
      depositTxHash: data.depositTxHash,
      noteIndex: index,
      note: "Deposited to the pool at a seed-derived note. Nothing to write down — `balance` rebuilds it from the seed.",
    },
    null,
    2,
  );
}

export { privateKeyToAccount };
