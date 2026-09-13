# Seed-Pool Risk Analysis

**Date:** 2026-05-31
**Scope:** End-to-end risk surface for executing B.3 (`scripts/seed-pools.ts` + `scripts/reclaim-seed-pools.ts`)
**Audience:** CEO, eng lead, compliance reviewer
**Posture:** No-script-run audit. Code claims below are anchored to `scripts/seed-pools.ts` line refs.

---

## 1. Compliance risk

### Jurisdictional read (founder is Singapore-resident)

**United States (FinCEN):** Treasury's 2025 Presidential Working Group report explicitly acknowledged that mixers have legitimate privacy uses, and Treasury declined to finalise the 2023 FinCEN proposed rulemaking that would have classed all CVC mixing as a primary money-laundering concern. **However**, custodial mixers (those holding customer funds) remain subject to MSB registration under the Bank Secrecy Act. zBase's design — non-custodial pool, ZK-verified withdrawals, ASP allowlist — places it outside the "custodial mixer" classification, but FinCEN's April 2026 proposed AML/CFT reform shifts toward an *outcome-based* regime where intent matters as much as form. **Treasury-seeding 100 of your own commitments is unusual enough that you should be ready to explain it.** Vitalik's $113K seed of 0xbow is the direct precedent and was not enforced against.

**Singapore (MAS):** The Payment Services Act and 2024 FSMA DTSP consultation require licensed providers to *track exposure* to anonymity-enhancing technologies and document transactions with addresses where AET is applied. Critically, this targets *licensed PSPs handling customer funds*, not protocol developers seeding their own contracts. A founder depositing personal/treasury USDC into a Base contract is **not, on its face, a regulated payment service activity in Singapore as of 2026**. The risk surface opens once zBase takes custody of third-party funds or routes payments on behalf of agents — which the facilitator architecture explicitly avoids. Recommend a one-page memo from a Singapore crypto counsel (Drew & Napier, RHTLaw Asia) before executing if seed size grows past Phase 0.

**EU (AMLR Art. 79, effective 2027-07-01):** Will prohibit credit institutions, financial institutions, and CASPs from handling privacy-preserving digital assets or maintaining anonymous accounts. zBase, as a non-EU-incorporated open-source protocol, is not a CASP — but any EU-based facilitator operator integrating zBase post-2027 will face restrictions. Seed pool execution itself is unaffected; downstream distribution into EU markets is. Flag for the Q1 2027 GTM plan.

### Recommendation

- Execute Phase 0 ($1,500) now without external counsel
- Singapore counsel one-pager before Phase 1 ($6K)
- US counsel opinion letter before Phase 2 ($28K) — particularly if any anchor investor is US-domiciled
- Public disclosure document (`docs/anonymity-set-disclosure.md`) is the single most powerful compliance defence: a treasury seed that is publicly labelled, on-chain auditable, and time-locked is the opposite of an obfuscation attempt

---

## 2. Technical risk (mid-run failure leaks treasury commitments)

Audit of `scripts/seed-pools.ts`:

| Property | Behaviour | Risk implication |
|---|---|---|
| **Resumability** | `allNotes` accumulates in-memory and is re-serialised + re-encrypted after every successful deposit (line 492: `writeEncryptedNotes(config, allNotes, encKey)`). On crash, partial encrypted file is on disk. | A re-run with the same `--config` does **NOT** resume from the partial file — it starts a fresh `allNotes = []` (line 419). Re-running after a crash will **DOUBLE-DEPOSIT** every commitment that was minted before the crash, producing fresh nullifiers and secrets for the same denominations. Old commitments stay on-chain but the script forgets them, and on-disk file is **overwritten with only the new notes**, permanently losing the old secrets. **This is the highest-severity bug surface.** Recommend a `--resume` flag or rename-on-overwrite before any live run |
| **Idempotency** | None at the script level. The on-chain `deposit()` is naturally non-idempotent (each call mints a new commitment) | A network blip that causes an apparent failure but actually succeeded on-chain (timeout-after-confirmation) will cause the resumability bug above |
| **Leak surface during failure** | The script writes encrypted notes only. No plaintext is logged. `console.log` exposes tx hash + first 14 chars of commitment (line 488) — these are public on-chain anyway | No incremental information leak. Plaintext only exists in process memory |
| **Treasury-attribution leak** | Every deposit is signed by `config.treasury`, which is hardcoded in the public config file (`scripts/seed-pools.config.json`). All 100 deposits will show the same `tx.from` on Basescan. Analysts can trivially identify "all deposits from address X are treasury seed" | **This is the design intent** — public disclosure depends on the treasury address being known. The seed is NOT meant to hide that it is the seed; it is meant to inflate the anonymity set for *organic* depositors who follow |
| **Timing leak** | `depositGapMs` defaults to 5000ms (line 420). With 100 deposits this produces a ~8-minute window of one-tx-every-5s from a single address | Recommend randomised jitter (`depositGapMs * (0.5 + Math.random())`) and a longer mean gap (30–60s) to make the seed deposits less visually distinguishable as a script |
| **Encryption strength** | AES-256-GCM with 12-byte random IV, AuthTag separate, plaintext SHA-256 stored for tamper detection (lines 237–256). Industry standard | OK |
| **Key validation** | Both the env var format (64 hex chars) and the treasury-key-matches-config-treasury check (line 356) are present | OK |

### Recommendation

1. **Before any live run, patch the resumability bug.** Either: (a) load existing encrypted notes file if present and append, OR (b) refuse to start if encrypted notes file already exists at `config.encryptedNotesPath`
2. Add randomised jitter to `depositGapMs`
3. Run `--dry-run` against mainnet config to verify plan output before live execution
4. Pre-flight check: `git stash list` empty, no uncommitted changes to the script or config

---

## 3. Disclosure risk (treasury outnumbers organic 100:3)

**Problem:** If the launch post reads "anonymity set = 103 (100 treasury + 3 organic)", every organic depositor's withdrawal is now in an effective set of 3, not 103, because analysts subtract the public treasury commitments. Disclosing the raw ratio is *worse than not disclosing it* until organic depth catches up.

**Proposed disclosure ladder:**

| Organic depositors | Public disclosure language | Quantitative detail published |
|---|---|---|
| 0–29 | "Anonymity set bootstrapped by zBase treasury seed. Treasury commitments are time-locked until 2026-12-01 and will be reclaimed transparently. Detailed composition published at 30+ organic depositors." | Total set size only |
| 30–99 | "Anonymity set: N total commitments, of which M (M ≥ 30) are organic." | Organic count + total |
| 100+ | Full ratio disclosure; quarterly composition reports per the GitBook commitment | Treasury %, organic %, by denomination |

**Threshold rationale:** k=30 is the conventional anonymity-set lower bound for meaningful unlinkability against passive observers (Tornado Cash anonymity research). Below 30 organic, treasury inflation does more PR harm than privacy good.

**Hard rule:** the encrypted notes file's `notesByPool[address].denomCount` IS public metadata (`scripts/seed-pools.ts:530–537`). Per-denomination treasury counts are already disclosed by file structure. Be honest about this in the disclosure doc.

---

## 4. Reclaim risk (2026-12-01 unlock clustering)

When the treasury reclaims, each `withdraw()` call burns a nullifier known to be a treasury nullifier (from the public disclosure). Analysts can:

1. Cluster all withdrawals in the days after 2026-12-01 from the treasury reclaim wallet
2. Subtract those from the anonymity set retroactively
3. Re-identify any organic withdrawal that happened *during* the seeded period

**Mitigations (reclaim-pattern recommendation):**

- **Stagger reclaim across ≥90 days** post-unlock, not in a single burst. 100 commitments / 90 days = 1–2 reclaims/day, lost in normal transaction noise
- **Reclaim to ≥10 fresh addresses**, never to a single treasury sink (else clustering trivially re-identifies treasury)
- **Skip reclaim of low-value commitments entirely** — for any commitment under $50, gas cost may exceed value, and leaving it in the set permanently strengthens the anonymity claim
- **Reclaim from the *least*-recently-deposited commitment first** (FIFO) so the residual set looks like an organically-aging pool
- **Publish the reclaim schedule in advance.** Pre-disclosure removes the "surprise un-mixing event" risk
- Coordinate reclaim window to NOT overlap with any high-profile organic withdrawal (e.g., known marquee agent's monthly settle)

---

## 5. Operational risk (`ZBASE_SEED_ENCRYPTION_KEY` loss)

The encryption key is the *only* path from on-chain commitment back to spendable nullifier+secret. Without it, $27,775 is locked forever (the pool contract has no admin recovery — by design).

**Backup recommendation (defense in depth):**

1. **Primary:** generate key via `openssl rand -hex 32` in an air-gapped session; never `console.log` it. Store in 1Password or AWS Secrets Manager with strict ACL (CEO + CTO only)
2. **Shamir 3-of-5 split** across:
   - CEO Ledger (paper backup in safe deposit box)
   - CTO Ledger (paper backup in separate physical location)
   - Cold-storage USB in CEO's residence safe
   - Cold-storage USB in CTO's residence safe
   - Encrypted file in AWS KMS with break-glass IAM role (CEO + CTO dual approval)
3. **Test reclaim quarterly** with a single throwaway commitment (deposit $1, reclaim $1) to verify the key, the script, and the encrypted notes file are all still functional. Calendar this — a key that works on day 1 but is lost on day 180 is the failure mode
4. **Off-host backup of the encrypted notes file itself** — encrypted file in S3 with versioning + object lock, plus a copy on each principal's machine. The encrypted file is useless without the key, so backing it up to cloud is safe

**Anti-pattern to avoid:** storing the key in the same place as the encrypted notes file (defeats the purpose) or in any environment variable that gets written to a shell history file.

---

## Sources

- [Treasury tells Congress mixers have valid privacy uses (The Block, 2025)](https://www.theblock.co/post/392769/treasury-tells-congress-mixers-have-valid-privacy-uses-recommends-hold-law-for-suspicious-crypto)
- [FinCEN April 2026 AML/CFT reform proposal (Mayer Brown)](https://www.mayerbrown.com/en/insights/publications/2026/04/out-with-the-old-in-with-the-risk-based-fincen-proposes-fundamental-reform-of-aml-cft-program-requirements)
- [FinCEN MSB Registration Rule fact sheet](https://www.fincen.gov/fact-sheet-msb-registration-rule)
- [Singapore PSA Amendments — DTSP scope (Lexology)](https://www.lexology.com/library/detail.aspx?g=7aaa4970-1f89-4625-b4d3-b3e03a88da86)
- [MAS Payment Services Act 2019](https://www.mas.gov.sg/regulation/acts/payment-services-act)
- [MAS DTSP consultation under FSMA (Duane Morris)](https://blogs.duanemorris.com/duanemorrisandselvam/2024/10/18/redefining-boundaries-mas-consults-on-new-regulatory-framework-for-digital-token-service-providers-under-the-fsma/)
- [EU AMLR Article 79 — anonymous account prohibition (FTFA-SAO)](https://ftfa-sao.org/eu-crypto-aml-requirements-mica-travel-rule-2027-compliance-guide)
- [EU anonymous wallet ban final, 2027 (CoinGeek)](https://coingeek.com/eu-law-banning-anonymous-digital-asset-wallets-by-2027-final/)
