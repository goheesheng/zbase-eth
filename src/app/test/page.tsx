"use client";

/**
 * /test — user + agent testing surface
 * ────────────────────────────────────
 * Four steps:
 *   Step 1 — connect a wallet
 *   Step 2 — get Sepolia USDC (via Circle's faucet)
 *   Step 3 — deposit + withdraw privately
 *   Step 4 — x402 facilitator playground (verify endpoint live-call)
 *
 * All four steps run against the production stack (the only stack post-staging-
 * abandonment 2026-06-01 — see src/lib/contracts.ts header).
 *
 * Aesthetic vocabulary (kept consistent with NetworkStackBanner):
 *   - Fraunces serif for section heds, Syne uppercase for kickers
 *   - Inter for body, IBM Plex Mono for numbers + code
 *   - Sage / ochre / brick status pills (no green / yellow / red)
 *   - Indigo accent reserved for the one primary action per section
 *   - Off-white #f8f7f4 base, generous white space, no decorative icons
 */

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { PRODUCTION_STACK } from "@/lib/contracts";
import NetworkStackBanner from "@/components/NetworkStackBanner";
import Faucet from "@/components/test/Faucet";
import DepositWithdraw from "@/components/test/DepositWithdraw";
import X402Playground from "@/components/test/X402Playground";
import DepositOnceFramer from "@/app/app/_components/DepositOnceFramer";

const STACK = {
  label: PRODUCTION_STACK.label,
  entrypoint: PRODUCTION_STACK.entrypoint,
  usdcPool: PRODUCTION_STACK.usdcPool,
  usdc: PRODUCTION_STACK.usdc,
};

export default function TestPage() {
  const { isConnected } = useAccount();

  return (
    <div className="min-h-screen bg-[#f8f7f4] font-inter text-black">
      <NetworkStackBanner />

      <main className="mx-auto max-w-[1100px] px-6 py-16">
        {/* ── Header ── */}
        <header className="mb-16">
          <div className="font-syne text-[11px] uppercase tracking-[0.18em] text-gray-500">
            Testing surface · v1
          </div>
          <h1
            className="mt-4 max-w-[820px] text-[64px] leading-[1.05] tracking-[-1.5px] text-black"
            style={{
              fontFamily: "var(--font-fraunces), 'Fraunces', serif",
              fontWeight: 400,
            }}
          >
            Test zBase with your own wallet.
          </h1>
          <p className="mt-6 max-w-[640px] font-inter text-[15px] leading-relaxed text-gray-600">
            Deposit, withdraw, and route x402 payments through the privacy
            pool against a wallet you control. Real Sepolia USDC (no real-value)
            — grab some from Circle's faucet in Step 2 if you need it.
          </p>
        </header>

        {/* ── Step 1: Connect ── */}
        <Section
          step="Step 1"
          title="Connect a wallet"
          subtitle="Any Base Sepolia wallet. You'll need ~0.001 ETH for gas and ~5 Sepolia USDC to run a few deposit/withdraw cycles."
        >
          <div className="rounded-lg border border-gray-200 bg-white p-8">
            <ConnectButton showBalance={false} chainStatus="icon" />
            {isConnected && (
              <p className="mt-4 font-inter text-[12px] text-[#3d4a2c]">
                Connected — banner above shows your live balance.
              </p>
            )}
          </div>
        </Section>

        {/* ── Step 2: Get Sepolia USDC ── */}
        <Section
          step="Step 2"
          title="Get Sepolia USDC"
          subtitle="Circle runs the canonical Base Sepolia USDC faucet — 10 USDC per claim, once every 12h per address. One-time Coinbase sign-in required; no payment info."
        >
          <Faucet />
        </Section>

        {/* ── Inter-step framing: set per-payment latency expectations ──
             Before the tester deposits, explain that the latency they'll see
             on Step 3 has TWO modes: setup (one-time) and per-payment. Avoids
             the "I deposited and it took 50s, is this broken?" reaction. */}
        <section className="mt-16 border-t border-gray-200 pt-12">
          <div className="grid grid-cols-1 gap-12 md:grid-cols-[280px_1fr]">
            <div>
              <div className="font-syne text-[11px] uppercase tracking-[0.18em] text-gray-500">
                Before you deposit
              </div>
              <h2
                className="mt-3 text-[28px] leading-[1.1] tracking-[-0.5px]"
                style={{
                  fontFamily: "var(--font-fraunces), 'Fraunces', serif",
                  fontWeight: 400,
                }}
              >
                What to expect on per-payment latency
              </h2>
              <p className="mt-3 font-inter text-[13px] leading-relaxed text-gray-500">
                Your first deposit takes longer because it includes setup. Each
                subsequent payment is just a proof + relay tx — much faster.
              </p>
            </div>
            <div className="flex flex-col gap-6">
              <DepositOnceFramer />
            </div>
          </div>
        </section>

        {/* ── Step 3: Deposit + Withdraw ── */}
        <Section
          step="Step 3"
          title="Deposit & withdraw privately"
          subtitle="The same flow your agents will run. Each form action mirrors as a copy-paste curl + TS + Python snippet with your actual addresses substituted."
        >
          <DepositWithdraw stack={STACK} />
        </Section>

        {/* ── Step 4: x402 playground ── */}
        <Section
          step="Step 4"
          title="x402 facilitator playground"
          subtitle="Construct a zBase paymentDetails + zbaseDeposit body and hit /api/facilitator/verify live. The zbaseDeposit field is the zBase-specific extension that links the payment to your pool deposit — not in stock x402 SDKs."
        >
          <X402Playground stack={STACK} />
        </Section>

        {/* ── Footer ── */}
        <footer className="mt-24 border-t border-gray-200 pt-6">
          <p className="font-mono text-[11px] text-gray-400">
            zBase testing surface — separate from /app and /demo. Source:{" "}
            <a
              href="https://github.com/goheesheng/zx402"
              className="underline hover:text-gray-600"
            >
              github.com/goheesheng/zx402
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}

function Section({
  step,
  title,
  subtitle,
  children,
}: {
  step: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-16 border-t border-gray-200 pt-12">
      <div className="grid grid-cols-1 gap-12 md:grid-cols-[280px_1fr]">
        <div>
          <div className="font-syne text-[11px] uppercase tracking-[0.18em] text-gray-500">
            {step}
          </div>
          <h2
            className="mt-3 text-[28px] leading-[1.1] tracking-[-0.5px]"
            style={{
              fontFamily: "var(--font-fraunces), 'Fraunces', serif",
              fontWeight: 400,
            }}
          >
            {title}
          </h2>
          <p className="mt-3 font-inter text-[13px] leading-relaxed text-gray-500">
            {subtitle}
          </p>
        </div>
        <div className="flex flex-col gap-6">{children}</div>
      </div>
    </section>
  );
}
