# env-doctor runbook (2026-05-31)

## TL;DR

Run `./scripts/env-doctor.sh` to see what's **set**, **missing**, or **blank** in
your `.env.local` compared against `.env.local.example`. Run with `--fix` to
auto-append missing keys as placeholders so you can fill them in manually.

Values are **never read aloud, logged, or echoed** — the script only reports
key names and one-line descriptions pulled from the comments in
`.env.local.example`.

```bash
chmod +x scripts/env-doctor.sh           # first time only
./scripts/env-doctor.sh                   # human-readable per-key report
./scripts/env-doctor.sh --quiet           # one-line summary
./scripts/env-doctor.sh --fix             # append placeholders for MISSING keys
```

Exit code: `0` if every REQUIRED var is set, `1` otherwise. Wire it into your
own pre-flight scripts.

---

## When to run it

| Situation | Command | Why |
|---|---|---|
| Right after `git pull` | `./scripts/env-doctor.sh` | `.env.local.example` may have gained new keys upstream that you don't have locally yet |
| Right after `git clone` | `cp .env.local.example .env.local && ./scripts/env-doctor.sh --fix` | Bootstrap from the template, then add stubs for any keys that landed after the template was last refreshed |
| Before every push runbook | `./scripts/env-doctor.sh --quiet` | Catch missing/blank REQUIRED vars before `scripts/pre-push-smoke.sh` Phase 1 does — the doctor is faster and prints per-key context the smoke gate doesn't |
| Onboarding a new contributor or signer | `./scripts/env-doctor.sh` | Hand the contributor a checklist of exactly which keys to ask for and why, with no chance of leaking your own values |

---

## What it does NOT do

- **Never reads or echoes secret values.** The script only looks for whether a
  key's value is empty or non-empty — the value itself never reaches stdout,
  stderr, or any temp file.
- **Never auto-fills a value.** `--fix` only appends lines of the form `KEY=`
  (blank value). You still have to open `.env.local` in an editor and paste the
  real value yourself. This is intentional — there's no safe place for the
  script to source secrets from, and we don't want a flag that someone might
  one day "improve" into a value-copier.
- **Never modifies `.env.local.example`.** That file is the template; only
  `.env.local` (which is `.gitignore`d) is ever written to.
- **Never touches `BLANK` keys.** If a key is present but empty, that may be
  intentional (e.g. `NEXT_PUBLIC_WALLETCONNECT_ID=` to disable WalletConnect).
  Only `MISSING` keys get placeholder lines.
- **Never validates value shape.** It won't tell you that
  `ZBASE_SEED_ENCRYPTION_KEY` is the wrong length or that
  `TREASURY_PRIVATE_KEY` is missing its `0x` prefix. That deeper validation
  lives in `scripts/pre-push-smoke.sh` Phase 1.

---

## Example output (synthetic, no real keys)

```text
$ ./scripts/env-doctor.sh
  ✓ SET     BASE_SEPOLIA_RPC
  ✗ MISSING NEXT_PUBLIC_BASE_SEPOLIA_RPC  — PUBLIC RPC for the browser frontend (wagmi/RainbowKit reads this).
  ○ BLANK   NEXT_PUBLIC_WALLETCONNECT_ID  — WalletConnect Project ID for RainbowKit (may be intentional)
  ✓ SET     POSTMAN_PRIVATE_KEY
  ○ BLANK   TREASURY_PRIVATE_KEY  — Used only by scripts/seed-pools.ts (B.3 anonymity-set bootstrap)
  ✗ MISSING ZBASE_SEED_ENCRYPTION_KEY  — 32-byte hex (64 chars). AES-256-GCM key encrypting data/seed-notes.*.json at rest.
  ... (lines omitted) ...

── env-doctor summary ──
  required: 6 set / 2 missing / 1 blank   (of 19)
  optional: 4 set / 8 missing / 6 blank   (of 18)
```

```text
$ ./scripts/env-doctor.sh --quiet
env-doctor: required 6/19 set, 2 missing, 1 blank · optional 4/18 set, 8 missing, 6 blank
```

```text
$ ./scripts/env-doctor.sh --fix
  ✗ MISSING NEXT_PUBLIC_BASE_SEPOLIA_RPC  — PUBLIC RPC for the browser frontend.
    → appended placeholder for NEXT_PUBLIC_BASE_SEPOLIA_RPC
  ✗ MISSING ZBASE_SEED_ENCRYPTION_KEY  — 32-byte hex (64 chars). AES-256-GCM key.
    → appended placeholder for ZBASE_SEED_ENCRYPTION_KEY
  ... (lines omitted) ...

── env-doctor summary ──
  required: 6 set / 0 missing / 3 blank   (of 19)
  optional: 4 set / 0 missing / 14 blank  (of 18)
  appended placeholders: 10
```

After `--fix`, open `.env.local` in your editor — every newly-appended block
looks like:

```env
# Auto-appended by scripts/env-doctor.sh on 2026-05-31T13:02:11Z
ZBASE_SEED_ENCRYPTION_KEY=
```

Paste your value to the right of `=`, save, and re-run the doctor without
`--fix` to confirm.

---

## REQUIRED vs OPTIONAL — how the doctor decides

`.env.local.example` uses two markers in its comments:

- `# REQUIRED` — the Sepolia push won't run without this. Counted in the
  "required" summary line; a missing or blank REQUIRED var causes exit 1.
- `# OPTIONAL` — feature works without it, or has a safe default. Counted in
  the "optional" summary line; a blank OPTIONAL var prints
  `(may be intentional)` and never causes exit 1.

The marker is inherited from the section header
(e.g. `=== DECOY SCHEDULER (OPTIONAL — §4 of runbook) ===` applies to every
var in that block) and can be overridden by a per-key comment.

---

## Cross-references

- **`.env.local.example`** — the source of truth for what keys the project
  expects. If you add or rename a key in code, add the corresponding line +
  comment + REQUIRED/OPTIONAL marker here in the same PR.
- **`scripts/pre-push-smoke.sh` Phase 1** — runs the same per-key existence
  check the doctor does, plus deeper shape validation
  (hex length, `0x` prefix, etc.). The doctor is the cheaper, broader cousin;
  the smoke script is the load-bearing gate before a push.
- **`docs/release/base-sepolia-push-runbook-2026-05-31.md`** — the umbrella
  runbook for an actual Sepolia push. Step 0 of any push should be
  `./scripts/env-doctor.sh` to catch friction before it bites you in Phase 4.

---

## If something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `.env.local not found` | Fresh clone, never bootstrapped | `cp .env.local.example .env.local && ./scripts/env-doctor.sh --fix` |
| Exit 1 but every key looks SET | A REQUIRED var is BLANK (not MISSING). Scroll up; BLANK lines without `(may be intentional)` are REQUIRED-blanks | Fill the value |
| Description column shows `(no description)` | The example file has no comment line immediately above that key | Cosmetic only — add a `# ...` line above the key in `.env.local.example` in your next docs PR |
| `--fix` appended a key you don't want | The key is in `.env.local.example` but you intentionally don't use it | Delete the auto-appended block from `.env.local`. The doctor will keep listing it as MISSING, but that's fine — `--fix` is opt-in |
| Two `ZBASE_API` placeholders appended on first `--fix` | `.env.local.example` legitimately declares `ZBASE_API` in two sections (decoy scheduler + onboard script) | `--fix` deduplicates within a single run, so this should not happen. If it does, delete the second block and report to the env-doctor maintainer |

---

*Last updated: 2026-05-31. Owner: whoever last touched this file. Pair file:
`scripts/env-doctor.sh`.*
