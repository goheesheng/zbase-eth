# Redeploying SVM V1 to the existing program ID

The on-chain program at `7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM` is the
V0 (no-op verifier) build. Phase 2 added the cryptographic core; Phase 3
fixed the SDK; the new `.so` exists at
`target/deploy/zx402_privacy_pool.so` but is not yet on-chain.

## You don't need the original program keypair

`anchor deploy` complains because the local
`target/deploy/zx402_privacy_pool-keypair.json` is a freshly-generated key
(`G7x1zQg…`), not the original deploy key for `7qGhxY9D…`. That mismatch only
matters for *first* deploys. For *upgrades*, you only need the program's
upgrade authority.

`solana program show 7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM --url devnet`
reports:

```
Authority: BWTaGJeK2WNYXjfXuVYRf7Xt7a4CkT1kfuqsiB4Nh6H8
```

— which is the wallet at `~/.config/solana/id.json`. So you (the upgrade
authority) can replace the on-chain program in place.

## Steps

```bash
# 1. From the program directory:
cd packages/svm/zx402-privacy-pool

# 2. Build (we already did this; re-run if you've edited Rust since):
anchor build --ignore-keys

# 3. Upgrade the existing on-chain program. The current ProgramData is
#    322,160 bytes; V1 is 532,200 bytes, so this also pays for a buffer
#    expansion (~0.5 extra SOL on devnet, returned on next downgrade).
solana program deploy \
  --program-id 7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM \
  --url devnet \
  target/deploy/zx402_privacy_pool.so
```

After this completes, `solana program show 7qGhxY9D…` will show the new
data length (~532K) and a new `Last Deployed In Slot`.

## After redeploy

1. **Run the devnet test.** From the same directory:
   ```bash
   npx ts-node tests/devnet-test.ts
   ```
   Expected output ends with `=== ALL CHECKS PASSED ===` and three
   explorer URLs. If it fails, look for the off-chain↔on-chain mismatch
   lines — they tell you where the divergence is (label, commitment,
   state root, ASP root, or context).

2. **Flip the SVM_READY flag.** In whatever `.env` the x402 server reads:
   ```
   ZX402_SVM_READY=true
   ZX402_SVM_SDK_PATH=../sdk/dist
   ZX402_CIRCUITS_URL=../../public/circuits
   ```
   The first one switches all the disclosure copy from "V0" to "Privacy
   Facilitator". The second points the `/api/facilitator/settle` endpoint
   at the built SDK so it can call `SvmPool.withdraw`. The third tells
   the SDK where the circuit artifacts live for proof generation.

3. **Update STATUS.md.** See the Solana row of the per-chain matrix —
   five "No (V0)" cells flip to "Yes". `STATUS.md` is the source of
   truth for marketing copy elsewhere; updating it is the equivalent of
   announcing V1.

## What can still go wrong on the first run

The Rust side is locked down by the type system + the ground-truth survey
in Phase 2.0. The off-chain side has three places where a single byte of
endianness or a single Fp2-coordinate swap can break verification without
producing an obvious error:

| Symptom on devnet                          | Most likely culprit                                        |
|--------------------------------------------|------------------------------------------------------------|
| `InvalidProof` from `relay_withdrawal`     | `proof_b` Fp2 coord ordering in `encodeProofForSolana`     |
| `IncorrectAspRoot`                         | ASP tree built with wrong leaf set or postman not updated  |
| `ContextMismatch`                          | `withdrawalData` byte layout differs from the program's    |
| `UnknownStateRoot`                         | LeanIMT replication off-chain ≠ on-chain (insertion order) |
| `local proof verification failed`          | One of the circuit inputs has a wrong type or value        |

The test prints `label/commitment match on-chain ✓` and `state root match
on-chain ✓` lines specifically to surface the second-to-last row before
you spend a transaction.

## If you want to break the program ID

If the original deploy keypair is permanently lost AND the upgrade
authority is also lost (it isn't — you have it), the only way forward
is a new program ID. To do that:

```bash
# Generate a new deploy keypair, derive the new program id,
# then patch declare_id! in lib.rs and Anchor.toml to match:
solana-keygen new -o target/deploy/zx402_privacy_pool-keypair.json --force
solana-keygen pubkey target/deploy/zx402_privacy_pool-keypair.json
# … paste that into:
#   programs/zx402-privacy-pool/src/lib.rs    (declare_id!)
#   Anchor.toml                                (programs.devnet)
#   packages/svm/sdk/src/pool.ts               (PROGRAM_ID const)
#   packages/svm/x402-server/index.js          (PROGRAM_ID const)
#   tests/devnet-test.ts                       (PROGRAM_ID const)
#   STATUS.md / CLAUDE.md                       (deployed addresses block)
anchor build && anchor deploy --provider.cluster devnet
```

You don't need this — the upgrade path above is cleaner.
