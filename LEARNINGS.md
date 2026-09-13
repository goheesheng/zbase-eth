# LEARNINGS

Things we learned the hard way that we don't want to re-learn.

---

## 2026-05-10 — Fixing `InvalidProof` in the agent flow

### Symptom

`npm run test:svm-x402-agent` reached step 5 of 5 and failed with:

```
AnchorError thrown in programs/zx402-privacy-pool/src/lib.rs:277.
Error Code: InvalidProof. Error Number: 6005.
```

The on-chain Groth16 verifier rejected the SDK's proof. ~153K compute units
consumed (verifier setup OK, pairing check failed). `npm run test:svm-devnet`
passed end-to-end against the same on-chain program with the same circuit.

### Root cause (cryptographic)

Light Protocol's `groth16-solana` expects Fp2 coordinates for `proof_b` and
the verifying key's G2 points (`vk_beta_g2`, `vk_gamma_g2`, `vk_delta_g2`) in
**`(c1, c0)` order**, big-endian:

```
x.c1 || x.c0 || y.c1 || y.c0
```

snarkjs emits Fp2 in **`(c0, c1)` order** natively. Without swapping, the
proof bytes are well-formed (verifier `::new()` succeeds) but the pairing
check fails.

REDEPLOY.md predicted this exact gotcha at line 83.

### What we changed

Three files needed the swap:

1. **`packages/svm/zx402-privacy-pool/tests/devnet-test.ts`** — `encodeProofForSolana`
2. **`packages/svm/sdk/src/pool.ts`** — `encodeProofForSolana`
3. **`packages/svm/zx402-privacy-pool/scripts/build-verifying-key.mjs`** — `g2()` helper

After fixing #3, regenerate the VK and rebuild + redeploy the program:

```bash
node packages/svm/zx402-privacy-pool/scripts/build-verifying-key.mjs
cd packages/svm/zx402-privacy-pool && anchor build --ignore-keys
solana program deploy \
  --program-id 7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM \
  --url devnet \
  target/deploy/zx402_privacy_pool.so
```

### Root cause (operational — why the fix didn't take immediately)

After applying the Fp2 swap to `pool.ts` source and running `npm run build`
in the SDK, the rebuilt `dist/pool.js` was correct. But the x402 server was
still running its earlier-imported version of the SDK in Node's module
cache. **Just restarting the server wasn't enough if `node_modules/@zx402/svm`
was an unchanged symlink** — the `import()` resolved the same on-disk path
and got the same cached module.

The reliable recipe is:

```bash
# 1. Edit the source (e.g., packages/svm/sdk/src/pool.ts)
# 2. Rebuild the SDK
cd packages/svm/sdk && npm run build

# 3. Hard-kill the server (don't trust SIGTERM if PIDs are duplicated)
pkill -9 -f "x402-server/index.js"
sleep 1

# 4. Verify port is free
lsof -i :4020   # should be empty

# 5. Start the server fresh, pointing AT the rebuilt dist explicitly
cd packages/svm/x402-server
env ZX402_SVM_READY=true \
    ZX402_SVM_SDK_PATH="/abs/path/to/packages/svm/sdk/dist/index.js" \
    ZX402_CIRCUITS_URL="/abs/path/to/public/circuits" \
    node index.js
```

Pointing `ZX402_SVM_SDK_PATH` at `index.js` (not the directory) avoids
Node's "Directory import not supported in ES modules" error.

### How we proved it

Added a local `snarkjs.groth16.verify()` call in `pool.ts` so the SDK
catches witness/encoder bugs before paying for an on-chain tx. The call
is identical to the one in `tests/devnet-test.ts` and prints
`[zBase-svm] local Groth16 verify: OK` when the proof is valid.

This local-verify is the cheapest possible canary: if the SDK ever
regresses on Fp2 ordering, witness inputs, or VK encoding, the failure
shows up off-chain in 1.7 seconds instead of as `InvalidProof` after a
full Solana RPC roundtrip.

### How we located it (debugging recipe)

The breakthrough was diffing public-input values between the **working**
test and the **failing** SDK path. We added `publicSignals.forEach((s, i)
=> console.log(...))` to both paths and ran them side by side. From the
diff we could see all 8 public signals were self-consistent for their
respective deposits — meaning the witness wasn't the bug, the encoder
was. That focused us on the proof-bytes side of the divergence and the
Fp2 swap surfaced.

### Verified end-to-end (2026-05-10)

- Standalone devnet test (deposit + withdraw + on-chain Groth16):
  https://explorer.solana.com/tx/3WYcmSyp1yzWCgQqu4LJUrTU3jGsNbbJwcaQ3pg8t2kdRfFjeBjJgJqjCznrcaXyur25iBAybD4n3esq4T4n4iTq?cluster=devnet
- Agent flow (402 → facilitator → deposit → ZK proof → relayed settlement,
  agent wallet absent from settlement tx):
  https://solscan.io/tx/2aQokcFh1dE5MQWAyDLhYheBgUtXZ2VUECpLY1iRbV6w2msafZk5VHsuewYyFR7mSTQmb18T4sJsuMgBJzbWS3Tg?cluster=devnet
- Settlement timing: ~1.7s end-to-end (proof gen + on-chain verify + relay)

### Cost

- ~0.17 SOL on devnet across two redeploys + several test runs
- ~3 hours of debug time
- The fix itself was ~10 lines of code across 3 files; the rest was
  finding it.

### TL;DR for next time

1. If `groth16-solana` rejects a proof, check Fp2 coordinate order on
   `proof_b` and ALL three VK G2 points first.
2. After ANY SDK source edit, `npm run build` in the SDK package AND
   hard-kill+restart any process holding the SDK in memory.
3. Add a local `snarkjs.groth16.verify` call in any SDK that produces
   on-chain proofs. The 50ms cost saves you from chasing on-chain
   failures.
4. To diagnose `InvalidProof`, log `publicSignals` from both your
   working reference path and your failing path. Diff the values
   field-by-field. The first difference is the bug.

---

## 2026-05-10 — Wiring STEP 6: making the agent see "200 OK paid privately"

### Symptom

After STEP 5 settled the payment via `/api/facilitator/settle` (the relayed
ZK withdrawal), the agent's STEP 6 retry of the protected endpoint still
returned `402 Payment Required`. The on-chain settlement was real, the
provider was paid, but the server didn't recognize the agent as having
paid.

### Why

The standard x402 `paymentMiddleware` from `@x402/express` validates an
`X-PAYMENT` header against a public x402 facilitator (`x402.org/facilitator`).
That facilitator expects the buyer to have signed an `exact` payment
authorization that the facilitator settles on-chain.

zBase inverts the architecture: the *facilitator settles on the buyer's
behalf* (via the privacy pool). The on-chain settlement transaction's
`from` address is the pool's PDA, not the agent's wallet. There is no
`X-PAYMENT` for the standard middleware to validate, because the agent
never authorized a direct transfer.

### Fix: settlement bypass middleware

A small Express middleware that runs *before* `paymentMiddleware` on the
protected resources:

1. **Cache** every successful `/api/facilitator/settle` keyed by the
   resulting on-chain `txHash`, with `{ payTo, amount, ts }` as the value.
   TTL 5 min.
2. **Bypass:** when a request to a protected resource carries
   `X-Zx402-Settlement: <txHash>` and the cache has an entry whose amount
   `>=` the resource's required amount, mark the request as paid
   (`req.zBaseSettlement = txHash`) and consume the cache entry (one-shot).
3. **Wrap** `paymentMiddleware` so it short-circuits when
   `req.zBaseSettlement` is set.

Cache key choice: **txHash alone**, not `(payTo, amount)`. The first
attempt keyed by `(server's PAY_TO, amount)` failed because the settle
handler stored under `paymentDetails.payTo` (the agent's recipient
address) but the bypass looked up under the server's static `PAY_TO`
constant. Mismatch. Keying by txHash side-steps the problem entirely:
the txHash is unique per settlement, and possessing it proves "this is
the settlement that just happened."

Files touched:

- `packages/svm/x402-server/index.js` — added cache, bypass middleware,
  and `withZx402Bypass(paymentMiddleware(...))` wrapper.
- `scripts/svm-test-agent.ts` — STEP 6 sends `X-Zx402-Settlement` (was
  `X-Payment-Signature` which the standard middleware ignored).

### Result

```
--- STEP 6: Retry paid endpoint with payment proof ---

  ✅  Service returned data privately:
{
  "address": "BWTaGJeK2WNYXjfXuVYRf7Xt7a4CkT1kfuqsiB4Nh6H8",
  ...
  "paidVia": "zx402-privacy-pool",
  "settlementTx": "5bA1eL5Rwtp5qnbqAca1dRP3jaP3CtGmTdnwyxfeRM8RAwp9qE88…"
}
```

The response itself now self-describes the privacy path. An x402 buyer
integrating zBase just changes the facilitator URL and adds one
`X-Zx402-Settlement` header on retry; the provider receives USDC like
before but the buyer's wallet is absent from the on-chain transaction.

### TL;DR

Privacy-relayed payment models break vanilla x402 middleware because
the buyer doesn't sign the transfer. Fix: cache your relayed
settlements server-side and accept your own settlement tx hash as
proof-of-payment via a custom header. Key by txHash, not by
(buyer, amount), or you'll hit the same `payTo`-mismatch trap.

---

## 2026-05-11 — Shared demo pool + state-tree reconstruction across runs

### What we wanted

The agent test script previously minted a fresh USDC mint and initialized
a fresh V1 pool every run. Clean and hermetic, but cosmetically each demo
appeared to start from "0 depositors" — which doesn't tell the
"anonymity set compounds" story.

We added `npm run demo:bootstrap` to create a *stable* shared pool that
the agent script reuses across runs, so STEP 2 reports
"Anonymity set: N prior depositor(s)" and N grows over time.

### What works

- `scripts/svm-demo-bootstrap.ts` — mints a stable test USDC, initializes
  V1 pool, persists `{mint, pool, vault, postman}` to `scripts/.demo-pool.json`.
  Idempotent. `--reset` forces a new pool.
- Server's `/api/zx402/pool-stats` patched to skip V0 PoolState ghosts
  (211-byte accounts left over from earlier deploys) and surface only
  V1 pools (2325-byte). Discovered in passing: anchor's bulk
  `program.account.poolState.all()` throws on the V0 ghost and tanks the
  whole call. Per-account fetch + try/catch is the workaround.
- Agent script STEP 3a checks for `.demo-pool.json` and reuses if present;
  otherwise falls back to fresh mint+pool.
- First agent run after bootstrap: full 6/6 STEPs pass.

### What didn't work

After the first withdrawal, the on-chain state tree includes:
1. The original deposit's commitment, AND
2. A "change commitment" from the withdrawal (`pool.frontier.insert(new_commitment)`
   in lib.rs:325 after every relay)

The SDK's state tree reconstruction needs to mirror the **exact insertion
order** the on-chain `LeanImtFrontier` saw. We tried three orderings:

- **Interleaved** (sort all leaves by slot)
- **Deposits-then-changes** (all deposits first, then all changes by slot)
- **Deposits-only** (ignore change commitments)

None of three matched the on-chain `pool.tree_root` after the second
deposit. Symptom: `UnknownStateRoot` (lib.rs:238) on the second run's
withdraw. The fundamental fix needs reading `LeafInserted`-style logs
in tx-signature-index order, which Solana's RPC doesn't expose
cheaply — needs a per-tx `getTransaction` scan that orders inner
instructions, not just outer txs.

### Workaround for the demo

The script is *demo-perfect for one run after bootstrap*. The repeatable
recipe:

```bash
npm run demo:bootstrap -- --reset           # fresh pool
ZX402_SVM_READY=true npm run test:svm-x402-agent   # full 6/6 pass
```

If you want N runs of "anonymity grows" cosmetically without ever
withdrawing, you could split the agent script into two modes:
- `--deposit-only`: run STEP 3b only (deposits accumulate, no state-tree
  contention)
- normal: full deposit + withdraw (only run once between bootstraps)

### TL;DR

Multi-run shared-pool demos require the SDK to reconstruct the on-chain
state tree's exact LeanIMT insertion sequence including withdrawal
change commitments. Slot-based ordering of `WithdrawalEvent`s is not
fine-grained enough. Real fix: read `pool.frontier.side_nodes` directly
to derive the canonical leaf sequence, or add an explicit "leaf index"
field to `WithdrawalEvent`. For demos, reset the pool between runs.
