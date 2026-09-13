# Install zBase (agent private payments)

Give an AI agent a **private payment wallet**: fund it once, then pay any x402 API privately - the
on-chain payment never names the wallet. Everything ships from **public npm** (the repo stays private),
so nothing here needs the source.

## Point your agent at the skill

Paste this to your agent. It routes itself to MCP or the CLI, creates or imports a wallet, funds it, and
makes a private payment - you don't pick an install style:

```text
Fetch https://zbase.app/SKILL.md and follow the setup instructions
```

That one line is the whole install for most people. It works in Claude Code, Claude Desktop, Cursor,
Codex CLI, and other agents. Prefer to wire it up by hand? Expand below.

??? note "Set it up manually (MCP, CLI, or SDK)"

    **MCP - Claude Code (terminal):**

    ```bash
    claude mcp add zbase -- npx -y @zbase-protocol/mcp@latest
    ```

    **MCP - Claude Desktop, Cursor, Cherry Studio:** add a `zbase` stdio server to the host's MCP config,
    then restart the app:

    ```json
    { "mcpServers": { "zbase": { "command": "npx", "args": ["-y", "@zbase-protocol/mcp@latest"] } } }
    ```

    Runs on **Base mainnet** by default (set `ZBASE_NETWORK` to target another chain). `@latest` keeps you
    on the newest money-safety fixes - pin a specific version if you need a reproducible install. This
    process controls a wallet; it talks to the hosted facilitator at `https://zbase.app`, you host nothing.

    **CLI - shell agents, scripts** (runs from public npm via `npx`, nothing to install):

    ```bash
    npx -y -p @zbase-protocol/mcp@latest zbase balance
    ```

    Then `... zbase address | sweep | pay <url> 0.05 --pilot`. Run the full command each time - a shell
    alias like `Z="npx ..."` will not survive across separate agent tool calls, and in zsh an unquoted
    `$Z` does not word-split.

    **SDK - build with code:**

    ```bash
    npm install @zbase-protocol/core
    ```

    Bundles `AGENTS.md` + docs + runnable examples. See [Pay privately from an agent (SDK)](sdk-overview.md).

## Pick a wallet: create new, or import

The wallet is a 12-word BIP39 seed stored locally at `~/.zbase/seed` (mode `0600`). Every note derives
from it, so a wiped machine restores from the seed alone.

### A) Create a new wallet (default)

Do nothing. The first call generates a fresh seed. Then back it up:

> "Show my seed phrase so I can write it down." (the agent calls `seed_backup` / `zbase seed show` -
> SENSITIVE: it prints the 12 words into the transcript; store them offline.)

### B) Import an existing wallet

Provide your BIP39 mnemonic **before first use**. Prefer the file or env, not a command argument (a
mnemonic on the command line lands in your shell history):

- **File (persistent):** put the mnemonic on one line in `~/.zbase/seed`. It **refuses to overwrite** an
  existing seed. `ZBASE_HOME` overrides the wallet directory to keep multiple wallets separate.
- **MCP, env (ephemeral, good for CI/containers):** set `ZBASE_SEED` on the server:

  ```bash
  claude mcp add zbase --env ZBASE_SEED="word1 word2 ... word12" -- npx -y @zbase-protocol/mcp@latest
  ```

## Fund, sweep, pay

Then just talk to your agent (MCP tool / CLI command in parentheses):

1. **Fund** - "What's my zBase deposit address?" (`fund_address` / `zbase address`). Send USDC to it from
   any wallet (an ordinary transfer; no ETH needed).
2. **Sweep** - "Move my funds into the pool." (`fund_sweep` / `zbase sweep`, gasless). Now the balance is
   private.
3. **Pay** - "Pay `https://api.seller.com/endpoint` privately." (`pay` / `zbase pay <url> 0.05 --pilot`).
   The seller is paid by a fresh single-use address and sees an ordinary x402 payment.

Check `balance` any time. Each payment spends **one** note, so a payment larger than your biggest single
note fails even if the total covers it (`balance` reports `largestNoteUSDC`).

## Money-safety (the one rule)

Every `pay` result carries an `outcome`. If it's `refused` (incompatible seller) or a clean
pre-settlement error, the note is untouched and retrying is safe. If it's `settled_not_delivered` the
note **is** spent and the seller returned no 2xx — the spend is final, so don't re-pay that seller. If
it's `uncertain` the note **may** be spent. On any of those `pay` selects a **different** note next
time, so a blind retry pays twice. Run `balance`, confirm whether you were charged, and only pay again
if you were not. Never start a new payment for the same purchase without checking `balance` first.

## The agent skill (SKILL.md)

The paths above are all wrapped by one file an agent can fetch and follow. Point your agent at the URL,
or fetch it yourself:

```bash
curl https://zbase.app/SKILL.md
# or drop it straight into a Claude Code skill:
curl https://zbase.app/SKILL.md -o ~/.claude/skills/zbase-private-pay/SKILL.md
```

??? note "Read the whole SKILL.md"

    ````markdown
    --8<-- "public/SKILL.md"
    ````

Next: [Pay privately in 5 minutes](pay-privately-quickstart.md)
