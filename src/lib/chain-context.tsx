"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

export type ChainId = "base-sepolia" | "base-mainnet" | "eth-sepolia" | "solana-devnet";

interface ChainConfig {
  id: ChainId;
  name: string;
  type: "evm" | "svm";
  network: string;
  usdcAddress: string;
  poolAddress: string;
  entrypointAddress: string;
  explorerUrl: string;
  rpcUrl: string;
}

export const CHAINS: Record<ChainId, ChainConfig> = {
  "base-sepolia": {
    id: "base-sepolia",
    name: "Base Sepolia",
    type: "evm",
    network: "eip155:84532",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    poolAddress: "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a",
    entrypointAddress: "0x598ffaac79ae29b1aae571fd91899d4492183688",
    explorerUrl: "https://sepolia.basescan.org",
    rpcUrl: "https://sepolia.base.org",
  },
  "base-mainnet": {
    id: "base-mainnet",
    name: "Base Mainnet",
    type: "evm",
    network: "eip155:8453",
    usdcAddress:
      process.env.NEXT_PUBLIC_BASE_MAINNET_USDC ||
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    poolAddress:
      process.env.NEXT_PUBLIC_BASE_MAINNET_POOL ||
      "0x0000000000000000000000000000000000000000",
    entrypointAddress:
      process.env.NEXT_PUBLIC_BASE_MAINNET_ENTRYPOINT ||
      "0x0000000000000000000000000000000000000000",
    explorerUrl: "https://basescan.org",
    rpcUrl: process.env.NEXT_PUBLIC_BASE_MAINNET_RPC || "https://mainnet.base.org",
  },
  "eth-sepolia": {
    id: "eth-sepolia",
    name: "Ethereum Sepolia",
    type: "evm",
    network: "eip155:11155111",
    // 0xbow's own canonical Ethereum Sepolia Privacy Pool deployment — zBase
    // rents this pool (read/deposit only, external ASP — see contracts.ts
    // ETH_SEPOLIA_STACK). Verified on-chain 2026-09-13.
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    poolAddress: "0x0b062Fe33c4f1592D8EA63f9a0177FcA44374C0f",
    entrypointAddress: "0x34A2068192b1297f2a7f85D7D8CdE66F8F0921cB",
    explorerUrl: "https://sepolia.etherscan.io",
    rpcUrl: process.env.NEXT_PUBLIC_ETH_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
  },
  "solana-devnet": {
    id: "solana-devnet",
    name: "Solana Devnet",
    type: "svm",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    usdcAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    poolAddress: "AMrw17mdgN7JihA3k4fSJ9VwxNDmJAnKa6JK8iY4Jv98",
    entrypointAddress: "7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM",
    explorerUrl: "https://explorer.solana.com",
    rpcUrl: "https://api.devnet.solana.com",
  },
};

interface ChainContextType {
  chain: ChainConfig;
  chainId: ChainId;
  setChainId: (id: ChainId) => void;
  isEvm: boolean;
  isSvm: boolean;
  // True only when Solana is explicitly re-enabled after the SVM audit fixes.
  // Keep false by default while the product focus is Base mainnet.
  svmReady: boolean;
  // True when the currently-selected chain is fully operational (privacy +
  // compliance enforced on-chain). EVM is always true; SVM follows svmReady.
  chainReady: boolean;
}

// Solana is paused by default after the July 2026 audit. Operators must opt in
// explicitly after the recipient/fee binding and Kamino CPI findings are fixed.
const SVM_READY =
  String(process.env.NEXT_PUBLIC_ZX402_SVM_READY ?? "false").toLowerCase() === "true";
const DEFAULT_CHAIN_ID: ChainId =
  process.env.NEXT_PUBLIC_NETWORK === "mainnet"
    ? "base-mainnet"
    : process.env.NEXT_PUBLIC_NETWORK === "eth-sepolia"
      ? "eth-sepolia"
      : "base-sepolia";

const ChainContext = createContext<ChainContextType>({
  chain: CHAINS[DEFAULT_CHAIN_ID],
  chainId: DEFAULT_CHAIN_ID,
  setChainId: () => {},
  isEvm: true,
  isSvm: false,
  svmReady: SVM_READY,
  chainReady: true,
});

export function ChainProvider({ children }: { children: ReactNode }) {
  const [chainId, setChainId] = useState<ChainId>(DEFAULT_CHAIN_ID);
  const chain = CHAINS[chainId];
  const isSvm = chain.type === "svm";

  return (
    <ChainContext.Provider
      value={{
        chain,
        chainId,
        setChainId,
        isEvm: chain.type === "evm",
        isSvm,
        svmReady: SVM_READY,
        chainReady: isSvm ? SVM_READY : true,
      }}
    >
      {children}
    </ChainContext.Provider>
  );
}

export function useChain() {
  return useContext(ChainContext);
}
