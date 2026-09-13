type LogoProps = {
  size?: number;
  tone?: "ink" | "mint" | "paper";
  accent?: string;
  href?: string;
  className?: string;
  /** Use mono font for the wordmark (terminal-style contexts). */
  mono?: boolean;
};

const TONES: Record<NonNullable<LogoProps["tone"]>, { fg: string; filter: string }> = {
  // zbase-mark.png is dark (grayscale + alpha) — no filter needed on light backgrounds.
  ink: { fg: "#0c1a0e", filter: "none" },
  // On dark backgrounds, invert the mark so the Z reads as light.
  mint: { fg: "#d8efd9", filter: "invert(1) brightness(1.1)" },
  paper: { fg: "#f7f2e6", filter: "invert(1) brightness(1.1)" },
};

export function Logo({
  size = 28,
  tone = "ink",
  href = "/",
  className,
  mono = false,
}: LogoProps) {
  const { fg, filter } = TONES[tone];

  const inner = (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: Math.max(6, Math.round(size * 0.25)),
        lineHeight: 1,
        color: fg,
      }}
    >
      <img
        src="/zbase-mark.png"
        alt=""
        width={Math.round(size * 0.95)}
        height={Math.round(size * 1.26)}
        aria-hidden
        style={{
          display: "block",
          flexShrink: 0,
          filter,
          imageRendering: "auto",
        }}
      />
      <span
        style={{
          fontFamily: mono
            ? "var(--font-mono-tech), ui-monospace, monospace"
            : "var(--font-body), system-ui, sans-serif",
          fontWeight: 700,
          letterSpacing: mono ? "0.06em" : "-0.025em",
          fontSize: Math.round(size * (mono ? 0.78 : 0.88)),
          color: fg,
          textTransform: "none",
        }}
      >
        Base
      </span>
    </span>
  );

  if (!href) return inner;
  return (
    <a
      href={href}
      aria-label="zBase home"
      style={{
        textDecoration: "none",
        color: "inherit",
        display: "inline-flex",
        alignItems: "center",
        minHeight: 44,
        padding: "6px 4px",
      }}
    >
      {inner}
    </a>
  );
}
