# Adversarial Audit Harness (internal review)

A repeatable, multi-angle adversarial review any capable model (Opus, Fable, or a
human auditor) can run against zBase's fund-holding surfaces. It packages the
three-angle review that found + fixed the executor's residual-input DoS
(2026-07-09) so the same rigor is reproducible on every change.

> ## ⚠️ THIS IS INTERNAL REVIEW — NOT AN EXTERNAL AUDIT
>
> Running this harness does **NOT** satisfy the external-audit gate. Per
> `SECURITY.md` and `MAINNET_READINESS.md` (C1/D1), an **external firm** must audit
> any deployed fund-holding instance before real money on mainnet. This harness
> makes code *audit-ready* and catches real bugs early; it is a complement to, not
> a replacement for, C1. Never describe a harness pass as "audited."

## What it reviews

| Target | File | Fund-holding? |
|--------|------|---------------|
| ExecutorProcessooor | `zbase-protocol/pkg/contracts/src/contracts/ExecutorProcessooor.sol` | Yes — withdraws from pool, spends into whitelisted calls |
| Forwarding engine core | `src/lib/forwarding-engine.ts` | Indirect — orchestrates deposits via a bounded relayer |
| Forwarding watcher | `src/lib/forwarding-watcher.ts` | No — detection + compliance screening |
| Forwarding registry | `src/app/api/forwarding/register/route.ts` | No — but authorizes precommitments (takeover surface) |

## The three angles (run each as an independent, hostile pass)

Spawn a **separate** reviewer per angle so they don't anchor on each other. Each is
instructed to **default to "there IS a bug"** and to produce concrete exploits, not
vibes. Only findings reproduced with a PoC or a precise trace are actioned.

### Angle 1 — Fund theft / permanent strand
Goal: steal or permanently strand funds. Attacker = relayer, malicious plan
author, malicious whitelisted target, or arbitrary third party. Must-try:
- redirect funds to an attacker address (check every fund-directing field is bound)
- pre-send tokens to skew delta/snapshot accounting
- reentrancy despite guards; raw `.call` callbacks
- front-running / griefing
- for the engine: can a failed/duplicate deposit double-spend or lose the inbound?

### Angle 2 — ERC-20 / accounting edge cases
Goal: wrong amounts, revert-on-valid, stuck funds. Must-try:
- fee-on-transfer / rebasing tokens vs delta accounting + residual asserts
- partial-consume targets (ERC-4626 rounding, exact-out routers)
- USDC blocklist on recipient/fee → does the nullifier roll back? (confirm atomicity)
- rounding (fee→0, spendAmount→0), forceApprove/USDT, integer underflow on valid paths

### Angle 3 — Proof / authorization binding
Goal: break the trust invariant. Must-try:
- is EVERY fund-directing field inside the bound preimage? (executor: `w.data`;
  registry: the signed message) — trace both the on-chain re-derivation AND the
  server/client encoding, byte-for-byte
- encode vs encodePacked collisions; unbound caller-controlled inputs
- for the registry: can anyone register/update a watched address they don't control?
  (the 2026-07-09 takeover bug — signature must bind address+precommitment+index+network)

## How to run

1. Read the target file(s) fully.
2. Launch one hostile reviewer per angle (parallel), each with the angle's brief +
   "default to there-is-a-bug, PoC or precise trace required, no invented findings."
3. Consolidate + dedupe findings across angles.
4. Fix only what's reproduced; add a regression test per fix.
5. Re-run the relevant test suite (`forge test` for contracts; the `scripts/test-forwarding-*.ts`
   for the engine) and confirm green.
6. Record the pass date + findings; note explicitly that C1 (external) remains open.

## Regression suites (must stay green after any change)

```
forge test --match-contract ExecutorProcessooor -vv   # 21 executor tests
npx tsx packages/core/src/forwardingNotes.test.ts      # 11 D3 fund-safety tests
npx tsx scripts/test-forwarding-watcher.ts             # 6 compliance-gate tests
npx tsx scripts/test-forwarding-authz.ts               # 5 registry-authz tests
npx tsx scripts/test-forwarding-engine.ts              # 8 engine fund-safety tests
```

## Prior passes

- **2026-07-09 — Executor, 3 angles.** No CRITICAL/HIGH fund-theft. Found + fixed:
  residual-input DoS (Medium, now refunds instead of reverting), fail-fast scope
  (Low), struct-sync comment (Info). Proof-binding confirmed sound. 12 PoC tests.
- **2026-07-09 — Forwarding registry.** Automated commit review caught a CRITICAL
  unauth-takeover (bare address-match update). Fixed: signature-bound
  register/update. 5 authz tests.
- **2026-07-09 — Full Sherlock-style pass (3 parallel streams: contracts / money-path
  API / off-chain engine + deps + sinks).** Found **3 HIGH + 3 MEDIUM**, all fixed +
  tested. The 3 contracts had no High/Medium fund-theft (Executor/UTXOPool/
  ThresholdEntrypoint all sound on access-control, reentrancy, nullifier-ordering,
  and signature/quorum). Findings + fixes:
  - **HIGH — reused-precommitment fund LOCK** (`forwarding-engine.ts`): 2nd inbound to
    a watched address minted a note with a colliding nullifier → permanently
    unspendable. Our own test *masked* it. Fixed: `depositedPrecommitments` guard
    (refuse 2nd deposit at a used precommitment; funds stay recoverable).
  - **HIGH — `sendPostmanTx` ignored `receipt.status`** (`postman-signer.ts`): a
    reverted-but-mined tx reported as success across the whole postman money path.
    Fixed: throw on non-success.
  - **HIGH — provider fee-tier downgrade** (`withdraw`/`settle`): `providerTier ??
    nullifierTier` let a self-registered standard provider downgrade a compliance
    nullifier (take bypass). Fixed: `resolveEffectiveFeeTier` charges the higher take.
  - **MEDIUM — consumed-tx namespace collision** (`/authorize` vs `/user/upgrade`):
    one payment could burn the other. Fixed: purpose-namespaced keys.
  - **MEDIUM — vault rate-limit victim-lockout** (pre-auth keying on claimed address).
    Fixed: authenticate first, rate-limit on the authenticated address.
  - **MEDIUM — daemon scan not persisted/chunked**: restart re-processed; large windows
    truncated + dropped inbounds. Fixed: disk persistence + ≤500-block chunking.
  - **Deps:** bumped viem 2.52.2 → 2.55.0 (only high-sev CVE on the fund path). The
    CRITICAL `shell-quote` + other highs are dev/build/agent-SDK transitive, NOT on the
    money path; did NOT run `npm audit fix --force` (breaks the build).
  - **Cleared false positives:** `execFileSync` (health), both `dangerouslySetInnerHTML`,
    SSRF, vault auth, forwarding signature fix — all verified safe.
  - **Lows left as noted (not fixed):** UTXOPool dummy-nullifier footgun (self-inflicted,
    circuit change → re-freeze risk), executor FoT-input DoS (can't trigger on USDC config).
