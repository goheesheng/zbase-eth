# @zbase-protocol/mcp — agent guide (v0.3.1)

This MCP server is a **local-seed wallet on Base**. You call tools; you never handle raw secrets.

## Tools

- `fund_address` (read-only) — get the USDC deposit address to give the user.
- `fund_sweep` (moves funds) — move funded USDC into the privacy pool. Omit `amount` to sweep all.
- `balance` (read-only) — spendable balance; `largestNoteUSDC` caps a single payment.
- `pay` (moves funds) — pay + fetch an x402 URL privately; read the result's `outcome` before any retry.
- `seed_backup` (read-only, SENSITIVE) — reveals the 12-word seed into the transcript. Only when the
  user explicitly asks to back up. Never volunteer it.

## The one money-safety rule

Every `pay` result carries an `outcome`. `refused` or a clean pre-settlement error means the note is
UNTOUCHED (safe to retry). `uncertain`, or `delivered` with no 2xx, means the note may be or **is**
spent — and `pay` re-selects a DIFFERENT note on the next call, so a blind retry pays twice. Run
`balance`, confirm you were not charged, and only then pay again. Never start a new payment for the same
purchase without checking `balance` first.

## Do / don't

- DO fund → sweep → pay in that order. A payment larger than `largestNoteUSDC` fails even if the
  total covers it (each pay spends one note).
- DON'T ask the user for private keys or note secrets, and don't paste them into the conversation.
- DON'T call `seed_backup` unless the user explicitly asks to back up their seed.

See `./SECURITY.md` for seed custody and the seed-compromise procedure. The example flow (no secrets)
is in `./examples/cli-flow.md`.
