"use client";

/**
 * Faucet
 * ──────
 * "Get Sepolia USDC" card for testers who don't already have it. Routes them
 * to Circle's official Base Sepolia faucet at faucet.circle.com — 10 USDC/day
 * per address, sign-in required (Coinbase OAuth). The card also reads the
 * connected wallet's live USDC balance so the tester can see when funds land
 * after the faucet claim.
 *
 * Historical: this component used to render a MockUSDC mint button when the
 * staging stack was active. Staging was abandoned 2026-06-01 because the
 * deployed pool had no Merkle tree, making MockUSDC deposits unspendable.
 * See src/lib/contracts.ts header for the full reasoning.
 *
 * Aesthetic carry-overs (consistent with NetworkStackBanner):
 *   - Sage/ochre/brick status pills (no green/yellow/red)
 *   - Monospace tabular nums for balances
 *   - Indigo accent reserved for the primary action ("Open Circle faucet")
 */

import { useState, useEffect, useCallback } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { formatUnits, parseAbi } from "viem";
import { USDC_ADDRESS } from "@/lib/wagmi";

const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const CIRCLE_FAUCET_URL = "https://faucet.circle.com/?network=base-sepolia";
const MIN_RECOMMENDED_USDC = 5; // enough for ~5 deposits at the 1 USDC minimum

export default function Faucet() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [copied, setCopied] = useState(false);

  const refetchBalance = useCallback(async () => {
    if (!publicClient || !address) return;
    try {
      const result = (await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: "balanceOf",
        args: [address],
      })) as bigint;
      setBalance(result);
    } catch {
      setBalance(null);
    }
  }, [publicClient, address]);

  useEffect(() => {
    refetchBalance();
  }, [refetchBalance]);

  // Re-poll balance every 8s while the page is visible so testers see funds
  // land after claiming from Circle without manually refreshing.
  useEffect(() => {
    if (!address) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refetchBalance();
    }, 8_000);
    return () => clearInterval(id);
  }, [address, refetchBalance]);

  async function handleCopyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; user can select manually */
    }
  }

  const balanceUsdc =
    balance !== null
      ? Number(formatUnits(balance, 6))
      : null;
  const hasEnough = balanceUsdc !== null && balanceUsdc >= MIN_RECOMMENDED_USDC;

  const balanceTone = !isConnected
    ? "bg-[#efece4] text-[#3a342a] border-[#dcd6c5]"
    : hasEnough
    ? "bg-[#e8eee0] text-[#3d4a2c] border-[#cfdbbf]"
    : "bg-[#f3e7c8] text-[#6b5417] border-[#e2d09a]";

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-gray-200 bg-white p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <div className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
              Your Sepolia USDC balance
            </div>
            <div className="mt-2 font-mono text-[36px] leading-none text-black tabular-nums">
              {isConnected && balance !== null
                ? Number(formatUnits(balance, 6)).toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })
                : "—"}
              <span className="ml-2 font-inter text-[14px] font-normal text-gray-500">
                USDC
              </span>
            </div>
            {isConnected && balanceUsdc !== null && (
              <div className="mt-3">
                <span
                  className={`inline-flex rounded-full border px-2.5 py-[3px] font-inter text-[10px] font-medium tracking-wide ${balanceTone}`}
                >
                  {hasEnough
                    ? "ready to test"
                    : `need ≥ ${MIN_RECOMMENDED_USDC} USDC to test`}
                </span>
              </div>
            )}
          </div>
          <a
            href={CIRCLE_FAUCET_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-indigo-600 px-5 py-3 font-syne text-[12px] uppercase tracking-[0.14em] text-white transition-colors hover:bg-indigo-700"
          >
            Open Circle faucet
          </a>
        </div>

        {isConnected && (
          <div className="mt-6 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <div className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
                Paste this address into the faucet
              </div>
              <div className="mt-1 break-all rounded-md border border-gray-200 bg-[#f8f7f4] px-3 py-2 font-mono text-[13px] text-black">
                {address}
              </div>
            </div>
            <button
              onClick={handleCopyAddress}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 font-syne text-[11px] uppercase tracking-[0.14em] text-gray-700 transition-colors hover:bg-[#f8f7f4]"
            >
              {copied ? "Copied" : "Copy address"}
            </button>
          </div>
        )}

        <ul className="mt-6 space-y-1.5 font-inter text-[12px] leading-relaxed text-gray-600">
          <li>
            <span className="text-gray-400">·</span> Circle's faucet sends 10
            Sepolia USDC per claim; you can claim every 12 hours per address.
          </li>
          <li>
            <span className="text-gray-400">·</span> Requires a Coinbase
            sign-in (one-time). Free, no payment info needed.
          </li>
          <li>
            <span className="text-gray-400">·</span> 1 USDC is the pool's
            minimum deposit, so ~5 USDC gives you several deposit/withdraw
            cycles to test with.
          </li>
        </ul>
      </div>
    </div>
  );
}
