# Solana devnet private-facilitator upgrade checklist

- **Prepared:** 2026-08-12
- **Program:** `zx402_privacy_pool`
- **Devnet program ID:** `7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM`
- **Operation:** in-place upgrade, not a new deployment
- **Readiness after upgrade:** devnet validation only; not mainnet or customer-ready

This upgrade contains:

- B4: recipient and relayer token-account owner binding;
- B5: pool-vault binding for deposits and withdrawals;
- B8: canonical withdrawal bytes must match the actual recipient, relay fee,
  and relayer before the proof context is accepted;
- removal of the unused arbitrary Kamino CPI instructions.

It is an outward-facing on-chain state change that spends devnet SOL. Do not
broadcast it from an unattended agent. Review the exact artifact and run the
swap explicitly.

## Verified preparation state

| Check | Result |
|---|---|
| Rust tests | 3 passed |
| Anchor SBF build | Passed with existing Anchor cfg warnings |
| SDK TypeScript build | Passed |
| Private payment binding test | Passed |
| New SBF size | 347,560 bytes |
| Reviewed SBF SHA-256 | `6961e45a7604c45eadec3c4f9f3424c1353e9acbdd8289460983b2d9d1912a3b` |
| Expected 532,200-byte ProgramData dump SHA-256 | `a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f` |
| Live devnet dump SHA-256 before upgrade | `59526023d12424edcf5ba281ebdf7c9ad9752f539483062f2640960447ee2d41` |
| Existing ProgramData allocation | 532,200 bytes; new binary fits |
| Upgrade authority last verified | `BWTaGJeK2WNYXjfXuVYRf7Xt7a4CkT1kfuqsiB4Nh6H8` |

The repository's
`target/deploy/zx402_privacy_pool-keypair.json` resolves to
`G7x1zQgJmJpCHkxuBAGR47eQsS6tFbq4mjUBCgiKLcEm`, not the deployed program.
That is why `anchor build` fails its key check. Build with `--ignore-keys`, and
never use that keypair as the upgrade target. For an upgrade, pass the deployed
program address explicitly.

## 1. Confirm authority and cluster

```bash
solana address
# must be the current upgrade authority, expected:
# BWTaGJeK2WNYXjfXuVYRf7Xt7a4CkT1kfuqsiB4Nh6H8

solana program show \
  7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM \
  --url devnet

solana balance --url devnet
```

Stop if the program is missing, the authority changed, or the wallet cannot
cover buffer rent and transaction fees.

## 2. Reproduce the artifact

```bash
cd packages/svm/zx402-privacy-pool
anchor build --ignore-keys

openssl dgst -sha256 target/deploy/zx402_privacy_pool.so
# must equal:
# 6961e45a7604c45eadec3c4f9f3424c1353e9acbdd8289460983b2d9d1912a3b

# Reproduce the bytes returned by `solana program dump`: ProgramData keeps its
# existing allocation and zero-pads the shorter program.
cp target/deploy/zx402_privacy_pool.so /tmp/zbase-reviewed-padded.so
truncate -s 532200 /tmp/zbase-reviewed-padded.so
openssl dgst -sha256 /tmp/zbase-reviewed-padded.so
# must equal:
# a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f

strings target/deploy/zx402_privacy_pool.so \
  | rg "Withdrawal bytes do not match|Vault account does not match"

jq '[.instructions[].name]' target/idl/zx402_privacy_pool.json
# must not include supply_to_kamino or redeem_from_kamino
```

If the hash differs, do not substitute it silently. Review the source diff,
update the expected hash in the server and this checklist, rebuild, and repeat
the test suite.

## 3. Sync and build the SDK

From the repository root:

```bash
cp packages/svm/zx402-privacy-pool/target/idl/zx402_privacy_pool.json \
  packages/svm/sdk/src/idl.json
npm run build:svm-sdk
npm run test:svm-private-payment
```

## 4. Write a resumable buffer

Writing the buffer does not change the live program:

```bash
solana program write-buffer \
  packages/svm/zx402-privacy-pool/target/deploy/zx402_privacy_pool.so \
  --url devnet
```

Record the printed buffer address and inspect it before continuing.

## 5. Explicitly perform the in-place upgrade

This is the state-changing step:

```bash
solana program deploy \
  --program-id 7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM \
  --buffer <BUFFER_ADDRESS> \
  --upgrade-authority ~/.config/solana/id.json \
  --url devnet
```

Do not use `anchor deploy`; the repository program keypair does not match the
deployed address.

## 6. Verify the bytes actually running

```bash
solana program dump \
  7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM \
  /tmp/zbase-devnet-post-upgrade.so \
  --url devnet

openssl dgst -sha256 /tmp/zbase-devnet-post-upgrade.so
# must equal the reviewed zero-padded ProgramData hash:
# a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f

cmp /tmp/zbase-reviewed-padded.so /tmp/zbase-devnet-post-upgrade.so
# no output and exit 0
```

Also re-run `solana program show` and record the deployment slot and authority.

## 7. Devnet tests before readiness

Keep `ZX402_SVM_READY=false` while running:

```bash
ZX402_ALLOW_DEVNET_WRITES=I_ACKNOWLEDGE_DEVNET_WRITES npm run test:svm-devnet
```

The command refuses to mutate devnet without that exact acknowledgement. It
creates an isolated buyer, fresh test mint and pool, then exercises the real
HTTP `private-exact` facilitator. Preserve its printed transaction IDs with the
release evidence.

1. deposit into the real bound pool vault;
2. reject a deposit with a foreign vault;
3. reject a withdrawal with a recipient token account owned by another key;
4. reject proof-bound bytes that differ from the actual recipient, relayer, or
   relay fee;
5. settle a partial withdrawal and then spend the returned change note;
6. submit two concurrent spends of one note and prove at most one settles;
7. verify a merchant payment where merchant and relayer are distinct;
8. inspect the transaction and confirm the depositor wallet is not a signer or
   transfer source.

Do not claim a full anonymity set from the current single-label ASP helper. A
production ASP witness source remains separate work.

## 8. Readiness flags

Only after every devnet test is recorded:

```bash
ZX402_DEPLOYED_BINARY_SHA256=a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f
ZX402_SVM_READY=true
```

`/supported` must then advertise `private-exact`. `/health` must still report
`customerReady:false`; this flag enables an explicitly scoped devnet test
surface, not production. The server also fetches the ProgramData account from
RPC and hashes its bytes after the 45-byte loader metadata prefix. If the live
hash differs, RPC is unavailable, or the loader layout is invalid, readiness
remains false regardless of both environment values.

Provision each test merchant's token ATA before settlement. Facilitator mode
does not create recipient ATAs at relayer expense. The default standalone
minimum is 5,000 atomic token units and can be raised with
`ZX402_MIN_SETTLEMENT_AMOUNT`.

## Failure and rollback

If buffer upload fails, the live program is unchanged. Close the buffer and
recover its rent only after confirming the exact buffer address:

```bash
solana program close <BUFFER_ADDRESS> \
  --recipient BWTaGJeK2WNYXjfXuVYRf7Xt7a4CkT1kfuqsiB4Nh6H8 \
  --url devnet
```

The loader does not retain the previous bytes for you. A rollback requires a
separately reproduced and reviewed prior artifact, followed by another upgrade.
Do not treat source checkout alone as a reproducible rollback artifact.

## Not authorized by this checklist

- any Solana mainnet deployment;
- setting a final/non-upgradeable program;
- moving or revoking the upgrade authority;
- enabling customer deposits;
- claiming amount hiding, timing privacy, production ASP coverage, or external
  audit completion.
