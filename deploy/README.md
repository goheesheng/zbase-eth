# zBase VPS deployment (Docker + Caddy)

The VPS is a **second deployment** — Vercel stays canonical for zbase.app.
The box authoritatively hosts the **paid x402 API** (`x402.zbase.app`) and
runs the crons at their designed cadence (Vercel Hobby forces daily).
Everything here is **Sepolia**; no mainnet fund keys ever go on this box
(see `docs/security/key-management.md`).

Stack: `app` (Next.js standalone, loopback :3000) + `x402` (Express paid API)
+ `caddy` (TLS, the only public listener). Deploys ship the **working tree**
from the laptop — uncommitted feature files deploy without a commit.

## One-time server prep (Ubuntu 24.04 + Docker preinstalled)

```bash
# 1. Layout
sudo mkdir -p /srv/zbase/app /srv/zbase/cron
sudo chown -R ubuntu:ubuntu /srv/zbase

# 2. Swap — next build spikes past 4GB on the 8GB box
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-zbase.conf && sudo sysctl -p /etc/sysctl.d/99-zbase.conf

# 3. Firewall — BOTH layers. ufw on the box:
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw enable
#    ...AND the Tencent Lighthouse console firewall (instance -> Firewall tab):
#    open 80/tcp, 443/tcp, 443/udp. It filters before packets reach the box.
#    (Docker-published ports bypass ufw; only caddy publishes publicly, and
#    the app binds 127.0.0.1 — so ufw stays truthful here.)

# 4. Basics
sudo apt update && sudo apt install -y fail2ban unattended-upgrades jq
sudo dpkg-reconfigure -plow unattended-upgrades

# 5. Docker log caps — MERGE into daemon.json, preserving the Tencent
#    registry mirror the image shipped with:
sudo jq '. + {"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}' \
  /etc/docker/daemon.json | sudo tee /etc/docker/daemon.json.new >/dev/null
sudo mv /etc/docker/daemon.json.new /etc/docker/daemon.json
sudo systemctl restart docker && sudo systemctl enable docker
docker info | grep -A2 -i mirror   # mirror must still be there

# 6. Env files (from the laptop) — templates in this directory:
#    scp deploy/env.vps.example  ubuntu@<vps>:/srv/zbase/.env
#    scp deploy/x402.env.example ubuntu@<vps>:/srv/zbase/x402.env
#    then ON THE BOX: fill real values, chmod 600 both.

# 7. Cron shim
cp /srv/zbase/app/deploy/cron-hit.sh /srv/zbase/cron/cron-hit.sh
chmod +x /srv/zbase/cron/cron-hit.sh
crontab -e   # paste deploy/crontab.example (AFTER first deploy is verified)
```

## DNS (before first deploy)

A records → the box IP (`43.156.119.46`):
- `vps.zbase.app` — Next.js app (noindex; canonical stays zbase.app)
- `x402.zbase.app` — paid x402 API

If the zone is on Cloudflare, both records must be **DNS-only (grey cloud)**
or ACME issuance fails. Caddy retries automatically once DNS is live.

## Full cutover — zbase.app moves to this box (replaces Vercel serving)

Do this ONLY after the stack is verified working on `vps.zbase.app` (all
first-deploy checks below green). The Vercel project stays intact and
untouched — it is the instant rollback: flipping DNS back restores Vercel
serving within the TTL (~30 min at GoDaddy's ½-hour default).

1. **Env parity first.** `/srv/zbase/.env` must contain the SAME values the
   Vercel Production scope has today — especially `ZBASE_SEED_ENCRYPTION_KEY`
   (existing Sepolia seed data decrypts only under the existing key; do NOT
   generate a fresh one) and `CRON_SECRET`, plus `POSTMAN_PRIVATE_KEY`,
   `HYPERSYNC_TOKEN`, `BASE_SEPOLIA_RPC`, and the Upstash pair if set.
   Verify on the box: `curl -fsS http://127.0.0.1:3000/api/health` →
   `status:"ok"` (not "degraded").
2. **GoDaddy changes (the actual cutover):**
   - `A @` : `76.76.21.21` → `43.156.119.46`
   - `CNAME www` : `cname.vercel-dns.com.` → `vps.zbase.app.`
   - Leave `docs` (GitBook), `_dmarc`, NS/SOA untouched.
3. **Wait for propagation** (`dig zbase.app +short` → `43.156.119.46`),
   then verify: `curl -sI https://zbase.app | grep -i server` (Caddy),
   `curl -fsS https://zbase.app/api/health` shows the deployed SHA, and
   `https://www.zbase.app` 308-redirects to the apex. Caddy auto-issues
   the zbase.app + www certs on first request after DNS lands.
4. **Post-cutover:** pushes to `main` no longer deploy the live site —
   `deploy/deploy.sh` is the deploy path now. The Vercel project keeps
   building on pushes (harmless; nothing points at it). Keep it as the
   rollback for at least a week, then optionally pause it. Remove the
   `crons` block from `vercel.json` once host cron is verified (step below).

**Rollback:** revert the two GoDaddy records (`A @` → `76.76.21.21`,
`www` → `cname.vercel-dns.com.`). Vercel resumes serving within the TTL.
No Vercel-side action needed — that's why the project stays untouched.

## Deploy (from the laptop)

```bash
./deploy/deploy.sh
```

rsyncs the working tree (gitignore-filtered — secrets and junk stay home),
builds both images on the box sequentially, `up -d`, waits for container
health, then asserts `/api/health` reports the shipped SHA and the paid API
answers. Idempotent — rerunning with no changes is a fast no-op.
Rollback: `git checkout <sha>` on the laptop → rerun `deploy.sh`.

## First-deploy verification

```bash
ssh ubuntu@<vps> docker compose -f /srv/zbase/app/docker-compose.yml ps   # 3x healthy
ssh ubuntu@<vps> 'curl -fsS http://127.0.0.1:3000/api/health'            # status:"ok", right SHA + network
curl -sI https://vps.zbase.app | head -3                                 # LE cert, HTTP/2
curl -fsS https://vps.zbase.app/skill.md | head -5                       # rewrite works
curl -fsS https://x402.zbase.app/api/zx402/supported                     # free listing
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://x402.zbase.app/api/zx402/privacy-check \
  -H 'content-type: application/json' \
  -d '{"address":"0x000000000000000000000000000000000000dEaD"}'          # 402 challenge
# Paid E2E (Sepolia-USDC agent wallet):
npx awal@2.8.2 x402 details https://x402.zbase.app/api/zx402/privacy-check
npx awal@2.8.2 x402 pay     https://x402.zbase.app/api/zx402/privacy-check -X POST \
  -d '{"address":"0x000000000000000000000000000000000000dEaD"}'
# Cron auth: unauthenticated must 401, shim must 200:
curl -s -o /dev/null -w '%{http_code}\n' https://vps.zbase.app/api/cron/indexer-sync
ssh ubuntu@<vps> /srv/zbase/cron/cron-hit.sh indexer-sync
# Resilience: sudo reboot -> stack self-starts, caddy logs show NO re-issuance.
```

## Notes

- **Provider registry state** (`data/providers.json`) is ephemeral in the
  container — providers registered on the VPS vanish on redeploy. Fine for
  the Sepolia second deployment; revisit if the VPS ever becomes primary.
- The standalone **decoy-scheduler** (systemd unit in `scripts/`) is a later
  add-on; the in-app `/api/cron/decoy` route covers the decoy defense and
  does NOT need the local-only `scripts/burn-addresses.json`.
- x402 request log: `docker compose exec x402 tail /app/logs/requests.ndjson`
  (named volume `zbase_x402_logs`, survives redeploys).
