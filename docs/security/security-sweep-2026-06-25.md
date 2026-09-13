# Security + redundancy sweep — 2026-06-25 (pre-publish / pre-mainnet)

Four-lens sweep (3 parallel adversarial agents + deterministic checks) before the
npm publish and eventual mainnet. Scope: secrets, API auth, money-path, deps,
circuits, contracts, redundancy/future-plans. Cite file:line.

---

## VERDICT

- **npm packages — SAFE TO PUBLISH once 2 mechanical blockers are fixed (now done).**
  No secrets/keys/internal URLs ship; `data/providers.json` (provider emails) is
  excluded; test vectors are public. The blockers were publish *mechanics*, not
  safety: (1) missing `prepublishOnly` build hook + gitignored `dist/`, (2) svm
  depends on unpublished core. Both addressed (hooks added; publish core-first).
- **Server app + mainnet — 2 HIGH live-now bugs to fix before `FEE_REQUIRED=true`
  / mainnet** (provider-hijack, unauth withdraw). NOT in the published packages.
- **Contracts — none may deploy** until C4 payout + SafeERC20 + ASP-window land
  (already gated by NOT-DEPLOYED banners).

---

## BLOCKS NPM PUBLISH (fixed this sweep)

1. **[HIGH→FIXED] No `prepublishOnly` hook + `dist/` gitignored** — `npm publish`
   would ship whatever `dist/` is on disk (empty on a clean checkout — the
   `learning_workspace_tsc_vercel_build` footgun). FIX: added
   `"prepublishOnly": "rm -rf dist && tsc"` to all 3 packages.
2. **[HIGH] `@zbase-protocol/svm` depends on unpublished `@zbase-protocol/core`
   (npm 404)** — external `npm i @zbase-protocol/svm` fails until core is live.
   FIX: publish order core → mcp → svm (already the plan). Not a code change.
3. **[MED] Transitive advisories** (zk-kit→ws, snarkjs→underscore, mcp→hono CORS)
   — all transitive, none in hot paths. Run `npm audit fix` / pin before release;
   not a publish blocker.

## HIGH — server app, live now (NOT in packages; fix before fee-flip/mainnet)

- **[HIGH] Provider-registration payout hijack — `src/app/api/providers/register/route.ts`.**
  Zero ownership proof on `metaAddress`/`fallbackPayTo`. Attacker registers a
  victim's `payTo` first → `findProviderByPayTo` (settle/route.ts:425) matches the
  attacker record → `deriveStealthAddress` reroutes USDC to an attacker-controlled
  stealth address. Also lets them set the fee tier (settle:271-277). FIX: require
  EIP-191/SIWE signature from `fallbackPayTo` (mirror authorize's `ownershipSignature`).
- **[HIGH] `/api/withdraw` single-value path unauthenticated + unrate-limited —
  `src/app/api/withdraw/route.ts`.** `checkRateLimit` only wired in the UTXO branch
  (line ~940); single-value runs body→proof→POSTMAN `relay()` with no caller gate →
  gas/CPU drain. (Fee-bypass is already closed — FIND-301.) FIX: add
  `checkRateLimit(request, "settle", nullifier-keyed)` at the single-value path top.

## MED / LOW — server app (gated or low impact)

- **[MED] `/api/agent/register` self-asserted owner + spend limits** — emits
  `verified:true` for unverified records; bind to owner signature.
- **[LOW] `/api/user/upgrade` no caller-owns-address check** — inert at
  `FEE_REQUIRED=false`; real at mainnet pricing. Extend `ownershipSignature`.
- **[LOW] In-memory rate-limit fallback is per-instance** (`rate-limit.ts:42`) —
  N× budget under multi-instance Vercel. Ensure Upstash provisioned in prod (the
  B7 guard already forces this on mainnet).

## MONEY-PATH — SOUND (verified)

- Fee bypass CLOSED — `relayFeeBPS`/`feeRecipient` server-resolved from tier
  (withdraw:458-472), never read from body.
- Cache poisoning SAFE — state root vs `currentRoot` + ASP labels vs `latestRoot`
  verified before trust (withdraw:290-293); divergence → full chain scan.
- Relay status checked (withdraw:630); double-spend enforced on-chain.

## CIRCUITS / CRYPTO

- **C4 dead-square CONFIRMED** (`note_spend.circom:310-317`) — payout parked; must
  re-expose `withdrawnAmount` as a public signal before any unshield.
- **[LOW pre-deploy] Unconstrained NPK preimage** (`note_spend.circom:145-154`) —
  spend authority lives off-circuit; auditor must confirm npk.ts scheme.
- **[LOW] `aspTreeDepth` prover-chosen** (declared, not in public list / not pinned
  by contract) — auditor must confirm wrong-depth paths can't be admitted.
- **[LOW] Weak KDF in `notes.ts:466/468`** — `keccak(shared)` not HKDF; file is
  marked scaffold/"not for production." Fix before encrypted-note path ships.
- Crypto core CLEAN — `randomFieldElement` uses `crypto.getRandomValues` + rejection
  sampling; no `Math.random` for secrets; stealth zero-key guards present.

## CONTRACTS (all NOT-DEPLOYED; scoped to "before any deploy")

- **[HIGH-deploy] `UTXOPool.spend()` pays 0 USDC** (C4) — cannot deploy until fixed.
- **[MED-deploy] raw `IERC20` transfer, return unchecked** when payout re-enabled
  (UTXOPool:463) — use SafeERC20.
- **[MED-deploy] strict ASP-root equality** (UTXOPool:485) — bricks spends after any
  intervening deposit; ship the rolling-window TODO before mainnet.
- ThresholdEntrypoint clean (signer dedup, chainid+nonce binding); note immutable
  3-of-5 has no key rotation — document it.

---

## REDUNDANCY / CLEANUP (separate from security — own follow-up)

**Safe to delete:** `src/app/api/service/route.ts` + `src/lib/escrow.ts` +
`src/lib/evaluator.ts` (AgentVault-era job-escrow, zero callers); core
`scanner.ts`/`proofs.ts` exports (zero importers); ~8 zero-reference scripts
(`demo-agentcash-private.ts`, `deploy.ts`, `gen-leanimt-reference.ts`,
`test-speed.ts`, `register-facilitator-bazaar.ts`, `test-fee-flow.ts`,
`wipe-grace-period-auths.ts`, `svm-devnet-redeploy-preflight.sh`); stale
`artifacts/` JSON for deleted legacy.

**Top dedup:** point 12 `SNARK_FIELD` copies at the existing
`SNARK_SCALAR_FIELD` export (`packages/core/src/account.ts:17`); shared
`EVENT_TOPICS` for 9 `DEPOSITED_TOPIC` copies; extract `src/lib/abis.ts`
(withdraw inlines 8+ ABI objects).

**RECONCILE — stale Morpho claims contradicting on-chain truth (user-facing!):**
- `src/app/anonymity-set/page.tsx:220-225` + `src/app/api/anonymity-set/route.ts:56-65`
  still tell USERS the pool "integrates with Morpho Blue for custody / yield
  paused." On-chain the pool REVERTS on every Morpho getter. Correct: "plain
  0xbow PrivacyPool, no Morpho, no yield."
- `src/lib/contracts.ts:5,26,172-174,186` calls the pool "PrivacyPoolMorpho" /
  `DeployPrivacyPoolMorpho.s.sol` — rename comments to "0xbow PrivacyPool."
- CLAUDE.md:8 intro still says "(Morpho-backed yield)" — contradicts the
  corrected line 118. Fix.

**Keep-but-mark:** `circuits/note_spend.circom` lacks the NOT-DEPLOYED box-banner
its `.sol` siblings have; UTXO/ceremony scripts unbannered. Add headers.

**Intentional (NOT bugs — rename in-flight):** dual `/api/{zx402,zbase}/*`, 3
`ZX402_*` env vars, the immutable Anchor crate path, `AGENTVAULT_PRIVATE_KEY`
fallback. Leave as-is.
