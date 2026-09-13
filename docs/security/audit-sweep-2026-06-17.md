# zBase full-repo audit sweep — 2026-06-17

**Trigger:** pre-mainnet diligence (user requested deploy + doc/code sync + bug hunt).
**Method:** 7 parallel read-only auditor agents (contracts, circuit, docs, SVM, API/x402,
crypto, scripts/config). High-severity fund-loss claims independently re-verified by
direct source reading. **No files modified by the audit. Nothing merged. Nothing deployed.**
**Verdict:** the system is **NOT mainnet-deployable** today — multiple independent blockers,
some pre-existing-and-known (ceremony, C4), some **NEW** (found by this sweep).

Branch audited: `feat/ceremony-github-selfhost` @ `2e4adc8`.

---

## DEPLOY-BLOCKERS (must clear before any mainnet / real-money launch)

### Pre-existing / known (process gates — already understood)
- **B0. Trusted-setup ceremony has not run.** UTXOPool's verifier is a test `MockVerifier`
  that returns `true` for any proof. Deploying = anyone drains the pool. (contract gate F9
  only checks `code.length > 0`, which a mock passes.)
- **B1. C4 — `withdrawnAmount` payout unsound.** `note_spend.circom:310-317` "binding"
  squares are dead no-ops; `withdrawnAmount` is unconstrained except by conservation.
  Contract correctly PARKS the payout (`UTXOPool.sol:421-443`, emits 0). Unshield cannot
  go live until the circuit binds the amount (re-expose as public signal = re-freeze + re-ceremony).
- **B2. External circuit + contract audit not done.** Internal-audit doc's standing conclusion.

### NEW blockers found by this sweep

- **B3 (HIGH, NEW) — Circuit witness-gen is wrong for any non-left-spine leaf.**
  `packages/core/src/merkle.ts:53-61` + `scripts/build-note-spend-witness.ts:173-187` feed the
  circuit the **raw `leafIndex`** for path bits but zero-pad zk-kit's **compacted** sibling
  array. When a leaf's path crosses a "no right sibling" level, the siblings and index bits
  misalign → wrong root → proof unsatisfiable. The committed fixture only uses spine indices
  (0,1) so `wtns calculate` passes **by luck** and masks it. *A ceremony validated only by the
  current fixture would be validating nothing.* Fix is off-chain (no circuit change): consume
  zk-kit's `proof.index` + compacted siblings faithfully, and add an adversarial fixture
  exercising a dropped-sibling leaf. **Must fix + re-verify before the ceremony is worth running.**

- **B4 (HIGH, NEW — Solana) — Withdrawal payout can be redirected to an attacker.**
  `lib.rs:608-609` `recipient_token_account` has no `associated_token::authority = recipient`
  constraint. The ZK context binds the recipient *pubkey* but not the token *account*; a
  permissionless relayer with a valid proof can set the destination to a USDC account they own
  (SPL Transfer checks mint, not owner) and steal the withdrawal. Fix: constrain the ATA to the
  `recipient` arg. Blocks Solana mainnet.

- **B5 (HIGH, NEW — Solana) — Deposit vault not bound to the pool PDA.**
  `lib.rs:577-578` `vault` is `#[account(mut)]` only. A depositor can send USDC to an account
  they control while still minting a valid commitment into the tree → commitments unbacked by
  vault funds → later honest withdrawals drain the real vault. Fix: `seeds=[b"vault", pool…],
  address = pool_state.vault`. Blocks Solana mainnet.

- **B6 (CRITICAL for EVM mainnet, NEW) — Money/ASP routes hardcode Base Sepolia.**
  `withdraw/route.ts:184` (`writeRpcUrl="https://sepolia.base.org"`, `chain: baseSepolia`),
  `asp-update/route.ts:71,145`, `verify/route.ts:6,242` all pin Sepolia viem clients/RPC even
  though they read addresses from `getActiveStack()`. Flipping `NEXT_PUBLIC_NETWORK=mainnet`
  would sign for chainId 84532 against mainnet addresses (and `MAINNET_STACK` is still
  `address(0)` placeholders anyway, `contracts.ts:143-151`). The network-selection *library*
  (`getActiveStack`/`getStackByName`/throw-on-utxo-mainnet) is correct; the route handlers
  ignore it. Must thread network → chain/RPC before any EVM mainnet flip.

- **B7 (HIGH if Upstash absent, NEW) — In-memory fallback = fee/replay/ratelimit bypass.**
  `facilitator-authz.ts:48-56`, `rate-limit.ts:36`, `vault/route.ts:45-58` silently degrade to
  per-instance in-memory maps when Upstash env is missing. On Vercel multi-instance this means
  per-instance replay of access-token txs and N× rate budget. No startup assertion. Add a
  fail-closed check that Upstash is provisioned before mainnet.

---

## OTHER REAL FINDINGS (not deploy-blockers, fix before the relevant surface goes live)

### Contracts (EVM)
- **HIGH (NEW) — `stateTreeDepth` (pubSignals[5]) never validated on-chain.** `UTXOPool.sol`
  checks [4],[6],[7] but not [5], despite storing `treeDepth`. Becomes a live risk once a real
  verifier is wired; reconcile with the circuit's `actualDepth` handling.
- **MED (NEW) — Entrypoint `latestRoot` type mismatch.** `IEntrypoint` declares `uint256`;
  `ThresholdEntrypoint.latestRoot` is `bytes32` with no field reduction. Decodes by luck today
  (ThresholdEntrypoint not yet wired); resolve before B.2 wiring.
- **MED (NEW) — Raw `IERC20.transfer` staged for the C4 re-enable.** UTXOPool's `IERC20` uses
  unchecked raw transfer; PrivacyPoolMorpho uses SafeERC20. Use SafeERC20 when payout is restored.
- `_insertLeaf` Poseidon2-LeanIMT re-derivation **CONFIRMED CORRECT** for indices 0..8 incl.
  perfect-tree (1,3,7); matches JS zk-kit. (Phase 2 work validated independently.)

### Circuit
- **MED (NEW) — `inAmount[i]` has no in-circuit 64-bit range check** (outputs + withdrawn do).
  Relies on the unstated assumption that every in-tree commitment has a bounded amount;
  conservation is over the full field, so a field-large input amount could wrap. Auditor must
  confirm no path inserts an unbounded-amount commitment, or add `Num2Bits(64)` to inputs
  (constraint-count change → affects freeze).
- **MED (NEW) — circuit does not enforce slot-distinct nullifiers** (same note in both input
  slots). Defended on-chain by `_consumeNullifiers` (`n0==n1` reverts), but any verifier reuse
  must replicate that guard.

### Crypto (off-chain)
- **MED (NEW) — `bytesToField` modulo bias is ~5.4% (2^-4.2), not the "<2^-253" the comment
  claims** (`npk.ts:71-80`). On `viewingPKBlind` (secret-derived) it's a real but bounded
  uniformity weakness; no fund loss, no proof failure. The false in-code security claim will
  mislead the external auditor — fix the comment + rejection-sample (the pattern already exists
  in `account.ts:151`).
- **MED (NEW) — `recoverViewingPKBlind` is dead code; the documented ECDH-recovery path is not
  the one used.** The blind actually travels in the AEAD plaintext (serialized note), not via
  the NPK ephemeral key (which is never published). No fund loss today, but the recoverability
  property the auditor is asked to rely on is provided differently than documented; a future
  refactor could silently break recovery with no test catching it. Reconcile docs↔code.
- **LOW-in-core / HIGH-adjacent — a stale duplicate `src/lib/stealth.ts` (pre-F8) is what the
  live facilitator imports** (`settle/route.ts:3`), lacking the `% n` reduction + zero-key
  guard that were only fixed in `packages/core`. Delete the dup and import core, or back-port F8.

### Scripts / CI
- **MED (NEW) — `scripts/forge-wrap.sh:31` routes `UTXOPool` + `DeployStaging` to the default
  profile → 0 tests run, exits 0 (false green).** The pool-safety suite can be "passed" while
  running nothing. Add both to `THRESHOLD_CONTRACTS`.
- **MED — `decoy-scheduler.ts:375` hardcodes the public Sepolia RPC for writes** (ignores
  `BASE_SEPOLIA_RPC`), so the A.2 FIFO-defense hits public-RPC rate limits.
- The 4 failing threshold deploy-script tests are **forge env-bleed (harness), not deploy bugs**
  — each passes in isolation; `vm.setEnv` leaks across tests. (Verified.)

---

## SYNC / DOC-DRIFT (cosmetic→misleading; no wrong-deploy risk on its own)

- CLAUDE.md:174 "Revenue: $0.002/settle + $499/mo Pro tier" — code has **no $499 tier**; it's a
  bps model (30/100 bps) with floors + access fees + enterprise $2.5K–$25K/mo. README is correct.
- `docs/release/mainnet-deploy-checklist.md:77-81` says `_insertLeaf` is a keccak placeholder —
  **stale** (Poseidon-LeanIMT landed 2026-06-16). Lines 9-10 mislocate the mock verifier (it's
  in the test file, not `UTXOPool.sol:50,98`). The *substance* (don't ship the mock) is right.
- `UTXOPool.sol:375,506` prose still says "10 public signals" — layout is 8 (`uint256[8]`). Cosmetic.
- internal-audit-2026-06-11.md:159-160 cites "UTXOPool 13/13" — now 15; "ThresholdEntrypoint 20/20"
  is actually 7 (20 is AgentVaultEscrow). Cosmetic count drift.
- README implies `@zbase-protocol/*` npm packages are published; CLAUDE.md + memory say none are.
- CLAUDE.md commands omit `test:note-spend-witness` + `ceremony:dryrun-smoke`, and don't note the
  `FOUNDRY_PROFILE=threshold` requirement for UTXOPool tests (plain `forge test` runs 0 of them).
- x402 `/supported` advertises "Kamino 4-9% APY" but the Kamino CPI path is unexercised legacy.

### Verified CORRECT (load-bearing confirmations)
- Circuit freeze hash matches `CIRCUIT_FROZEN_FOR_AUDIT.md`. All Base Sepolia addresses match
  across CLAUDE.md / contracts.ts / test-curl.sh. Solana immutables (lib name + program ID +
  idl metadata.name) intact. NPK/commitment/nullifier recipes match circuit↔core↔witness builder.
  AEAD (XChaCha20-Poly1305, random nonce, domain-separated, AAD = keccak256(abi.encode(commitment)))
  sound. `randomFieldElement` correctly rejection-sampled. 501 guards on the UTXO real-proof path
  are fail-closed and correct. Ceremony scripts' EXIT-trap cleanup + test-beacon refusal are solid.
  No private keys in any tracked file; `.env.example` clean; no `sed -i` footgun in scripts.

---

## Fixes applied (2026-06-17, same day — branch `feat/ceremony-github-selfhost`)

All verified by build/test; nothing merged or deployed. EVM contracts: default
50/50, UTXOPool 15/15. core+svm-sdk build, app tsc, `npm run build`, witness
`wtns calculate`, and the Anchor `cargo build-sbf` all green.

| ID | Status | What changed |
|----|--------|--------------|
| **B3** | FIXED (+ residual flagged) | `merkle.ts` + `build-note-spend-witness.ts` + SVM `pool.ts` now feed the circuit zk-kit's COMPACTED `proof.index`/`actualDepth` (not raw leafIndex). Fixture moved to a non-spine 4-leaf perfect tree (depth 2) so `wtns calculate` no longer passes by luck. **Residual circuit-design limit** (shared `stateTreeDepth` can't represent non-perfect-tree indices) is documented for the external auditor — needs a circuit change → re-freeze. |
| **B4** | FIXED (Solana) | `RelayWithdrawal.recipient_token_account` now `token::authority = recipient` (+ `relayer_token_account` bound to relayer). Closes payout redirection. |
| **B5** | FIXED (Solana) | `Deposit.vault` + `RelayWithdrawal.vault` now `address = pool_state.vault @ InvalidVault`. Closes the unbacked-commitment solvency hole. |
| **B6** | FIXED (EVM) | New `getActiveChain()` in `contracts.ts`; `withdraw`/`asp-update`/`verify` routes resolve chain + read/write RPC (+ HyperSync URL + pool address) per network instead of hardcoding Base Sepolia. **Follow-up (2026-06-17, from the /qa pass):** `facilitator/supported/route.ts` also hardcoded `eip155:84532` + "Base Sepolia (84532)" (same class, advertising metadata) — now derived from `stack.facilitatorNetwork`. Runtime-verified: unset/sepolia→84532, mainnet→8453. |
| **B7** | FIXED (EVM) | `facilitator-authz.ts` throws at load if `NEXT_PUBLIC_NETWORK=mainnet` without Upstash/KV — fail-closed against the in-memory fee/replay bypass. |
| bias (MED) | FIXED | `bytesToField` now deterministic rejection-samples (uniform over the field); the false "<2^-253" comment corrected to the real ~5.4%. |
| stealth dup | FIXED | Deleted stale pre-F8 `src/lib/stealth.ts`; facilitator + provider routes now import the F8-fixed `@zbase-protocol/core`. |
| forge-wrap | FIXED | `THRESHOLD_CONTRACTS` now includes `UTXOPool`+`DeployStaging` (false-green silent 0-tests fixed). |
| doc drift | FIXED | CLAUDE.md revenue model, UTXOPool "10 signals" prose → 8, deploy-checklist keccak-placeholder + mock-verifier line refs. |

**Deferred (correctly NOT fixed here — they change the frozen circuit / need the external auditor):**
- B1/C4 (`withdrawnAmount` soundness), the circuit `inAmount` 64-bit range check, in-circuit
  nullifier slot-distinctness, the on-chain `stateTreeDepth` validation, and the B3 residual
  circuit-design limit. All require editing `note_spend.circom` → re-freeze → re-ceremony, so
  they belong to the external audit pass, not a unilateral edit. B0/B2 (ceremony + audit) are
  process gates.

## Bottom line for the mainnet goal
Three *independent* layers each block mainnet today: (1) ZK — no ceremony + the witness-gen bug
B3 means there isn't yet a provable circuit to ceremony; (2) Solana — B4/B5 are real fund-loss
account-constraint bugs; (3) EVM service — B6 hardcoded-Sepolia + B7 Upstash mean a mainnet flip
misbehaves even before the contract questions. None are merge-blocking for *this* branch (it
deploys nothing), but all are launch-blocking. Recommended order: fix B3 (+adversarial fixture) →
external audit (covers B1/C4, stateTreeDepth, inAmount range, dummy soundness) → ceremony →
B4/B5 (Solana) + B6/B7 (EVM service) → deploy checklist → CEO double-confirm.
