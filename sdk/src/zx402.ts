import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  encodeAbiParameters,
  keccak256,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { poseidon2, poseidon3 } from "poseidon-lite";
import { LeanIMT } from "@zk-kit/lean-imt";

import { ZX402Account } from "./account.js";
import type {
  ZX402Config,
  DepositResult,
  WithdrawalResult,
  PaymentResult,
} from "./types.js";
import { BASE_SEPOLIA_DEFAULTS } from "./types.js";

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_BLOCK_RANGE = 9999n;

const DEPOSIT_ERC20_ABI = [{
  name: "deposit", type: "function", stateMutability: "nonpayable",
  inputs: [
    { name: "_asset", type: "address" },
    { name: "_value", type: "uint256" },
    { name: "_precommitment", type: "uint256" },
  ],
  outputs: [{ name: "_commitment", type: "uint256" }],
}] as const;

const USDC_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const POOL_ABI = [
  { name: "SCOPE", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "currentRoot", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "currentTreeSize", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "getYieldEarned", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "totalCommitted", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const ENTRYPOINT_ABI = [
  { name: "latestRoot", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    name: "updateRoot", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "_root", type: "uint256" }, { name: "_ipfsCID", type: "string" }],
    outputs: [{ name: "_index", type: "uint256" }],
  },
  {
    name: "relay", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "_withdrawal", type: "tuple", components: [{ name: "processooor", type: "address" }, { name: "data", type: "bytes" }] },
      { name: "_proof", type: "tuple", components: [
        { name: "pA", type: "uint256[2]" }, { name: "pB", type: "uint256[2][2]" },
        { name: "pC", type: "uint256[2]" }, { name: "pubSignals", type: "uint256[8]" },
      ]},
      { name: "_scope", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const DEPOSITED_EVENT = {
  type: "event" as const, name: "Deposited" as const,
  inputs: [
    { name: "_depositor", type: "address" as const, indexed: true as const },
    { name: "_commitment", type: "uint256" as const, indexed: false as const },
    { name: "_label", type: "uint256" as const, indexed: false as const },
    { name: "_value", type: "uint256" as const, indexed: false as const },
    { name: "_precommitmentHash", type: "uint256" as const, indexed: false as const },
  ],
};

const LEAF_INSERTED_EVENT = {
  type: "event" as const, name: "LeafInserted" as const,
  inputs: [
    { name: "_index", type: "uint256" as const, indexed: false as const },
    { name: "_leaf", type: "uint256" as const, indexed: false as const },
    { name: "_root", type: "uint256" as const, indexed: false as const },
  ],
};

/**
 * zBase SDK — Add privacy to any dApp on Base.
 *
 * Three operations:
 * - deposit(): Move funds from public wallet → private pool
 * - withdraw(): Move funds from private pool → any address (ZK proof)
 * - pay(): Private payment to a service provider (ZK proof)
 *
 * All operations use Groth16 ZK proofs verified on-chain.
 * Legacy note: the active zBase pool is plain USDC with no Morpho/yield leg.
 *
 * @example
 * ```ts
 * const zbase = new ZX402({ rpcUrl, privateKey: "0x..." });
 * const account = zbase.createAccount();
 * await zbase.deposit(account, "10.0");
 * await zbase.pay(account, "0xAgent...", "1.0");
 * ```
 */
export class ZX402 {
  private publicClient;
  private walletClient;
  private config: Required<ZX402Config>;
  private deployBlock: bigint;

  constructor(config: Partial<ZX402Config> & { rpcUrl: string }) {
    this.config = {
      rpcUrl: config.rpcUrl,
      entrypoint: config.entrypoint ?? BASE_SEPOLIA_DEFAULTS.entrypoint,
      pool: config.pool ?? BASE_SEPOLIA_DEFAULTS.pool,
      usdc: config.usdc ?? BASE_SEPOLIA_DEFAULTS.usdc,
      privateKey: config.privateKey ?? ("0x" as Hex),
      chainId: config.chainId ?? BASE_SEPOLIA_DEFAULTS.chainId,
      circuitsUrl: config.circuitsUrl ?? "",
    };

    this.publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(this.config.rpcUrl),
    });

    if (this.config.privateKey && this.config.privateKey !== "0x") {
      const account = privateKeyToAccount(this.config.privateKey);
      this.walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(this.config.rpcUrl),
      });
    }

    // Estimate deploy block (current - 50000 to be safe)
    this.deployBlock = 40627700n;
  }

  /** Create a new private account with fresh cryptographic secrets */
  createAccount(): ZX402Account {
    return new ZX402Account();
  }

  /** Restore an account from saved secrets */
  restoreAccount(json: string): ZX402Account {
    return ZX402Account.deserialize(json);
  }

  /**
   * Deposit USDC into the privacy pool.
   * After this, your funds are shielded in the plain USDC privacy pool.
   *
   * @param account - The private account (holds your secrets)
   * @param amount - USDC amount as string (e.g., "10.0")
   * @returns Deposit result with tx hash and updated secrets
   */
  async deposit(account: ZX402Account, amount: string): Promise<DepositResult> {
    if (!this.walletClient) throw new Error("Private key required for deposit");

    const amountRaw = parseUnits(amount, 6);
    const sender = this.walletClient.account!.address;

    // Check and approve USDC
    const allowance = await this.publicClient.readContract({
      address: this.config.usdc, abi: USDC_ABI, functionName: "allowance",
      args: [sender, this.config.entrypoint],
    });

    if (allowance < amountRaw) {
      const approveTx = await this.walletClient.writeContract({
        address: this.config.usdc, abi: USDC_ABI, functionName: "approve",
        args: [this.config.entrypoint, 2n ** 256n - 1n],
      });
      await this.publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    // Deposit
    const depositTx = await this.walletClient.writeContract({
      address: this.config.entrypoint,
      abi: DEPOSIT_ERC20_ABI,
      functionName: "deposit",
      args: [this.config.usdc, amountRaw, account.precommitment],
      gas: 500_000n,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: depositTx });

    // Parse Deposited event
    const DEPOSITED_TOPIC = "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === this.config.pool.toLowerCase()
          && log.topics[0] === DEPOSITED_TOPIC) {
        const data = log.data as string;
        account.commitment = BigInt("0x" + data.slice(2, 66));
        account.label = BigInt("0x" + data.slice(66, 130));
        account.value = BigInt("0x" + data.slice(130, 194));
        account.deposited = true;
        break;
      }
    }

    // Auto-update ASP root
    await this.updateASPRoot();

    return {
      txHash: depositTx,
      commitment: account.commitment.toString(),
      label: account.label.toString(),
      value: account.value.toString(),
      secrets: account.toSecrets(),
    };
  }

  /**
   * Withdraw funds privately from the pool.
   * Generates a ZK proof and sends USDC to any address.
   * Nobody can link the withdrawal to your deposit.
   *
   * @param account - The private account with deposit secrets
   * @param recipient - Where to send the USDC
   * @returns Withdrawal result with tx hash and proof time
   */
  async withdraw(account: ZX402Account, recipient: Address, amountAtomic?: string): Promise<WithdrawalResult> {
    if (!this.walletClient) throw new Error("Private key required for withdrawal");
    if (!account.deposited) throw new Error("Account has no deposit");
    if (account.withdrawn) throw new Error("Account already withdrawn");

    const startTime = Date.now();

    // Build trees
    const { stateTree, aspTree, stateLeaves, aspLabels } = await this.buildTrees();

    // Ensure ASP root is current
    await this.ensureASPRoot(aspLabels);

    // Get on-chain state
    const scope = await this.publicClient.readContract({
      address: this.config.pool, abi: POOL_ABI, functionName: "SCOPE",
    }) as bigint;

    const aspRoot = await this.publicClient.readContract({
      address: this.config.entrypoint, abi: ENTRYPOINT_ABI, functionName: "latestRoot",
    }) as bigint;

    // Generate Merkle proofs
    const stateIdx = stateTree.indexOf(account.commitment);
    if (stateIdx === -1) throw new Error("Commitment not found in state tree");
    const stateProof = stateTree.generateProof(stateIdx);

    const aspIdx = aspTree.indexOf(account.label);
    if (aspIdx === -1) throw new Error("Label not found in ASP tree");
    const aspProof = aspTree.generateProof(aspIdx);

    const padSiblings = (s: bigint[]) => [...s, ...Array(32 - s.length).fill(0n)];

    // Build withdrawal struct
    const relayData = encodeAbiParameters(
      [{ type: "tuple", components: [{ name: "recipient", type: "address" }, { name: "feeRecipient", type: "address" }, { name: "relayFeeBPS", type: "uint256" }] }],
      [{ recipient, feeRecipient: recipient, relayFeeBPS: 0n }]
    );

    const withdrawal = { processooor: this.config.entrypoint, data: relayData };

    const context = BigInt(keccak256(
      encodeAbiParameters(
        [{ type: "tuple", components: [{ name: "processooor", type: "address" }, { name: "data", type: "bytes" }] }, { name: "scope", type: "uint256" }],
        [withdrawal, scope]
      )
    )) % SNARK_FIELD;

    const existingValue = account.value;
    const withdrawnValue = amountAtomic ? BigInt(amountAtomic) : existingValue;
    if (withdrawnValue <= 0n) throw new Error("Withdrawal amount must be > 0");
    if (withdrawnValue > existingValue) throw new Error("Withdrawal amount exceeds account value");
    const remainingValue = existingValue - withdrawnValue;

    // New secrets for change commitment
    const newNullifier = this.randomField();
    const newSecret = this.randomField();
    const newPrecommitment = poseidon2([newNullifier, newSecret]);
    const expectedNewCommitment = poseidon3([remainingValue, account.label, newPrecommitment]);

    // Generate ZK proof
    const snarkjs = await import("snarkjs");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      {
        withdrawnValue,
        stateRoot: stateTree.root,
        stateTreeDepth: BigInt(stateTree.depth),
        ASPRoot: aspRoot,
        ASPTreeDepth: BigInt(aspTree.depth),
        context,
        label: account.label,
        existingValue,
        existingNullifier: account.nullifier,
        existingSecret: account.secret,
        newNullifier,
        newSecret,
        stateSiblings: padSiblings(stateProof.siblings),
        stateIndex: BigInt(stateProof.index),
        ASPSiblings: padSiblings(aspProof.siblings),
        ASPIndex: BigInt(aspProof.index),
      } as unknown as Record<string, unknown>,
      this.config.circuitsUrl + "/circuits/withdraw/withdraw.wasm",
      this.config.circuitsUrl + "/circuits/withdraw/groth16_pkey.zkey"
    );

    const proofTimeMs = Date.now() - startTime;
    if (BigInt(publicSignals[0]) !== expectedNewCommitment) {
      throw new Error("Proof new commitment mismatch");
    }

    // Format proof
    const p = proof as { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    const formattedProof = {
      pA: [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])],
      pB: [[BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])], [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])]],
      pC: [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])],
      pubSignals: publicSignals.map((s: string) => BigInt(s)),
    };

    // Submit relay tx
    const txHash = await this.walletClient.writeContract({
      address: this.config.entrypoint,
      abi: ENTRYPOINT_ABI,
      functionName: "relay",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: [withdrawal, formattedProof, scope] as any,
      gas: 600_000n,
    });

    const txReceipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (txReceipt.status === "reverted") throw new Error("Withdrawal tx reverted");

    account.withdrawn = true;

    return {
      txHash,
      recipient,
      amount: withdrawnValue.toString(),
      remainingValue: remainingValue.toString(),
      ...(remainingValue > 0n
        ? {
            nextDeposit: {
              nullifier: newNullifier.toString(),
              secret: newSecret.toString(),
              precommitment: newPrecommitment.toString(),
              label: account.label.toString(),
              commitment: expectedNewCommitment.toString(),
              value: remainingValue.toString(),
            },
          }
        : {}),
      proofTimeMs,
      yieldBonus: "0", // TODO: parse from event
    };
  }

  /**
   * Private payment to a service provider.
   * Same as withdraw() but framed as a payment.
   * The provider gets USDC. Nobody knows who paid.
   *
   * @param account - The private account with deposit secrets
   * @param provider - Service provider's address (e.g., AI agent)
   * @param amount - Payment amount in USDC decimal units; omitted means full note
   * @returns Payment result with tx hash
   */
  async pay(account: ZX402Account, provider: Address, amount?: string): Promise<PaymentResult> {
    const amountAtomic = amount ? parseUnits(amount, 6).toString() : undefined;
    const result = await this.withdraw(account, provider, amountAtomic);
    return {
      txHash: result.txHash,
      provider,
      amount: result.amount,
      remainingValue: result.remainingValue,
      nextDeposit: result.nextDeposit,
      proofTimeMs: result.proofTimeMs,
      privacy: {
        method: "Groth16 ZK-SNARK",
        linkable: false,
      },
    };
  }

  /**
   * Wrap fetch() with automatic private x402 payment handling.
   *
   * Returns a fetch-like function that intercepts 402 Payment Required
   * responses, generates a ZK proof, pays the provider privately,
   * and retries the request — all automatically.
   *
   * This is the killer DX feature. One line to make any API call private.
   *
   * @param account - Pre-funded private account
   * @returns A fetch function that handles x402 payments privately
   *
   * @example
   * ```ts
   * const privateFetch = zbase.wrapFetch(account);
   *
   * // This call hits a paid API. zBase handles payment privately.
   * const data = await privateFetch("https://api.stableenrich.com/people?name=John");
   * // Agent got the data. Payment came from privacy pool. Nobody knows who asked.
   * ```
   */
  wrapFetch(account: ZX402Account): typeof fetch {
    const self = this;

    return async function privateFetch(
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> {
      // Step 1: Make the original request
      const response = await fetch(input, init);

      // Step 2: If not 402, return as-is
      if (response.status !== 402) {
        return response;
      }

      // Step 3: Parse the 402 payment requirements
      const paymentRequired = await response.json().catch(() => null);
      if (!paymentRequired) {
        throw new Error("402 response but no payment details found");
      }

      // Extract provider address from the 402 response
      // x402 puts payment details in the response body or headers
      const provider = (
        paymentRequired.payTo ||
        paymentRequired.recipient ||
        paymentRequired.address ||
        response.headers.get("x-payment-address")
      ) as Address;

      if (!provider) {
        throw new Error("402 response missing payment address");
      }

      console.log(`[zBase] 402 Payment Required: ${provider}`);
      console.log(`[zBase] Paying privately via ZK proof...`);

      // Step 4: Pay privately via ZK proof
      const payment = await self.pay(account, provider);

      console.log(`[zBase] Private payment complete: ${payment.txHash}`);
      console.log(`[zBase] Proof generated in ${payment.proofTimeMs}ms`);

      // Step 5: Retry the original request with payment proof
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set("X-Payment-Tx", payment.txHash);
      retryHeaders.set("X-Payment-Method", "zbase-private");
      retryHeaders.set("X-Payment-Proof", "groth16");

      const retryResponse = await fetch(input, {
        ...init,
        headers: retryHeaders,
      });

      return retryResponse;
    };
  }

  /**
   * Pay for an x402 API call privately.
   *
   * Convenience method for agents that already have the 402 response parsed.
   * Generates ZK proof, pays provider, returns the payment receipt.
   *
   * @param account - Pre-funded private account
   * @param url - The API endpoint URL
   * @param provider - Provider's payment address (from 402 response)
   * @returns Payment receipt + service response
   *
   * @example
   * ```ts
   * const result = await zbase.payAPI(account, "https://api.example.com/data", "0xProvider...");
   * console.log(result.payment.txHash); // Private payment tx
   * console.log(result.serviceResponse); // The API data
   * ```
   */
  async payAPI(
    account: ZX402Account,
    url: string,
    provider: Address
  ): Promise<{ payment: PaymentResult; serviceResponse: unknown }> {
    // Pay privately
    const payment = await this.pay(account, provider);

    // Fetch the service with payment proof
    let serviceResponse: unknown = null;
    try {
      const res = await fetch(url, {
        headers: {
          "X-Payment-Tx": payment.txHash,
          "X-Payment-Method": "zbase-private",
        },
      });
      if (res.ok) {
        const ct = res.headers.get("content-type") || "";
        serviceResponse = ct.includes("json") ? await res.json() : await res.text();
      }
    } catch {
      // Service fetch failed but payment succeeded
    }

    return { payment, serviceResponse };
  }

  /** Get pool stats */
  // ═══ AGENT IDENTITY + PERMISSIONS ═══

  /**
   * Register an AI agent with identity and permissions.
   * Solves a16z's "prove who it represents + what it's allowed to do"
   */
  async registerAgent(opts: {
    name: string;
    owner: string;
    permissions?: {
      maxSpendPerTx?: string;
      maxSpendPerDay?: string;
      allowedCategories?: string[];
      allowedProviders?: string[];
    };
    apiUrl?: string;
  }) {
    const baseUrl = opts.apiUrl || "http://localhost:3009";
    const res = await fetch(`${baseUrl}/api/agent/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: opts.name,
        owner: opts.owner,
        permissions: opts.permissions || {
          maxSpendPerTx: "1000000",
          maxSpendPerDay: "10000000",
          allowedCategories: ["all"],
        },
      }),
    });
    return res.json();
  }

  /**
   * List all registered agents
   */
  async listAgents(apiUrl = "http://localhost:3009") {
    const res = await fetch(`${apiUrl}/api/agent/register`);
    return res.json();
  }

  /**
   * Pay with agent identity -- includes permission checks and spend tracking
   */
  async payAsAgent(
    account: ZX402Account,
    provider: Address,
    agentId: string,
    apiUrl = "http://localhost:3009"
  ): Promise<PaymentResult> {
    const secrets = account.toSecrets();

    // Verify with agent permissions
    const verifyRes = await fetch(`${apiUrl}/api/facilitator/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentDetails: {
          scheme: "exact",
          payTo: provider,
          maxAmountRequired: secrets.value,
          networkId: "eip155:84532",
        },
        zbaseDeposit: secrets,
        agentId,
      }),
    });
    const verifyData = await verifyRes.json();
    if (!verifyData.valid) {
      throw new Error(`Agent verification failed: ${verifyData.reason}`);
    }

    // Settle with agent identity
    const settleRes = await fetch(`${apiUrl}/api/facilitator/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentDetails: { payTo: provider },
        zbaseDeposit: secrets,
        agentId,
      }),
    });
    const settleData = await settleRes.json();
    if (!settleData.settled) {
      throw new Error(`Settlement failed: ${settleData.error}`);
    }

    account.withdrawn = true;

    return {
      txHash: settleData.txHash,
      provider,
      amount: secrets.value,
      proofTimeMs: 0,
      privacy: {
        method: "Groth16 ZK-SNARK",
        linkable: false,
      },
    };
  }

  // ═══ POOL STATS ═══

  async getPoolStats() {
    const [treeSize, yieldEarned, totalCommitted] = await Promise.all([
      this.publicClient.readContract({ address: this.config.pool, abi: POOL_ABI, functionName: "currentTreeSize" }),
      this.publicClient.readContract({ address: this.config.pool, abi: POOL_ABI, functionName: "getYieldEarned" }).catch(() => 0n),
      this.publicClient.readContract({ address: this.config.pool, abi: POOL_ABI, functionName: "totalCommitted" }).catch(() => 0n),
    ]);
    return {
      deposits: Number(treeSize),
      yieldEarned: formatUnits(yieldEarned as bigint, 6),
      totalCommitted: formatUnits(totalCommitted as bigint, 6),
    };
  }

  // ═══ INTERNAL ═══

  private async buildTrees() {
    const currentBlock = await this.publicClient.getBlockNumber();

    // Fetch Deposited events (for labels/ASP tree)
    const depositLogs = await this.fetchLogs(DEPOSITED_EVENT, currentBlock);
    const aspLabels = depositLogs.map((l) => ((l as unknown as { args: { _label: bigint } }).args._label));

    // Fetch LeafInserted events (for state tree — includes withdrawal change commitments)
    const leafLogs = await this.fetchLogs(LEAF_INSERTED_EVENT, currentBlock);
    const stateLeaves = leafLogs.map((l) => ((l as unknown as { args: { _leaf: bigint } }).args._leaf));

    const stateTree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
    if (stateLeaves.length > 0) stateTree.insertMany(stateLeaves);

    const aspTree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
    if (aspLabels.length > 0) aspTree.insertMany(aspLabels);

    return { stateTree, aspTree, stateLeaves, aspLabels };
  }

  private async fetchLogs(event: typeof DEPOSITED_EVENT | typeof LEAF_INSERTED_EVENT, currentBlock: bigint) {
    const allLogs: unknown[] = [];
    for (let from = this.deployBlock; from <= currentBlock; from += MAX_BLOCK_RANGE) {
      const to = from + MAX_BLOCK_RANGE - 1n > currentBlock ? currentBlock : from + MAX_BLOCK_RANGE - 1n;
      const chunk = await this.publicClient.getLogs({
        address: this.config.pool, event, fromBlock: from, toBlock: to,
      });
      allLogs.push(...chunk);
      if (from + MAX_BLOCK_RANGE <= currentBlock) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    return allLogs;
  }

  private async updateASPRoot() {
    if (!this.walletClient) return;
    const currentBlock = await this.publicClient.getBlockNumber();
    const depositLogs = await this.fetchLogs(DEPOSITED_EVENT, currentBlock);
    const labels = depositLogs.map((l) => ((l as unknown as { args: { _label: bigint } }).args._label));
    if (labels.length === 0) return;

    const aspTree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
    aspTree.insertMany(labels);

    const onChainRoot = await this.publicClient.readContract({
      address: this.config.entrypoint, abi: ENTRYPOINT_ABI, functionName: "latestRoot",
    }) as bigint;

    if (aspTree.root !== onChainRoot) {
      const ipfsCID = `QmZbaseSDK${labels.length}d${Date.now()}padpadpadpadpad`;
      await this.walletClient.writeContract({
        address: this.config.entrypoint, abi: ENTRYPOINT_ABI, functionName: "updateRoot",
        args: [aspTree.root, ipfsCID], gas: 200_000n,
      });
    }
  }

  private async ensureASPRoot(labels: bigint[]) {
    if (!this.walletClient || labels.length === 0) return;
    const aspTree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
    aspTree.insertMany(labels);

    const onChainRoot = await this.publicClient.readContract({
      address: this.config.entrypoint, abi: ENTRYPOINT_ABI, functionName: "latestRoot",
    }) as bigint;

    if (aspTree.root !== onChainRoot) {
      const ipfsCID = `QmZbaseSDK${labels.length}d${Date.now()}padpadpadpadpad`;
      await this.walletClient.writeContract({
        address: this.config.entrypoint, abi: ENTRYPOINT_ABI, functionName: "updateRoot",
        args: [aspTree.root, ipfsCID], gas: 200_000n,
      });
    }
  }

  private randomField(): bigint {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let result = 0n;
    for (const byte of bytes) result = (result << 8n) + BigInt(byte);
    return result % SNARK_FIELD;
  }
}
