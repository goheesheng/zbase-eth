# Hosting zBase on Vercel — steps (2026-07-01)

**Repo is deploy-ready + verified:** production build compiles clean locally
(incl. /api/ragequit); cron is Hobby-legal; .vercelignore ships both circuits.
The deploy COMMANDS are operator-run (your Vercel account) — Claude doesn't
authenticate to your accounts or handle keys.

## Already set up (verified 2026-07-01)
- Repo linked to Vercel project `zbase` (prj_KUQYPYXL…, team_2C6VVl…) — `.vercel/project.json`
- Vercel CLI installed; logged in as `goheesheng`
- Remote: github.com/goheesheng/zBase; branch feat/ceremony-github-selfhost @ 0bc36fa
- `npm run build` → GREEN (local)

## Step 1 — PREVIEW deploy (safe; does NOT touch main / zbase.app)
```bash
vercel               # from repo root → a preview URL (zbase-xxx.vercel.app)
```

## Step 2 — Env vars (Vercel dashboard → zbase → Settings → Environment Variables)
Copy from `.env.local`. Scope: Production + Preview. Mandatory:
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`  (or `KV_REST_API_URL/_TOKEN`)
- `POSTMAN_PRIVATE_KEY`
- `HYPERSYNC_TOKEN`
- `ZBASE_SEED_ENCRYPTION_KEY`   (openssl rand -hex 32)
- `CRON_SECRET`
- `BASE_SEPOLIA_RPC`
- `NEXT_PUBLIC_NETWORK=sepolia`  (mainnet pool not deployed — keep sepolia)
Optional (defaults exist): `ZBASE_FEE_*`, `ZBASE_ACCESS_*`.
Do NOT set: `ALLOW_UNSAFE_UTXO_TEST_MODE` (dev-only mock-proof flag).
Then re-run `vercel` so vars take effect.

## Step 3 — Verify preview
- `<url>/api/facilitator/supported` → 200
- `<url>/api/health` → `"status":"ok"` (confirms Upstash + enc key)
- optional: run scripts with `ZBASE_API_URL=<preview-url>`

## Step 4 — Go live (production) — GATED
- **Option A (Vercel URL, no main touch):** `vercel --prod`
- **Option B (zbase.app):** merge feat branch → main (auto-deploys). ⚠️ main =
  zbase.app; per standing rule this needs the founder's explicit double-yes.

## Step 5 — Post-deploy
- `<prod>/api/health` → ok
- Vercel → zbase → Cron Jobs shows `decoy` (12:00) + `indexer-sync` (03:00), daily
- `NEXT_PUBLIC_NETWORK=sepolia`

## Gotchas (from repo history)
- Vercel Hobby = daily cron only (config now compliant; don't re-add `*/N`).
  Want 10-min indexer → Vercel Pro $20/mo.
- Upstash mandatory (facilitator throws on mainnet without it; health "degraded"
  without enc key).
- main auto-deploys zbase.app → merging there is the go-live (double-yes).
