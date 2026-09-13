import type { Hex, Address } from "viem";

export interface ZX402Config {
  /** Base Sepolia or Base mainnet RPC URL */
  rpcUrl: string;
  /** Entrypoint contract address */
  entrypoint: Address;
  /** USDC Privacy Pool address */
  pool: Address;
  /** USDC token address */
  usdc?: Address;
  /** Private key for server-side operations (proof generation + relay) */
  privateKey?: Hex;
  /** Chain ID (84532 for Base Sepolia, 8453 for Base) */
  chainId?: number;
  /** Circuit artifacts URL base (for WASM + zkey files) */
  circuitsUrl?: string;
}

export interface AccountSecrets {
  nullifier: string;
  secret: string;
  precommitment: string;
  label: string;
  commitment: string;
  value: string;
}

export interface DepositResult {
  txHash: Hex;
  commitment: string;
  label: string;
  value: string;
  secrets: AccountSecrets;
}

export interface WithdrawalResult {
  txHash: Hex;
  recipient: Address;
  amount: string;
  remainingValue?: string;
  nextDeposit?: AccountSecrets;
  proofTimeMs: number;
  yieldBonus: string;
}

export interface PaymentResult {
  txHash: Hex;
  provider: Address;
  amount: string;
  remainingValue?: string;
  nextDeposit?: AccountSecrets;
  proofTimeMs: number;
  privacy: {
    method: string;
    linkable: boolean;
  };
}

/** Default contract addresses for Base Sepolia */
export const BASE_SEPOLIA_DEFAULTS = {
  entrypoint: "0x598ffaac79ae29b1aae571fd91899d4492183688" as Address,
  pool: "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a" as Address,
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
  chainId: 84532,
} as const;
