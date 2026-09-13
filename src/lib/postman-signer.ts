/**
 * postman-signer.ts — the single place the server signs POSTMAN transactions.
 *
 * WHY: the postman signs updateRoot (ASP root) + relay (withdrawals/settles) on
 * every deposit/settle. Historically each route inlined
 *   privateKeyToAccount(POSTMAN_PRIVATE_KEY) → createWalletClient → writeContract
 * (5 duplicated sites). This adapter centralizes that so we can swap the signer
 * backend in ONE place — specifically to move the postman to a CDP (Coinbase
 * Developer Platform) Smart Account with SPONSORED (gasless) gas.
 *
 * Backend selected by env `POSTMAN_SIGNER`:
 *   - "eoa" (DEFAULT): raw POSTMAN_PRIVATE_KEY + viem (identical to the prior
 *     inline behavior — zero change unless explicitly flipped).
 *   - "cdp": a CDP Smart Account (ERC-4337) sends the call via sendUserOperation
 *     with paymaster sponsorship. No ETH top-ups; key managed by CDP, not on the
 *     server as a raw key.
 *
 * Contract-side notes (verified against the vendored 0xbow Entrypoint):
 *   - updateRoot is onlyRole(_ASP_POSTMAN) → the CDP smart-account ADDRESS must
 *     hold ASP_POSTMAN (granted at deploy via ENTRYPOINT_POSTMAN, or later).
 *   - relay is PERMISSIONLESS (proof binds processooor==Entrypoint, not caller),
 *     so any sender — including a CDP smart account — can relay.
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  type Chain,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeNetwork } from "./contracts";

export type PostmanSignerKind = "eoa" | "cdp";

/**
 * AUDIT HIGH (2026-07-09): a mined-but-REVERTED tx has receipt.status
 * "reverted" (viem returns only "success" | "reverted"). Treating it as
 * confirmed strands funds and suppresses retries across the postman money path
 * (forwarding deposit, withdraw relay, settle). Extracted as a pure, tested
 * invariant: anything that is not exactly "success" throws.
 */
export function assertReceiptSucceeded(status: string, txHash: string): void {
  if (status !== "success") {
    throw new Error(`Postman tx reverted on-chain (status=${status}): ${txHash}`);
  }
}

export function postmanSignerKind(): PostmanSignerKind {
  const raw = String(process.env.POSTMAN_SIGNER ?? "eoa").trim().toLowerCase();
  if (raw === "" || raw === "eoa") return "eoa";
  if (raw === "cdp") return "cdp";
  throw new Error(`POSTMAN_SIGNER must be "eoa" or "cdp"; got "${process.env.POSTMAN_SIGNER}"`);
}

function mainnetEoaOverrideEnabled(): boolean {
  return String(process.env.ZBASE_ALLOW_MAINNET_EOA_POSTMAN ?? "false").toLowerCase() === "true";
}

export function postmanSignerConfigIssues(): string[] {
  let kind: PostmanSignerKind;
  try {
    kind = postmanSignerKind();
  } catch (error) {
    return [(error as Error).message];
  }

  const issues: string[] = [];
  if (kind === "eoa") {
    if (!process.env.POSTMAN_PRIVATE_KEY) {
      issues.push("POSTMAN_PRIVATE_KEY is required when POSTMAN_SIGNER=eoa");
    }
    if (activeNetwork() === "mainnet" && !mainnetEoaOverrideEnabled()) {
      issues.push(
        "POSTMAN_SIGNER=eoa is blocked on mainnet; use POSTMAN_SIGNER=cdp, or set ZBASE_ALLOW_MAINNET_EOA_POSTMAN=true for an emergency override",
      );
    }
    return issues;
  }

  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET || !process.env.CDP_WALLET_SECRET) {
    issues.push("POSTMAN_SIGNER=cdp requires CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET");
  }
  if (activeNetwork() === "mainnet" && !process.env.CDP_POSTMAN_SMART_ACCOUNT) {
    issues.push("mainnet CDP mode requires explicit CDP_POSTMAN_SMART_ACCOUNT");
  }
  return issues;
}

export function assertPostmanSignerLaunchReady(): void {
  const issues = postmanSignerConfigIssues();
  if (issues.length > 0) throw new Error(issues.join("; "));
}

export interface SendPostmanTxArgs {
  /** Target contract (Entrypoint or pool). */
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** Gas hint (EOA path). CDP estimates its own; ignored in the CDP branch. */
  gas?: bigint;
  /** Chain + write RPC (from getActiveChain()). */
  chain: Chain;
  writeRpcUrl: string;
  /** If true, the caller wants the receipt waited on before returning (default true). */
  waitForReceipt?: boolean;
  /** Read RPC for receipt waiting (EOA path); defaults to writeRpcUrl. */
  readRpcUrl?: string;
}

/**
 * Sign + send a postman transaction. Returns the on-chain tx hash.
 * Backend is chosen by POSTMAN_SIGNER (eoa default / cdp).
 */
export async function sendPostmanTx(a: SendPostmanTxArgs): Promise<`0x${string}`> {
  assertPostmanSignerLaunchReady();
  return postmanSignerKind() === "cdp" ? sendViaCdp(a) : sendViaEoa(a);
}

/** One call in a postman batch. Same shape sendPostmanTx takes, minus the shared ctx. */
export interface PostmanCall {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** EOA-path per-call gas hint; ignored by CDP (it estimates the whole userOp). */
  gas?: bigint;
}

/**
 * Send several postman calls as ONE atomic unit. Returns the final tx hash.
 *
 * WHY THIS EXISTS — the cross-userOp state race. The forwarding sweep must
 * receiveWithAuthorization → (approve) → deposit. Sending each as its own CDP
 * userOperation looks fine (every waitForUserOperation returned "complete") but
 * ISN'T: CDP gas-estimates each userOp by simulating it against a bundler node that
 * lags the just-mined previous userOp. So `deposit`, prepared right after `approve`,
 * simulated against a still-zero allowance and reverted at ESTIMATION time
 * ("transfer amount exceeds allowance") — and the USDC the receive had already
 * pulled sat stranded in the postman. The same lag stranded an earlier build that
 * measured a post-tx balance which read 0.
 *
 * A single userOp carries all calls in one EVM transaction, so estimation simulates
 * them IN SEQUENCE: the deposit's simulation sees the approve's allowance and the
 * receive's balance. And because it is one transaction, any revert rolls back every
 * call — funds can never strand between steps. This is the fix.
 *
 * CDP: one sendUserOperation with N calls (native ERC-4337 batching, sponsored).
 * EOA: no native batch, so calls run sequentially, each awaited to a SUCCESSFUL
 * receipt before the next (same RPC → state is reflected, no lag). This path is NOT
 * atomic — a mid-batch revert leaves earlier calls mined. EOA is normally testnet
 * only, but ZBASE_ALLOW_MAINNET_EOA_POSTMAN is an emergency override that lets it run
 * on mainnet, so "mainnet forces CDP" is not absolute. A MULTI-call batch there could
 * consume the receiveWithAuthorization and then fail the deposit, stranding the user's
 * USDC in the postman — exactly what atomicity is supposed to prevent. So a multi-call
 * batch on the EOA backend is REFUSED on mainnet (fail closed): the sweep needs atomic
 * submission and only CDP provides it. Single-call postman txs (relay/settle/updateRoot)
 * are unaffected on either backend.
 */
export async function sendPostmanBatch(
  calls: PostmanCall[],
  ctx: { chain: Chain; writeRpcUrl: string; readRpcUrl?: string },
): Promise<`0x${string}`> {
  assertPostmanSignerLaunchReady();
  if (calls.length === 0) throw new Error("sendPostmanBatch: no calls to send.");
  return postmanSignerKind() === "cdp"
    ? sendBatchViaCdp(calls, ctx)
    : sendBatchViaEoa(calls, ctx);
}

async function sendBatchViaEoa(
  calls: PostmanCall[],
  ctx: { chain: Chain; writeRpcUrl: string; readRpcUrl?: string },
): Promise<`0x${string}`> {
  // Fail closed: a multi-call batch on the non-atomic EOA path can strand funds on a
  // mid-batch revert. Blocked on mainnet even under ZBASE_ALLOW_MAINNET_EOA_POSTMAN —
  // the sweep must go through CDP, which submits all calls in one atomic userOp.
  if (calls.length > 1 && activeNetwork() === "mainnet") {
    throw new Error(
      "sendPostmanBatch: atomic multi-call batch is unavailable on the EOA postman backend " +
        "(sequential txs can strand funds on a mid-batch revert). Mainnet requires POSTMAN_SIGNER=cdp " +
        "for the forwarding sweep; the ZBASE_ALLOW_MAINNET_EOA_POSTMAN override does not extend to it.",
    );
  }
  let last: `0x${string}` | undefined;
  for (const c of calls) {
    last = await sendViaEoa({
      address: c.address,
      abi: c.abi,
      functionName: c.functionName,
      args: c.args,
      gas: c.gas,
      chain: ctx.chain,
      writeRpcUrl: ctx.writeRpcUrl,
      readRpcUrl: ctx.readRpcUrl,
      waitForReceipt: true,
    });
  }
  return last as `0x${string}`;
}

/**
 * The postman's own address — the account that will `msg.sender` every postman tx.
 *
 * Needed by the sweep: EIP-3009 `receiveWithAuthorization` binds `to` into the signed
 * message and requires `msg.sender == to`, so the client must know this address
 * BEFORE it signs. That is also why it is safe to publish: it is the destination of a
 * transfer the user is explicitly authorising.
 *
 * Async because the CDP branch resolves the smart account through an SDK round-trip
 * — there is no synchronous way to learn it.
 *
 * PRIVACY: this is a permanent correlation anchor. Every sweep, for every user, names
 * the SAME `to`. Anyone watching USDC can enumerate "addresses that funded zBase".
 * That is inherent to routing deposits through one relayer, not a leak introduced
 * here — but it is real, and it is why the sweep hop is a linkability cost the pool
 * then has to undo.
 */
export async function getPostmanAddress(chain: Chain): Promise<`0x${string}`> {
  assertPostmanSignerLaunchReady();
  if (postmanSignerKind() !== "cdp") {
    const postmanKey = process.env.POSTMAN_PRIVATE_KEY;
    if (!postmanKey) throw new Error("Missing POSTMAN_PRIVATE_KEY (POSTMAN_SIGNER=eoa)");
    return privateKeyToAccount(`0x${postmanKey.replace(/^0x/i, "")}` as Hex).address;
  }
  return (await resolveCdpSmartAccount(chain)).address as `0x${string}`;
}

// ── EOA backend (default) — the prior inline behavior, lifted verbatim ────────
async function sendViaEoa(a: SendPostmanTxArgs): Promise<`0x${string}`> {
  const postmanKey = process.env.POSTMAN_PRIVATE_KEY;
  if (!postmanKey) throw new Error("Missing POSTMAN_PRIVATE_KEY (POSTMAN_SIGNER=eoa)");
  const normalizedKey = postmanKey.replace(/^0x/i, "");
  const account = privateKeyToAccount(`0x${normalizedKey}` as Hex);
  const walletClient = createWalletClient({
    account,
    chain: a.chain,
    transport: http(a.writeRpcUrl),
  });
  const txHash = await walletClient.writeContract({
    address: a.address,
    abi: a.abi,
    functionName: a.functionName,
    args: a.args as unknown[],
    ...(a.gas !== undefined ? { gas: a.gas } : {}),
  });
  if (a.waitForReceipt !== false) {
    const pub = createPublicClient({
      chain: a.chain,
      transport: http(a.readRpcUrl ?? a.writeRpcUrl),
    });
    // AUDIT HIGH (2026-07-09): a REVERTED tx still mines, and
    // waitForTransactionReceipt resolves for it. Without this status check the
    // caller (forwarding deposit, withdraw relay, settle) would treat a
    // reverted on-chain tx as CONFIRMED — marking work done, suppressing the
    // retry, and stranding funds. The CDP path already checks; the decoy
    // scheduler already checks; this shared EOA path did not. Fail loud.
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    assertReceiptSucceeded(receipt.status, txHash);
  }
  return txHash;
}

// ── CDP backend — sponsored (gasless) via a Smart Account (ERC-4337) ──────────
// Lazy-imports @coinbase/cdp-sdk so the EOA path never loads it. Encodes calldata
// with viem, sends via the smart account's sendUserOperation with paymaster
// sponsorship, returns the resulting on-chain tx hash.
/** CDP network id for a chain. Gas is auto-sponsored on both via CDP Paymaster. */
function cdpNetworkFor(chain: Chain): "base" | "base-sepolia" {
  if (chain.id === 8453) return "base";
  if (chain.id === 84532) return "base-sepolia";
  throw new Error(
    `CDP postman only supports Base (8453) / Base Sepolia (84532); got chainId ${chain.id}`,
  );
}

/**
 * Resolve the CDP-managed smart account. ONE place that knows the account names.
 *
 * Extracted because sendViaCdp and getPostmanAddress must resolve the SAME account —
 * if they ever disagree, the sweep would sign an authorization naming address X while
 * the tx is sent from Y, and `receiveWithAuthorization` (which requires
 * msg.sender == to) would revert every time. scripts/print-cdp-postman.ts re-derives
 * these names independently and agrees only by copy-paste; that is the drift this
 * avoids.
 */
async function resolveCdpSmartAccount(chain: Chain) {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new Error(
      "POSTMAN_SIGNER=cdp requires CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET",
    );
  }
  cdpNetworkFor(chain); // fail fast on an unsupported chain

  const ownerName = process.env.CDP_POSTMAN_OWNER ?? "zbase-postman-owner";
  const smartName = process.env.CDP_POSTMAN_SMART_ACCOUNT ?? "zbase-postman";

  // Lazy import so the EOA default never pulls the CDP SDK in.
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const cdp = new CdpClient();

  // A smart account needs an owner EOA (CDP-managed); both resolved by name.
  const owner = await cdp.evm.getOrCreateAccount({ name: ownerName });
  return cdp.evm.getOrCreateSmartAccount({ name: smartName, owner });
}

async function sendViaCdp(a: SendPostmanTxArgs): Promise<`0x${string}`> {
  // A single-call batch — one code path for one-or-many so CDP submission logic
  // (encode → sendUserOperation → wait → status check) lives in exactly one place.
  return sendBatchViaCdp(
    [{ address: a.address, abi: a.abi, functionName: a.functionName, args: a.args }],
    { chain: a.chain, writeRpcUrl: a.writeRpcUrl, readRpcUrl: a.readRpcUrl },
  );
}

/**
 * Encode a batch into the CDP `calls[]` shape, PRESERVING ORDER (a later call must be
 * able to see an earlier call's state — approve before the deposit that spends it,
 * receive before the deposit that pulls it). Pure and exported so the ordering
 * invariant is directly unit-testable without a CDP round-trip.
 */
export function encodeBatchCalls(
  calls: PostmanCall[],
): Array<{ to: `0x${string}`; data: `0x${string}`; value: bigint }> {
  return calls.map((c) => ({
    to: c.address,
    data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args as unknown[] }),
    value: 0n,
  }));
}

async function sendBatchViaCdp(
  calls: PostmanCall[],
  ctx: { chain: Chain; writeRpcUrl: string; readRpcUrl?: string },
): Promise<`0x${string}`> {
  const network = cdpNetworkFor(ctx.chain);
  const smartAccount = await resolveCdpSmartAccount(ctx.chain);

  // All calls in ONE userOperation → one EVM tx. Encoded in order; the bundler
  // simulates them in sequence, so a later call sees earlier calls' state.
  const encoded = encodeBatchCalls(calls);

  // Gas is auto-sponsored on Base / Base Sepolia by CDP's Paymaster.
  const userOp = await smartAccount.sendUserOperation({ network, calls: encoded });
  const receipt = await smartAccount.waitForUserOperation(userOp);

  if (receipt.status !== "complete" || !receipt.transactionHash) {
    throw new Error(`CDP userOperation did not complete: status=${receipt.status}`);
  }
  return receipt.transactionHash as `0x${string}`;
}
