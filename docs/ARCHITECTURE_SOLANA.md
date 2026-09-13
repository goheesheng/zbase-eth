# zBase private x402 on Solana (SVM)

**Status (2026-08-12): implemented locally, paused on devnet, not customer-ready.**

Solana can host the private settlement path. Standard x402 already identifies
Solana networks with CAIP-2 identifiers; zBase adds a custom x402 v2 scheme,
`private-exact`, whose settlement transaction withdraws from a Groth16 privacy
pool instead of transferring directly from the buyer wallet.

This is not a mainnet authorization. The live devnet program predates required
fund-safety and withdrawal-binding fixes. `ZX402_SVM_READY` must remain false
until the reviewed program is upgraded and the post-upgrade test gates pass.

## Current truth

| Boundary | Current state |
|---|---|
| Solana x402 transport | Supported through x402 v2 and CAIP-2 |
| zBase `private-exact` SDK/facilitator | Implemented and locally tested |
| Reviewed SBF build | `6961e45a7604c45eadec3c4f9f3424c1353e9acbdd8289460983b2d9d1912a3b` |
| Expected 532,200-byte ProgramData dump after upgrade | `a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f` |
| Live devnet binary | `59526023d12424edcf5ba281ebdf7c9ad9752f539483062f2640960447ee2d41` (stale) |
| Devnet program | `7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM` |
| Devnet readiness | Paused until in-place upgrade and E2E verification |
| Mainnet readiness | No; external review and production infrastructure are missing |
| Amount privacy | No; amounts and timing remain public |
| Yield | Disabled; no external yield CPI remains in the program |
| Native-program recipients | Implemented locally through PDA-owned ATAs and an atomic CPI receiver example |

Networks:

- Devnet: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`
- Mainnet: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`

## Trust boundary

The buyer, not the facilitator, proves note ownership.

```text
buyer SDK                          facilitator                       SVM program
---------                          -----------                       -----------
holds note secrets
rebuilds state/ASP witnesses
generates Groth16 proof
binds recipient + amount + relayer
      |
      | x402 v2 PaymentPayload
      | proof + public inputs only
      v
                                   validate requirement binding
                                   simulate relay_withdrawal
                                   settle by signing as relayer
                                          |
                                          v
                                                                    verify proof
                                                                    enforce known root + ASP
                                                                    enforce canonical payout bytes
                                                                    mark nullifier spent
                                                                    pool vault -> merchant ATA
```

The HTTP payload must never contain `nullifier`, `secret`, or `nextDeposit`.
The facilitator learns the public nullifier hash, recipient, amount, timing,
relayer, pool, and proof. It does not learn which deposit note was spent or the
change-note secret.

The client keeps the next note in a pending state while settlement is in
flight. It promotes the note only after a successful x402 settle response. A
transport error or failed settle response is indeterminate because a relay may
have been broadcast before confirmation failed: the client must reconcile the
nullifier on chain before selecting the old or change note. This state is
monotonic: a later 402 response cannot downgrade an indeterminate attempt into
a rejection, and the same unresolved nullifier cannot prepare another payment.
`reconcilePayment` reads the nullifier PDA and invokes the durable
`onReconciled` hook before releasing the in-memory lock only when a finalized
spent record exists. A missing record leaves the lock intact because account
absence does not prove an ambiguous transaction can no longer land.

## x402 surface

The SDK implements three roles:

- `PrivateExactSvmServerScheme`: resource-server price parsing and payment
  requirements for `private-exact`.
- `PrivateExactSvmClientScheme`: client-side proof construction and note-state
  callbacks.
- `SvmFacilitator`: the x402 v2 facilitator mechanism for `/supported`,
  `/verify`, and `/settle`.

The facilitator advertises:

```json
{
  "x402Version": 2,
  "scheme": "private-exact",
  "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "extra": {
    "assetTransferMethod": "zbase-groth16-pool",
    "paymentFlow": "authorization",
    "proofGeneration": "client",
    "facilitatorReceivesNoteSecrets": false,
    "amountHiding": false,
    "minimumSettlementAmount": "5000",
    "recipientTokenAccountCreation": "merchant"
  }
}
```

The standalone server exposes the standard x402 v2 paths and legacy aliases:

| Standard | Alias | Behavior |
|---|---|---|
| `GET/POST /supported` | `GET /api/facilitator/supported` | Advertises no usable kind while paused |
| `POST /verify` | `POST /api/facilitator/verify` | Validates bindings and simulates the Anchor instruction |
| `POST /settle` | `POST /api/facilitator/settle` | Re-verifies and relays the prepared withdrawal |

The old API that sent complete note secrets to the server has been removed.
The standalone facilitator serializes concurrent settlement attempts for the
same nullifier. It also declines to fund recipient ATA creation: a merchant
must provision its token account before accepting private payments. The
relayer still creates its own ATA idempotently.

## On-chain safety properties

`relay_withdrawal` verifies eight public inputs:

1. new commitment;
2. existing nullifier hash;
3. withdrawn amount;
4. known state root;
5. state-tree depth;
6. current ASP root;
7. ASP-tree depth;
8. context.

The patched instruction additionally enforces all of the following:

- the nullifier PDA uses the same hash as public input 1;
- the instruction amount equals public input 2;
- the proof context hashes the actual pool, recipient, relay-fee bps, relayer,
  and scope;
- caller-supplied withdrawal bytes exactly equal that canonical encoding;
- the recipient token account is owned by the proof-bound recipient;
- the relayer fee token account is owned by the relayer signer;
- deposits and withdrawals use the pool's bound vault.

The historical `supply_to_kamino` and `redeem_from_kamino` instructions were
removed. They accepted an unsafe arbitrary CPI surface and were not required by
the private-payment wedge.

## Native program integration

An executable Solana program is not used directly as the SPL token authority.
The receiving program creates a per-order PDA and a token account owned by that
PDA. The SDK derives its canonical ATA with off-curve ownership enabled.

`zx402-native-receiver` demonstrates an atomic integration:

```text
merchant creates priced intent + per-order recipient PDA
buyer binds Groth16 proof to that PDA and exact amount
relayer submits receiver fulfill instruction
  -> receiver validates intent and recipient
  -> receiver CPIs relay_withdrawal into privacy pool
  -> pool verifies proof, spends nullifier, transfers tokens
  -> receiver reloads token account and checks exact delta
  -> receiver marks intent fulfilled
```

The payment intent exists before proof generation, so the relayer cannot invent
a price or recipient. Solana transaction atomicity rolls back both programs if
any later check fails. The integration uses a v0 transaction/address lookup
table because the Groth16 proof and CPI account list exceed the legacy
transaction packet size.

This is composability evidence, not a production deployment: the receiver has
only been built and tested on an isolated local validator and has not received
an independent security review.

## What privacy this provides

When the anonymity set and client behavior are sufficient, the settlement
transaction shows `pool vault -> merchant`, not `buyer wallet -> merchant`.

It does not hide:

- deposit or withdrawal amount;
- deposit and withdrawal time;
- merchant address;
- relayer address;
- the fact that the privacy pool was used.

A small set, a unique amount, or a short deposit-to-payment interval can make
the buyer inferable. “Private” here means sender-recipient unlinkability under
the stated anonymity assumptions, not blanket transaction confidentiality.

## Remaining devnet gates

1. Upgrade the existing devnet program in place with the reviewed SBF artifact.
2. Dump the program back from devnet and verify its SHA-256 is exactly the
   reviewed zero-padded ProgramData hash.
3. Run negative account-binding/context tests and a real deposit, partial
   withdrawal, second withdrawal, and merchant settlement.
4. Verify two simultaneous spends of one note cannot both settle.
5. Confirm each test merchant is distinct from the relayer and only then set
   `ZX402_SVM_READY=true` plus
   `ZX402_DEPLOYED_BINARY_SHA256=a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f`.

At runtime the server independently reads the upgradeable-loader ProgramData
account, removes its 45-byte metadata prefix, and hashes the deployed bytes.
It advertises no private kind unless that live hash also equals the reviewed
ProgramData hash. The environment variables are necessary operator gates, not
a substitute for on-chain attestation.

See [the devnet upgrade checklist](./release/svm-devnet-redeploy-checklist.md).

## Mainnet blockers

Devnet success is not sufficient for mainnet. These remain hard blockers:

- independent Solana/Anchor and circuit review;
- a complete, authenticated ASP witness distribution service (the current SDK
  only constructs a single-label ASP witness);
- a deterministic state-tree indexer (the SDK currently reconstructs history
  from bounded RPC scans and cannot guarantee completeness at scale);
- resolution of the shared-depth/non-perfect-tree circuit limitation;
- durable note locking, retry, and on-chain reconciliation across client
  crashes and concurrent requests;
- separate relayer, merchant, postman, and upgrade roles, with multisig or
  equivalent production controls;
- rate limiting, authentication, observability, RPC redundancy, dependency
  remediation, load tests, and incident procedures;
- a mainnet-specific deployment review. The devnet program ID must not be
  presented as a mainnet deployment.

## Key files

- Anchor program: `packages/svm/zx402-privacy-pool/programs/zx402-privacy-pool/src/lib.rs`
- SDK and proof preparation: `packages/svm/sdk/src/pool.ts`
- x402 schemes: `packages/svm/sdk/src/x402.ts`
- facilitator mechanism: `packages/svm/sdk/src/facilitator.ts`
- standalone server: `packages/svm/x402-server/index.js`
- focused binding test: `packages/svm/sdk/src/privatePayment.test.ts`
