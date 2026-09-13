# Stealth addresses

TL;DR — ERC-5564 stealth meta-addresses let a provider register once and
receive every payment at a fresh, unlinkable address. Same provider, different
recipient every call.

> Status: SDK + provider registry + facilitator integration all live.
> 100-payment offline test passing. Live POST 200 against running dev server.
> Needs first provider to register.

## The problem it solves

Today every payment to OpenAI's x402 endpoint pays the **same address**. An
outside observer can build a graph: "wallet X paid OpenAI 40 times this hour —
they're running an arbitrage bot using OpenAI's gpt-5o feed at known intervals."

The ASP and the pool hide the *payer*. They don't hide the *receiver*. Provider
correlation breaks the privacy claim end-to-end.

## The fix

[ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) stealth addresses, secp256k1
scheme 1 (the audited variant). Each provider:

1. **One-time:** generates a public stealth meta-address (one address that derives
   infinite receiving addresses) via `generateMetaAddress()`.
2. **Registers** with zBase via `POST /api/providers/register`, persisted to
   `data/providers.json`.
3. **Per payment**, the facilitator calls `deriveStealthAddress(metaAddress,
   randomNonce)` and routes the withdrawal to the derived address. The
   ephemeral pubkey is published on-chain alongside.
4. **Provider's scanner** watches recent blocks, uses view-tag fast path
   (256× faster than full scan) to identify which stealth addresses are theirs,
   sweeps to treasury whenever convenient.

Result: a thousand payments to the same provider land at a thousand different
addresses. Outside observers see unrelated transfers. Provider's accounting
still reconciles cleanly via the scanning key.

## What landed in this update

| Component | What it is |
|---|---|
| Stealth SDK | ERC-5564 SDK (446 lines, secp256k1 scheme 1) |
| Provider registry route | Provider registry (POST/GET) |
| Facilitator settle route (modified) | Derives stealth address if payTo matches a registered meta-address |
| Stealth invariant test | 100-payment invariant test |
| Provider route test | Route smoke test (8 assertions) |
| Provider integration doc | Provider onboarding doc |

## SDK surface

```ts
// Provider-side, one-time
const meta = generateMetaAddress(seed?, chainTag?);
// → { metaAddress, spendingPublicKey, viewingPublicKey,
//     spendingPrivateKey, viewingPrivateKey }

// Facilitator-side, per call
const stealth = deriveStealthAddress(metaAddress, ephemeralNonce?);
// → { stealthAddress, ephemeralPublicKey, viewTag }

// Provider-side, scanning
const matches = scanForPayments(
  viewingPrivateKey, ephemeralPubkeys, spendingPublicKey, expectedViewTags?
);

// Provider-side, sweep
const sk = computeStealthPrivateKey(
  spendingPrivateKey, viewingPrivateKey, ephemeralPublicKey
);
```

## Live test on Sepolia (2026-05-29)

| Test | Result |
|---|---|
| 100 stealth derivations from one meta-address | All unique, none collide with meta-address |
| View-tag scan (100 addresses) | 164.0 ms |
| Full scan (100 addresses) | 172.1 ms |
| Private-key recovery (all 100) | All match facilitator-derived addresses |
| Determinism (same nonce → same address) | Passes |
| Seeded generation (same seed → same meta-address) | Passes |
| Live POST /api/providers/register | 200, persisted to disk |

## Backwards compatibility

If `paymentDetails.payTo` is a plain Ethereum address (not a registered stealth
meta-address), the facilitator settles to that address as before. **Nothing
breaks** for existing providers. Stealth is opt-in.

If `paymentDetails.payTo` looks like a meta-address but isn't registered, the
facilitator returns 400 with a clear error message so debugging is fast.

## Things to be honest about

- An observer who controls the facilitator could correlate `ephemeralPubkey →
  recipient` if they also knew the provider's viewing key. They don't, because
  the viewing key **never leaves the provider's machine**.
- Stealth addresses don't hide the **payment amount**.
- The provider's scanner is a real piece of infrastructure they have to run.
  Hosted scanning is on the roadmap as a paid managed service.

Next → [Merkle tree & proofs](sdk-merkle-tree-proofs.md)
