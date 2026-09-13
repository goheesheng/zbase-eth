# Decoy Scheduler Runbook — 2026-05-31

Operational runbook for running `scripts/decoy-scheduler.ts` (Shipment A.2)
continuously in support of the Base Sepolia push. The scheduler emits
Poisson-distributed real Groth16 withdrawals to deterministic burn addresses
so a passive observer applying the FIFO heuristic cannot re-link genuine
user withdrawals to their deposits.

This runbook covers two launchers. Use one — not both.

| Launcher | When to use | Where it works |
|---|---|---|
| **systemd** (`scripts/decoy-scheduler.service`) | Always-on Linux VPS / bare metal you control | Linux only |
| **tmux** (`scripts/decoy-scheduler-launcher.sh`) | macOS dev box, container without init, founder laptop | Linux + macOS |

> **macOS note:** the founder's primary box is Darwin (per the project env).
> systemd does not exist on macOS — go straight to the tmux launcher. Use the
> systemd unit only if you provision a Linux VPS (Hetzner, Fly machines,
> Railway dedicated, etc.).

---

## 1. Pre-flight

Run these checks before starting the scheduler the first time and after every
significant infra change (new RPC, new postman wallet, redeploy).

### 1.1 Postman wallet balances

```bash
# From the repo root, with .env.local sourced:
POSTMAN=$(cast wallet address "$POSTMAN_PRIVATE_KEY")
echo "postman: $POSTMAN"

# ETH on Base Sepolia — need ≥ 0.05 for gas headroom (~150 decoys @ 0.0003 each).
cast balance --rpc-url "$BASE_SEPOLIA_RPC" "$POSTMAN"

# USDC on Base Sepolia — need ≥ 5 USDC so the scheduler can self-seed deposit notes.
cast call --rpc-url "$BASE_SEPOLIA_RPC" \
  0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  "balanceOf(address)(uint256)" "$POSTMAN"
```

Top-up sources for Sepolia: <https://faucet.circle.com> (USDC),
<https://www.alchemy.com/faucets/base-sepolia> (ETH).

### 1.2 Environment variables

`.env.local` must contain:

```
POSTMAN_PRIVATE_KEY=...        # funded wallet, 0x-prefixed or not
BASE_SEPOLIA_RPC=https://...   # Infura/Alchemy/QuickNode — public RPC will 429
HYPERSYNC_TOKEN=...            # required by /api/withdraw on the dev server
ZBASE_API=http://localhost:3009   # or your deployed Next.js origin
USDC_POOL_ADDRESS=0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a   # current plain 0xbow pool
MAX_DAILY_BUDGET_USD=5         # hard cap — script auto-pauses when exceeded
ZBASE_DECOY_AMOUNT_USDC=0.01   # per-decoy spend (default)
```

Verify the cap is set:

```bash
grep -E '^MAX_DAILY_BUDGET_USD=' .env.local || echo "WARN: cap missing, will default to 5"
```

### 1.3 Burn addresses present

```bash
test -f scripts/burn-addresses.json && jq '.count, (.addresses | length)' scripts/burn-addresses.json
```

Expected output:

```
10
10
```

If the file is missing, the scheduler will exit on startup at `loadBurnAddresses()`.

### 1.4 Dependent service up

```bash
curl -fsS "$ZBASE_API/api/asp-update" -X POST -H 'content-type: application/json' -d '{}' >/dev/null \
  && echo "ZBASE_API reachable"
```

The scheduler calls `POST /api/withdraw` — that route requires the Next.js dev
server (or production deployment) to be live. Start it separately first.

### 1.5 Dry run

Always do one dry run on a fresh host before going live:

```bash
npx tsx scripts/decoy-scheduler.ts --dry-run --once
```

You should see `cycle=1 skipped reason=dry-run` and zero on-chain transactions.

---

## 2. Start

### 2.1 systemd (Linux)

```bash
# One-time install
sudo cp scripts/decoy-scheduler.service /etc/systemd/system/zbase-decoy.service
sudo $EDITOR /etc/systemd/system/zbase-decoy.service     # replace REPLACE_ME placeholders
sudo touch /var/log/zbase-decoy.log
sudo chown zbase:zbase /var/log/zbase-decoy.log
sudo systemctl daemon-reload

# Enable + start
sudo systemctl enable --now zbase-decoy.service
sudo systemctl status zbase-decoy
```

Log paths:

- `journalctl -u zbase-decoy` — full structured journal
- `/var/log/zbase-decoy.log` — append-mode plaintext (configured in unit file)

### 2.2 tmux (macOS or no-init Linux)

```bash
chmod +x scripts/decoy-scheduler-launcher.sh   # one time
./scripts/decoy-scheduler-launcher.sh start
```

Log path: `.decoy-state/decoy-scheduler.log` (under the repo).

The launcher refuses to start a second copy. To restart cleanly:

```bash
./scripts/decoy-scheduler-launcher.sh restart
```

---

## 3. Monitor

### 3.1 systemd

```bash
sudo journalctl -u zbase-decoy -f                 # live tail
sudo journalctl -u zbase-decoy --since "1 hour ago" | grep -E 'tx=|skipped|error'
sudo systemctl status zbase-decoy                 # uptime + recent log preview
```

### 3.2 tmux

```bash
./scripts/decoy-scheduler-launcher.sh status      # last 20 lines + PID
./scripts/decoy-scheduler-launcher.sh logs        # attach read-only (Ctrl-b d to detach)
tail -f .decoy-state/decoy-scheduler.log          # plain tail outside tmux
```

### 3.3 State file

`/REPO/.decoy-state/deposits.json` is the source of truth for budget tracking:

```bash
jq '{notes: (.notes | length), spentTodayUsd, totalDecoysSent, lastDecoyAt}' \
  .decoy-state/deposits.json
```

---

## 4. Stop

### 4.1 systemd

```bash
sudo systemctl stop zbase-decoy        # graceful — sends SIGTERM, waits 60s
sudo systemctl disable zbase-decoy     # also stop respawn on reboot
```

### 4.2 tmux

```bash
./scripts/decoy-scheduler-launcher.sh stop
```

Sends Ctrl-C into the tmux pane (the script's SIGINT handler finishes the
current cycle), waits 3s, then kills the session.

---

## 5. Alerting — "no decoy in 6 hours" pager

The scheduler should emit ~15 decoys/hour. A 6-hour silence means the process
is wedged, the RPC is down, or the budget cap was hit. The watchdog at
`scripts/decoy-watchdog.sh` detects that silence and pages a webhook.

How it detects staleness: every decoy cycle appends a line to the log file,
which updates the file's mtime. The watchdog compares mtime to `now` — no
log-line parsing needed, which is the same on both `tee -a` (tmux) and
systemd `append:` modes, and on both macOS and Linux.

Exit codes: `0` healthy, `1` stale, `2` log missing entirely (a distinct
failure mode meaning "scheduler never started"), `3` bad args.

### 5.1 Watchdog (recommended): cron mode

```bash
# 1. Edit the cron template — replace REPLACE_ME_REPO_PATH and the webhook URL
$EDITOR scripts/decoy-watchdog.cron

# 2. Install (append; preserves existing entries)
crontab -l > /tmp/cron.bak && cat scripts/decoy-watchdog.cron >> /tmp/cron.bak && crontab /tmp/cron.bak

# 3. Verify
crontab -l | grep decoy-watchdog

# 4. Tail the watchdog's own log
tail -f .decoy-state/watchdog.log
```

Cadence is every 15 minutes — well under the 6h threshold, so you get ~24
shots before the SLA window closes.

### 5.2 Watchdog: tmux loop mode (alternative)

When you don't have cron (or you want the watchdog to live in the same tmux
multiplexer as the scheduler itself):

```bash
tmux new-session -d -s zbase-watchdog "./scripts/decoy-watchdog.sh --loop=900"
tmux attach -r -t zbase-watchdog   # read-only attach
```

Loop mode stays silent on healthy ticks (no green-checkmark spam) and only
prints when stale/missing.

### 5.3 Manual one-shot check

```bash
./scripts/decoy-watchdog.sh
# → ✓ decoy scheduler healthy — last activity 42s ago
```

### 5.4 Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ZBASE_DECOY_LOG` | `.decoy-state/decoy-scheduler.log` (repo-relative) | Log path override — set this if you're on systemd and pointed `StandardOutput=append:/var/log/zbase-decoy.log` |
| `ZBASE_DECOY_MAX_AGE_SEC` | `21600` (6h) | Staleness threshold; lower it if you raise `--mean-seconds` |
| `ZBASE_DECOY_WEBHOOK` | unset | If set, POSTs `{"service":"zbase-decoy","status":"stale\|missing","lastActivityAgo":"Xh Ym","logPath":"..."}` JSON on failure |

Tested compatibility: macOS bash 3.2 (default `/bin/bash`), Linux (any bash 4+
distro). Uses `stat -f %m` on Darwin and falls back to `stat -c %Y` on Linux.

---

## 6. Budget tripwire

`MAX_DAILY_BUDGET_USD` (default `5`) is enforced inside `fireDecoy()` in
`scripts/decoy-scheduler.ts`. Behaviour when the cap is reached:

- `state.spentTodayUsd + decoyAmountUsd > MAX_DAILY_BUDGET_USD` → cycle returns
  `skipped: daily-budget-exceeded`
- The scheduler does **not** exit; it keeps looping at the Poisson cadence so
  it can resume the moment the 24h window rolls over.
- `state.spentTodayUsd` resets to `0` automatically when `now - spentDayStartUnix > 86400`.

To raise the cap temporarily:

1. `sudo systemctl stop zbase-decoy` (or `./scripts/decoy-scheduler-launcher.sh stop`)
2. Edit `.env.local` → bump `MAX_DAILY_BUDGET_USD`
3. Restart

To force an early reset (e.g. after a stuck day):

```bash
jq '.spentTodayUsd = 0 | .spentDayStartUnix = (now | floor)' \
  .decoy-state/deposits.json > .decoy-state/deposits.json.tmp \
  && mv .decoy-state/deposits.json.tmp .decoy-state/deposits.json
```

---

## 7. Cost estimate

| Network | Per-decoy cost | Cadence | Daily est. | Notes |
|---|---|---|---|---|
| Base Sepolia | gas ≈ $0 (test ETH) + 0.01 USDC test | ~15/hr | ~3.6 USDC test/day | within $5 cap |
| Base mainnet | gas ≈ $0.003 + 0.01 USDC real | ~15/hr | ~$4.7/day (≈$140/mo) | tune `--mean-seconds 480` to halve cost |

Per-decoy on Sepolia: gas paid in faucet ETH (effectively free); USDC payable
to the burn address (irrecoverable by design — that's the point).

Per-decoy on mainnet at 240s mean Poisson with $0.01/decoy and ~$0.003 gas:
360 decoys/day → 3.6 USDC + ~$1.08 gas = **~$4.68/day, ~$140/month**.

The `MAX_DAILY_BUDGET_USD=5` cap is sized for the testnet push. For mainnet,
either raise the cap to ~$10/day or stretch `--mean-seconds` to slow the
cadence. See the trade-off discussion in
`docs/gitbook/decoy-scheduler.md#real-mode-operational-plan`.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing POSTMAN_PRIVATE_KEY or BASE_SEPOLIA_RPC` | env file not loaded | systemd: check `EnvironmentFile=`. tmux: ensure `.env.local` sits in repo root (the script calls `import "dotenv/config"`) |
| `/api/withdraw failed: delay_window_active` (logged as `skipped`) | normal — the deposit is still inside the 60s min-delay window | nothing; next cycle will retry |
| Repeated `cycle=N error: 429` | RPC rate-limit (public sepolia.base.org) | swap `BASE_SEPOLIA_RPC` to Infura/Alchemy paid tier |
| `daily-budget-exceeded` for hours | budget cap hit | wait for 24h rollover or follow §6 to bump the cap |
| `session failed to start` (tmux launcher) | tmux not installed, or scheduler crashed inside the pane | `brew install tmux`, then re-check `.decoy-state/decoy-scheduler.log` |
| Service flapping on systemd | likely bad zkey/RPC; check `StartLimitBurst=5` exceeded | `journalctl -u zbase-decoy -n 100` and resolve the underlying error before re-enabling |

---

## 9. Related docs

- `docs/gitbook/decoy-scheduler.md` — design rationale + FIFO threat model
- `docs/gitbook/trust-model.md` — what privacy guarantees the scheduler underwrites
- `scripts/decoy-scheduler.ts` — the script itself (do not modify without re-running `scripts/test-fifo-resistance.ts`)
- `scripts/burn-addresses.json` — deterministic, verifiably-unowned recipients
