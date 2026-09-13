# Security — @zbase-protocol/mcp

This MCP server controls a wallet. Treat it accordingly.

## Seed custody

- All funds derive from a 12-word seed stored locally under `~/.zbase/` (mode `0600`). Anyone who
  reads that seed owns every note. It is never sent to the facilitator or put on the wire.
- The facilitator (`https://zbase.app`) sees a note's spend secrets only at settle time (server-side
  proving). Pin `baseUrl` to a host you trust. It cannot forge a withdrawal (the verifier is
  on-chain) and cannot redirect a payment (the recipient is bound into the proof).
- `seed_backup` reveals the seed **into the client transcript**. Only call it on an explicit user
  request to back up, and tell the user to store it offline. A model that volunteers the seed has
  published the wallet.

## Running it

- Install with `@latest` (`npx -y @zbase-protocol/mcp@latest`) so you get the newest money-safety
  fixes — important during the pilot while the payment path is still hardening. If you prefer
  supply-chain conservatism, pin a specific reviewed version instead, and track releases so you do not
  strand yourself on an older build that is missing a safety fix.
- Run one instance per seed directory. Concurrent instances against the same seed can race on note
  selection.
- stdout is the MCP transport — the server logs only to stderr and never prints secrets to stdout.

## If the seed is compromised

Assume all funds are at risk immediately.

1. From a clean machine, create a NEW seed (new wallet home) and `fund_address` there.
2. Move any recoverable funds out of the old wallet: `pay` remaining balance to a destination you
   control, or reclaim deposits, until the old `balance` is zero.
3. Delete the old `~/.zbase/` seed file and rotate anything that shared the machine.
4. Do not reuse the compromised seed.

## Reporting

Report vulnerabilities via https://github.com/goheesheng/zBase/issues (or the contact on
https://zbase.app). Do not open a public issue with an active exploit against user funds.
