"use client";

/**
 * NetworkStackBanner
 * ──────────────────
 * Top strip for the testing surface. Three reads at a glance:
 *
 *   1. /api/health status — confirms the server can reach Base Sepolia.
 *   2. Anonymity-set size + latest block — the privacy headline number and
 *      chain liveness.
 *   3. Connected wallet's USDC balance.
 *
 * Aesthetic notes (Syne + Inter + warm off-white #f8f7f4):
 *   - Monospace tabular nums for every number (alignment integrity in a
 *     financial product).
 *   - Status pills use sage/ochre/brick instead of green/yellow/red.
 *   - No icons — status is communicated by color + word.
 *
 * Historical: this banner also rendered a "staging" pill + tint when the
 * STAGING stack was active. That path was removed 2026-06-01 because the
 * staging deploy was non-functional (no Merkle tree). See contracts.ts header.
 */

import { useAccount, useReadContract } from "wagmi";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { USDC_ABI, USDC_ADDRESS } from "@/lib/wagmi";

interface HealthResponse {
  status: "ok" | "degraded";
  stack: "production" | "staging";
  entrypoint: string;
  privacyPool: string;
  // /api/health serializes bigints as strings (JSON has no bigint). Numeric
  // fields can also be null when chain reads fail. Treat both as strings here
  // and parse defensively before formatting.
  blockNumber: string | number | null;
  anonymitySet: string | number | null;
  latencyMs: number;
}

function fmtNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

// Sage / ochre / brick — not green / yellow / red. See aesthetic note above.
const PILL_TONES = {
  sage: "bg-[#e8eee0] text-[#3d4a2c] border-[#cfdbbf]",
  ochre: "bg-[#f3e7c8] text-[#6b5417] border-[#e2d09a]",
  brick: "bg-[#f0d6cf] text-[#6b2e1f] border-[#deb6a8]",
  bone: "bg-[#efece4] text-[#3a342a] border-[#dcd6c5]",
  indigo: "bg-[#e0e3f6] text-[#1d2566] border-[#c2c8ed]",
} as const;

type PillTone = keyof typeof PILL_TONES;

function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] font-inter text-[11px] font-medium leading-none tracking-wide ${PILL_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

function fmtUsdc(raw: bigint | undefined): string {
  if (raw === undefined) return "—";
  // 2dp is enough for a banner; the deposit form shows full precision.
  return Number(formatUnits(raw, 6)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shortAddr(addr: string | undefined): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function NetworkStackBanner() {
  const { address, isConnected } = useAccount();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  // Poll /api/health every 12s. Cheap (cached by Next), gives the banner a
  // live block counter without a websocket. Skip if the tab is hidden.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as HealthResponse;
        if (!cancelled) {
          setHealth(data);
          setHealthError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setHealthError((err as Error).message || "health check failed");
        }
      }
    }
    poll();
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      poll();
    }, 12_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Active USDC balance — uses the address the wagmi config already resolved
  // (which reflects NEXT_PUBLIC_STAGING at build time). The banner shows
  // server-resolved stack label + client-resolved balance side by side; if
  // they disagree, that itself is a useful signal that the server and client
  // have drifted out of sync (e.g. NEXT_PUBLIC_STAGING true server-side but
  // wagmi was built without it).
  const { data: usdcBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
  });

  const statusTone: PillTone =
    health?.status === "ok" ? "sage" : healthError ? "brick" : "bone";

  return (
    <div className="sticky top-0 z-40 w-full border-b border-gray-200 bg-[#f8f7f4]/85 backdrop-blur-[12px]">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-2.5 text-[12px] leading-none">
        {/* ── Status (load-bearing left side) ── */}
        <div className="flex items-center gap-3">
          <span className="font-syne text-[11px] uppercase tracking-[0.16em] text-gray-500">
            Status
          </span>
          <Pill tone={statusTone}>
            {health ? health.status : healthError ? "offline" : "checking"}
          </Pill>
        </div>

        {/* ── Chain liveness ── */}
        <div className="flex items-center gap-3">
          <span className="font-syne text-[11px] uppercase tracking-[0.16em] text-gray-500">
            Chain
          </span>
          <span className="font-inter text-[12px] text-black">Base Sepolia</span>
          <span className="font-mono text-[11px] text-gray-500">
            block {fmtNumber(health?.blockNumber)}
          </span>
        </div>

        {/* ── Anonymity set (the privacy headline number) ── */}
        <div className="flex items-center gap-2">
          <span className="font-syne text-[11px] uppercase tracking-[0.16em] text-gray-500">
            Anon set
          </span>
          <span className="font-mono text-[12px] font-medium text-black tabular-nums">
            {fmtNumber(health?.anonymitySet)}
          </span>
        </div>

        {/* ── Wallet + balance (pushed right) ── */}
        <div className="ml-auto flex items-center gap-3">
          {isConnected ? (
            <>
              <span className="font-syne text-[11px] uppercase tracking-[0.16em] text-gray-500">
                Wallet
              </span>
              <span className="font-mono text-[11px] text-gray-600">
                {shortAddr(address)}
              </span>
              <span className="font-mono text-[12px] font-medium text-black tabular-nums">
                {fmtUsdc(usdcBalance as bigint | undefined)}{" "}
                <span className="text-[11px] font-normal text-gray-500">
                  USDC
                </span>
              </span>
            </>
          ) : (
            <span className="font-inter text-[11px] text-gray-500">
              Wallet not connected
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
