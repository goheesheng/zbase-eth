# API reference — @zbase-protocol/core (v0.5.0)

Entry points (all from `@zbase-protocol/core` unless noted):

## Facilitator client (the payment surface)

```ts
import { createFacilitatorClient, type FacilitatorClient, type PrivateFetchResult } from "@zbase-protocol/core";

const zbase: FacilitatorClient = createFacilitatorClient({
  baseUrl: string,        // the facilitator to pin (it sees your spend secrets at settle)
  network: string,        // CAIP-2, e.g. "eip155:8453" (Base mainnet)
  acceptNotPrivate?: boolean,
});
```

### `zbase.payAndFetch(url, init, opts): Promise<PrivateFetchResult>`

Runs the whole loop: free-probe → 402 → private settle → retry with the payment header → return the
data. `init` = `{ method?, headers?, body? }`. `opts`:

- `deposit: DepositSecrets` — the pool note to spend (required).
- `maxAmountAtomic?: string | bigint` — refuse to pay more than this (guards a hostile 402).
- `onNoteRotate?: (next: DepositSecrets) => void | Promise<void>` — persist the change note.
- `acceptNotPrivate?: boolean` — settle even when the anonymity set is below the privacy floor.
- `asset?: string` — restrict which token to pay in.
- `skipProbe?: boolean` — skip the free-probe (only for a proven seller).

Returns `PrivateFetchResult` — **read `./result-contract.md`**: `{ outcome, safeToRetry?, status,
response, fundingTxHash?, payer?, amount?, nextDeposit?, privacy? }`. Throws only on a provably-unspent
note.

### `zbase.probe(url, init): Promise<ProbeResult>`

Free-probe a seller without paying: reports `{ compatible, priceAtomic, network }`. `$0`, no note spent.

## Notes & secrets

- `generateDepositSecrets(...)` — create a pool note's secrets.
- `DepositSecrets` — `{ nullifier, secret, value, label, commitment }`. These are **bearer
  credentials**; keep them off the wire except to the facilitator you pin.
- `@zbase-protocol/core/wallet` — seed-derived (BIP39) note management + wallet balance.

## Other exports

Merkle tree + Groth16 proof helpers, ERC-5564 stealth recipients, and the seller side
(`createSeller`) are exported from the main entry; the UTXO scaffold is behind
`@zbase-protocol/core/experimental` (pre-deployment, do not use with real funds).

For concepts, tutorials, and the product docs, see https://zbase.app (human-facing). This bundled
`docs/` is the normative SDK behavior + safety contract.
