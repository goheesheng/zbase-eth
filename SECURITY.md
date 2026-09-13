# Security Policy

zBase is privacy infrastructure. A bug in the cryptographic primitives, the on-chain verifier, the ASP attestation flow, or the relayer signing path can cost real funds or break the privacy property that users depend on. Take security reports seriously and respond fast.

## Reporting a vulnerability

**Do not open public GitHub issues for security findings.**

DM **[@zbase__](https://x.com/zbase__) on Twitter / X** with the words "security disclosure" so the message routes correctly. Include:

- A clear description of the vulnerability
- Steps to reproduce (PoC code if applicable)
- Your assessment of impact (funds at risk? privacy broken? service degraded?)
- Whether the issue affects production zbase.app, the deployed Solana devnet program, the Base Sepolia contracts, or only the published SDK

We'll respond within 48 hours to acknowledge receipt and ask for whatever's needed to reproduce. If you don't hear back in that window, follow up publicly with a non-specific ping ("please check your DMs about a security report").

For larger findings, we'll move the conversation to an encrypted channel (Signal, Keybase, or a one-time PGP key — your preference).

## Scope

**In scope:**
- Smart contracts under `contracts/` and `zbase-protocol/`
- The Solana Anchor program at `7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM` on devnet (and any successor program ID on mainnet)
- The published `@zbase-protocol/sdk`, `@zbase-protocol/svm`, and `@zbase-protocol/mcp` npm packages
- The Next.js app at zbase.app — specifically the API routes under `src/app/api/` and the facilitator endpoints
- The ZK circuits in `circuits/` and the verifying keys in `public/circuits/`
- The ASP attestation pipeline

**Out of scope:**
- Issues in the 0xbow Privacy Pools upstream that have already been disclosed to 0xbow (we inherit their security posture for the protocol layer)
- Theoretical attacks against Groth16, secp256k1, BN254, or Poseidon that don't have a concrete exploit path against zBase's specific implementation
- Social engineering or phishing attempts
- Spam, abuse, or rate-limit bypass on free endpoints
- Anything requiring physical access to a user's device
- Vulnerabilities in third-party services we depend on (Vercel, Coinbase CDP, Pay.sh) — report those directly to the service

## Disclosure policy

zBase practices coordinated disclosure:

- **Critical findings** (funds at risk, privacy property broken, key compromise): we'll patch within 7 days, then publicly disclose with credit after a 30-day silent period for affected users to upgrade
- **High findings** (degraded privacy guarantee, partial information leak): 14-day patch window, 30-day silent period
- **Medium / Low findings**: included in the next regular release notes

If you discover a critical vulnerability and we haven't responded within 7 days of your report, you may disclose publicly. We'd rather have the issue fixed than buried.

## Privacy regression reporting

Beyond traditional security bugs, zBase cares about **privacy regressions** — anything that makes the on-chain settlement edge between agent and provider weaker than the documented privacy guarantee. Examples:

- A deposit + withdraw pattern that's correlatable across multiple settlements
- Metadata leakage from the facilitator (we strip sentinel headers at the middleware layer; if one slipped through, that's a regression)
- ASP attestation forgery
- Anonymity-set size below the documented minimum threshold

Report these the same way as a security vulnerability: DM [@zbase__](https://x.com/zbase__) with "security disclosure" in the message.

## Bounty

zBase doesn't currently offer a formal bug bounty program. We've reserved a small budget for ad-hoc payments to researchers who report meaningful findings — the amount scales with severity and quality of the report. DM [@zbase__](https://x.com/zbase__) to discuss.

## Audit status

> **Posture (2026-07-09):** zBase has undergone **rigorous, repeated INTERNAL
> adversarial audit** — multiple multi-agent passes that found and fixed real
> High/Medium vulnerabilities (see the dated entries below and
> [`docs/security/adversarial-audit-harness.md`](docs/security/adversarial-audit-harness.md)).
> The protocol layer inherits 0xbow's external audits (ChainSecurity, Trail of
> Bits). An **independent external audit of zBase's own deployed instances is
> recommended before mainnet real-money use** — internal review, however
> thorough, is not a substitute for independent eyes, and each of our passes has
> found something the previous one missed. Scope package for that external audit:
> [`docs/security/external-audit-scope.md`](docs/security/external-audit-scope.md).

- **Protocol layer** (0xbow Privacy Pools): audited by ChainSecurity, Trail of Bits; reports available at the [0xbow GitHub](https://github.com/0xbow-io/privacy-pools-core).
- **zBase Solana adaptation** (`packages/svm/zx402-privacy-pool/`): not yet independently audited as of 2026-06-04. Tranche 3 of the in-progress Solana Foundation Malaysia grant funds an independent threat-model review.
- **zBase Base Sepolia deployment**: uses the upstream-audited contracts; the Morpho yield extension at `contracts/PrivacyPoolMorpho.sol` has 5 passing Foundry tests but no third-party audit.
- **Internal security review (2026-06-11)**: a multi-agent internal audit plus hand verification fixed **15 findings** across the facilitator, ASP screening, deposit vault, and contracts — including fail-closed compliance screening, time-boxed vault auth, and nullifier-before-verify ordering in `UTXOPool.sol`. Full report and per-finding status: [`docs/security/internal-audit-2026-06-11.md`](docs/security/internal-audit-2026-06-11.md). **This internal review does NOT replace the external circuit audit**, which — together with the trusted-setup ceremony — remains required before any mainnet / real-money use.
- **UTXO / amount-hiding circuit** (`circuits/note_spend.circom`): frozen for the external audit (zksecurity / Veridise scope), not yet audited; the trusted-setup ceremony has not run, so the UTXO pool is testnet scaffold only.
- **ExecutorProcessooor** (private-funded cross-asset settlement, `zbase-protocol/.../ExecutorProcessooor.sol`): **internally** reviewed via a 3-angle adversarial pass (2026-07-09) — fund-theft (12 executable PoCs), ERC-20/accounting, proof-binding. **No CRITICAL/HIGH fund-theft; the context-binding invariant is sound.** Two findings fixed (residual-input DoS → refund; fail-fast scope check). 21 passing tests. **External audit (C1) is still required before mainnet** — scope package ready at [`docs/security/external-audit-scope.md`](docs/security/external-audit-scope.md); the deploy script hard-blocks mainnet until then.
- **Forwarding rail** (auto-privatize / payer-agnostic receive — `src/lib/forwarding-*.ts`, `src/app/api/forwarding/register/`): built + fund-safety-tested (62-test regression via `bash scripts/audit-regression.sh`). Includes an inbound-payer OFAC/ASP screening gate (tainted inbound is quarantined, never auto-deposited) and signature-bound registration (fixes an unauth-takeover caught in commit review 2026-07-09). Deposit notes are seed-derived (D3) so the relayer can deposit but never spend; recovery is scan-by-commitment. The live deposit + inbound-scan wiring is operator-gated for deploy. Reproducible review harness: [`docs/security/adversarial-audit-harness.md`](docs/security/adversarial-audit-harness.md).
- **Full Sherlock-style internal audit (2026-07-09)**: a 3-stream adversarial pass (custom contracts / money-path API routes / off-chain engine + dependencies + injection sinks) found **3 HIGH + 3 MEDIUM**, all fixed + tested. HIGHs: a reused-precommitment fund-lock and a missing `receipt.status` check (both in the forwarding rail / postman signer), and a provider fee-tier downgrade (compliance→standard take bypass). MEDIUMs: a consumed-tx namespace collision, a vault rate-limit victim-lockout, and daemon scan persistence/chunking. viem bumped 2.52.2→2.55.0 (the only high-sev CVE on the fund path; the CRITICAL `shell-quote` and other highs are dev/build/agent-SDK transitive, not on the money path). The three custom contracts (Executor/UTXOPool/ThresholdEntrypoint) had **no High/Medium fund-theft**. Two Lows left as noted. Per-finding detail + prior passes: [`docs/security/adversarial-audit-harness.md`](docs/security/adversarial-audit-harness.md).
- **SDK publish audit (2026-07-09)**: a 2-stream audit (API-misuse/crypto + supply-chain) before the first public `@zbase-protocol/core` release. The deployed surface (account/Merkle/proofs/stealth/facilitator/forwarding) verified clean — correct CSPRNG+rejection sampling, circuit-matching commitments, spec-correct ERC-5564. Fixed before publish: missing LICENSE/NOTICE (Apache §4), 4 high dependency CVEs (→ 0), and the unfinished UTXO scaffold's integrator fund-lock footguns (moved to an opt-in `@zbase-protocol/core/experimental` subpath so the main entry can't reach them). A post-publish fresh-install test caught an undeclared `viem` dependency (0.1.0 broke on install) → fixed in `0.1.1`.
- **Regression audit of the fixes (2026-07-09)**: an adversarial pass to verify the above fixes didn't introduce new bugs. Confirmed 4/6 fixes + the SDK restructure sound. Found + fixed one **HIGH**: the forwarding daemon's new state persistence re-opened the reused-precommitment fund-lock via non-atomic writes + silent-empty-on-corrupt + no instance lock — now atomic-write (temp+rename), **halt-on-corrupt** (never wipe the fund-lock guard), and an exclusive PID lockfile. One **MEDIUM remains open (documented, not code-fixable in-repo)**: the vault route authenticates before rate-limiting (fixing a victim-lockout), which leaves an unthrottled pre-auth ECDSA-verify CPU-DoS — because privacy middleware strips IP headers, this needs a **platform/edge throttle (e.g. Vercel WAF) on `/api/vault`**, an operational deploy control rather than a code change.

**Bottom line:** the deployed single-value + stealth + facilitator + forwarding paths and the three custom contracts have **no known High/Medium fund-theft** after internal audit. The one open item is the operational vault-throttle (MEDIUM). **Independent external audit remains recommended before mainnet real-money use.**

If you're considering using zBase with real funds, read the trust model and threat model in `docs/gitbook/` first.

## Past incidents

None publicly disclosed as of 2026-06-04.

## Maintainer

- zBase contributors
- Twitter / X: [@zbase__](https://x.com/zbase__)
- GitHub: [goheesheng/zBase](https://github.com/goheesheng/zBase)
