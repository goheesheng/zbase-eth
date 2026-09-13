# Runbook: prove the charge works on Base Sepolia (before any mainnet deploy)

**Goal:** demonstrate, on-chain, that a paid settle takes the 5% fee and it
lands in the treasury — using testnet funds, no code commit, no mainnet risk.
This is the "prove the meter before installing it in production" step.

**What proves it:** `scripts/simulate-buyer.ts` runs the full path (deposit →
access fee → authorize → settle) and reads the treasury USDC balance before/after.
A green run = the revenue model works end-to-end. After this, mainnet is the same
flow on a different chain.

> ⚠️ This SPENDS testnet funds and signs real transactions, so YOU run it — it
> needs `BUYER_PRIVATE_KEY` (a private key never belongs in my hands). Claude
> wrote the preflight + this runbook; the on-chain steps are yours.

---

## Prerequisites (one-time, ~5 min)

1. **A fresh Base Sepolia wallet** funded with:
   - **≥ 1.001 USDC** — 1.0 for the deposit + 0.001 access fee. (The $0.70 settle
     is paid out of the deposit, not from fresh USDC.) Faucet:
     https://faucet.circle.com (Base Sepolia, 10 USDC/hr).
   - **≥ 0.005 ETH** — gas for deposit + approve + access-fee txs. Faucet:
     https://www.alchemy.com/faucets/base-sepolia.
2. **Your keys in the shell** (or `.env`): `BUYER_PRIVATE_KEY`, `BASE_SEPOLIA_RPC`
   (Alchemy/Infura), `HYPERSYNC_TOKEN` (Envio), `POSTMAN_PRIVATE_KEY` (already in
   your `.env` — signs the relay).
3. No Upstash needed on Sepolia — the in-memory fallback is allowed there.
4. No code change needed — `ZBASE_FEE_REQUIRED=true` is passed inline for the run.

---

## Step 1 — Start the dev server WITH the fee gate on

The fee gate is read by the **running server**, so it must be started with the
env var (setting it only for the preflight/buyer scripts does NOT affect an
already-running server).

```bash
cd ~/Desktop/zx402
ZBASE_FEE_REQUIRED=true npm run dev -- -p 3009
```

Leave it running in its own terminal.

## Step 2 — Preflight (READ-ONLY, no spend)

In a second terminal, with your env set:

```bash
cd ~/Desktop/zx402
export BUYER_PRIVATE_KEY=0x<your_funded_sepolia_wallet_key>
export BASE_SEPOLIA_RPC=https://base-sepolia.g.alchemy.com/v2/<your_key>
export ZBASE_API_URL=http://localhost:3009
export ZBASE_FEE_REQUIRED=true   # so the preflight knows your intent

npx tsx scripts/preflight-paid-settle.ts
```

This makes ZERO transactions. It checks: buyer ETH ≥ 0.005, buyer USDC ≥ 1.001,
RPC on chainId 84532, treasury readable, dev server up, and crucially that the
**server reports `pricing.enforced = true`** (i.e. you actually started it with
the flag). Fix any `FAIL` before continuing. Expect `=== READY ===`.

## Step 3 — Pre-warm the ASP root (avoids an ~18s wait mid-run)

```bash
curl -s -X POST http://localhost:3009/api/asp-update | head -c 300; echo
```

## Step 4 — Run the real paid-settle proof (SPENDS testnet funds)

```bash
BUYER_PRIVATE_KEY=$BUYER_PRIVATE_KEY \
ZBASE_API_URL=http://localhost:3009 \
BASE_SEPOLIA_RPC=$BASE_SEPOLIA_RPC \
HYPERSYNC_TOKEN=$HYPERSYNC_TOKEN \
npx tsx scripts/simulate-buyer.ts
```

It will: deposit 1 USDC → send 0.001 USDC access fee to treasury → POST
`/authorize` → POST `/settle` ($0.70 to a fake provider) → submit the relay →
print the treasury balance delta with BaseScan links.

## Step 5 — Verify (this is the proof)

Confirm in the script output AND on BaseScan (rates updated 2026-07-10: standard
take is now **5%**):

- **Treasury USDC delta = +0.036** (0.001 access fee + 0.035 per-settle take of
  5% on $0.70). The script asserts this and prints ✅ if it matches.
- **Settle/relay tx** on https://sepolia.basescan.org shows the withdrawal split:
  fake provider gets ~0.665 USDC, treasury gets 0.035.
- **Access tx** shows 0.001 USDC arriving at `0xDbAA…0f21`.

If the treasury delta matches, **the charge path is proven**. Paste me the output
(or the two tx hashes) and I'll confirm the numbers.

> NOTE: `FEE_REQUIRED=true` is already set on the LIVE Sepolia deploy
> (zbase.app reports `pricing.enforced: true`), so you can run the proof directly
> against `ZBASE_API_URL=https://zbase.app` — no local server or env flip needed.
> (Running against a local dev server still works if you prefer; start it with
> `ZBASE_FEE_REQUIRED=true`.)

---

## What this does and does NOT prove
- ✅ Proves: authorize gate, server-resolved fee (FIND-301), on-chain 5% split
  to treasury, the full single-value paid-settle flow works.
- ❌ Does NOT prove: mainnet (different chain, needs the deploy), the UTXO pool
  (pre-ceremony, irrelevant to revenue), or that anyone will *pay* (that's the
  provider-signing job, not a code test).

## After a green run — the honest next step
Proving the meter is necessary but not sufficient. The thing standing between you
and revenue is still **a provider who will pay**, not the deploy. Garry's order:
green Sepolia proof → sign 1–2 providers on the seam Veil refuses (resource
servers who want to get paid privately) → THEN deploy single-value to mainnet for
those specific providers (ceremony-free; see the feasibility finding). Do not
deploy mainnet to charge customers who don't exist yet.
