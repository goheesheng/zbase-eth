# @zbase-protocol/mcp

> MCP server for **zBase** — a private x402 agent wallet on Base. Lets Claude Code / Claude Desktop /
> Cursor / any MCP client fund a wallet and pay x402 APIs privately, from natural language.

> **Agents:** read [`AGENTS.md`](./AGENTS.md) and [`SECURITY.md`](./SECURITY.md) before moving funds.

The server is a **local-seed wallet**: every note derives from a 12-word seed stored on disk
(`~/.zbase/…`). You (the agent) never handle raw secrets — you call tools. It talks x402 to the
hosted facilitator at `https://zbase.app` (Base mainnet, `eip155:8453`).

## Add it to your MCP client

Once published:

```bash
claude mcp add zbase -- npx -y @zbase-protocol/mcp@latest
```

`@latest` keeps you on the newest money-safety fixes (recommended during the pilot). Pin a specific
reviewed version only if you need a reproducible install and track releases. Or run from source in this
repo: `npm run build && node dist/index.js`.

## Tools (5)

| Tool | What it does | Annotation |
|---|---|---|
| `fund_address` | Returns your seed-derived USDC deposit address (send USDC from any wallet; no ETH needed). | read-only |
| `fund_sweep` | Sweeps funded USDC into the ZK privacy pool via a gasless EIP-3009 authorization. `amount` optional (sweep all). | moves funds |
| `balance` | Spendable pool balance, rebuilt from the seed + on-chain commitments. Reports `largestNoteUSDC` (each pay spends ONE note). | read-only |
| `pay` | Pays + fetches any x402 URL privately (single-use payer address, ordinary x402 to the seller). | moves funds; check `outcome` before retry |
| `seed_backup` | Reveals the 12-word seed (SENSITIVE — appears in the transcript). Only on explicit user request. | read-only, sensitive |

## Money-safety (the one rule)

Every `pay` result carries an `outcome`. `refused` (incompatible seller) or a clean pre-settlement
error means the note is UNTOUCHED — retrying is safe. `uncertain`, or `delivered` with no 2xx, means the
note may be or **is** spent — and `pay` selects a **different** note on the next call, so a blind retry
pays twice. Run `balance`, confirm whether you were charged, and only pay again if you were not. Never
start a new payment for the same purchase without checking `balance` first.

## Typical flow

`fund_address` → user sends USDC → `fund_sweep` → `pay <url>`. `balance` any time. A payment larger
than the biggest single note fails even when the total covers it (each pay spends one note).

See the SDK the tools wrap: [`@zbase-protocol/core`](https://www.npmjs.com/package/@zbase-protocol/core).
