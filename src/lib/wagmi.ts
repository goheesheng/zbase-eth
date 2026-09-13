import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  coinbaseWallet,
  rainbowWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { base, baseSepolia, sepolia } from "wagmi/chains";
import { http, createConfig } from "wagmi";
import { getActiveStack } from "./contracts";

// Wagmi config — browser-extension wallets only (no WalletConnect).
//
// Switched from `getDefaultConfig` to explicit `createConfig` on 2026-06-03
// to drop the WalletConnect / Reown / cloud.reown.com dependency. The auto
// path uses a shared WalletConnect projectId whose allowlist doesn't include
// our origins, which caused a persistent "Origin http://localhost:3000 not
// found on Allowlist" console error on every page load.
//
// Tradeoff: visitors with mobile-only wallets (Trust Wallet, Rainbow mobile
// via QR scan) lose the ability to connect. Browser-extension users
// (MetaMask, Coinbase Wallet, Rainbow desktop, Phantom EVM, etc.) are
// unaffected via the `injected` connector. Our audience is dev/agent
// operators on desktop; this is the right cut.
const connectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [
        injectedWallet,
        metaMaskWallet,
        coinbaseWallet,
        rainbowWallet,
      ],
    },
  ],
  {
    appName: "zBase",
    // Reown projectId is still required by the RainbowKit type signature even
    // when no WalletConnect wallet is registered. Using a placeholder string
    // is safe — no WalletConnect connection is ever attempted.
    projectId: "REOWN_UNUSED_LOCAL_INJECTED_ONLY",
  },
);

const activeWagmiChain =
  process.env.NEXT_PUBLIC_NETWORK === "mainnet"
    ? base
    : process.env.NEXT_PUBLIC_NETWORK === "eth-sepolia"
      ? sepolia
      : baseSepolia;

export const config = createConfig({
  connectors,
  chains: [activeWagmiChain],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_MAINNET_RPC || "https://mainnet.base.org"),
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC || "https://sepolia.base.org"),
    [sepolia.id]: http(
      process.env.NEXT_PUBLIC_ETH_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
    ),
  },
  ssr: true,
});

// zBase contract addresses. Delegates to src/lib/contracts.ts
// which currently returns the production stack unconditionally — the staging
// path was abandoned 2026-06-01 (see contracts.ts header for why).
const _activeStack = getActiveStack();
export const ENTRYPOINT_ADDRESS = _activeStack.entrypoint;
export const USDC_POOL_ADDRESS = _activeStack.usdcPool;
export const ETH_POOL_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`; // no ETH pool on Morpho entrypoint
export const USDC_ADDRESS = _activeStack.usdc;

// Old pool addresses (deprecated — no yield)
// export const OLD_ENTRYPOINT = "0x0D82f3c4b80a6700317f181ba447e2F1606a5623";
// export const OLD_USDC_POOL = "0x58e114AC70474db5BE6FbB916Eb4e5df2C64BaFc";

// Minimal ABIs for frontend interaction
export const USDC_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// Separate ABIs for each deposit overload to avoid wagmi confusion
export const DEPOSIT_ERC20_ABI = [
  { name: "deposit", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "_asset", type: "address" },
      { name: "_value", type: "uint256" },
      { name: "_precommitment", type: "uint256" },
    ],
    outputs: [{ name: "_commitment", type: "uint256" }] },
] as const;

export const DEPOSIT_ETH_ABI = [
  { name: "deposit", type: "function", stateMutability: "payable",
    inputs: [{ name: "_precommitment", type: "uint256" }],
    outputs: [{ name: "_commitment", type: "uint256" }] },
] as const;

export const ENTRYPOINT_ABI = [
  // Relay withdrawal
  { name: "relay", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "_withdrawal", type: "tuple", components: [
        { name: "processooor", type: "address" },
        { name: "recipient", type: "address" },
        { name: "feeRecipient", type: "address" },
        { name: "existingNullifierHash", type: "uint256" },
        { name: "newNullifierHash", type: "uint256" },
        { name: "newCommitmentHash", type: "uint256" },
        { name: "withdrawAmount", type: "uint256" },
        { name: "fee", type: "uint256" },
        { name: "associationSetIndex", type: "uint256" },
      ]},
      { name: "_proof", type: "tuple", components: [
        { name: "pA", type: "uint256[2]" },
        { name: "pB", type: "uint256[2][2]" },
        { name: "pC", type: "uint256[2]" },
        { name: "pubSignals", type: "uint256[8]" },
      ]},
      { name: "_scope", type: "uint256" },
    ],
    outputs: [] },
  // Asset config
  { name: "assetConfig", type: "function", stateMutability: "view",
    inputs: [{ name: "_asset", type: "address" }],
    outputs: [
      { name: "pool", type: "address" },
      { name: "minimumDepositAmount", type: "uint256" },
      { name: "vettingFeeBPS", type: "uint256" },
      { name: "maxRelayFeeBPS", type: "uint256" },
    ] },
  // Latest root
  { name: "latestRoot", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // Association sets length
  { name: "associationSets", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "root", type: "uint256" },
      { name: "ipfsCID", type: "string" },
      { name: "timestamp", type: "uint256" },
    ] },
] as const;

export const POOL_ABI = [
  { name: "SCOPE", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "ASSET", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "currentTreeSize", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "currentRoot", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // Spent-nullifier check — `mapping(uint256 => bool) public nullifierHashes`
  // (vendor/0xbow/contracts/State.sol:64). The mapping was always public; this ABI
  // just never surfaced it, leaving the client with no trustless way to ask "is
  // this note already spent?". A seed-recovering wallet needs exactly that: derive
  // candidate notes from the seed, subtract the spent ones, and that is the
  // balance. Without it, "spent" can only be a LOCAL flag (cf. deposit-vault.ts
  // isSpent → d.withdrawn) — which a fresh install restoring from a seed phrase
  // does not have, and would therefore report already-spent notes as spendable.
  { name: "nullifierHashes", type: "function", stateMutability: "view", inputs: [{ name: "_nullifierHash", type: "uint256" }], outputs: [{ type: "bool" }] },
  // Historical yield-variant compatibility functions; active plain pool reverts these.
  { name: "yieldEnabled", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "getYieldEarned", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "getCurrentAPY", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "totalCommitted", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // Deposit event
  { type: "event", name: "Deposit",
    inputs: [
      { name: "commitment", type: "uint256", indexed: true },
      { name: "value", type: "uint256", indexed: false },
      { name: "label", type: "uint256", indexed: false },
      { name: "precommitment", type: "uint256", indexed: false },
      { name: "leafIndex", type: "uint256", indexed: false },
    ] },
  // Withdrawal event
  { type: "event", name: "Withdrawal",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "nullifierHash", type: "uint256", indexed: false },
    ] },
] as const;
