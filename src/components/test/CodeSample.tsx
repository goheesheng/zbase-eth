"use client";

/**
 * CodeSample
 * ──────────
 * Renders a curl / TypeScript / Python snippet group with copy buttons.
 * The samples below each interactive step in /test are the differentiating
 * feature for agent developers — every form action is mirrored as code they
 * can paste into their own stack.
 *
 * Aesthetic notes (within the existing zBase vocabulary):
 *   - Tab strip is small uppercase Syne, matching the banner.
 *   - Code uses IBM Plex Mono (already loaded). Slight letter-spacing to
 *     keep dense bash one-liners readable.
 *   - Copy button is text-only ("Copy" / "Copied"), no icon — same restraint
 *     as the banner's no-icon status pills.
 *   - Background is #1a1815 (off-black, not pure black), text #e8e3d6
 *     (off-white). Slightly warm to match the rest of the page.
 *
 * Usage:
 *   <CodeSample
 *     samples={{
 *       curl: `curl -X POST ...`,
 *       typescript: `await fetch(...)`,
 *       python: `requests.post(...)`,
 *     }}
 *   />
 */

import { useState } from "react";

type Lang = "curl" | "typescript" | "python";

interface Props {
  samples: Partial<Record<Lang, string>>;
  /** Optional caption rendered above the tabs (e.g. "Equivalent request"). */
  caption?: string;
}

const LANG_LABELS: Record<Lang, string> = {
  curl: "curl",
  typescript: "typescript",
  python: "python",
};

export default function CodeSample({ samples, caption }: Props) {
  const available = (Object.keys(samples) as Lang[]).filter(
    (k) => typeof samples[k] === "string" && samples[k]!.length > 0,
  );
  const [active, setActive] = useState<Lang>(available[0] || "curl");
  const [copied, setCopied] = useState(false);

  if (available.length === 0) return null;

  const activeText = samples[active] ?? "";

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(activeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // navigator.clipboard requires HTTPS or localhost; if it fails the
      // user is in an exotic env and can select-all manually.
    }
  }

  return (
    <div className="overflow-hidden rounded-md border border-[#2a2620] bg-[#1a1815]">
      {/* ── Header strip ── */}
      <div className="flex items-center justify-between border-b border-[#2a2620] bg-[#221f1a] px-3 py-2">
        <div className="flex items-center gap-3">
          {caption && (
            <span className="font-syne text-[10px] uppercase tracking-[0.18em] text-[#8a8174]">
              {caption}
            </span>
          )}
          <div className="flex gap-0.5">
            {available.map((lang) => (
              <button
                key={lang}
                onClick={() => setActive(lang)}
                className={`rounded px-2.5 py-1 font-syne text-[10px] uppercase tracking-[0.14em] transition-colors ${
                  active === lang
                    ? "bg-[#332e26] text-[#e8e3d6]"
                    : "text-[#8a8174] hover:text-[#cfc8b8]"
                }`}
              >
                {LANG_LABELS[lang]}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={handleCopy}
          className="font-syne text-[10px] uppercase tracking-[0.14em] text-[#8a8174] transition-colors hover:text-[#e8e3d6]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* ── Code body ── */}
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12px] leading-[1.6] text-[#e8e3d6]">
        <code>{activeText}</code>
      </pre>
    </div>
  );
}
