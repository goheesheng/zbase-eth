"use client";

/**
 * EarlyProductNotice
 * ──────────────────
 * The top strip that tells a depositor, before they put money in, that zBase is an early
 * product and their payments are not private YET.
 *
 * WHY THIS EXISTS AT ALL
 * zBase settles real payments on mainnet today with a small anonymity set. The machinery
 * is real — Groth16 proofs, a fresh payer EOA per payment, OFAC-screened ASP — but a
 * privacy pool hides your withdrawal among N independent deposits, and while N is small
 * an observer can link the withdrawal back to the deposit. The payment works; the privacy
 * does not, yet.
 *
 * That gap is invisible from the outside. A not-private payment looks exactly like a
 * private one: same proof, same fresh payer, same receipt. The API discloses it in every
 * settle response (`privacy.private:false`), and the SDK makes callers pass
 * `acceptNotPrivate` — but a person using the web app reads neither. This banner is their
 * copy of that disclosure, shown before the deposit rather than after.
 *
 * IT READS THE LIVE NUMBER, DELIBERATELY.
 * A hardcoded "early access" ribbon rots: someone ships it, the set grows past the
 * minimum, and the app keeps apologising for a limitation that no longer exists — or
 * worse, someone deletes the ribbon early and the app silently over-claims. Both failures
 * come from a human having to remember. So this reads `customerReady` + the live
 * independent-depositor count from /api/facilitator/supported and disappears on its own
 * the moment the math is true. Nobody flips it. Same rule as `customerReady` itself.
 *
 * LAYOUT: this renders a 34px-tall FIXED strip, matching the existing Solana banner in
 * app/page.tsx, because the nav and every section are positioned against that exact height
 * (`top-[34px]`, `pt-[120px]`). So the copy is kept to ONE line on desktop deliberately —
 * a taller strip silently overlaps the nav. It reports visibility upward via `onVisible`
 * so the page can offset the nav, since the banner decides for itself (asynchronously)
 * whether to show.
 *
 * Aesthetic: matches NetworkStackBanner (Syne + Inter, warm #f8f7f4, ochre not yellow,
 * tabular nums, no icons — status is colour + word).
 */

import { useEffect, useState } from "react";

interface SupportedResponse {
  customerReady?: boolean;
  pilot?: {
    enabled?: boolean;
    anonymitySet?: number | null;
    minimumForPrivacy?: number;
  };
}

export default function EarlyProductNotice({
  onVisible,
}: {
  /** Fires with whether the strip is showing, so the page can offset its fixed nav. */
  onVisible?: (visible: boolean) => void;
}) {
  const [state, setState] = useState<SupportedResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/facilitator/supported")
      .then((r) => r.json())
      .then((d: SupportedResponse) => { if (!cancelled) setState(d); })
      // Stay SILENT on a fetch failure rather than guess. Rendering "not private" when we
      // could not read the state would be its own false claim, and the settle response
      // carries the authoritative disclosure regardless.
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const visible = state !== null && state.customerReady === false;
  useEffect(() => { onVisible?.(visible); }, [visible, onVisible]);

  // Nothing to say when the claim is real, or before we know.
  if (!visible) return null;

  const set = state.pilot?.anonymitySet;
  const min = state.pilot?.minimumForPrivacy;
  const counts =
    typeof set === "number" && typeof min === "number"
      ? `${set.toLocaleString("en-US")} of ${min.toLocaleString("en-US")}`
      : null;

  return (
    <div
      role="status"
      className="fixed top-0 left-0 right-0 z-[60] h-[34px] flex items-center justify-center gap-1.5 bg-[#f3e7c8] border-b border-[#e2d09a] text-[#6b5417] text-[12px] font-inter font-medium px-6 overflow-hidden"
    >
      <span className="font-semibold">Early product — payments are not private yet.</span>
      <span className="hidden sm:inline">
        {counts ? (
          <>
            The anonymity set is{" "}
            <span className="font-mono tabular-nums">{counts}</span> independent depositors, so a
            withdrawal can still be linked to your deposit.
          </>
        ) : (
          <>The anonymity set is still too small to hide a withdrawal from its deposit.</>
        )}{" "}
        It turns private automatically as more people deposit.
      </span>
      <a
        href="https://docs.zbase.app"
        target="_blank"
        rel="noopener noreferrer"
        className="underline shrink-0"
      >
        Details
      </a>
    </div>
  );
}
