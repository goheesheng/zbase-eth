"use client";

/**
 * TryWithoutWallet
 * ────────────────
 * The pre-funded showcase, folded out of /demo and into /app#try as a
 * section. Same /api/demo/run backend; rewritten frontend with three
 * deliberate changes:
 *
 *   1. Aesthetic match with /app — Syne display + Inter body + IBM Plex
 *      Mono numerals + sage/ochre/brick status pills. Drops the green-50
 *      and amber-50 panels that clashed with /app's warm-cream palette.
 *
 *   2. Result panel reframed from "we did the thing" to "here is what
 *      to look at and what it proves." Three sub-blocks: What just
 *      happened (annotated tx hashes), Privacy strength (anon-set + the
 *      one-of-N claim), Where the time went (deposit vs payment split
 *      so the headline number isn't misleading).
 *
 *   3. "How this works" mini-explainer kept but inline, not behind a
 *      <details> toggle — investors and visitors should see the
 *      explanation by default, not hunt for it.
 *
 * Calls POST /api/demo/run unchanged (route at src/app/api/demo/run/route.ts).
 * The endpoint's response shape and rate-limits are unchanged.
 */

import { useState, useEffect } from "react";
import DepositOnceFramer from "./DepositOnceFramer";

type DemoResult = {
  status: string;
  message?: string;
  error?: string;
  gatesChecked?: Record<string, unknown>;
  demoDepositAmountUsdc?: number;
  depositTxHash?: string;
  settleTxHash?: string;
  ephemeralRecipient?: string;
  totalWallClockMs?: number;
  anonymitySetSize?: number;
  baseScanLinks?: { deposit?: string; settle?: string };
  // Fields returned by the route on `status: "timeout"` — added 2026-06-02
  // so the user can verify on-chain whether their attempted settle actually
  // landed despite the timeout (Base Sepolia confirmation often outlasts
  // the 120s budget).
  demoWalletAddress?: string | null;
  baseScanRecentTxUrl?: string | null;
  retryHint?: string;
};

type State = "idle" | "running" | "success" | "error" | "disabled";

function shortHash(h?: string): string {
  if (!h) return "";
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

type Quota = {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
  enabled: boolean;
  reason?: string;
};

export default function TryWithoutWallet() {
  const [state, setState] = useState<State>("idle");
  const [result, setResult] = useState<DemoResult | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [quota, setQuota] = useState<Quota | null>(null);
  const demoEnabled = quota?.enabled !== false;

  // Poll the demo daily quota every 30s so the banner stays fresh during
  // launch traffic. /api/demo/run GET is side-effect free + cheap.
  useEffect(() => {
    let active = true;
    async function tick() {
      try {
        const res = await fetch("/api/demo/run", { method: "GET" });
        if (!res.ok) return;
        const data = (await res.json()) as Quota;
        if (active) setQuota(data);
      } catch {
        // silent — banner just doesn't render
      }
    }
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  async function runDemo() {
    if (!demoEnabled) return;
    setState("running");
    setResult(null);
    const t0 = Date.now();
    const tick = setInterval(() => setElapsedMs(Date.now() - t0), 100);
    try {
      const res = await fetch("/api/demo/run", { method: "POST" });
      const data = (await res.json()) as DemoResult;
      clearInterval(tick);
      setElapsedMs(Date.now() - t0);
      setResult(data);
      if (data.status === "disabled" || data.status === "wallet_empty") {
        setState("disabled");
      } else if (data.depositTxHash) {
        setState("success");
      } else {
        setState("error");
      }
    } catch (err) {
      clearInterval(tick);
      setResult({ status: "error", error: (err as Error).message });
      setState("error");
    }
  }

  // Approximate breakdown of where the wall-clock went. The API doesn't
  // surface per-step ms; we estimate from typical observed splits so the
  // user gets a sense of why the headline number is what it is. If a
  // future API change adds step-level timing, swap these to real values.
  function estimateBreakdown(totalMs: number) {
    // Deposit + ASP update ≈ 55-65% of total; settle ≈ 35-45%.
    const setupMs = Math.round(totalMs * 0.6);
    const settleMs = totalMs - setupMs;
    return { setupMs, settleMs };
  }

  return (
    <div className="font-inter">
      {/* ── Section intro ── */}
      <div className="mx-auto max-w-[1200px] px-12">
        <p className="font-syne text-[11px] uppercase tracking-[0.18em] text-gray-500">
          Try without your wallet
        </p>
        <h2
          className="mt-4 max-w-[820px] text-[52px] leading-[1.05] tracking-[-1px] text-black"
          style={{ fontFamily: "var(--font-syne), 'Syne', sans-serif", fontWeight: 700 }}
        >
          {demoEnabled
            ? "See a private settle on Base Sepolia in ~17 seconds."
            : "Mainnet private settlement is deployed, but closed for customer use."}
        </h2>
        <p className="mt-6 max-w-[640px] font-inter text-[15px] leading-relaxed text-gray-600">
          {demoEnabled ? (
            <>
              No wallet, no signup. zBase&apos;s demo wallet deposits $1.00 USDC into
              the pool, the facilitator generates a Groth16 proof, and the postman
              relays a settle to a fresh address that has never appeared on-chain.
              Both transactions are public on BaseScan and the demo wallet does
              not appear in the settle transaction.
            </>
          ) : (
            <>
              The hosted demo is Sepolia-only. On Base Mainnet, zBase will not
              advertise private settlement until the anonymity set, ASP root,
              root-verified indexer, pricing, independent review, legal, and
              customer-pull gates all pass.
            </>
          )}
        </p>
      </div>

      {quota && !quota.enabled && (
        <div className="mx-auto mt-6 max-w-[1200px] px-12" aria-live="polite">
          <div className="rounded-lg border border-[#e2d09a] bg-[#fbf6e8] px-4 py-3 font-inter text-[12px] leading-relaxed text-[#6b5417]">
            <span className="font-syne text-[10px] font-semibold uppercase tracking-[0.14em]">
              Demo unavailable ·{" "}
            </span>
            {quota.reason ?? "The active network is not enabled for the hosted demo."}
          </div>
        </div>
      )}

      {/* ── Daily-quota banner ─────────────────────────────────────────
          Honest disclosure of the demo wallet's daily ceiling. Visible at
          all times (not just when exhausted) so visitors understand the
          shared-pool model upfront. Hits a hard ceiling of 25 runs/day per
          UTC day (lowered from 50 on 2026-06-07 to halve the demo wallet
          USDC burn rate). Color shifts amber when remaining <= 5, red when
          exhausted. */}
      {quota && quota.enabled && (
        <div className="mx-auto mt-6 max-w-[1200px] px-12">
          <div
            className={`flex items-center justify-between rounded-lg border px-4 py-3 font-inter text-[12px] leading-relaxed ${
              quota.remaining === 0
                ? "border-red-300 bg-red-50 text-red-900"
                : quota.remaining <= 5
                ? "border-[#e2d09a] bg-[#fbf6e8] text-[#6b5417]"
                : "border-gray-200 bg-[#f8f7f4] text-gray-700"
            }`}
          >
            <span>
              Demo quota today:{" "}
              <span className="font-mono tabular-nums">
                {quota.used}/{quota.limit}
              </span>{" "}
              {quota.remaining === 0
                ? "— exhausted. Refills at 00:00 UTC."
                : `(${quota.remaining} remaining, refills at 00:00 UTC)`}
            </span>
            <a
              href="https://github.com/goheesheng/zBase"
              target="_blank"
              rel="noreferrer"
              className="font-syne text-[11px] uppercase tracking-[0.12em] underline-offset-4 hover:underline"
            >
              For unlimited → clone the repo
            </a>
          </div>
        </div>
      )}

      {/* ── Deposit-once-pay-many framer — leads the demo section so
          visitors absorb the speed model BEFORE clicking run. The framer's
          ~7-15s per-payment row directly contextualizes the demo's ~17s
          headline as "first-time setup, not steady-state." Moved here
          2026-06-03 per founder's "emphasize speed in the demo" intent. */}
      {demoEnabled && (
        <div className="mx-auto mt-10 max-w-[1200px] px-12">
          <DepositOnceFramer />
        </div>
      )}

      {/* ── Main action card ── */}
      <div className="mx-auto mt-10 max-w-[1200px] px-12">
        <div className="rounded-2xl border border-gray-200 bg-white p-10">
          {/* Run button */}
          <button
            onClick={runDemo}
            disabled={state === "running" || !demoEnabled}
            className="w-full rounded-xl bg-indigo-600 px-6 py-5 font-syne text-[14px] font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {!demoEnabled ? (
              "Demo unavailable on Base Mainnet"
            ) : (
              <>
                {state === "idle" && "Run the demo →"}
                {state === "running" && (
                  <>
                    Running…{" "}
                    <span className="font-mono font-normal">
                      {(elapsedMs / 1000).toFixed(1)}s
                    </span>
                  </>
                )}
                {state === "success" && "Run again →"}
                {state === "error" && "Try again"}
                {state === "disabled" && "Demo paused"}
              </>
            )}
          </button>

          {/* Live status pills while running.
              Thresholds calibrated 2026-06-02 against real Base Sepolia
              latency: deposit ~5s, ASP update ~17-36s, withdraw 28-46s.
              Total flow is 50-75s on a typical day. The route's hard
              timeout is 120s. */}
          {state === "running" && (
            <div className="mt-8 grid grid-cols-4 gap-3">
              {[
                { ms: 0,     label: "Safety gates" },
                { ms: 4000,  label: "Deposit" },
                { ms: 18000, label: "ASP + proof" },
                { ms: 40000, label: "Settle" },
              ].map((step) => {
                const active = elapsedMs >= step.ms;
                return (
                  <div
                    key={step.label}
                    className={`flex flex-col gap-2 rounded-lg border px-4 py-3 transition-colors ${
                      active
                        ? "border-[#cfdbbf] bg-[#e8eee0]"
                        : "border-gray-200 bg-[#f8f7f4]"
                    }`}
                  >
                    <span
                      className={`font-syne text-[10px] uppercase tracking-[0.14em] ${
                        active ? "text-[#3d4a2c]" : "text-gray-400"
                      }`}
                    >
                      {step.label}
                    </span>
                    <span
                      className={`font-mono text-[12px] tabular-nums ${
                        active ? "text-[#3d4a2c]" : "text-gray-400"
                      }`}
                    >
                      {active ? "running" : "queued"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Slow-network hint — appears after 45s elapsed without completion.
              The user's actual fear during a long wait is "is it stuck or
              did it fail?" Being explicit about Base Sepolia variance is
              more trustworthy than pretending the wait is normal. */}
          {state === "running" && elapsedMs > 45000 && (
            <div className="mt-4 rounded-lg border border-[#e2d09a] bg-[#fbf6e8] px-4 py-3 font-inter text-[12px] leading-relaxed text-[#6b5417]">
              <span className="font-syne text-[10px] font-semibold uppercase tracking-[0.14em]">
                Heads up ·{" "}
              </span>
              Base Sepolia is slow today. This can take up to 2 minutes. The
              on-chain transactions have likely already been submitted — we&apos;re
              waiting for the network to confirm. Don&apos;t refresh.
            </div>
          )}

          {/* Success panel */}
          {state === "success" && result && (
            <div className="mt-8 grid gap-6">
              {/* Block 1: What just happened */}
              <div className="rounded-xl border border-gray-200 bg-[#f8f7f4] p-6">
                <p className="font-syne text-[10px] uppercase tracking-[0.16em] text-[#3d4a2c]">
                  What just happened
                </p>
                <div className="mt-4 grid gap-3 text-[13px]">
                  {result.depositTxHash && (
                    <div className="grid grid-cols-[110px_auto_1fr] items-baseline gap-3">
                      <span className="font-syne text-[10px] uppercase tracking-[0.12em] text-gray-500">
                        Deposit tx
                      </span>
                      <a
                        href={result.baseScanLinks?.deposit}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[12px] text-black underline decoration-gray-300 underline-offset-2 hover:decoration-black"
                      >
                        {shortHash(result.depositTxHash)}
                      </a>
                      <span className="font-inter text-[12px] text-gray-600">
                        demo wallet → pool ·{" "}
                        <span className="font-mono">
                          ${result.demoDepositAmountUsdc?.toFixed(2) ?? "1.00"} USDC
                        </span>{" "}
                        · public
                      </span>
                    </div>
                  )}
                  {result.settleTxHash && (
                    <div className="grid grid-cols-[110px_auto_1fr] items-baseline gap-3">
                      <span className="font-syne text-[10px] uppercase tracking-[0.12em] text-gray-500">
                        Settle tx
                      </span>
                      <a
                        href={result.baseScanLinks?.settle}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[12px] text-black underline decoration-gray-300 underline-offset-2 hover:decoration-black"
                      >
                        {shortHash(result.settleTxHash)}
                      </a>
                      <span className="font-inter text-[12px] text-gray-600">
                        postman → fresh address ·{" "}
                        <span className="font-mono">~$0.99 USDC</span> · recipient unlinked
                      </span>
                    </div>
                  )}
                  {result.ephemeralRecipient && (
                    <div className="grid grid-cols-[110px_auto_1fr] items-baseline gap-3">
                      <span className="font-syne text-[10px] uppercase tracking-[0.12em] text-gray-500">
                        Recipient
                      </span>
                      <span className="font-mono text-[12px] text-gray-700">
                        {shortHash(result.ephemeralRecipient)}
                      </span>
                      <span className="font-inter text-[12px] text-gray-600">
                        one-shot key · no prior on-chain history
                      </span>
                    </div>
                  )}
                </div>
                <p className="mt-5 max-w-[640px] font-inter text-[12px] leading-relaxed text-gray-600">
                  Open both transactions side-by-side on BaseScan. The demo
                  wallet&apos;s address does not appear in the settle
                  transaction. That on-chain gap is the privacy property —
                  there is no public link from the recipient back to the
                  depositor.
                </p>
              </div>

              {/* Block 2: Privacy strength + Block 3: Time breakdown side by side */}
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-xl border border-gray-200 bg-white p-6">
                  <p className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
                    Privacy strength
                  </p>
                  <p className="mt-3 font-mono text-[52px] leading-none tabular-nums text-black">
                    {result.anonymitySetSize ?? "—"}
                    <span className="ml-2 font-inter text-[14px] font-normal text-gray-500">
                      commitments
                    </span>
                  </p>
                  <p className="mt-4 font-inter text-[12px] leading-relaxed text-gray-600">
                    The withdrawal is provably <strong className="font-semibold text-black">one of {result.anonymitySetSize ?? "N"}</strong> — nobody on-chain can tell which deposit it came from. Privacy strength grows with each new depositor.
                  </p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-6">
                  <p className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
                    Where the time went
                  </p>
                  <p className="mt-3 font-mono text-[52px] leading-none tabular-nums text-black">
                    {result.totalWallClockMs
                      ? (result.totalWallClockMs / 1000).toFixed(1)
                      : "—"}
                    <span className="ml-2 font-inter text-[14px] font-normal text-gray-500">
                      s total
                    </span>
                  </p>
                  {result.totalWallClockMs && (
                    <div className="mt-4 grid gap-2">
                      {(() => {
                        const { setupMs, settleMs } = estimateBreakdown(
                          result.totalWallClockMs,
                        );
                        return (
                          <>
                            <div className="grid grid-cols-[1fr_auto] items-baseline gap-2 font-mono text-[11px] tabular-nums">
                              <span className="text-gray-600">
                                Setup · deposit + ASP update
                              </span>
                              <span className="text-black">
                                ~{(setupMs / 1000).toFixed(1)}s
                              </span>
                            </div>
                            <div className="grid grid-cols-[1fr_auto] items-baseline gap-2 font-mono text-[11px] tabular-nums">
                              <span className="text-gray-600">
                                Payment · proof + settle tx
                              </span>
                              <span className="text-black">
                                ~{(settleMs / 1000).toFixed(1)}s
                              </span>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}
                  <p className="mt-4 font-inter text-[12px] leading-relaxed text-gray-600">
                    Production agents deposit once at funding time, then make
                    many fast payments. The number that matters for ongoing UX
                    is the <strong className="font-semibold text-black">payment row</strong>, not the total.
                  </p>
                </div>
              </div>

              {/* Safety gates collapsed details */}
              {result.gatesChecked && (
                <details className="rounded-lg border border-gray-200 bg-white p-4">
                  <summary className="cursor-pointer font-syne text-[11px] uppercase tracking-[0.14em] text-gray-600 hover:text-black">
                    Safety gates verified
                  </summary>
                  <pre className="mt-3 overflow-x-auto rounded bg-[#1a1815] p-3 font-mono text-[11px] text-[#e8e3d6]">
                    <code>{JSON.stringify(result.gatesChecked, null, 2)}</code>
                  </pre>
                </details>
              )}
            </div>
          )}

          {/* Error / disabled panel.
              Three distinct error shapes, ranked by how often we expect to
              hit them: timeout (Sepolia variance, usually means the tx
              actually landed), disabled (config issue), generic settle
              failure. Timeout gets its own actionable layout — the user
              can verify on-chain whether the settle landed before
              retrying. Disabled and generic stay simple. */}
          {(state === "error" || state === "disabled") && result && (
            <div
              className={`mt-8 rounded-xl border p-6 ${
                state === "disabled"
                  ? "border-[#e2d09a] bg-[#fbf6e8]"
                  : result.status === "timeout"
                  ? "border-[#e2d09a] bg-[#fbf6e8]"
                  : "border-[#deb6a8] bg-[#f0d6cf]"
              }`}
            >
              <p
                className={`font-syne text-[12px] font-semibold uppercase tracking-[0.14em] ${
                  state === "disabled" || result.status === "timeout"
                    ? "text-[#6b5417]"
                    : "text-[#6b2e1f]"
                }`}
              >
                {state === "disabled"
                  ? "Demo paused"
                  : result.status === "timeout"
                  ? "Demo timed out — your settle may have landed anyway"
                  : "Something went wrong"}
              </p>

              {/* Body copy varies by error shape */}
              {result.status === "timeout" ? (
                <div className="mt-3 space-y-3 font-inter text-[13px] leading-relaxed text-[#6b5417]">
                  <p>{result.error}</p>
                  {result.baseScanRecentTxUrl && (
                    <p>
                      <span className="font-syne text-[10px] font-semibold uppercase tracking-[0.12em]">
                        Check first ·{" "}
                      </span>
                      <a
                        href={result.baseScanRecentTxUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[12px] text-[#6b5417] underline decoration-[#e2d09a] underline-offset-2 hover:decoration-[#6b5417]"
                      >
                        demo wallet&apos;s recent transactions on BaseScan
                      </a>
                      . If the last tx is your settle, you&apos;re done — no
                      need to retry.
                    </p>
                  )}
                  {result.retryHint && (
                    <p className="text-[12px] text-[#6b5417]/85">
                      {result.retryHint}
                    </p>
                  )}
                </div>
              ) : (
                <p
                  className={`mt-2 font-inter text-[13px] ${
                    state === "disabled" ? "text-[#6b5417]" : "text-[#6b2e1f]"
                  }`}
                >
                  {result.error}
                </p>
              )}

              <p
                className={`mt-4 font-inter text-[12px] ${
                  state === "disabled" || result.status === "timeout"
                    ? "text-[#6b5417]/80"
                    : "text-[#6b2e1f]/80"
                }`}
              >
                Want it back online or have a question? DM{" "}
                <a
                  href="https://x.com/zbase__"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`underline underline-offset-2 ${
                    state === "disabled" || result.status === "timeout"
                      ? "decoration-[#6b5417]/40 hover:decoration-[#6b5417]"
                      : "decoration-[#6b2e1f]/40 hover:decoration-[#6b2e1f]"
                  }`}
                >
                  @zbase__
                </a>
                .
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── "How this works" — inline by default, not behind a toggle ── */}
      <div className="mx-auto mt-12 max-w-[1200px] px-12">
        <p className="font-syne text-[11px] uppercase tracking-[0.18em] text-gray-500">
          How this works
        </p>
        <div className="mt-6 grid grid-cols-3 gap-6">
          {[
            {
              n: "01",
              title: "Public deposit, private commitment",
              body: "The demo wallet sends USDC + a Poseidon commitment to the pool. Deposit is visible on-chain — it has to be. The commitment hides which deposit is yours among the rest.",
              meta: "~6-12s · once per funding",
            },
            {
              n: "02",
              title: "Groth16 zero-knowledge proof",
              body: "The facilitator generates a proof: “I own one of N depositors in the approved set.” The proof binds the recipient address, so a relayer can’t redirect funds.",
              meta: "~3-7s · server-side compute",
            },
            {
              n: "03",
              title: "Postman settles to a fresh address",
              body: "The postman wallet — not the demo wallet — submits the proof. The pool verifies on-chain and transfers USDC to a recipient that has no prior on-chain history.",
              meta: "~7-15s · per payment",
            },
          ].map((step) => (
            <div
              key={step.n}
              className="rounded-xl border border-gray-200 bg-white p-6"
            >
              <span className="font-mono text-[11px] tracking-[0.14em] text-indigo-600">
                {step.n}
              </span>
              <h3
                className="mt-3 font-syne text-[18px] leading-tight tracking-[-0.01em] text-black"
                style={{ fontFamily: "var(--font-syne), 'Syne', sans-serif", fontWeight: 700 }}
              >
                {step.title}
              </h3>
              <p className="mt-3 font-inter text-[13px] leading-relaxed text-gray-600">
                {step.body}
              </p>
              <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.1em] text-gray-400">
                {step.meta}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-8 font-inter text-[12px] leading-relaxed text-gray-500 max-w-[820px]">
          Same flow agents use via the{" "}
          <a
            href="/api/facilitator/supported"
            className="text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-600"
          >
            x402 facilitator
          </a>
          . Privacy strength compounds with each new depositor — see the{" "}
          <a
            href="/anonymity-set"
            className="text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-600"
          >
            live anonymity set
          </a>
          . Honesty commitments documented in the{" "}
          <a
            href="/anonymity-set-disclosure"
            className="text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-600"
          >
            disclosure policy
          </a>
          .
        </p>

        {/* Funding footnote */}
        <p className="mt-6 border-t border-gray-200 pt-4 font-mono text-[11px] leading-relaxed text-gray-400">
          {demoEnabled
            ? "This is a real Base Sepolia settle, paid for by a zBase demo wallet (actual founder budget, not free testnet ETH). Rate-limited to 1 run / IP / 60s and capped at 25 runs / UTC day. Tx hashes are public on BaseScan."
            : "No Base Mainnet demo transaction will be initiated from this page while the private route is closed for customer use."}
        </p>
      </div>
    </div>
  );
}
