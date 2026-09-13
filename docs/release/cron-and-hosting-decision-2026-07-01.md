# Cron + hosting decision (logged 2026-07-01) — NOT YET ACTIONED

Logging the analysis before changing `vercel.json`, so the reasoning is on record.
Nothing here has been changed yet.

## The open bug (fix before any Vercel prod deploy)

`vercel.json` has `indexer-sync` scheduled `*/10 * * * *` (every 10 min). **Vercel
Hobby rejects sub-daily crons → the production build goes RED.** This is a
regression of the exact issue in `learning_vercel_hobby_cron_daily` (it was fixed
to daily before, now back to `*/10`). Must be resolved before a clean Vercel deploy.

## Do we actually need cron? — No, not for launch.

The 3 crons are optimizations/hardenings, NOT load-bearing. Core product (deposit /
private settle / withdraw / ragequit) works with ZERO crons.

| Cron | Purpose | Needed for launch? | What breaks without it |
|---|---|---|---|
| `indexer-sync` | Redis cache of the pool Merkle tree so settle/withdraw skips re-scanning chain history per payment | **Optional** | Nothing — settle/withdraw has a chain-scan fallback. Just slower per payment. Pure perf optimization. |
| `decoy` (A.2) | Poisson-jittered dummy withdrawals to defeat timing/FIFO de-anon | **No** | Lose a timing-privacy hardening that only matters AT VOLUME. At low volume decoys hide nothing and cost gas per fire. |
| `decoy-transfer` | Same, for the UTXO pool | **No** | The UTXO pool isn't deployed — this cron has nothing to act on. Dead weight today. |

## Decision (to action later, not now)

**For launch, strip cron to the minimum → clean Vercel Hobby deploy, no wasted gas:**
1. Remove `decoy` + `decoy-transfer` crons from `vercel.json` (keep the CODE; just
   don't schedule). No volume to hide; decoy-transfer targets an undeployed pool.
2. Set `indexer-sync` to daily (`0 3 * * *`) OR remove it — the chain-scan fallback
   covers correctness. Re-enable frequent sync only when payment volume makes
   per-settle re-scanning slow.

Re-add crons (and Vercel Pro $20/mo or a VM cron for sub-daily schedules) LATER,
when real traffic makes the indexer speed-up + decoys worth their cost.

## Hosting: Vercel, not Tencent (for the main app)

The product is a Next.js app + serverless API/cron ROUTES = 100% serverless-
compatible → Vercel-native, lowest ops. A VM (Tencent) only makes sense LATER for
the CONTINUOUS daemons that are NOT the product:
- `x402-server/` (the paid-demo standalone Node server, port 4020) — optional/reference
- a future PrivacyCash relayer (if the Solana "build-on-top" path — see
  project-build-on-top-pivot) — a long-lived process a VM suits.

Moving the main Next.js app to a VM = adding ops (pm2/nginx/TLS/patching/scaling)
for no benefit. Vercel Hobby (free) is right for launch; Vercel Pro or a small VM
is a "when there's volume" decision, not a launch one.

## Status
- [ ] Fix/trim `vercel.json` cron (the actual change — deferred until you decide)
- [ ] Provision Upstash (indexer-sync + facilitator-authz need it; mandatory on mainnet regardless)
- Decision recorded; no code changed yet.
