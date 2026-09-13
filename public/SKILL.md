---
name: zbase-private-pay
description: Pay any Base-USDC x402 API privately from a zBase wallet. Payments are funded from a shared privacy pool via a Groth16 zero-knowledge withdrawal, so the on-chain payment does not name your wallet. Use when the user mentions zBase, x402, private payments, "pay for an API/service privately", "hide my payment wallet", an agent wallet, or when an agent must pay a per-request paid service without exposing its wallet. Routes shell-capable agents (Claude Code, Codex CLI, Gemini CLI) to the zbase CLI, and MCP chat apps (Claude Desktop, Cursor, Cherry Studio) to the zBase MCP server. Covers setup, create-or-import wallet, funding, and private paid calls. For MCP users, use plain non-technical language.
metadata:
  homepage: https://zbase.app
  openclaw:
    user-invocable: true
    requires:
      anyBins: [npx]
---

# Private payments with zBase

zBase is a private payment layer for x402 on Base. It lets your agent pay a Base-USDC x402 seller (a
pay-per-call API priced in USDC) so the on-chain payment does NOT name your wallet: funds route through a
shared privacy pool and each payment is made by a fresh single-use address. The seller is paid a
completely standard payment and never learns zBase was involved.

You host nothing; the facilitator is at https://zbase.app. zBase is in an open PILOT: the anonymity set
is still filling toward its privacy floor, so payments settle and deliver but are NOT yet crowd-anonymous.
Never tell the user a payment is "private" during the pilot - say the funds moved into the pool.

The tools run on Base mainnet by default. To target a different chain later, set `ZBASE_NETWORK` (for
example `eip155:84532` for Base Sepolia). Commands use `@latest` so you always get the newest
money-safety fixes; pin a specific version if you need a reproducible install.

## Choose the setup silently

Pick the setup from the host. Do NOT ask the user to choose a path.

- Use the CLI setup in Claude Code, Codex CLI, Gemini CLI, or another shell-capable agent.
- Use the MCP setup in Claude Desktop, Cursor, Cherry Studio, or another chat app that runs local MCP servers.

For MCP users, assume they may not know developer terms. Do NOT say "MCP server", "npx", "402", or
similar unless the user asks. Explain only what they need to do next, in plain language. If setup needs
to happen on the user's computer, guide them to Terminal with simple steps.

## Before any payment: authorize explicitly

`pay` and `sweep` move real money. Before each one, confirm with the user: the seller URL, the max USDC
amount, and (for a POST) the body. Do not pay or sweep on a vague request. During the pilot, also tell
the user the payment is not yet crowd-anonymous and get their OK before using `--pilot`.

## CLI setup: the zbase CLI

Each command is `npx -y -p @zbase-protocol/mcp@latest zbase <args>` (public npm, no install). Run the
FULL command every time - do not rely on a shell alias/variable: it will not survive across separate
agent tool calls, and in zsh (the macOS default shell) an unquoted `$Z` does not word-split.

1. Check first: `npx -y -p @zbase-protocol/mcp@latest zbase balance`. If it shows a spendable balance,
   skip to step 5.
2. Pick a wallet. Create new: do nothing, the first command generates a 12-word seed at ~/.zbase/seed
   (mode 0600). Import existing: put the 12 words on one line in ~/.zbase/seed then `chmod 600 ~/.zbase/seed`,
   or set ZBASE_SEED before first use. Avoid `zbase seed import "<words>"` - the phrase lands in shell history.
3. Get the deposit address to fund: `... zbase address`. The user sends USDC to it from any wallet (an
   ordinary transfer, no ETH needed) on Base mainnet.
4. Move the funds into the pool (gasless): `... zbase sweep`.
5. Pay and fetch an x402 URL: `... zbase pay <url> 0.05 --pilot`
   (POST body: add `--body '{"k":"v"}'`; check a seller for free first: `... zbase probe <url>`).

Notes: `0.05` is the max USDC you will pay (default 0.10). Each pay spends ONE note, so a pay larger than
your biggest single note fails even when the total covers it (`balance` reports `largestNoteUSDC`).

## MCP setup: chat apps (Claude Desktop, Cursor, ...)

zBase runs as a local stdio MCP server. Install it into the host:

- Claude Code (terminal): `claude mcp add zbase -- npx -y @zbase-protocol/mcp@latest`
- Claude Desktop, Cursor, Cherry Studio, or another MCP chat app: add this to the host's MCP config
  file, then restart the app:

  ```json
  {
    "mcpServers": {
      "zbase": { "command": "npx", "args": ["-y", "@zbase-protocol/mcp@latest"] }
    }
  }
  ```

When a non-technical user has nothing set up yet and their host is Claude Code, keep it simple:

> zBase is a private wallet for your agent. It lets me pay for paid services (like premium data or
> APIs) without exposing your wallet on the blockchain.
>
> To set it up, open Terminal (Launchpad, type Terminal, open it), paste this line, and press Return:
>
> ```bash
> claude mcp add zbase -- npx -y @zbase-protocol/mcp@latest
> ```
>
> Then restart your app and ask me to check your zBase wallet.

Do not continue with wallet or funding steps in that first setup message. After the user restarts and
asks to use their zBase wallet, use the available tools:

1. Check the balance with the `balance` tool.
2. Get a deposit address with `fund_address` and tell the user to send USDC to it (on Base mainnet).
3. Move funds into the pool with `fund_sweep`. Tell the user the funds moved into the pool (not
   "private" - during the pilot they are not yet crowd-anonymous).
4. Pay a service with `pay` after confirming the URL and max amount with the user. Tell them the cost.
5. To back up the wallet, ONLY on explicit request, use `seed_backup` (it prints the secret words into
   the chat; tell the user to store them offline and treat the chat as compromised for that wallet).

## Money-safety (critical)

Every `pay` result has an `outcome` and `safeToRetry`. Read them before doing anything else. This tool
picks a note fresh on every call, so a blind retry can spend a DIFFERENT note and pay twice:

- `outcome:"refused"` (incompatible seller) or a clean pre-settlement `error`: the note is UNTOUCHED.
  Retrying is safe (`safeToRetry:true`).
- `outcome:"delivered"`: the seller returned a 2xx. The note is spent, change derives from your seed.
  A 2xx proves the seller responded, not that the payload is correct - check the response yourself.
- `outcome:"settled_not_delivered"`: the note IS spent and the seller returned no 2xx. The money left,
  the value did not arrive. Do NOT re-pay this seller - the spend is final and a retry spends a
  DIFFERENT note. Check `sellerFault` in the result: it names a seller-side facilitator failure.
- `outcome:"uncertain"`: the note MAY be spent. Do NOT retry blindly - run `balance`, confirm whether
  you were charged, and only pay again if you were NOT.

Never start a new payment for the same purchase without first checking `balance`. A duplicate payment is
the one irreversible mistake.

## MCP user tone

Use this style for Claude Desktop and similar users:

- Speak in plain words.
- Say "zBase wallet" instead of package or server names after setup.
- Say "paid services" or "paid tools" instead of "x402 APIs".
- Say "add funds" instead of "deposit and sweep" unless a step needs the detail.
- Say "sign in" or "back up your words" instead of "seed" or "auth".
- Do not explain what the agent cannot do. Say what the user needs to do next.
- Do not mention packages, paths, headers, or networks unless needed for a specific payment issue.

## Targeting an x402 service

zBase has no service directory of its own - you bring the URL. It pays sellers that speak standard x402
with a Base-USDC `exact` offer (EIP-712 payment terms); it does NOT pay bespoke facilitators or non-Base
/ non-USDC offers. To find services, use an x402 directory such as the Coinbase x402 Bazaar, then pay the
endpoint's URL through zBase.

Before paying an unfamiliar URL, check it for free first:

- CLI: `... zbase probe <url>` reports whether the seller looks standard-x402 and the price it quotes.
- MCP: the `pay` tool free-probes by default and refuses an incompatible seller for $0 before spending.

The probe is a heuristic, not a delivery guarantee - a seller can still settle-but-not-deliver, which is
why the money-safety rule above matters. Then pay: `... zbase pay <url> <maxUSDC> --pilot` (add
`--body '{"k":"v"}'` to POST a JSON body). The seller sees an ordinary x402 payment from a fresh
single-use address.

## Common issues

| Symptom | Cause | Fix |
| --- | --- | --- |
| funds sent but balance stays 0 | funded the wrong network | zBase defaults to Base mainnet; make sure the deposit went to Base mainnet (or match `ZBASE_NETWORK`) |
| balance shows nothing spendable | wallet not funded, or funds not swept | fund the deposit address, then run sweep |
| pay says the amount is too large | each pay spends ONE note | check `largestNoteUSDC` in balance; deposit more into one note |
| seller returns nothing after pay | bespoke / incompatible seller | run probe first; pick a standard Base-USDC x402 seller |
| result says not private yet | anonymity set below the floor (open pilot) | expected during the pilot; `--pilot` acknowledges it |
| command 404s on npm | packages not published yet | see https://docs.zbase.app/install-mcp/ |

## If you need more

- Install guide: https://docs.zbase.app/install-mcp/
- Build with code: `npm install @zbase-protocol/core` (bundles AGENTS.md + docs + runnable examples;
  read node_modules/@zbase-protocol/core/AGENTS.md before writing payment code)
- Trust and threat model: https://docs.zbase.app/trust-model/ , https://docs.zbase.app/threat-model/
