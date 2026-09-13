# @zbase-protocol/svm

Solana SDK and x402 v2 mechanism for proof-based payments from the zBase
privacy pool.

**Status (2026-08-12): devnet implementation, paused, not for production
funds.** The deployed devnet program is older than the reviewed SBF build.
Keep `ZX402_SVM_READY=false` until the in-place upgrade and post-upgrade E2E
checks in `docs/release/svm-devnet-redeploy-checklist.md` are complete.

## What the private flow does

The buyer generates the Groth16 proof locally. The facilitator receives only a
proof-bearing x402 payload bound to the network, program, pool, mint, merchant,
amount, and relayer. It never receives the buyer's note nullifier/secret or the
change-note secret.

The settlement hides the direct buyer-to-merchant link: tokens move from the
pool vault to the merchant ATA and the relayer pays transaction fees. Amount,
timing, merchant, relayer, and pool use remain public.

## Exports

| Symbol | Role |
|---|---|
| `SvmPool` | Deposit, client-side proof preparation, simulation, relay, and pool queries |
| `SvmFacilitator` | x402 v2 `private-exact` verify/settle mechanism |
| `PrivateExactSvmServerScheme` | Resource-server payment requirements |
| `PrivateExactSvmClientScheme` | Client-side x402 payload creation and note-state hooks |
| `validatePreparedSvmPayment` | Pure fail-closed validation of a prepared payment |
| `deriveSvmRecipientTokenAccount` | Canonical ATA derivation for wallet or off-curve PDA recipients |
| `SOLANA_DEVNET_CAIP2` | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |
| `SOLANA_MAINNET_CAIP2` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (identifier only; no zBase mainnet deployment) |
| `SOLANA_TESTNET_CAIP2` | `solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z` (identifier only; no zBase deployment) |

## Direct SDK flow

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { SvmPool } from "@zbase-protocol/svm";

const relayer = Keypair.fromSecretKey(/* load securely */);
const pool = new SvmPool({
  connection: new Connection("https://api.devnet.solana.com"),
  wallet: relayer,
  network: "devnet",
  circuitsUrl: "/absolute/or/served/path/to/circuits",
});

// Depositing is public. Persist these secrets locally and encrypt at rest.
const deposit = await pool.deposit("10.0");

// Proof generation happens here. `prepared.payment` is safe to send to the
// facilitator; `prepared.nextDeposit` must remain local and pending.
const prepared = await pool.prepareWithdrawal(
  deposit.secrets,
  merchantAddress,
  "5000", // atomic USDC units
  relayer.publicKey.toBase58(),
);

const check = await pool.verifyPreparedWithdrawal(prepared.payment, {
  recipient: merchantAddress,
  amount: "5000",
});
if (!check.isValid) throw new Error(check.invalidReason);

const signature = await pool.relayPreparedWithdrawal(prepared.payment, {
  recipient: merchantAddress,
  amount: "5000",
});
```

Do not promote `prepared.nextDeposit` merely because the HTTP request was sent.
Promote it only after successful settlement. If the response is lost or settle
returns failure, query the nullifier on chain before deciding whether the
original or change note is spendable; broadcast and confirmation can fail at
different points.

## x402 client mechanism

```ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SvmPool } from "@zbase-protocol/svm";
import { PrivateExactSvmClientScheme } from "@zbase-protocol/svm";

const buyer = Keypair.fromSecretKey(/* load the buyer key securely */);
const clientPool = new SvmPool({
  connection: new Connection("https://api.devnet.solana.com"),
  wallet: buyer,
  // Public key advertised by the facilitator. The client never receives the
  // facilitator's secret key.
  relayer: new PublicKey(advertisedRelayer),
  network: "devnet",
  circuitsUrl: "/absolute/or/served/path/to/circuits",
});

let spendableNote = loadEncryptedNote();
let pending;

const scheme = new PrivateExactSvmClientScheme({
  pool: clientPool,
  getNote: () => spendableNote,
  onPrepared: prepared => {
    pending = prepared;
    persistPending(prepared.nextDeposit);
  },
  onSettled: prepared => {
    spendableNote = prepared.nextDeposit;
    promotePendingNote(prepared.nextDeposit);
    pending = undefined;
  },
  onRejected: () => {
    discardPendingNote();
    pending = undefined;
  },
  onIndeterminate: prepared => {
    // Keep both states locked. Reconcile prepared.payment.nullifierHash on
    // chain before selecting a spendable note.
    scheduleOnchainReconciliation(prepared);
  },
  onReconciled: (prepared, { spent }) => {
    // This hook runs only after a finalized spent PDA is observed.
    if (spent) promotePendingNote(prepared.nextDeposit);
  },
});

// After an ambiguous settle response:
await scheme.reconcilePayment(pending.payment.nullifierHash);
```

If the finalized nullifier PDA is absent, `reconcilePayment` throws and retains
the lock. Absence is not proof that an ambiguously broadcast transaction has
expired. Unlocking the original note requires separate transaction-expiry
evidence; the SDK deliberately does not guess.

Register this mechanism for the devnet CAIP-2 network with an x402 client. A
resource server uses `PrivateExactSvmServerScheme`; a facilitator uses
`SvmFacilitator` and exposes standard `/supported`, `/verify`, and `/settle`
routes. Facilitator mode defaults to merchant-provisioned recipient ATAs; set a
minimum atomic settlement appropriate for the relayer's fee policy. It also
serializes same-nullifier settlements in process. Production replicas still
need a shared idempotency store.

## Native Solana program recipients

Native programs receive tokens through a PDA authority, not an executable
program account. `deriveSvmRecipientTokenAccount(mint, recipientPda)` derives
the canonical off-curve ATA used by the facilitator. The merchant must create
that account before advertising the payment requirement.

For an atomic pay-and-execute flow, see
`packages/svm/zx402-privacy-pool/programs/zx402-native-receiver`. It creates a
unique payment intent and recipient PDA per order, accepts the same proof fields
as `relay_withdrawal`, CPIs into the privacy pool, reloads the recipient token
account, and marks the intent fulfilled only after observing the exact expected
token increase. Any failure rolls back the token transfer, nullifier write, and
fulfillment state.
Because the proof payload plus account list is larger than a legacy Solana
transaction, the example E2E uses a v0 transaction with an address lookup
table.

## On-chain artifact

| Artifact | Value |
|---|---|
| Devnet program ID | `7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM` |
| Reviewed local SBF hash | `6961e45a7604c45eadec3c4f9f3424c1353e9acbdd8289460983b2d9d1912a3b` |
| Expected post-upgrade ProgramData dump hash | `a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f` |
| Pre-upgrade live devnet hash | `59526023d12424edcf5ba281ebdf7c9ad9752f539483062f2640960447ee2d41` |
| Proving system | Groth16 over BN254, verified with `groth16-solana` |
| Yield integration | None |
| Mainnet program | None |

## Local verification

```bash
npm run build:svm-sdk
npm run test:svm-private-payment
npm run test:svm-x402-server
npm run test:svm-native-program # requires the isolated local validator below

cd packages/svm/zx402-privacy-pool
cargo test
anchor build --ignore-keys
```

The native-program E2E preloads both SBF artifacts into an isolated
`solana-test-validator`; it does not write devnet or mainnet state. Its
adversarial case deliberately mismatches the committed amount after a valid
pool CPI and verifies that recipient tokens, the nullifier, and fulfillment
state all roll back. See `scripts/svm-native-program-e2e.ts` for the expected
account flow.

After the reviewed artifact is upgraded and its live hash matches, run the
state-changing HTTP/on-chain flow explicitly:

```bash
ZX402_ALLOW_DEVNET_WRITES=I_ACKNOWLEDGE_DEVNET_WRITES npm run test:svm-devnet
```

It creates a fresh test mint and pool, keeps proofs client-side, settles two
change-note payments, races a duplicate settlement, and checks that the buyer
is absent from the settlement transaction.

The current SDK still depends on bounded RPC history reconstruction and a
single-label ASP witness helper. Those are devnet limitations and mainnet
blockers, not production infrastructure.

## License

Apache-2.0. The pool design follows the 0xbow Privacy Pools architecture and
uses Light Protocol's `groth16-solana` verifier.
