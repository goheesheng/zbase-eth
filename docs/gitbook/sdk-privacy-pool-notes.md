# Privacy Pool notes

How a note is encoded, where the fields come from, and how to read or write
them with `@zbase-protocol/core`.

## The note shape

```ts
type ZBaseDeposit = {
  nullifier: string;     // 32-byte hex, owner-only secret
  secret: string;        // 32-byte hex, owner-only secret
  value: string;         // atomic units (USDC has 6 decimals)
  label: string;         // hex; computed on-chain as keccak256(SCOPE, nonce)
  commitment: string;    // hex; Poseidon(value, label, Poseidon(nullifier, secret))
};
```

Every interaction with the facilitator (`/verify`, `/settle`, `/withdraw`)
takes a `zbaseDeposit` of this shape.

## Where each field comes from

| Field | Source |
|---|---|
| `nullifier` | Generated client-side at deposit. Random 32 bytes. |
| `secret` | Generated client-side at deposit. Random 32 bytes. |
| `value` | Equals the deposit amount minus the 1% vetting fee — `Poseidon` is computed over the **post-fee** value. A 1 USDC deposit becomes `value = "990000"`. |
| `label` | Read from the `Deposited` event, not computed client-side. |
| `commitment` | Read from the `Deposited` event (or computed locally for round-trip checks). |

> Common mistake — computing `label` client-side. The contract uses
> `keccak256(SCOPE, nonce)` where `nonce` is a per-pool counter, so the canonical
> source is the event log.

## SDK helpers

```ts
import { encodeNote, decodeNote, computeCommitment } from '@zbase-protocol/core/notes';

// Encode for transport (hex-stringified)
const encoded = encodeNote(note);

// Decode from on-the-wire form
const note = decodeNote(encoded);

// Re-derive the commitment (used to sanity-check a note before sending)
const c = computeCommitment(note);
```

## Persistence

The browser app persists notes per connected wallet in `localStorage`:

```text
zx402-deposits-${lowercaseAddress}
```

This key prefix is load-bearing — renaming it orphans existing browser deposits.
See the reconciliation note in `CLAUDE.md`.

For server-side flows the agent is responsible for note storage. **The original
note is spent the moment `/settle` returns** — the SDK does not auto-persist.
Save `nextDeposit` from the settle response before doing anything else.

## Round-trip example

```ts
// 1. Deposit (client-side)
const note = generateNote(amountAtomic);
const tx = await pool.deposit(amountAtomic, computeCommitment(note));
const { label } = parseDepositedEvent(await tx.wait());
note.label = label;
saveNote(note);

// 2. Pay (server-side via facilitator)
const res = await fetch('/api/facilitator/settle', {
  method: 'POST',
  body: JSON.stringify({ paymentDetails, zbaseDeposit: note }),
});
const { nextDeposit, txHash } = await res.json();
if (nextDeposit) saveNote(nextDeposit); // CRITICAL — original is spent
```

Next → [Stealth addresses](stealth-recipients.md)
