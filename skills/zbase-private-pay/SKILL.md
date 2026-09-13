---
name: zbase-private-pay
description: Pay any x402 API privately from a zBase wallet on Base. Use when you or the user want to pay for a paid API/service privately, make an x402 payment without exposing the wallet, fund or check a private payment wallet, or set up (create/import) a zBase wallet. Covers "pay this API privately", "private x402 payment", "hide my payment wallet", "fund my zBase wallet", "sweep into the pool", "import my wallet".
triggers:
  - "pay this API privately"
  - "private x402 payment"
  - "hide my payment wallet"
  - "fund my zBase wallet"
  - "check my zBase wallet"
  - "sweep into the pool"
  - "import my zBase wallet"
---

# zBase - private x402 payments

Pay any x402 API so the on-chain payment does **not** name your wallet. Funds route through a shared
privacy pool via a ZK withdrawal; the seller is paid by a fresh single-use address and sees an
ordinary x402 payment. Live on Base mainnet.

Every operation runs the `zbase` CLI via `npx` - no global install, no MCP server, no path setup:

```bash
npx -y -p @zbase-protocol/mcp@0.2.1 zbase <command>
```

## Check first (idempotent)

Before setup, see if a wallet already exists and is funded:

```bash
npx -y -p @zbase-protocol/mcp@0.2.1 zbase balance
```

If it errors or shows zero spendable, run setup below. Otherwise skip to **Pay**.

## Set up a wallet (once)

The wallet is a 12-word BIP39 seed at `~/.zbase/seed` (0600). Every note derives from it.

- **Create new** (default): nothing to do - the first command generates a seed. After funding, back
  it up: `zbase seed show` (SENSITIVE - prints the 12 words; tell the user to store them offline).
- **Import existing**: `zbase seed import "word1 word2 ... word12"` (refuses to overwrite). For
  ephemeral/CI, set `ZBASE_SEED="<12 words>"` in the env instead.

## The flow

```bash
Z="npx -y -p @zbase-protocol/mcp@0.2.1 zbase"

$Z address        # give this USDC deposit address to the user (any wallet; no ETH needed)
$Z balance        # what arrived
$Z sweep          # move it into the privacy pool (gasless); now it's private
$Z pay https://api.seller.com/endpoint 0.05 --pilot   # pay + fetch privately
#   POST body:  add  --body '{"k":"v"}'      proven seller (skip free-probe):  --no-probe
#   check compatibility first for $0:        $Z probe <url>
```

- `0.05` = the max USDC you'll pay (a ceiling vs a hostile 402).
- `--pilot` acknowledges the open-pilot disclosure (the anonymity set is still filling toward 30, so
  the payment settles and delivers but is not yet crowd-anonymous).

## Money-safety (critical)

`pay` settlement is **idempotent on the note**. If a `pay` returns an UNCERTAIN or ambiguous result,
**retry the SAME `zbase pay` command** - do NOT start a new payment for the same purchase. Starting a
fresh payment is the only way to double-pay.

## Gotchas

- Each payment spends **one** note, so a payment larger than your biggest single note fails even when
  the total covers it - `balance` reports `largestNoteUSDC`.
- Never ask the user for private keys or paste the seed into the conversation. Only run `seed show`
  when the user explicitly asks to back up.
- Some sellers run a bespoke facilitator that won't honor a standard payload; the free-probe (default)
  refuses those for $0 before spending.

Docs: https://docs.zbase.app/install-mcp/ | SDK: `@zbase-protocol/core` | Full skill (MCP + CLI): https://zbase.app/SKILL.md
