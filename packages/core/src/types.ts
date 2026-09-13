/**
 * @zbase-protocol/core — Chain-agnostic types for ZK privacy payments
 */

// --- Account & Secrets ---

export interface AccountSecrets {
  nullifier: string;
  secret: string;
  commitment: string;
  value: string;
  label: string;
}

export interface ZX402AccountData {
  secrets: AccountSecrets;
  depositTxHash?: string;
  chain: ChainType;
  withdrawn: boolean;
  createdAt: number;
}

export type ChainType = "evm" | "svm";

// --- Pool Interface (chain-specific implementations) ---

export interface DepositResult {
  txHash: string;
  commitment: string;
  label: string;
  value: string;
  secrets: AccountSecrets;
  chain: ChainType;
}

export interface WithdrawResult {
  txHash: string;
  recipient: string;
  amount: string;
  remainingValue?: string;
  nextDeposit?: AccountSecrets;
  proofTimeMs: number;
  chain: ChainType;
}

export interface PayResult extends WithdrawResult {
  provider: string;
}

export interface PoolStats {
  depositsCount: number;
  totalCommittedValue: string;
  yieldEarned: string;
  anonymitySetSize: number;
  chain: ChainType;
}

export interface ZX402Pool {
  readonly chain: ChainType;

  /** Deposit tokens into the privacy pool */
  deposit(amount: string): Promise<DepositResult>;

  /** Withdraw from pool to recipient via ZK proof */
  withdraw(secrets: AccountSecrets, recipient: string, amountAtomic?: string): Promise<WithdrawResult>;

  /** Pay a provider privately via ZK proof */
  pay(secrets: AccountSecrets, provider: string, amount?: string): Promise<PayResult>;

  /** Get pool statistics */
  getPoolStats(): Promise<PoolStats>;
}

// --- Facilitator Interface (chain-specific implementations) ---

export interface VerifyRequest {
  paymentDetails: {
    scheme: string;
    payTo: string;
    maxAmountRequired: string;
    networkId: string;
  };
  deposit: AccountSecrets;
  agentId?: string;
}

export interface VerifyResponse {
  valid: boolean;
  reason?: string;
  anonymitySetSize?: number;
  agent?: AgentInfo;
}

export interface SettleRequest {
  paymentDetails: {
    payTo: string;
    maxAmountRequired?: string;
    tokenMint?: string;
  };
  deposit: AccountSecrets;
  agentId?: string;
}

export interface SettleResponse {
  settled: boolean;
  txHash?: string;
  network: string;
  amount?: string;
  remainingValue?: string;
  nextDeposit?: AccountSecrets;
  proofTimeMs?: number;
  agent?: AgentInfo;
}

export interface ZX402Facilitator {
  readonly chain: ChainType;

  /** Verify a payment can be settled */
  verify(request: VerifyRequest): Promise<VerifyResponse>;

  /** Generate ZK proof and settle payment */
  settle(request: SettleRequest): Promise<SettleResponse>;

  /** Get supported capabilities */
  getSupported(): SupportedCapabilities;
}

// --- Agent Identity ---

export interface AgentPermissions {
  maxSpendPerTx: string;
  maxSpendPerDay: string;
  allowedProviders: string[];
  allowedCategories: string[];
}

export interface AgentInfo {
  id: string;
  name: string;
  owner: string;
  publicKey?: string;
  hotKey?: string;   // For Solana hotkey/coldkey pattern
  coldKey?: string;
  permissions: AgentPermissions;
  totalSpent: string;
  dailySpent: string;
  txCount: number;
  registeredAt: number;
}

export interface RegisterAgentRequest {
  name: string;
  owner: string;
  publicKey?: string;
  hotKey?: string;
  coldKey?: string;
  permissions?: Partial<AgentPermissions>;
}

// --- Privacy Scanner ---

export interface ExposureReport {
  address: string;
  totalTransfers: number;
  x402PaymentsDetected: number;
  servicesExposed: string[];
  totalSpendVisible: string;
  riskScore: number;
  riskLevel: "HIGH" | "MEDIUM" | "LOW";
  providerBreakdown: Array<{
    provider: string;
    payments: number;
    totalAmount: string;
  }>;
  recommendations: string[];
  chain: ChainType;
}

// --- Supported Capabilities ---

export interface SupportedCapabilities {
  facilitator: string;
  version: string;
  chain: ChainType;
  networks: string[];
  /**
   * `false` while the cryptographic core (Poseidon, Merkle, on-chain Groth16,
   * ASP enforcement, recipient binding) is not yet implemented for this chain.
   * Consumers MUST treat `privacy` and `compliance` as advisory until this is
   * `true`. See STATUS.md for the per-chain status matrix.
   */
  ready: boolean;
  privacy: {
    method: string;
    compliance: string;
    /** True only when on-chain proof verification is live. */
    enforced: boolean;
  };
  yield: {
    enabled: boolean;
    protocol: string;
    estimatedAPY: string;
  };
  agentRegistry: boolean;
  encryptedMessaging: boolean;
  bulkRelay: boolean;
  /** Human-readable note describing any non-ready capabilities. */
  disclosure?: string;
}
