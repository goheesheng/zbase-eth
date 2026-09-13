"use client";

import { useEffect, useState } from "react";
import { Logo } from "./_components/Logo";
import { getActiveChain } from "@/lib/contracts";

type Status = "idle" | "submitting" | "done" | "error";

const credCardSide = (): React.CSSProperties => ({
  padding: "16px 18px",
  textAlign: "center",
  borderRadius: 16,
  background: "rgba(255,255,255,0.55)",
  borderColor: "rgba(12,26,14,0.18)",
});

const credName = (): React.CSSProperties => ({
  fontFamily: "var(--font-body), sans-serif",
  fontWeight: 700,
  fontSize: 17,
  letterSpacing: "-0.015em",
  color: "var(--ink)",
});

const credSub = (): React.CSSProperties => ({
  fontFamily: "var(--font-mono-tech), monospace",
  fontSize: 10,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "var(--ink-soft)",
  marginTop: 4,
});

/**
 * LiveStatus — testnet-honest hero status line. Fetches live anonymity-set
 * size + treasury balance + git SHA on mount; falls back to "—" if any
 * endpoint fails (don't block hero render on a slow API).
 *
 * Sales-credibility framing: this replaces the prior hardcoded "Live on
 * Base Sepolia · 105 commitments" line. Now it shows:
 *   - Honest status ("LIVE ON BASE SEPOLIA")
 *   - Live anonymity-set size (proof the pool is real + growing)
 *   - Live treasury balance (proof the fee mechanism actually works)
 *   - Mainnet status framing ("MAINNET ON FIRST SIGNED PILOT")
 *
 * Per the sales-led launch plan: don't promise dates ("Q3 2026") — promise
 * a trigger ("on first signed pilot"). Avoids dead-promise risk if the
 * pilot conversation slips.
 */
function LiveStatus() {
  const [anonSet, setAnonSet] = useState<string>("—");
  const [treasuryUsdc, setTreasuryUsdc] = useState<string>("—");

  useEffect(() => {
    // Anonymity set from /api/health (already returns this field).
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.anonymitySet === "number") {
          setAnonSet(d.anonymitySet.toString());
        }
      })
      .catch(() => {});

    // Treasury balance via on-chain RPC. Read-only, no wallet required.
    // USDC balanceOf(treasury) on Base Sepolia. ABI = 0x70a08231 + addr.
    const TREASURY = "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21";
    const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const callData = "0x70a08231" + "000000000000000000000000" + TREASURY.slice(2).toLowerCase();
    // This hero widget is always Base-Sepolia-framed copy ("Live on Base
    // Sepolia" below) regardless of NEXT_PUBLIC_NETWORK, so the RPC target
    // is pinned to "sepolia" rather than following the active network —
    // routes through the shared RPC-override helper without changing which
    // chain this probe reads from.
    fetch(getActiveChain("sepolia").readRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: USDC, data: callData }, "latest"],
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.result === "string") {
          // BigInt("0x") throws SyntaxError in V8 — RPC returns lone "0x"
          // (no digits) when the balance is exactly zero. Normalize to
          // "0x0" so a drained treasury renders "$0.0000" not "$—".
          // Per /security-review on PR #28 (2026-06-08).
          const raw = d.result === "0x" ? "0x0" : d.result;
          const atomic = BigInt(raw);
          // 6 decimals. Show 4 sig figs for sub-cent amounts.
          const usdc = Number(atomic) / 1_000_000;
          setTreasuryUsdc(usdc.toFixed(usdc < 0.01 ? 6 : 4));
        }
      })
      .catch(() => {});
  }, []);

  return (
    <>
      Live on Base Sepolia · {anonSet} commitments · ${treasuryUsdc} treasury
      <br />
      <span style={{ opacity: 0.7 }}>Mainnet on first signed pilot</span>
    </>
  );
}

/**
 * Official Base brand mark — the rounded-square "TheSquare" mark from base/brand-kit.
 * Source: https://github.com/base/brand-kit/blob/main/logo/TheSquare/Digital/Base_square_blue.svg
 * Path data preserved exactly; only fill is parameterized so we can recolor for dark contexts.
 */
function BaseMark({ size = 22, fill = "var(--base-blue)" }: { size?: number; fill?: string }) {
  return (
    <svg viewBox="0 0 1280 1280" width={size} height={size} aria-hidden style={{ flexShrink: 0, display: "block" }}>
      <path
        fill={fill}
        d="M0,101.12c0-34.64,0-51.95,6.53-65.28,6.25-12.76,16.56-23.07,29.32-29.32C49.17,0,66.48,0,101.12,0h1077.76c34.63,0,51.96,0,65.28,6.53,12.75,6.25,23.06,16.56,29.32,29.32,6.52,13.32,6.52,30.64,6.52,65.28v1077.76c0,34.63,0,51.96-6.52,65.28-6.26,12.75-16.57,23.06-29.32,29.32-13.32,6.52-30.65,6.52-65.28,6.52H101.12c-34.64,0-51.95,0-65.28-6.52-12.76-6.26-23.07-16.57-29.32-29.32-6.53-13.32-6.53-30.65-6.53-65.28V101.12Z"
      />
    </svg>
  );
}

/**
 * Official Base wordmark — the "Basemark" (BASE spelled out in 4 rounded rectangles).
 * Source: https://github.com/base/brand-kit/blob/main/logo/Basemark/Digital/Base_basemark_blue.svg
 */
function BaseWordmark({ height = 18, fill = "var(--base-blue)" }: { height?: number; fill?: string }) {
  return (
    <svg
      viewBox="0 0 1280 417.43"
      height={height}
      aria-label="Base"
      style={{ flexShrink: 0, display: "block", width: "auto" }}
    >
      <g fill={fill}>
        <path d="M616.78,120.78c-3.1-1.52-7.12-1.52-15.18-1.52h-250.64c-8.06,0-12.08,0-15.18,1.52-2.97,1.46-5.36,3.86-6.82,6.83-1.52,3.1-1.52,7.14-1.52,15.21v251.05c0,8.07,0,12.1,1.52,15.21,1.45,2.97,3.85,5.37,6.82,6.83,3.1,1.52,7.13,1.52,15.18,1.52h250.64c8.06,0,12.08,0,15.18-1.52,2.97-1.46,5.37-3.86,6.82-6.83,1.52-3.1,1.52-7.14,1.52-15.21v-251.05c0-8.07,0-12.1-1.52-15.21-1.45-2.97-3.85-5.37-6.82-6.83Z" />
        <path d="M944.22,120.78c-3.1-1.52-7.13-1.52-15.18-1.52h-250.64c-8.06,0-12.08,0-15.18,1.52-2.97,1.46-5.36,3.86-6.82,6.83-1.52,3.1-1.52,7.14-1.52,15.21v251.05c0,8.07,0,12.1,1.52,15.21,1.46,2.97,3.85,5.37,6.82,6.83,3.1,1.52,7.12,1.52,15.18,1.52h250.64c8.06,0,12.08,0,15.18-1.52,2.96-1.46,5.36-3.86,6.82-6.83,1.52-3.1,1.52-7.14,1.52-15.21v-251.05c0-8.07,0-12.1-1.52-15.21-1.45-2.97-3.85-5.37-6.82-6.83Z" />
        <path d="M1278.48,127.61c-1.46-2.97-3.85-5.37-6.82-6.83-3.1-1.52-7.12-1.52-15.18-1.52h-250.64c-8.06,0-12.08,0-15.18,1.52-2.97,1.46-5.36,3.86-6.82,6.83-1.52,3.1-1.52,7.14-1.52,15.21v251.05c0,8.07,0,12.1,1.52,15.21,1.45,2.97,3.85,5.37,6.82,6.83,3.1,1.52,7.13,1.52,15.18,1.52h250.64c8.06,0,12.08,0,15.18-1.52,2.97-1.46,5.36-3.86,6.82-6.83,1.52-3.1,1.52-7.14,1.52-15.21v-251.05c0-8.07,0-12.1-1.52-15.21Z" />
        <path d="M289.34,120.78c-3.1-1.52-7.13-1.52-15.18-1.52h-131.57c-8.05,0-12.08,0-15.18-1.52-2.97-1.46-5.36-3.86-6.82-6.83-1.52-3.1-1.52-7.14-1.52-15.21V23.55c0-8.07,0-12.1-1.52-15.21-1.45-2.97-3.85-5.37-6.82-6.83C107.64,0,103.61,0,95.55,0H23.52C15.46,0,11.43,0,8.34,1.52c-2.97,1.46-5.36,3.86-6.82,6.83-1.52,3.1-1.52,7.14-1.52,15.21v370.32c0,8.07,0,12.1,1.52,15.21,1.45,2.97,3.85,5.37,6.82,6.83,3.1,1.52,7.13,1.52,15.18,1.52h250.64c8.05,0,12.08,0,15.18-1.52,2.97-1.46,5.37-3.86,6.82-6.83,1.52-3.1,1.52-7.14,1.52-15.21v-251.05c0-8.07,0-12.1-1.52-15.21-1.45-2.97-3.85-5.37-6.82-6.83Z" />
      </g>
    </svg>
  );
}

function FinalistBanner() {
  return (
    <div
      className="relative z-10 w-full overflow-hidden"
      style={{ background: "var(--base-blue)", borderBottom: "1px solid rgba(255,255,255,0.18)" }}
    >
      <div
        style={{
          display: "flex",
          width: "max-content",
          animation: "marquee 26s linear infinite",
          padding: "12px 0",
          color: "#fff",
        }}
      >
        {[0, 1].map((d) => (
          <div
            key={d}
            aria-hidden={d === 1}
            style={{ display: "inline-flex", alignItems: "center", gap: 28, paddingRight: 28 }}
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <span
                key={i}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 14,
                  fontFamily: "var(--font-mono-tech), monospace",
                  fontWeight: 700,
                  fontSize: 14,
                  letterSpacing: "0.28em",
                  textTransform: "uppercase",
                }}
              >
                <BaseMark size={16} fill="#fff" />
                Base Batches 003 · Finalist
                <span style={{ opacity: 0.55 }}>★</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Headline — JetBrains Mono terminal-print-head treatment.
 *
 * "PRIVACY FOR AGENTS" assembles once on mount via a per-character scanline
 * reveal (steps-based clip-path), then settles. A solid block cursor blinks at
 * the end, in the page's Base-blue accent.
 *
 * Uses the same typeface as the matching kicker label
 *   "━━━━ Privacy is for all, including your agents ━━━━"
 * so the headline reads as part of one typographic system.
 *
 * Animations run once (no infinite loop) — entry takes longer than exit, and
 * subsequent visits don't keep redrawing.
 */
const HEADLINE_TEXT = "PRIVACY FOR AGENTS";
const CHAR_DRAW_MS = 60;    // per-character scan duration (one row of pixels)

function Headline() {
  // Split into words so each word can wrap as a unit (no orphan letters on mobile)
  const words = HEADLINE_TEXT.split(" ");
  let globalIdx = 0;
  return (
    <span
      className="mono-headline"
      style={{
        fontFamily: "var(--font-mono-tech), ui-monospace, monospace",
        fontWeight: 700,
        letterSpacing: "0.02em",
        color: "var(--ink)",
        display: "inline-flex",
        alignItems: "baseline",
        flexWrap: "wrap",
        justifyContent: "center",
        rowGap: "0.1em",
        columnGap: "0.45em",
      }}
      aria-label="Privacy for Agents"
    >
      {words.map((word, wi) => (
        <span
          key={wi}
          style={{ display: "inline-flex", whiteSpace: "nowrap" }}
        >
          {word.split("").map((c) => {
            const i = globalIdx++;
            return (
              <span
                key={i}
                className="mono-cell"
                style={{
                  animationDelay: `${((i * CHAR_DRAW_MS) / 1000).toFixed(3)}s`,
                  display: "inline-block",
                }}
              >
                {c}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}

export default function FinalistClient() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [count, setCount] = useState<number | null>(null);

  // REMOVED 2026-08-03: a synthetic signup counter (baseline 100 + 2.3/hour + a sine "wobble"
  // so the number "feels organic") used to render here as "N joined". It was fabricated traction
  // shown to prospects while the real count from /api/interest was fetched and never displayed.
  // A technical buyer diffing the homepage against /api/facilitator/supported would find it and
  // then distrust every privacy and receipt claim on the site. Only the real count renders now,
  // and only once it exists. Do not reintroduce a modelled number on a public surface.

  useEffect(() => {
    fetch("/api/interest")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.count === "number") setCount(d.count);
      })
      .catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setStatus("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/interest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role, source: "finalist" }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `err ${res.status}`);
      }
      const d = await res.json().catch(() => ({}));
      if (typeof d?.count === "number") setCount(d.count);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "submit failed");
    }
  }

  return (
    <>
      <style jsx global>{`
        :root {
          --mint: #d8efd9;
          --mint-deep: #b0dfb2;
          --ink: #0c1a0e;
          --ink-soft: #2c4530;
          --chrome-1: #f5e7c2;
          --chrome-2: #b8e2ff;
          --chrome-3: #f0bce0;
          --chrome-4: #c9ffd1;
          --hot: #ff5b1f;
          --base-blue: #0000ff;
          --base-blue-deep: #0000c8;
        }
        html, body { background: var(--mint); }
        .finalist-root {
          font-family: var(--font-body), system-ui, sans-serif;
          color: var(--ink);
          min-height: 100vh;
          position: relative;
          overflow-x: hidden;
          background:
            radial-gradient(ellipse 80% 60% at 80% 10%, rgba(176, 223, 178, 0.7), transparent 60%),
            radial-gradient(ellipse 60% 50% at 10% 90%, rgba(255, 200, 230, 0.35), transparent 60%),
            var(--mint);
        }
        /* Grain */
        .finalist-root::before {
          content: "";
          position: fixed; inset: 0; pointer-events: none; z-index: 1;
          background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.045 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
          mix-blend-mode: multiply;
          opacity: 0.55;
        }
        .display {
          font-family: var(--font-display), "Times New Roman", serif;
          font-style: italic;
          letter-spacing: -0.02em;
          line-height: 0.95;
        }
        .mono {
          font-family: var(--font-mono-tech), ui-monospace, monospace;
        }
        .lbl {
          font-family: var(--font-mono-tech), monospace;
          font-size: 11px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: var(--ink-soft);
        }
        .chrome-text {
          /* Deeper, higher-contrast foil so italic display reads against pale mint */
          background: linear-gradient(
            105deg,
            #c9a55a 0%,
            #5fa0d8 18%,
            #b06fc4 36%,
            #5fd07f 58%,
            #f0a05a 78%,
            #c9a55a 100%
          );
          background-size: 280% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          -webkit-text-stroke: 1.5px var(--ink);
          animation: chrome-shimmer 9s linear infinite;
          filter:
            drop-shadow(0 3px 0 rgba(12, 26, 14, 0.85))
            drop-shadow(0 6px 14px rgba(12, 26, 14, 0.22));
        }
        @keyframes chrome-shimmer {
          0% { background-position: 0% 50%; }
          100% { background-position: 300% 50%; }
        }
        @keyframes float-blob {
          0%, 100% { transform: translate(0, 0) rotate(0deg); }
          33% { transform: translate(20px, -14px) rotate(2deg); }
          66% { transform: translate(-12px, 8px) rotate(-2deg); }
        }
        .blob {
          position: absolute;
          border-radius: 50%;
          filter: blur(60px);
          opacity: 0.55;
          animation: float-blob 18s ease-in-out infinite;
          pointer-events: none;
        }
        @keyframes rise {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: none; }
        }
        .anim-1 { animation: rise 800ms 100ms both cubic-bezier(.2,.7,.2,1); }
        .anim-2 { animation: rise 800ms 280ms both cubic-bezier(.2,.7,.2,1); }
        .anim-3 { animation: rise 800ms 480ms both cubic-bezier(.2,.7,.2,1); }
        .anim-4 { animation: rise 800ms 700ms both cubic-bezier(.2,.7,.2,1); }

        /* Base finalist ribbon */
        .base-ribbon {
          background: var(--base-blue);
          color: #fff;
          position: relative;
          overflow: hidden;
        }
        .base-ribbon::after {
          content: "";
          position: absolute; inset: 0;
          background: linear-gradient(
            110deg,
            transparent 0%,
            transparent 40%,
            rgba(255,255,255,0.25) 50%,
            transparent 60%,
            transparent 100%
          );
          animation: ribbon-shine 4.5s ease-in-out infinite;
          pointer-events: none;
        }
        @keyframes ribbon-shine {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .base-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 5px 12px 5px 8px;
          border-radius: 999px;
          background: var(--base-blue);
          color: #fff;
          font-family: var(--font-mono-tech), monospace;
          font-size: 11px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          font-weight: 700;
          box-shadow: 0 0 0 2px rgba(255,255,255,0.6), 0 6px 18px -4px rgba(0,0,255,0.55);
        }
        .base-pill .base-mark {
          width: 16px; height: 16px; border-radius: 50%;
          background: #fff;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--base-blue);
        }
        .as-seen {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 8px 16px;
          border-radius: 999px;
          background: rgba(0, 0, 255, 0.08);
          border: 1.5px solid var(--base-blue);
          color: var(--base-blue);
          font-family: var(--font-mono-tech), monospace;
          font-size: 11.5px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          font-weight: 700;
        }

        /* Banner marquee animation */
        @keyframes marquee {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }

        /* === HEADLINE — JetBrains Mono terminal scanline reveal (one-pass) === */
        .mono-headline {
          /* No font-smoothing override — JetBrains Mono renders best with the
           * platform default. We want crisp typography, not chunky raster. */
        }
        .mono-cell {
          /* Each character is hidden until its delay, then scans in top→bottom
           * via a clip-path inset, in 6 steps. Runs once (no iteration count). */
          clip-path: inset(100% 0 0 0);
          animation-name: mono-scan;
          animation-duration: 260ms;
          animation-iteration-count: 1;
          animation-timing-function: steps(6, end);
          animation-fill-mode: forwards;
          will-change: clip-path;
        }
        @keyframes mono-scan {
          0%   { clip-path: inset(100% 0 0 0); }
          100% { clip-path: inset(0 0 0 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .mono-cell {
            animation: none !important;
            clip-path: none !important;
          }
        }

        .card {
          background: rgba(255, 255, 255, 0.55);
          backdrop-filter: blur(14px) saturate(140%);
          -webkit-backdrop-filter: blur(14px) saturate(140%);
          border: 1.5px solid rgba(12, 26, 14, 0.18);
          border-radius: 28px;
          box-shadow:
            0 1px 0 rgba(255,255,255,0.8) inset,
            0 -1px 0 rgba(12,26,14,0.06) inset,
            0 24px 60px -28px rgba(12, 26, 14, 0.35);
        }
        .chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 14px;
          border-radius: 999px;
          background: rgba(12, 26, 14, 0.06);
          border: 1px solid rgba(12, 26, 14, 0.18);
          font-family: var(--font-mono-tech), monospace;
          font-size: 11px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: var(--ink);
        }
        .chip .dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: var(--hot);
          box-shadow: 0 0 0 3px rgba(255, 91, 31, 0.18);
        }
        .input-pill {
          width: 100%;
          background: rgba(255,255,255,0.7);
          border: 1.5px solid rgba(12,26,14,0.22);
          border-radius: 16px;
          padding: 16px 18px;
          font-family: var(--font-body), sans-serif;
          font-size: 16px;
          color: var(--ink);
          outline: 0;
          transition: border-color 120ms, box-shadow 120ms;
        }
        .input-pill:focus {
          border-color: var(--hot);
          box-shadow: 0 0 0 4px rgba(255, 91, 31, 0.18);
        }
        .input-pill::placeholder { color: rgba(12,26,14,0.4); }
        .btn-mint {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          background: var(--ink);
          color: var(--mint);
          padding: 16px 28px;
          border-radius: 999px;
          border: 0;
          cursor: pointer;
          font-family: var(--font-body), sans-serif;
          font-weight: 600;
          font-size: 16px;
          letter-spacing: -0.01em;
          box-shadow:
            0 0 0 1.5px var(--ink),
            6px 8px 0 rgba(12, 26, 14, 0.18);
          transition: transform 100ms ease, box-shadow 150ms ease;
        }
        .btn-mint:hover {
          transform: translate(-2px, -2px);
          box-shadow: 0 0 0 1.5px var(--ink), 10px 12px 0 rgba(12,26,14,0.22);
        }
        .btn-mint:active {
          transform: translate(0, 0);
          box-shadow: 0 0 0 1.5px var(--ink), 2px 3px 0 rgba(12,26,14,0.2);
        }
        .btn-mint:disabled { opacity: 0.65; cursor: wait; }
        .badge-foil {
          background: linear-gradient(120deg, var(--chrome-1), var(--chrome-2), var(--chrome-3), var(--chrome-4));
          background-size: 240% 240%;
          animation: chrome-shimmer 8s linear infinite;
          color: var(--ink);
        }
        @keyframes blink { 50% { opacity: 0; } }
        .blink { animation: blink 1.05s steps(2,end) infinite; }

        /* hand-drawn underline */
        .squiggle {
          position: relative;
          display: inline-block;
        }
        .squiggle::after {
          content: "";
          position: absolute;
          left: -2px; right: -2px; bottom: -6px;
          height: 12px;
          background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 12' preserveAspectRatio='none'><path d='M0,6 C30,0 60,12 90,6 C120,0 150,12 180,6 C210,0 240,12 270,6 C285,3 295,8 300,6' fill='none' stroke='%23ff5b1f' stroke-width='2.5' stroke-linecap='round'/></svg>");
          background-size: 100% 100%;
          background-repeat: no-repeat;
        }
      `}</style>

      {/* Background blobs */}
      <div
        className="blob"
        style={{
          background: "radial-gradient(circle, #ffd5b8, transparent 70%)",
          width: 520, height: 520, top: -120, right: -100, zIndex: 0,
        }}
      />
      <div
        className="blob"
        style={{
          background: "radial-gradient(circle, #b8e2ff, transparent 70%)",
          width: 460, height: 460, bottom: 80, left: -120, zIndex: 0,
          animationDelay: "-6s",
        }}
      />

      {/* Base Batches 003 Finalist — banner (switchable via ?banner=1..5) */}
      <FinalistBanner />

      <header className="relative z-10 px-5 md:px-10 lg:px-14 pt-6 flex items-center justify-between">
        <Logo size={32} tone="ink" accent="var(--hot)" />
        <div className="flex items-center gap-3">
          <span className="chip">
            <span className="dot" />
            Coming soon
          </span>
          <span className="base-pill hidden sm:inline-flex">
            <BaseMark size={14} fill="#fff" />
            Base Batches 003 · Finalist
          </span>
        </div>
      </header>

      {/* HERO */}
      <section className="relative z-10 px-5 md:px-10 lg:px-14 pt-14 md:pt-20 pb-12 text-center">
        {/* Prominent TESTNET status badge — first thing a prospect sees.
            Sales-credibility prep: do NOT let anyone reach the hero copy
            without first knowing "this is testnet, not mainnet, on purpose."
            Mainnet flips on first signed pilot per the launch plan. */}
        <div className="anim-1 mb-4 flex justify-center">
          <a
            href="/test"
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-semibold tracking-wider uppercase border border-[rgba(12,26,14,0.18)] bg-[rgba(247,200,46,0.12)] text-[var(--ink)] hover:bg-[rgba(247,200,46,0.20)] transition-colors"
            style={{ fontFamily: "var(--font-mono-tech), ui-monospace, monospace" }}
            title="Open the agent / developer testing surface"
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--hot)] animate-pulse"
              aria-hidden="true"
            />
            <span>🧪 Testnet live</span>
            <span className="opacity-60">·</span>
            <span className="opacity-80">Base Sepolia · mainnet next</span>
            <span className="opacity-60">·</span>
            <span className="opacity-80">Test as agent →</span>
          </a>
        </div>

        <div className="anim-1 flex items-center justify-center gap-2 mb-6 lbl">
          <span>━━━━</span>
          <span>Privacy is for all, including your agents</span>
          <span>━━━━</span>
        </div>

        <h1
          className="anim-2"
          style={{
            fontSize: "clamp(32px, 8vw, 104px)",
            lineHeight: 1.05,
            marginTop: 8,
            fontWeight: 700,
            letterSpacing: "0.02em",
            fontFamily: "var(--font-mono-tech), ui-monospace, monospace",
          }}
        >
          <Headline />
        </h1>

        <p
          className="anim-3 mx-auto mt-10 max-w-2xl text-lg md:text-xl leading-snug text-[var(--ink-soft)]"
          style={{ fontFamily: "var(--font-body), sans-serif" }}
        >
          <strong style={{ color: "var(--ink)", fontWeight: 700 }}>zBase</strong> is a zero-knowledge privacy facilitator for{" "}
          <span className="mono font-semibold px-1.5 py-0.5 rounded bg-[rgba(12,26,14,0.08)] text-[0.85em]">
            x402
          </span>{" "}
          agent payments on Base and Solana. Built on{" "}
          <span className="squiggle">Vitalik Buterin&apos;s Privacy Pools</span>.
          Compliant by construction.
        </p>

        {/* Chip row */}
        <div className="anim-3 mt-10 flex flex-wrap items-center justify-center gap-2.5">
          {[
            "Groth16 / On-chain",
            "ASP-compliant",
            "x402 facilitator",
            "Kohaku-aligned",
            "Open source",
          ].map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
        </div>

        {/* Primary CTA — beta product on Base Sepolia.
            Sits above the email signup form because the live product is the
            stronger conversion target than the interest list. Visitors who
            want to wait can still scroll to the form below. */}
        <div className="anim-3 mt-10 flex flex-wrap items-center justify-center gap-3">
          <a
            href="/app"
            className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full font-semibold text-[15px] bg-[var(--hot)] text-white hover:brightness-110 transition-all"
            style={{ fontFamily: "var(--font-body), sans-serif" }}
          >
            Launch beta
            <span aria-hidden="true">→</span>
          </a>
          <a
            href="/app#try"
            className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full font-semibold text-[15px] border-[1.5px] border-[var(--ink)] text-[var(--ink)] hover:bg-[var(--ink)] hover:text-[var(--bg)] transition-colors"
            style={{ fontFamily: "var(--font-body), sans-serif" }}
          >
            Try without wallet
          </a>
          {/* Third CTA — explicitly for the agent/developer persona who wants
              to actually integrate, not just preview. Sends them to /test
              (the 4-step developer surface: connect → faucet → deposit/
              withdraw → x402 playground). Mono font signals "dev land." */}
          <a
            href="/test"
            className="inline-flex items-center gap-2 px-6 py-3.5 rounded-full font-semibold text-[13px] tracking-wider uppercase text-[var(--ink-soft)] hover:text-[var(--ink)] transition-colors"
            style={{ fontFamily: "var(--font-mono-tech), ui-monospace, monospace" }}
            title="Open the agent / developer testing surface"
          >
            Test as agent
            <span aria-hidden="true">→</span>
          </a>
        </div>
        <p
          className="anim-3 mt-3 text-[12px] uppercase tracking-[0.16em] text-[var(--ink-soft)]"
          style={{ fontFamily: "var(--font-mono-tech), ui-monospace, monospace" }}
        >
          {/* Sales-credibility status line (Phase 3a). Anonymity set was a
              hardcoded 105 in pre-audit code; now pulled from a live
              /api/anonymity-set call in <LiveStatus />. Mainnet ETA framing
              is honest ("gated on first signed pilot") not aspirational
              ("Q3 2026"), per the sales-led launch plan. */}
          <LiveStatus />
        </p>

        {/* Integrate section — "test as a human OR as an agent" 4-card grid.
            User-requested addition (2026-06-08): humans + agents both need a
            clear testnet path. All 4 cards say "Base Sepolia" / "Sepolia USDC"
            so there's zero ambiguity about the testing environment.

            Humans:  🌐 Browser test → /test  ·  🎮 No-wallet demo → /app#try
            Agents:  🤖 SKILL.md → /SKILL.md  ·  ⚡ curl + SDK → GitBook docs
        */}
        <section
          className="anim-4 mt-16 mx-auto max-w-5xl"
          aria-labelledby="integrate-heading"
        >
          <h2
            id="integrate-heading"
            className="text-center text-[13px] uppercase tracking-[0.2em] text-[var(--ink-soft)] mb-2"
            style={{ fontFamily: "var(--font-mono-tech), ui-monospace, monospace" }}
          >
            Integrate
          </h2>
          <p
            className="text-center text-lg md:text-xl text-[var(--ink)] mb-2"
            style={{ fontFamily: "var(--font-display), serif", fontStyle: "italic" }}
          >
            Test as a human, integrate as an agent — all on Base Sepolia today.
          </p>
          <p className="text-center text-[12px] text-[var(--ink-soft)] mb-8">
            Privacy = sender/receiver unlinkability today. Amount hiding ships with UTXO notes.{" "}
            <a
              href="https://docs.zbase.app/threat-model/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted hover:text-[var(--hot)]"
            >
              Read the threat model →
            </a>
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* HUMAN — Browser test */}
            <a
              href="/test"
              className="block p-5 rounded-2xl border border-[rgba(12,26,14,0.12)] bg-[rgba(255,255,255,0.5)] hover:bg-[rgba(255,255,255,0.8)] hover:border-[rgba(12,26,14,0.24)] transition-all text-left group"
            >
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-2xl" aria-hidden="true">🌐</span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--ink-soft)] opacity-70">Human · Browser</span>
              </div>
              <div className="font-semibold text-[15px] text-[var(--ink)] mb-1.5">Browser test</div>
              <p className="text-[13px] leading-snug text-[var(--ink-soft)] mb-3">
                Connect a wallet, get Sepolia USDC from Circle&apos;s faucet, deposit + withdraw privately. ~5 min, no code.
              </p>
              <div className="text-[12px] font-semibold text-[var(--hot)] group-hover:translate-x-0.5 transition-transform inline-flex items-center gap-1">
                Open /test →
              </div>
            </a>

            {/* HUMAN — No-wallet demo */}
            <a
              href="/app#try"
              className="block p-5 rounded-2xl border border-[rgba(12,26,14,0.12)] bg-[rgba(255,255,255,0.5)] hover:bg-[rgba(255,255,255,0.8)] hover:border-[rgba(12,26,14,0.24)] transition-all text-left group"
            >
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-2xl" aria-hidden="true">🎮</span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--ink-soft)] opacity-70">Human · No wallet</span>
              </div>
              <div className="font-semibold text-[15px] text-[var(--ink)] mb-1.5">No-wallet demo</div>
              <p className="text-[13px] leading-snug text-[var(--ink-soft)] mb-3">
                Watch a private payment land on Base Sepolia using our pre-funded demo wallet. ~15 sec, just click.
              </p>
              <div className="text-[12px] font-semibold text-[var(--hot)] group-hover:translate-x-0.5 transition-transform inline-flex items-center gap-1">
                Open /app#try →
              </div>
            </a>

            {/* AGENT — SKILL.md (fetch and follow) */}
            <a
              href="/SKILL.md"
              className="block p-5 rounded-2xl border border-[rgba(12,26,14,0.12)] bg-[rgba(255,255,255,0.5)] hover:bg-[rgba(255,255,255,0.8)] hover:border-[rgba(12,26,14,0.24)] transition-all text-left group"
            >
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-2xl" aria-hidden="true">🤖</span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--ink-soft)] opacity-70">Agent · SKILL.md</span>
              </div>
              <div className="font-semibold text-[15px] text-[var(--ink)] mb-1.5">AI coding agent skill</div>
              <p className="text-[13px] leading-snug text-[var(--ink-soft)] mb-2">
                One file. Claude Code, Cursor, and MCP hosts learn the zBase private-pay flow (MCP or CLI) in one shot.
              </p>
              <code className="block text-[11px] font-mono bg-[rgba(12,26,14,0.06)] rounded px-2 py-1.5 mb-3 overflow-x-auto whitespace-nowrap">
                curl zbase.app/SKILL.md
              </code>
              <div className="text-[12px] font-semibold text-[var(--hot)] group-hover:translate-x-0.5 transition-transform inline-flex items-center gap-1">
                Fetch skill →
              </div>
            </a>

            {/* AGENT — curl + SDK */}
            <a
              href="https://docs.zbase.app"
              target="_blank"
              rel="noopener noreferrer"
              className="block p-5 rounded-2xl border border-[rgba(12,26,14,0.12)] bg-[rgba(255,255,255,0.5)] hover:bg-[rgba(255,255,255,0.8)] hover:border-[rgba(12,26,14,0.24)] transition-all text-left group"
            >
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-2xl" aria-hidden="true">⚡</span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--ink-soft)] opacity-70">Agent · curl / SDK</span>
              </div>
              <div className="font-semibold text-[15px] text-[var(--ink)] mb-1.5">curl or npm install</div>
              <p className="text-[13px] leading-snug text-[var(--ink-soft)] mb-2">
                Pure HTTP — x402 standard, no SDK required. Or npm install for engineers (coming on first signed pilot).
              </p>
              <code className="block text-[11px] font-mono bg-[rgba(12,26,14,0.06)] rounded px-2 py-1.5 mb-3 overflow-x-auto whitespace-nowrap">
                POST /api/facilitator/settle
              </code>
              <div className="text-[12px] font-semibold text-[var(--hot)] group-hover:translate-x-0.5 transition-transform inline-flex items-center gap-1">
                See docs →
              </div>
            </a>
          </div>
        </section>

        {/* Form card */}
        <div className="anim-4 mt-14 mx-auto max-w-xl card p-6 md:p-8 text-left">
          <div className="flex items-baseline justify-between mb-1">
            <div className="lbl">Interest list</div>
            {/* Real count only (from /api/interest). Renders nothing until there is something
                true to show — never a modelled or time-derived number. */}
            {typeof count === "number" && count > 0 && (
              <div className="lbl">
                <span className="text-[var(--hot)] font-bold">{count}</span> joined
              </div>
            )}
          </div>
          <h2
            className="display text-3xl md:text-4xl mt-1"
            style={{ fontStyle: "italic" }}
          >
            Be first in line.
          </h2>

          {status === "done" ? (
            <div className="mt-7">
              <div className="display text-4xl">
                You&apos;re on it.{" "}
                <span className="text-[var(--hot)]" style={{ fontStyle: "normal" }}>
                  ↗
                </span>
              </div>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-7 space-y-4">
              <div>
                <label className="lbl block mb-2">Email</label>
                <input
                  type="email"
                  required
                  placeholder="you@protocol.xyz"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input-pill"
                  autoComplete="email"
                />
              </div>
              <div>
                <label className="lbl block mb-2">
                  Role <span className="opacity-70">(optional)</span>
                </label>
                <input
                  type="text"
                  placeholder="Agent builder · researcher · trader · curious"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="input-pill"
                />
              </div>
              <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
                <button
                  type="submit"
                  disabled={status === "submitting"}
                  className="btn-mint"
                >
                  {status === "submitting" ? "Adding…" : "Get on the list"}{" "}
                  <span>→</span>
                </button>
              </div>
              {status === "error" && (
                <div className="mono text-sm text-[var(--hot)]">
                  ✕ {errorMsg}
                </div>
              )}
            </form>
          )}
        </div>
      </section>

      {/* Supported by — static, two anchors only */}
      <section className="relative z-10 pt-2 pb-12">
        <div className="text-center px-5">
          <div className="lbl mb-5">Supported by</div>
          <div
            className="mx-auto"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 36,
              flexWrap: "wrap",
              justifyContent: "center",
              padding: "20px 32px",
              background: "rgba(255,255,255,0.55)",
              border: "1px solid rgba(12,26,14,0.18)",
              borderRadius: 999,
              boxShadow: "0 14px 40px -22px rgba(12,26,14,0.35)",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
              <BaseMark size={36} />
              <span
                style={{
                  fontFamily: "var(--font-body), sans-serif",
                  fontWeight: 700,
                  fontSize: 24,
                  letterSpacing: "-0.02em",
                  color: "var(--base-blue)",
                }}
              >
                Base
              </span>
            </span>
            <span aria-hidden style={{ width: 1, height: 36, background: "rgba(12,26,14,0.22)" }} />
            <span style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
              {/* x402 Foundation mark — square containing "x402" lockup */}
              <span
                aria-hidden
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: "var(--ink)",
                  color: "#fff",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "var(--font-mono-tech), monospace",
                  fontWeight: 700,
                  fontSize: 12,
                  letterSpacing: "-0.02em",
                }}
              >
                x402
              </span>
              <span
                style={{
                  fontFamily: "var(--font-body), sans-serif",
                  fontWeight: 700,
                  fontSize: 24,
                  letterSpacing: "-0.02em",
                  color: "var(--ink)",
                }}
              >
                x402 Foundation
              </span>
            </span>
          </div>
        </div>
      </section>

      {/* Credentials strip — three lineage cards (Base lives in "Supported by" above) */}
      <section className="relative z-10 px-5 md:px-10 lg:px-14 pb-14">
        <div className="lbl text-center mb-6">Built on · Backed by lineage</div>
        <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
          <div className="card" style={{ ...credCardSide(), minHeight: 140, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={credName()}>Privacy Pools</div>
            <div style={credSub()}>Vitalik et al. · 2023</div>
          </div>
          <div className="card" style={{ ...credCardSide(), minHeight: 140, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={credName()}>x402</div>
            <div style={credSub()}>Agent payment rail</div>
          </div>
          <div className="card" style={{ ...credCardSide(), minHeight: 140, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={credName()}>0xbow</div>
            <div style={credSub()}>Upstream fork · $3.5M seed</div>
          </div>
        </div>
      </section>

      {/* Three-up "how it works" */}
      <section className="relative z-10 px-5 md:px-10 lg:px-14 pt-10 pb-24">
        <div className="text-center mb-10">
          <div className="lbl">How it works · in three motions</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 max-w-6xl mx-auto">
          {[
            {
              num: "01",
              title: "Deposit",
              body:
                "Agent sends USDC + a commitment hash. Goes into the Merkle tree alongside everyone else.",
            },
            {
              num: "02",
              title: "Prove",
              body:
                "Groth16 proof of pool membership without revealing which deposit. ASP gates the clean subset.",
            },
            {
              num: "03",
              title: "Withdraw",
              body:
                "Funds land at a fresh address. No on-chain link between the sender and receiver agent.",
            },
          ].map((s) => (
            <article key={s.num} className="card p-7">
              <div className="display text-6xl text-[var(--hot)] leading-none">
                {s.num}
              </div>
              <div
                className="display text-3xl mt-4"
                style={{ fontStyle: "italic" }}
              >
                {s.title}
              </div>
              <p className="mt-3 text-[15px] leading-snug text-[var(--ink-soft)]">
                {s.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      <footer className="relative z-10 border-t border-[rgba(12,26,14,0.18)] px-5 md:px-10 lg:px-14 py-7">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
          <div className="lbl">© zBase Labs · 2026</div>
          <div className="flex items-center gap-3 lbl">
            <a
              href="https://x.com/zbase__"
              target="_blank"
              rel="noreferrer"
              aria-label="zBase on X"
              className="hover:text-[var(--hot)] inline-flex items-center gap-1.5"
              style={{ minHeight: 44, padding: "10px 12px" }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden style={{ display: "block" }}>
                <path
                  fill="currentColor"
                  d="M18.244 2H21.5l-7.5 8.57L22.75 22h-6.84l-5.36-7-6.13 7H1.16l8.02-9.16L1.25 2h7l4.84 6.39L18.244 2zm-1.2 18.39h1.9L7.04 3.5H5.04l12.004 16.89z"
                />
              </svg>
              @zbase__
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
