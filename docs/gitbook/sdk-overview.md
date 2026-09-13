# SDK overview

zBase ships two SDK packages and a backend API. This page is the map; the
pages that follow drill into each surface.

## Packages

| Package | npm name | Role |
|---|---|---|
| `@zbase-protocol/core` | `zx402` | Note encoding, stealth address, shared types — the Base (EVM) SDK |

> The npm namespace is `zx402` for build-time stability. The product brand is
> **zBase**. Both names refer to the same code.

Everything on this page is Base.

## Three integration surfaces

| Surface | Who uses it | Page |
|---|---|---|
| `@zbase-protocol/core` SDK | Agent/wallet code that holds notes | [Privacy Pool notes](sdk-privacy-pool-notes.md), [Merkle tree & proofs](sdk-merkle-tree-proofs.md) |
| Provider stealth SDK | Provider services receiving payments | [Stealth addresses](stealth-recipients.md) |
| Wallet backend API | Hosted facilitators and integrators that don't want to hold note state | [Wallet backend API](wallet-backend-api.md) |

## Quick-look — three import lines you will see

```ts
// Note encoding
import { encodeNote, decodeNote } from '@zbase-protocol/core/notes';

// ERC-5564 stealth
import {
  generateMetaAddress,
  deriveStealthAddress,
  scanForPayments,
} from '@zbase-protocol/core/stealth';
```

## What the SDK does NOT do

- It does **not** sign relays. The postman (single key today, 3-of-5 in a future release)
  signs the on-chain settlement transaction.
- It does **not** decide ASP approval. The ASP risk pipeline runs off-chain.
- It does **not** rotate stealth scanning keys for the provider — the provider
  retains the viewing key on their own infrastructure.

## Install

```bash
npm install @zbase-protocol/core
```

That's the whole footprint for an integrator — a published client SDK you point
at the hosted facilitator (`https://zbase.app`). You don't build or run the
zBase app itself; the facilitator is hosted.

Next → [Privacy Pool notes](sdk-privacy-pool-notes.md)
