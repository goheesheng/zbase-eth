# Runbook: make the UTXO pool work on Base Sepolia (testnet)

> 🧭 STRATEGIC CONTEXT — READ BEFORE TREATING THIS AS "DO NEXT" (2026-06-25)
> UTXO (amount-hiding) is **DEFERRED — it is NOT the moat and NOT on the critical
> path to revenue.** A four-lens adversarial review concluded the moat is the
> RAIL (x402 facilitator + sellers + volume on Base/Solana), not amount-hiding —
> which is 0xbow's home turf (they wrote the circuits we forked). Build the
> single-value mainnet path + sign paying sellers FIRST. UTXO becomes correct
> only when a NAMED high-value buyer (or a raise) is gated on amount-hiding.
> Full reasoning: `docs/strategy/utxo-moat-review-2026-06-25.md`. This runbook is
> for a *testnet mechanism demo* (or pre-built inventory) — NOT a signal to ship
> UTXO. And do NOT run the REAL multi-party ceremony before C4+B3 (re-freeze).

**Goal:** take the UTXO note-spend path from its current 501 ("ceremony_pending")
to a working *testnet* demo — using a THROWAWAY solo-ceremony verifier (safe for
testnet, never mainnet). Single-value is already done + proven; this is only UTXO.

> ⚠️ Read this first — the honest limits even after all steps:
> 1. **The verifier is a solo dry-run = cryptographically UNSAFE.** Fine for
>    testnet (play money); it can NEVER touch mainnet. Mainnet UTXO needs the real
>    multi-party ceremony (docs/ceremony/ceremony-runbook-2026-05-31.md).
> 2. **C4: UTXO `spend()` pays out 0 USDC** (payout parked on an audit finding) —
>    so testnet UTXO demonstrates private NOTE TRANSFERS, not private unshield-to-
>    USDC. A "spend" mints output notes; it does not send USDC to a recipient.
> 3. **B3 residual:** only perfect-tree (2^k-leaf) input indices produce a
>    satisfying witness; arbitrary tree shapes need a circuit change (re-freeze).
> So this proves the UTXO *mechanism* on testnet, not a production-complete feature.

You run the ceremony + deploys (your keys). Claude prepped the scripts; the
on-chain/key steps are yours.

---

## Prerequisites
- The toolchain the ceremony needs: `snarkjs` (via npx), `circom` 2.1.9, `circomlib`,
  Node ≥18. (Check: `bash scripts/ceremony-dryrun-smoke.sh` should already pass —
  it proves the toolchain end-to-end.)
- `foundry` (`forge`) for the contract deploys.
- A funded Base Sepolia deployer key (`DEPLOYER_PRIVATE_KEY`) — ETH for gas.
- `BASE_SEPOLIA_RPC`.

## Step 1 — Produce a throwaway ceremony zkey + verifier
The dry-run flow generates a SINGLE-contributor (unsafe, testnet-only) final zkey
+ exports the Solidity verifier:

```bash
cd ~/Desktop/zx402
# single-contributor full run — TEST ONLY (forces the throwaway test beacon)
bash scripts/ceremony-setup.sh all "testnet-dryrun"
```
Outputs (under `build/ceremony/`):
- `note_spend_final.zkey`  — the throwaway proving key
- `Verifier_NoteSpend.sol` — the Solidity verifier exported from it
- (and the compiled `note_spend.wasm` under `build/ceremony/note_spend_js/`)

Sanity: it ends with "✓ DONE" and a `zkey verify` pass. (If it refuses a real
beacon, that's the safety guard — `all` uses the test beacon by design.)

## Step 2 — Deploy the verifier to Base Sepolia
The UTXOPool constructor requires a verifier CONTRACT (F9 guard:
`_verifier.code.length > 0`). Deploy the exported verifier:

```bash
cd ~/Desktop/zx402
forge create build/ceremony/Verifier_NoteSpend.sol:Groth16Verifier \
  --rpc-url "$BASE_SEPOLIA_RPC" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast
# capture the deployed address → export VERIFIER_ADDRESS=0x...
```
(The exported contract name from snarkjs is usually `Groth16Verifier` — confirm the
`contract` name at the top of `build/ceremony/Verifier_NoteSpend.sol` and match it.)

## Step 3 — Deploy the UTXOPool
The deploy script reuses the existing entrypoint + USDC, computes a distinct SCOPE,
and requires the verifier from Step 2:

```bash
VERIFIER_ADDRESS=0x<from step 2> \
DEPLOYER_PRIVATE_KEY=0x<deployer> \
BASE_SEPOLIA_RPC=$BASE_SEPOLIA_RPC \
bash scripts/deploy-utxo-pool.sh
```
It deploys `UTXOPool(_verifier, _entrypoint, _token, _scope)` and prints the pool
address + deploy block. (Constructor: verifier from Step 2, entrypoint
`0x598ffaac…` default, USDC `0x036CbD53…`, SCOPE auto-computed.)

## Step 4 — Wire UTXO_STACK in src/lib/contracts.ts
Fill the placeholders (currently all `0x0` / `0n`):
- `usdcPool` → the UTXOPool address from Step 3
- `withdrawalVerifier` → the verifier from Step 2
- `poolDeployBlock` → the deploy block from Step 3
(commitmentVerifier already reuses the 0xbow one; usdc/entrypoint already set.)

## Step 5 — Serve the circuit artifacts (flips the routes 501 → live)
The UTXO routes 501 until these two files exist (existsSync gate at
withdraw/route.ts:1216-1218):

```bash
mkdir -p public/circuits/note_spend
cp build/ceremony/note_spend_js/note_spend.wasm public/circuits/note_spend/note_spend.wasm
cp build/ceremony/note_spend_final.zkey        public/circuits/note_spend/groth16_pkey.zkey
# optional, for local verify:
npx snarkjs zkey export verificationkey build/ceremony/note_spend_final.zkey \
  public/circuits/note_spend/groth16_vkey.json
```
> NOTE: these are committed-artifact-sized (tens of MB). Check `.vercelignore` /
> repo policy before committing — the single-value ones live in public/circuits/
> already, so follow that precedent.

## Step 6 — Verify it works on testnet
```bash
npm run build && npm run dev -- -p 3009
```
- The UTXO route no longer 501s: `POST /api/withdraw?pool=utxo` (real-proof path)
  now finds the wasm/zkey and attempts a real Groth16 prove.
- Use the witness fixture as the canonical satisfiable input
  (`test/fixtures/note_spend_input.json`, built by `scripts/build-note-spend-witness.ts`).
- `npm run test:note-spend-witness` should pass (proves the circuit is satisfiable
  against the served wasm).
- Remember the limits: a `spend()` mints output notes but pays out 0 USDC (C4);
  use perfect-tree input indices (B3).

## Step 7 — (only if you want the mock path instead)
To exercise the UTXO route WITHOUT a ceremony at all (pure plumbing test):
```bash
ALLOW_UNSAFE_UTXO_TEST_MODE=true npm run dev -- -p 3009
# then POST /api/withdraw?pool=utxo&unsafeTestMode=true
```
This submits a mock proof — the on-chain mock verifier accepts anything. Useful to
test the event/wire surface; proves NOTHING about the circuit. (Gated behind the
explicit env flag so it can't ship by accident.)

---

## What this gives you vs. doesn't
- ✅ UTXO routes live on testnet; real Groth16 proofs verify on-chain; private note
  transfers demonstrable.
- ❌ NOT real unshield-to-USDC (C4 parked), NOT arbitrary tree shapes (B3), NOT
  mainnet-safe (solo verifier). Mainnet UTXO = real multi-party ceremony + C4 fix
  + the B3 circuit change + re-freeze.

## Honest recommendation (unchanged from the decision)
This is real work (ceremony dry-run + 2 deploys + wiring + ~tens-of-MB artifacts)
to demo a feature that's transfer-only until C4. If the goal is a *demo of private
UTXO notes*, do it. If the goal is *shippable private payments*, single-value is
already live + proven and is the product — UTXO can wait for the C4 fix + real
demand + the real ceremony. Don't burn the real multi-party ceremony on a circuit
that still needs the C4 + B3 fixes; those force a re-freeze, which wastes a
ceremony.
