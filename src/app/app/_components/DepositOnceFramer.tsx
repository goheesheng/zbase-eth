"use client";

/**
 * DepositOnceFramer
 * ─────────────────
 * Reusable explainer card that answers the most common "is this too slow?"
 * question we hear from people first running the demo. Production zBase
 * users don't experience 50-117s per payment — that's the full first-time
 * flow. After the initial deposit, each subsequent withdraw or x402 settle
 * is ~7-15s on Base Sepolia today.
 *
 * Used in two surfaces:
 *   - `/app#integrate` — agent devs landing to integrate via SDK/x402
 *   - `/test` between Step 2 (faucet) and Step 3 (deposit/withdraw)
 *
 * The voice was lifted from TryWithoutWallet.tsx:330-335 which already nails
 * the framing inside the demo success panel. This component carries that
 * framing into surfaces where the demo's success panel isn't visible.
 *
 * Aesthetic primitives (matches NetworkStackBanner, Faucet, DepositWithdraw):
 *   - Syne uppercase kicker, Fraunces-style serif italic for the emphasized
 *     word in the headline (rendered via inline span; Fraunces variable is
 *     loaded in the layout)
 *   - IBM Plex Mono tabular numerals for every numeric value
 *   - Sage / ochre / indigo status tones — never traffic-light colors
 *   - Indigo accent used exactly once (the headline's italic word + the
 *     left-rail divider on the "what an agent does" pull-quote)
 *   - Warm cream surface (#f8f7f4) on a white card so it sits inside any
 *     parent section without fighting the surrounding palette
 *
 * Honest about what's measured: the 2026-06-02 footnote dates the numbers
 * and signals that mainnet will be different. Replacing this constant
 * later is a 1-line edit.
 */

const MEASURED_DATE = "2026-06-02";

export default function DepositOnceFramer() {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-8 md:p-10">
      {/* Kicker */}
      <p className="font-syne text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
        Why one big deposit, not many small ones
      </p>

      {/* Headline — Syne bold with one Fraunces italic word */}
      <h3
        className="mt-4 max-w-[720px] text-[42px] leading-[1.06] tracking-[-0.5px] text-black"
        style={{ fontFamily: "var(--font-syne), 'Syne', sans-serif", fontWeight: 700 }}
      >
        Deposit once.{" "}
        <span
          className="text-indigo-600"
          style={{
            fontFamily: "var(--font-fraunces), 'Fraunces', serif",
            fontStyle: "italic",
            fontWeight: 400,
          }}
        >
          Pay many times.
        </span>
      </h3>

      {/* Body paragraph */}
      <p className="mt-5 max-w-[680px] font-inter text-[14px] leading-relaxed text-gray-600">
        Each deposit funds a shielded balance you can spend across many
        private payments — to x402 providers, to agents, to fresh addresses.
        The setup transaction is one-time per funding event. After that,
        every payment is just a Groth16 proof plus a relay tx — the
        postman wallet sends USDC to the recipient and your wallet never
        appears in the settle transaction.
      </p>

      {/* 3-column data grid */}
      <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* SETUP */}
        <div className="rounded-xl border border-gray-200 bg-[#f8f7f4] p-5">
          <p className="font-syne text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
            Setup · one-time
          </p>
          <p className="mt-3 font-mono text-[36px] leading-none tabular-nums text-black">
            ~15<span className="text-gray-400">–</span>25
            <span className="ml-1 font-inter text-[14px] font-normal text-gray-500">
              s
            </span>
          </p>
          <p className="mt-3 font-inter text-[12px] leading-relaxed text-gray-600">
            Deposit tx + ASP root update + first proof. Per funding event,
            not per payment.
          </p>
        </div>

        {/* EACH PAYMENT — the load-bearing claim, indigo-tinted */}
        <div className="rounded-xl border border-[#c4c8eb] bg-[#e0e3f6] p-5">
          <p className="font-syne text-[10px] font-semibold uppercase tracking-[0.16em] text-[#1d2566]">
            Each payment
          </p>
          <p className="mt-3 font-mono text-[36px] leading-none tabular-nums text-[#1d2566]">
            ~7<span className="text-[#1d2566]/50">–</span>15
            <span className="ml-1 font-inter text-[14px] font-normal text-[#1d2566]/70">
              s
            </span>
          </p>
          <p className="mt-3 font-inter text-[12px] leading-relaxed text-[#1d2566]/80">
            Proof + relay tx on Base Sepolia after the initial deposit.
            This is what your agent feels in production.
          </p>
        </div>

        {/* RECOMMENDED FUND */}
        <div className="rounded-xl border border-gray-200 bg-[#f8f7f4] p-5">
          <p className="font-syne text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
            Recommended fund
          </p>
          <p className="mt-3 font-mono text-[36px] leading-none tabular-nums text-black">
            ~10
            <span className="ml-1 font-inter text-[14px] font-normal text-gray-500">
              USDC
            </span>
          </p>
          <p className="mt-3 font-inter text-[12px] leading-relaxed text-gray-600">
            Covers many x402 payments at the pool&apos;s 1 USDC minimum
            without re-funding mid-session.
          </p>
        </div>
      </div>

      {/* Pull quote — what agents actually do */}
      <div className="mt-7 border-l-2 border-indigo-500 pl-4">
        <p className="font-inter text-[13px] leading-relaxed text-gray-700">
          <span className="font-semibold text-black">
            Production agents deposit once at funding time, then make many
            fast payments.
          </span>{" "}
          The number that matters for ongoing UX is the per-payment row, not
          the full first-time flow you see in the demo.
        </p>
      </div>

      {/* Footnote */}
      <p className="mt-6 border-t border-gray-200 pt-4 font-mono text-[10px] leading-relaxed text-gray-400">
        Numbers measured against the live Base Sepolia stack on{" "}
        {MEASURED_DATE}. Mainnet figures will land tighter once we ship past
        testnet. Sepolia confirmation latency varies — see the demo at{" "}
        <a
          href="#try"
          className="text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-600"
        >
          /app#try
        </a>{" "}
        for a live end-to-end measurement.
      </p>
    </div>
  );
}
