"use client";

import { useChain } from "@/lib/chain-context";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export function WalletConnect() {
  const { isEvm } = useChain();

  if (isEvm) {
    return <ConnectButton />;
  }

  return (
    <button
      type="button"
      disabled
      className="inline-flex h-10 items-center justify-center rounded-md border border-white/15 bg-white/5 px-4 text-sm font-medium text-white/45"
    >
      Solana paused
    </button>
  );
}

export function useConnectedAddress(): string | undefined {
  const { isEvm } = useChain();

  // For EVM, the address comes from wagmi (useAccount hook in the parent).
  // SVM wallet support is paused for the Base mainnet launch.
  return undefined; // Components should use useAccount() directly.
}
