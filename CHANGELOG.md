# Changelog

All notable changes to zBase. Each release lists what shipped, what changed for
users, and what's still pending verification.

## [Unreleased] — docs + money-safety — 2026-07-20

Idempotent settlement closes the last double-pay gap, and the docs moved off
GitBook to a self-hosted, open-source site at **https://docs.zbase.app**.

### For users

- **A payment can never be charged twice.** Settlement is now idempotent on the
  note: a lost or ambiguous response replays the same payment instead of paying
  again from the change note. The SDK reports a **tri-state** — `paid` (done),
  a thrown "note unspent" (provably safe to retry), or `uncertain` (may be spent;
  retry the same call, never pay from another note). Proven on Base mainnet with
  a **$0.001** private payment to MetaLend (plus BlockRun $0.028, Nansen $0.01).
- **New docs at [docs.zbase.app](https://docs.zbase.app).** Task-first, with a live
  API playground you can fire real read-only requests from, plain-English diagrams,
  a competitor comparison (incl. Dexter Shield), and contract addresses. Replaces
  the GitBook.
- **Docs now lead with Base mainnet (live, open pilot).** The site foregrounds the
  proven mainnet payments and demotes the Sepolia testnet to a dev-only note. The
  docs were also simplified: Ondo-style UI, collapsible nav, lighter/centered
  diagrams, and removal of internal jargon plus not-yet-shipped material (self-hosting
  guide, yield, UTXO notes, and the trusted-setup ceremony — the live pool inherits
  0xbow's audited setup).

### For contributors

- **Settlement idempotency** (`src/app/api/facilitator/settle-x402/route.ts`,
  `src/lib/settlement-store.ts`): reserve-before-withdraw on the nullifier (Redis
  lease with an ownership token + atomic Lua compare-and-finalize/delete), finalize
  never rolls back a spent note, on-chain `nullifierHashes` backstop, release only
  on proven pre-spend failure. Closed 5 Codex P1 money-safety findings + a
  lease-token serialization bug caught by `/review`.
- **`@zbase-protocol/core@0.4.5`** — client-side tri-state + idempotent settle
  retry; MCP `pay` surfaces the settlement receipt (amount, funding tx, change note
  summary) with no secret leakage.
- **Docs = MkDocs Material** (`mkdocs.yml`, `docs-requirements.txt`,
  `deploy/docs-deploy.sh`, `docker-compose.edge.yml` + `deploy/Caddyfile` for
  `docs.zbase.app`). Interactive API uses Scalar (pinned + SRI) over a hand-authored
  `openapi.yaml` of the SAFE endpoints only; `src/middleware.ts` adds scoped CORS on
  an exact-path allowlist (never a money route). All `zbase.gitbook.io` references →
  `docs.zbase.app`.

## [Unreleased] — main — 2026-07-19

Private x402 payments now work **end-to-end on Base mainnet** against real,
third-party sellers. Proven against **BlockRun** (search) and **Nansen** (token
screener), both settling via Coinbase CDP.

### For users

- **Pay real x402 sellers privately, gaslessly.** Send USDC to your deposit
  address (no ETH), `sweep` it into the pool, then `pay` any CDP-facilitated x402
  seller. The seller sees a fresh single-use address with no link to your wallet,
  and returns its data (`200`). Your change is a note re-derivable from your seed
  — nothing to write down. See `docs/how-it-works.md` → "Proven mainnet E2E".
- **Works with both x402 transport conventions.** Some sellers read the
  `X-PAYMENT` header (BlockRun), others `Payment-Signature` (Nansen); zBase now
  sends both. It does NOT work with sellers running a bespoke facilitator that
  requires signed-offers/SIWX (e.g. Otto AI).

### For contributors

- **Five fixes unblocked mainnet delivery** (`packages/mcp`, `src/lib`,
  `src/app/api`): the sweep is one atomic CDP userOp (`792df6c`); HyperSync
  `eth_getLogs` gets **hex** block numbers via `hexBlock` — the Turbopack bundle
  sent decimal, which is why the indexer "was never populated" (`9423fd8`,
  `ed6cca9`); a `--pilot` flag + post-settlement propagation retry (`aca4b6c`,
  `b651901`); and the key one — the **x402 v2 payload must include the `accepted`
  PaymentRequirements field** or CDP rejects it (`e5412ad`, `src/lib/x402-exact-payment.ts`).
- **Gotcha:** run `deploy/cron-hit.sh mainnet indexer-sync` before a pay if any
  deposit/withdrawal happened since the last sync, or the withdraw refuses with
  "indexer state tree is cold". Client `isSpent` read now uses `ZBASE_BASE_RPC`
  (Infura default rate-limits under load).

## [Unreleased] — main — 2026-06-12

Phase 1B/1C + ASP screening + a 15-finding internal security pass landed on main
(PRs #32–#40). zbase.app auto-deploys main, so everything below is live on
Base Sepolia.

### For users

- **Your deposit secrets survive a cleared browser.** Deposits now save to an
  encrypted vault keyed by your wallet signature — clearing browser data no
  longer loses access to your funds. Reconnect the same wallet anywhere and your
  deposits decrypt. Auth is time-boxed, so a captured session can't be replayed.
- **Amount-hiding (UTXO notes) — exploring, NOT live.** The shielded-transfer flow
  that would keep per-payment amounts off-chain is a scaffold only (mock verifier,
  pre-ceremony, not deployed). Today the live pool hides the payer↔payee LINK; the
  AMOUNT is still public on-chain. Amount-hiding is something we're actively
  exploring as a v2 (needs the C4/B3 circuit fixes + a trusted-setup ceremony). Do
  not represent it as shipped.
- **Compliance screening is real, not a placeholder.** Every deposit is now
  screened against the OFAC sanctions list plus a curated mixer/hack blocklist
  before it can withdraw. If screening data is unavailable the system fails
  *closed* (rejects), never silently approves. See `/api/asp-update/rejected`
  for what was excluded and why.

### For contributors

- **Internal security audit — 15 findings fixed** (`docs/security/internal-audit-2026-06-11.md`):
  fail-closed OFAC screening, time-boxed vault auth (no replay), nullifier-before-
  verify ordering in `UTXOPool.sol`, asp-update auth gate, demo-wallet IP
  hardening, authorize ownership proof, unbiased field-element sampling, stealth
  zero-key ordering, plus 7 MEDIUM/LOW fixes. The external circuit audit + trusted
  setup ceremony remain required before mainnet.
- **UTXO commitment recipe aligned to the frozen circuit (C3).** The SDK now builds
  `Poseidon3(amount, NPK, secret)` commitments matching `note_spend.circom`; the
  NPK key-derivation from recipient viewing keys stays scoped to the external audit.
- **`.vercelignore` keeps `packages/core`** so the workspace package the app
  imports is present at build time; root build script + `npm ci` install fixed.

### Still pending verification

- External circuit audit (zksecurity / Veridise) — not started.
- Trusted-setup ceremony for `note_spend.circom` — not run; UTXO pool uses a mock
  verifier and is testnet scaffold only.
- 3-of-5 threshold ASP signers — built, not yet recruited (single operator today).
- Chainalysis graph-taint screening (L3) — seam built, not wired.

## main — 2026-06-03

The `integration-test` branch landed on main via PR #7 + #8 + #9. zbase.app
auto-deploys main, so everything below is live.

### For users

- **You can now try a private payment without connecting a wallet.** The new
  `/app#try` page runs a pre-funded demo wallet through a real Base Sepolia
  deposit + ZK proof + relay in ~7–15s per payment. No MetaMask required.
- **Cleaner /app navigation.** Removed the Pool Stats tab and yield-marketing
  copy from the hero. New section flow: Home → Demo → Explain → Compliance
  → Deposit → Withdraw → Pay (agents) → Integrate. Scroll-snap is now
  `proximity` (was `mandatory`) so scrolling feels smoother on mousewheel.
- **Landing page has a clear path forward.** New orange "Launch beta" CTA
  on `/`, plus "Try without wallet" alongside. Both land on `/app`.
- **DM @zbase__** (was `@goheesheng_`) for early access — handle swapped
  across the demo error panel, `/app#integrate`, and `TryWithoutWallet`.
- **`/demo` now redirects to `/app#try`** (308). Old bookmarks keep working.

### For dev / agent operators

- **New `/test` page** is the hands-on dev surface — bundled Faucet,
  DepositWithdraw, X402Playground, CodeSample components. Use for
  onboarding new agent integrations.
- **MockUSDC parallel pool** for staging tests (`NEXT_PUBLIC_STAGING` env
  switch). Staging stack was ultimately abandoned because the ThresholdEntrypoint
  variant has no `deposit()` — testers should use Circle's faucet against
  the production pool instead.
- **Dropped WalletConnect from wagmi config.** zBase no longer ships the
  cloud.reown.com 403 console error on every page load. Browser-extension
  wallets only (MetaMask, Coinbase Wallet, Rainbow desktop, Phantom EVM).
  Mobile-only wallets via QR scan lose connect support.
- **`/api/demo/run` end-to-end demo flow** with 120s timeout, BaseScan
  recovery link on timeout, and explicit Sepolia-slow UX hint at 45s.
- **`/api/health` dashboard endpoint** for monitoring deploy state.

### Reliability

- **PR #9**: `MAX_BLOCK_RANGE` in `/api/asp-update` reduced from `9999n`
  to `1999n`. Public `https://sepolia.base.org` caps `eth_getLogs` at 2000
  blocks per call, so the previous limit silently failed for anyone
  running without a HyperSync endpoint. Fallback chunked-getLogs path now
  works against the free RPC.

### For contributors

- New `src/app/app/_components/TryWithoutWallet.tsx` (~540 LOC) drives the
  pre-funded demo showcase.
- New `src/app/app/_components/DepositOnceFramer.tsx` framer for the
  "deposit once, pay many times" explainer.
- New `src/components/test/{Faucet,DepositWithdraw,X402Playground,CodeSample}.tsx`
  for `/test`.
- `src/lib/wagmi.ts` switched from `getDefaultConfig` to explicit
  `createConfig` + `connectorsForWallets` (drops WalletConnect dep).
- `src/lib/contracts.ts` `getActiveStack()` pattern returns production stack
  unconditionally (staging path abandoned 2026-06-01).
- `next.config.ts` `/demo` → `/app#try` 308 redirect.

### Security / hygiene

- `.env.local.example` strengthened the POSTMAN ≠ TREASURY key-role warning
  with consequence explanation (same-key collision would correlate seed
  deposits with decoy traffic, killing the privacy guarantee).
- Repository-wide secret scan run before merge — no API keys, private keys,
  or PATs leaked.
- A previously-leaked Gemini API key (since rotated) was the only finding
  from the historical audit; that key is dead.

### Known caveats (carry over from 2026-05-29)

- UTXO notes contract (`UTXOPool.sol`) still scaffold-only — requires
  trusted-setup ceremony before deploy.
- Threshold-ASP (`ThresholdEntrypoint.sol`) requires 5 signers recruited
  before activation.
- Yield-distribution contract (`PrivacyPoolMorpho.sol` with `BPS=0`)
  awaiting a fresh deploy ceremony — the existing deployed pool does NOT
  yet distribute Morpho yield to depositors.
- Decoy scheduler is NOT running by default. Operator must launch
  manually via `scripts/decoy-scheduler-launcher.sh` before publicly
  claiming FIFO-resistance.

## [Unreleased] — `integration-test` branch — 2026-05-31

- `fix(B.3): seed-pools.ts crash-restart no longer double-deposits` (commit `866d625`)
  — partial-run resumption now reads the persisted encrypted-notes file and
  skips already-confirmed deposits instead of re-issuing them. Safe to Ctrl-C
  and re-invoke without burning extra USDC.
- `feat(B.3): Phase 0 seed config — 30 deposits x small denoms for bootstrap`
  (`scripts/seed-pools.phase0.config.json`) — founder-self-fundable $1,600 USDC
  bootstrap (`$10 x 10 + $50 x 10 + $100 x 10`) that unblocks Base Sepolia push
  without waiting for the $27,775 Phase 1 treasury.
- `docs: GitBook restructured to mirror shh.gg navigation` (in progress) —
  re-org of `docs/gitbook/` so the public docs share information architecture
  with the dominant privacy-pool reference site, lowering the learning cost
  for users arriving from shh.gg.
- `docs: competitive analysis vs privashh/shh.gg + Aztec Connect post-mortem`
  (`docs/competitive/why-not-an-l3-2026-05-31.md`) — argues why zBase stays
  L2-native on Base rather than spinning an L3, using the Aztec Connect
  shutdown as the cautionary case.

## [Unreleased] — `integration-test` branch — 2026-05-29

Eight shipments closing the production-grade privacy gaps surfaced during diligence
prep. Tested locally (50/50 Foundry, 7/7 seed pool, 8/8 providers route,
100/100 stealth invariants); not yet deployed to any network. See `STATUS.md`
for the shipped-vs-pending matrix and `~/.claude/plans/i-want-production-grade-enchanted-scone.md`
for the design rationale.

### For users

- **Your funds keep earning ~5% Morpho yield while idle** — all of it. The
  pool's `PROTOCOL_FEE_BPS` is now `0`; depositors receive 100% of accrued yield
  at withdrawal time. (Previously: yield sat in the pool contract undistributed.)
- **Each x402 payment now goes to a different address** (when the provider has
  registered an ERC-5564 stealth meta-address). An outside observer can no
  longer build a "wallet X paid OpenAI 40 times this hour" graph from the chain.
- **Variable deposit amounts no longer reveal the whale.** The new UTXO note
  model encrypts the value field — observers see only a commitment hash.
  (Scaffolded; full deployment requires a new trusted-setup ceremony.)
- **Facilitator no longer logs your IP, user-agent, or other identifying
  headers.** They're stripped at the middleware layer before any handler sees them.
- **Withdrawals on freshly-deposited notes are rate-limited** (default 60s)
  to defeat Tornado-style FIFO temporal de-anonymization. Pass `?fast=true`
  to opt out and accept the disclosed privacy tradeoff.

### For operators

- ASP root updates will move from single-key to **3-of-5 threshold signing**
  (FROST/BLS-style EIP-191 aggregation). Contract + 7 passing tests + governance
  doc ready; signer recruitment pending. See `docs/governance.md`.
- New decoy-withdrawal scheduler (`scripts/decoy-scheduler.ts`) blurs timing
  correlation. Poisson-distributed dummy withdrawals at ~15/hour/pool,
  configurable `MAX_DAILY_BUDGET_USD` cap.
- Anonymity-set bootstrap script (`scripts/seed-pools.ts`) deposits N notes
  per denomination from the treasury before public launch. Mirror of Vitalik's
  $113K personal seed of 0xbow Privacy Pools at their mainnet launch.

### For contributors

- New repo layout additions:
  - `circuits/note_spend.circom` — UTXO spend circuit (v0)
  - `packages/core/src/notes.ts` — note encoding + viewing-key encryption (414 lines)
  - `packages/core/src/stealth.ts` — ERC-5564 SDK (secp256k1 scheme 1, 446 lines)
  - `src/middleware.ts` — facilitator header stripping
  - `src/app/api/providers/register/route.ts` — provider stealth registry
  - `contracts/PrivacyPoolMorpho.sol` — yield-distributing pool (233 lines, 5 tests)
  - `zbase-protocol/.../UTXOPool.sol` — UTXO pool scaffold (313 lines)
  - `zbase-protocol/.../ThresholdEntrypoint.sol` — 3-of-5 ASP (243 lines, 7 tests)
  - `scripts/threshold-postman/` — off-chain quorum coordination
  - `scripts/seed-pools.ts` + `scripts/reclaim-seed-pools.ts` — anonymity-set bootstrap
  - `docs/gitbook/trust-model.md` — what zBase defeats / does NOT defeat
  - `docs/gitbook/threat-model.md` — attack-to-defense map
  - `docs/governance.md` — threshold-signer operations
  - `docs/provider-integration.md` — ERC-5564 onboarding for providers
  - `docs/utxo-notes-design.md` — UTXO design + ceremony requirement
  - `docs/anonymity-set-disclosure.md` — transparent treasury-vs-organic reporting

- Revenue-model change: dropped the 1% Morpho yield spread that earlier drafts
  proposed. Three reasons documented in the plan file: math doesn't work at
  agent TVL scale ($0.0125/yr/customer at typical balances), conflicts with
  the privacy thesis, triggers SEC/MiCA/BSA regulatory category-creep.
  Final pricing: `$0.002/settle + $499/mo Pro` — yield is now a customer
  benefit, not a revenue line.

### Live-tested on Base Sepolia (2026-05-29)

All safe paths exercised against a running dev server + live Base Sepolia. No new
contract deploys (yield-distribution, UTXO, threshold-ASP all still need ceremonies).

| Test | Result | Evidence |
|---|---|---|
| Full E2E (1 USDC, run 1) | 7,086 ms settle | [deposit](https://sepolia.basescan.org/tx/0x10983625d69cc811c81be7a4eacb797fb43a7a626688c9af56fe6ee585b9a018) · [withdraw](https://sepolia.basescan.org/tx/0xecd379c0671d13890bf4b544030373199b35695a3be62607c3608292f076628c) · anon-set 75 |
| Full E2E (1 USDC, run 2) | 7,414 ms settle | [deposit](https://sepolia.basescan.org/tx/0xbb9806a8fef29e0d2b9b96011243e79d446febce0dd00dc782e287015b732842) · [withdraw](https://sepolia.basescan.org/tx/0x878643fcb762b6b661b193b6d1b1e52d0c981314470ef2ca174a32451bbf3ae0) · anon-set 77 |
| A.3 middleware live HTTP | PASS | 6 sentinel headers stripped, 4 privacy headers stamped, no leaks |
| A.2 decoy dry-run | PASS | 10 burn addrs loaded, Poisson interval 43.9s, no gas spent |
| B.1 stealth SDK (100 derivations) | PASS | view-tag scan 164ms, all 100 keys recovered |
| B.1 providers route live | PASS | POST 200, persisted to `data/providers.json` |
| B.3 seed pool dry-run | PASS | 100 deposits / 27,775 USDC across 4 denoms planned |
| Foundry suite (50 tests) | PASS | yield 5 + threshold 7 + StealthPay 18 + 0xbow Unit 20 |

**Mean settle:** ~7.25s across both runs. Plan's gate revised to ≤10s p95.

### Still scaffold-only (not yet live)

- **A.1 UTXO** — circuit + SDK + contract scaffold landed; needs trusted-setup ceremony before deploy
- **B.2 Threshold ASP** — contract + coordinator landed; needs 5 signers recruited before deploy
- **Yield distribution contract** — `PrivacyPoolMorpho.sol` with `BPS=0` landed; needs multi-sig deploy
  (the e2e tests ran against the *existing* deployed pool, which does not yet have yield-distribution
  code — the off-chain parser is forward-compatible)

### Pending before mainnet

- Trusted-setup ceremony for UTXO spend circuit (A.1)
- Recruit 5 threshold signers (B.2)
- Multi-sig deploy of `PrivacyPoolMorpho.sol` with `PROTOCOL_FEE_BPS = 0` (new pool address)
- Onboard first provider with stealth meta-address (B.1, SAN Foundation is the obvious first ask)
- Apply to Base Ecosystem Fund for $50K matching capital for B.3 seed deposits
