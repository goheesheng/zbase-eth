# Key management — testnet vs mainnet (2026-07-11)

> ⚠️ LOCAL ONLY — do not commit. Operational secrets policy. Contains NO secret
> values, only names + policy, but kept local to avoid documenting the prod
> surface publicly. If this is ever made public, strip the env-var inventory.

The server uses **three different kinds of secret**, with three different
network-separation rules. "Different keys for mainnet and testnet" is correct for
all three — but the *reason* and the *danger* differ. Do not treat them the same.

---

## The three keys at a glance

| Env var | Kind | Generate with | Network separation | Rotation risk |
|---|---|---|---|---|
| `POSTMAN_PRIVATE_KEY` (+ treasury) | **Signs & holds funds** | see §3 — NOT `openssl rand` for mainnet | 🔴 MUST differ (non-negotiable) | rotating = new address; move funds |
| `ZBASE_SEED_ENCRYPTION_KEY` | **AES-256-GCM** encrypts deposit seeds/notes | `openssl rand -hex 32` (exactly 64 hex) | 🟡 should differ | 🔴 **write-once** — rotating orphans encrypted funds |
| `CRON_SECRET` / `ASP_UPDATE_SECRET` | **Bearer token** for cron/ASP routes | `openssl rand -base64 32` or `-hex 32` | 🟡 should differ (cheap) | safe to rotate anytime |

Code requirements verified in source (2026-07-11):
- `ZBASE_SEED_ENCRYPTION_KEY` must be **exactly 64 hex chars (32 bytes)** — validated,
  throws otherwise (`scripts/seed-pools.ts:243`, `reclaim-seed-pools.ts:74`).
- `CRON_SECRET`/`ASP_UPDATE_SECRET` — either satisfies the prod fail-closed check
  (`health/route.ts:161`); gates `asp-update`, `cron/decoy`, `cron/decoy-transfer`,
  `cron/indexer-sync`.
- Postman signer selected by `POSTMAN_SIGNER` (`eoa` default / `cdp`)
  (`postman-signer.ts:52`).

---

## 1. `ZBASE_SEED_ENCRYPTION_KEY` — the write-once rule

Encrypts deposit seeds/notes at rest (AES-256-GCM, fresh IV per record).

```bash
openssl rand -hex 32     # → 64 hex chars. That is the value.
```

**CRITICAL: never change it once funds are encrypted under it.** Rotating this key
makes every seed/note already encrypted **undecryptable → funds unrecoverable**
(same failure class as losing a nullifier). Therefore:

- **Testnet:** the existing `.env.local` value already protects Sepolia seed-pool
  data. Do NOT regenerate — reuse it.
- **Mainnet:** generate ONE fresh key, set it in the mainnet scope **before the
  first mainnet deposit exists**, then treat it as write-once forever. Back it up
  in a password manager / secrets vault, never in a repo file.

## 2. `CRON_SECRET` / `ASP_UPDATE_SECRET` — cheap to separate

Bearer token the Vercel cron sends as `Authorization: Bearer <secret>`; string
compare only. Different value per environment costs nothing and limits blast radius.

```bash
openssl rand -base64 32 | tr -d '\n'    # url-safe-ish; or -hex 32 to avoid +//=
```

Safe to rotate anytime (no data is encrypted under it). After the **C2 fix**, prod
routes **fail-closed (503)** if this is missing — that is correct, not a bug.

## 3. `POSTMAN_PRIVATE_KEY` (mainnet) — do NOT `openssl rand` this

This signs transactions and its address **holds funds**. A single key shared across
networks means a testnet bug/leak can drain **real mainnet USDC**. Per custody plan
(ZBA-33), the mainnet signer must be **hardware-backed**, not a hot key in an env var.

The code enforces this: `POSTMAN_SIGNER=eoa` is **blocked on mainnet (chainId 8453)**
unless `ZBASE_ALLOW_MAINNET_EOA_POSTMAN=true` (emergency override only)
(`postman-signer.ts:59,77`).

| Option | How | Use for |
|---|---|---|
| **CDP signer (recommended)** | `POSTMAN_SIGNER=cdp` + `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` + `CDP_WALLET_SECRET` — key lives in Coinbase KMS, never in your env (`postman-signer.ts:83`) | **Mainnet** |
| **Hardware wallet / Ledger** | generate on-device; export only the address | **Mainnet** self-custody |
| `cast wallet new` / `openssl` (hot key) | prints a fresh keypair into your shell | **Testnet only** — never mainnet funds |

Testnet postman today = `0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843` (holds Sepolia
play money). Mainnet postman MUST be a different, hardware/CDP-backed identity.

---

## How to actually separate the values (Vercel)

**Recommended: separate by Vercel environment SCOPE, keep the same var names.**
The code reads **bare names** (`ZBASE_SEED_ENCRYPTION_KEY`, `CRON_SECRET`,
`POSTMAN_PRIVATE_KEY`) — it does NOT read `_MAINNET`/`_SEPOLIA` suffixes for these
(unlike RPC, which does). So set the same var name to different values per Vercel
environment (Production vs Preview/Development). No code change.

**⚠️ The catch:** production `zbase.app` currently serves **Base Sepolia**
(`network: base-sepolia` in `/api/health`). So *today*, "Production scope" = testnet.

- **Now (clear the `degraded` state):** put the **existing testnet** values from
  `.env.local` into Production scope (`ZBASE_SEED_ENCRYPTION_KEY`, `CRON_SECRET`).
  Do NOT put fresh/mainnet keys in Production yet — that would orphan Sepolia seed
  data under a key nobody has.
- **At mainnet cutover:** swap Production scope to the mainnet values (fresh enc key,
  fresh cron secret, CDP signer), as part of the deploy — not before.

Alternative (only if both networks must run live from one deployment — they don't):
suffix the names (`ZBASE_SEED_ENCRYPTION_KEY_MAINNET`) with a `?? bare` code
fallback, mirroring the existing `ZBASE_X ?? ZX402_X` pattern. More explicit, needs
a code change, buys little over Vercel scoping. Skip unless required.

---

## Checklist — mainnet cutover

- [ ] Generate fresh `ZBASE_SEED_ENCRYPTION_KEY` (64 hex), store in vault, set in
      mainnet scope BEFORE first deposit. Never rotate after.
- [ ] Generate fresh `CRON_SECRET`, set in mainnet scope.
- [ ] `POSTMAN_SIGNER=cdp` + `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`/`CDP_WALLET_SECRET`
      (or Ledger). Do NOT set `ZBASE_ALLOW_MAINNET_EOA_POSTMAN=true` except emergency.
- [ ] Confirm mainnet postman address ≠ testnet `0xcDB4…`.
- [ ] Redeploy; verify `/api/health` → `status: ok`, correct git SHA, correct network.

## Immediate action — clear today's `degraded`

Prod is on Sepolia. Set in Vercel Production scope (from existing `.env.local`):
1. `ZBASE_SEED_ENCRYPTION_KEY` — **existing** testnet value (not a new one).
2. `CRON_SECRET` — existing testnet value.

Then redeploy. `/api/health` flips `degraded → ok`; the 503s clear.

---
See [[project_c1_base_custody]], [[project_custody_execution]],
[[project_facilitator_fee_structure]].
