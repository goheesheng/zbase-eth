# zBase — full mainnet deployment steps (Docker VPS)

> Generated for the VPS topology (NOT Vercel). **Postman: the CDP smart account
> `0xd411f68a53F5698d05c840C52065a624F9CC5769`** (gasless, no hot key, already
> proven on Sepolia). ✅ Sepolia ragequit dry-run PASSED — the contract is safe
> to deploy.
>
> Why CDP over an EOA postman:
> - **Gasless** — CDP's Paymaster sponsors `updateRoot`/`relay`, so the postman
>   needs NO ETH (only the deployer needs mainnet ETH, once).
> - **No hot key on the box** — the key lives in Coinbase KMS, not in the env.
> - **Same address across chains** — the ERC-4337 account proven on Sepolia IS
>   the mainnet postman; nothing new to create.
>
> Legend: 🧑 = you (on-chain / keys, never Claude) · 🤖 = Claude-doable (plumbing).

---

## 0. Fixed values (copy-paste reference)

```
Postman (CDP smart account): 0xd411f68a53F5698d05c840C52065a624F9CC5769
USDC (Base mainnet):         0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
Base mainnet RPC:            https://mainnet.base.org   (swap for Alchemy/Infura for the deploy)
Deploy script:               zbase-protocol/pkg/contracts/src/vendor/0xbow/script/DeployMainnetPool.s.sol:DeployMainnetPool
Box:                         ubuntu@43.156.119.46   (ssh key ~/.ssh/zBase.pem)
Mainnet env on box:          /srv/zbase/mainnet/app.env  +  /srv/zbase/mainnet/x402.env
CDP portal:                  https://portal.cdp.coinbase.com
```

---

## Phase A — Prerequisites 🧑 (do ALL before spending any mainnet ETH)

### A1. ✅ Sepolia ragequit dry-run — DONE, passed
The escape hatch works; the `[8]`/`[4]` verifier risk is cleared. Proceed.

### A2. Fund the mainnet DEPLOYER wallet (real ETH)
~0.01–0.02 ETH covers ~5 deploy txs. `ENTRYPOINT_OWNER` MUST equal this deployer
address (the script does `require(owner == deployer)`).
**This is the ONLY wallet of yours that needs mainnet ETH** (postman is gasless).

### A3. CDP credentials ready (from portal.cdp.coinbase.com, your API project)
- `CDP_API_KEY_ID`
- `CDP_API_KEY_SECRET`
- `CDP_WALLET_SECRET` (authorizes account/user-op signing)
These go on the box in Phase C. The smart account `0xd411f68a…` is already
created; you do NOT create a new one.

### A4. (Recommended) a real mainnet RPC
`mainnet.base.org` rate-limits. An Alchemy/Infura Base-mainnet URL is safer for
the deploy + log scans. Use it as `--rpc-url` below.

---

## Phase B — Deploy the contract 🧑 (real ETH, on-chain, Claude never runs this)

### B1. Dry-run FIRST (simulation, no gas) — catches reverts before you pay

```bash
cd ~/Desktop/zx402
ENTRYPOINT_OWNER=<your_deployer_address> \
ENTRYPOINT_POSTMAN=0xd411f68a53F5698d05c840C52065a624F9CC5769 \
FOUNDRY_PROFILE=vendor forge script \
  zbase-protocol/pkg/contracts/src/vendor/0xbow/script/DeployMainnetPool.s.sol:DeployMainnetPool \
  --rpc-url https://mainnet.base.org \
  --private-key <DEPLOYER_PRIVATE_KEY>
```
No revert in simulation → proceed to B2.

### B2. Real deploy (adds `--broadcast --verify`)

```bash
cd ~/Desktop/zx402
ENTRYPOINT_OWNER=<your_deployer_address> \
ENTRYPOINT_POSTMAN=0xd411f68a53F5698d05c840C52065a624F9CC5769 \
FOUNDRY_PROFILE=vendor forge script \
  zbase-protocol/pkg/contracts/src/vendor/0xbow/script/DeployMainnetPool.s.sol:DeployMainnetPool \
  --rpc-url https://mainnet.base.org \
  --private-key <DEPLOYER_PRIVATE_KEY> \
  --broadcast --verify
```
Deploys WithdrawalVerifier + CommitmentVerifier (fresh) → Entrypoint impl →
ERC1967Proxy → initialize(owner, postman) → PrivacyPoolComplex → registerPool.
The broadcast also grants `ASP_POSTMAN` to `0xd411f68a…` (no separate grant tx).
(`--verify` needs a Basescan API key in forge; drop it and verify later if not set.)

### B3. Capture 5 values from the output
```
Entrypoint (proxy) address:      0x...
PrivacyPoolComplex (pool):       0x...
WithdrawalVerifier (fresh):      0x...
CommitmentVerifier (fresh):      0x...
Deploy block:                    <number>
```
⚠️ **Deploy block:** read the REAL block from
`broadcast/DeployMainnetPool.s.sol/8453/run-latest.json`, NOT the logged
`block.number` (simulation block ≠ mined block → wrong log-scan floor).

**Paste these 5 values to Claude** — Phase C is the plumbing.

---

## Phase B½ — Set the CDP mainnet Paymaster policy 🧑 (AFTER deploy, BEFORE go-live)

Mainnet is **NOT auto-sponsored** like Sepolia. Without a policy, every
`updateRoot`/`relay` user-op reverts unsponsored. The policy references the
just-deployed addresses, so it can only be set after Phase B.

**Where:** portal.cdp.coinbase.com → your **API project** (the one that issued
`CDP_API_KEY_ID`) → **Paymaster / Bundler** section. NOT the "Non-custodial
Wallets" screen — that's a different product and its "No paymaster
configurations" empty state is unrelated to your server smart account.
Docs: https://docs.cdp.coinbase.com/paymaster

**Configure:**
- **Network:** Base mainnet (8453)
- **Allowlist:** the deployed **Entrypoint** + **pool** addresses (from B3) — so
  only your contract's calls are sponsored, not arbitrary ones.
- **Spend cap:** a daily/monthly ceiling (real gas = real money; cap protects
  against a bug/abuse draining sponsorship).
- (Optional) scope sender to `0xd411f68a…`.

**Ordering is strict:** deploy → get addresses → set THIS policy → THEN start the
mainnet app with `POSTMAN_SIGNER=cdp` (Phase D1). Never flip cdp live before the
policy exists.

---

## Phase C — Wire the addresses on the box 🤖 (Claude does; you provide secrets)

### C1. You generate + vault the fresh mainnet seed key (write-once)
```bash
openssl rand -hex 32
```
Store in your password manager. NEVER the Sepolia value. NEVER rotate after the
first mainnet deposit (orphans notes). Place it:
```bash
ssh -i ~/.ssh/zBase.pem ubuntu@43.156.119.46 \
  "sed -i '/^ZBASE_SEED_ENCRYPTION_KEY=/d' /srv/zbase/mainnet/app.env && \
   printf 'ZBASE_SEED_ENCRYPTION_KEY=%s\n' '<the_64_hex>' >> /srv/zbase/mainnet/app.env"
```

### C2. Place the CDP credentials (NO private key, NO EOA vars)
```bash
ssh -i ~/.ssh/zBase.pem ubuntu@43.156.119.46 \
  "sed -i '/^CDP_WALLET_SECRET=/d' /srv/zbase/mainnet/app.env && \
   printf 'CDP_WALLET_SECRET=%s\n' '<your_cdp_wallet_secret>' >> /srv/zbase/mainnet/app.env"
```
And the CDP API keys in the x402 env (mainnet facilitator):
```bash
ssh -i ~/.ssh/zBase.pem ubuntu@43.156.119.46 "cat >> /srv/zbase/mainnet/x402.env" <<'EOF'
CDP_API_KEY_ID=<your_cdp_api_key_id>
CDP_API_KEY_SECRET=<your_cdp_api_key_secret>
EOF
```
(app.env already has `POSTMAN_SIGNER=cdp` + `CDP_POSTMAN_SMART_ACCOUNT=zbase-postman`.
Also add `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` to app.env — the postman signer
reads all three CDP_* vars.)

### C3. Claude wires the 5 contract values
Claude sets both the server var and its `NEXT_PUBLIC_` mirror for entrypoint /
pool / withdrawalVerifier / commitmentVerifier / deployBlock in
`/srv/zbase/mainnet/app.env`.

### C4. Claude runs preflight until green
```bash
NEXT_PUBLIC_NETWORK=mainnet npm run preflight:mainnet
```
Must report zero issues (all `BASE_MAINNET_*` real, no Sepolia placeholders).

---

## Phase D — Initialize + stand up on STAGING 🤖/🧑 (no apex, no fees)

### D1. Claude stands mainnet up on the staging host (Paymaster policy MUST be live)
```bash
./deploy/deploy.sh mainnet
```
Serves `mainnet-staging.zbase.app`. Verify: `/api/health` → `status:"ok"`,
`network:mainnet`. (Needs DNS `A mainnet-staging.zbase.app → 43.156.119.46`.)

### D2. Prove the sponsored postman works (gasless)
The CDP postman signs `updateRoot`/`relay` gaslessly ONLY with the Paymaster
policy live (Phase B½). A first sponsored `updateRoot` in D3 confirms it.

### D3. Set the initial ASP root (else every withdrawal reverts IncorrectASPRoot)
```bash
curl -fsS -X POST https://mainnet-staging.zbase.app/api/asp-update \
  -H "Authorization: Bearer <mainnet_CRON_SECRET_or_ASP_UPDATE_SECRET>"
```
Confirm the tx was sponsored (postman spent 0 ETH) + `latestRoot()` updated.

### D4. 🧑 Seed a few treasury deposits (anonymity set not empty)
```bash
NEXT_PUBLIC_NETWORK=mainnet npx tsx --env-file=<mainnet env> scripts/seed-pools.ts
```
(Needs the mainnet seed key + a funded treasury wallet.)

---

## Phase E — Go live 🧑 (double-confirm) — the apex cutover

### E1. Claude flips the apex (reversible in seconds)
Edit `deploy/Caddyfile`: `zbase.app` → `reverse_proxy mainnet-app:3000`,
`x402.zbase.app` → `reverse_proxy mainnet-x402:4020`, then:
```bash
./deploy/deploy.sh edge     # reloads Caddy
```
**Requires your explicit double-yes** (main-branch / production rule).
Rollback = revert the two lines + `./deploy/deploy.sh edge`. Seconds. No DNS change.

### E2. 🧑 One small real paid-settle on mainnet
Prove deposit → authorize → settle end-to-end with real USDC, and that the
sponsored relay works with the Paymaster policy live. Confirm treasury credited.

### E3. Fees — SEPARATE + later
Only after E1/E2 verified stable:
```bash
# in /srv/zbase/mainnet/app.env
FEE_REQUIRED=true
```
+ TVL cap (e.g. $500K / 90 days) + honest disclosure. Redeploy mainnet.

---

## Honest gates (from every review this session)
- **External audit is still OPEN** — the deploy script is internally reviewed,
  NOT externally audited. Real funds in an unaudited ZK contract is the risk you
  accept for a TVL-capped soft launch. Name it.
- **A paying seller is the real bottleneck** — mainnet costs real ETH + real
  risk and earns $0 without one. Deploy FOR a committed seller, not before.
- **Separate Upstash DB for mainnet** — done (`smart-seagull-92818`), distinct
  from Sepolia. Never share a keyspace or token across networks.

---

## Who does what (one-glance)
| Phase | Action | Owner |
|---|---|---|
| A1 | Sepolia ragequit dry-run | ✅ DONE |
| A2–A4 | fund deployer, CDP creds, RPC | 🧑 |
| B1–B3 | dry-run + real deploy, capture addresses | 🧑 (on-chain) |
| B½ | CDP mainnet Paymaster policy | 🧑 (CDP portal) |
| C1–C2 | seed key + CDP secrets onto box | 🧑 (secrets) |
| C3–C4 | wire addresses + preflight | 🤖 |
| D1 | deploy to staging | 🤖 |
| D3–D4 | ASP root, seed pools | 🧑/🤖 |
| E1 | apex Caddy cutover | 🤖 (your double-yes) |
| E2–E3 | mainnet settle proof, fee flip | 🧑 |
