# Stealth Provider Onboarding — 2026-05-31

zBase ships ERC-5564 stealth recipients (scheme 1, secp256k1) as Shipment B.1.
Once registered, every settlement targeting your endpoint lands on a fresh
on-chain address derived from your meta-address — the buyer sees a single API
URL, the chain sees N unrelated recipients.

## Who this is for

AI providers and API merchants accepting x402 payments who do not want every
caller's transaction graph to expose their revenue pattern. Today, every
payment to (say) OpenAI's x402 endpoint pays the same address; with B.1
registered you get the same UX with unlinkable on-chain recipients.

## What you'll do

1. Mint a meta-address (a long-lived public identity composed of two
   secp256k1 public keys).
2. Register the meta-address with a running zBase facilitator.
3. Start receiving stealth payments — one fresh address per settlement.
4. Scan published `ephemeralPubkey` values periodically to detect inbound
   funds and sweep when you want.

The viewing private key never leaves your machine. The spending private key
is needed only when you sweep.

## 5-minute setup

Prereqs: Node 20+, npm, a checkout of this repo, a running zBase facilitator
(local dev on `http://localhost:3009` or a deployment URL).

### 1. Generate a strong seed (optional, but recommended for reproducibility)

```bash
export STEALTH_SEED=$(openssl rand -hex 64)
# STORE THIS IN A PASSWORD MANAGER. Without it, the spending+viewing private
# keys minted in step 2 cannot be re-derived.
```

If you skip this step, the script uses fresh OS randomness and prints the
private keys exactly once (only with `--reveal-private-keys`). Lose them and
all stealth payments to that meta-address become permanently unspendable.

### 2. Register against the facilitator

```bash
PROVIDER_NAME="Nansen API" \
PROVIDER_EMAIL="ops@nansen.ai" \
ZBASE_API="http://localhost:3009" \
  npx tsx scripts/register-stealth-provider.ts --reveal-private-keys
```

The script:
- Mints the meta-address (deterministic if `STEALTH_SEED` is set).
- POSTs `{ providerName, metaAddress, contactEmail, scheme: 1, fallbackPayTo? }`
  to `POST /api/providers/register`.
- Derives one test stealth address from the meta-address to prove the
  facilitator-side derivation works.
- GETs `/api/providers/register` and confirms your provider is in the listing.

Optional env: `FALLBACK_PAYTO=0x...` — if your x402 endpoint already hard-codes
a recipient `0x` address in its 402 response, register it as `fallbackPayTo`
and the facilitator will stealth-route settlements that target it.

Save the printed `spending private key` and `viewing private key` to a password
manager. The meta-address, both public keys, and the provider id are safe to
share.

### 3. Run the integration test (optional)

```bash
bash scripts/test-stealth-roundtrip.sh
```

Boots a dev server, runs the registration script against it, confirms the
GET listing contains the new provider, tears down. Use this in CI to keep
the onboarding path green.

## What zBase does with your meta-address

- **Storage:** appended to `data/providers.json` on the facilitator instance
  that received the POST. This file is local to that instance — there is no
  central registry today.
- **On-chain:** **nothing.** The meta-address is never published. Only the
  per-settlement ephemeral pubkey + view tag hit the chain (via the
  facilitator's settle log).
- **At settle time:** `findProviderByPayTo()` looks up the provider by
  `metaAddress` or `fallbackPayTo`. On a match, `deriveStealthAddress()` mints
  a fresh address from your meta-address + a CSPRNG nonce, and the settlement
  pays that address instead. `recordStealthDerivation()` bumps the public
  counter so you can sanity-check usage.

## Scanning your payments

```ts
import { scanForPayments, computeStealthPrivateKey } from "@zbase-protocol/core";

// Pull the ephemeralPubkeys (and view tags) the facilitator published for your
// provider id from /api/facilitator/settle logs — they're emitted on every
// stealth settlement.
const ephemeralPubkeys: string[] = [/* 0x... compressed pubkeys */];
const viewTags: string[] = [/* 0x.. one byte each, same length */];

const matches = scanForPayments(
  process.env.VIEWING_PRIVATE_KEY!,     // never leaves your box
  ephemeralPubkeys,
  process.env.SPENDING_PUBLIC_KEY!,     // public, fine in env
  viewTags,                              // optional — ~256x scan speedup
);

for (const m of matches) {
  // m.stealthAddress holds the funds. To sweep:
  const spendKey = computeStealthPrivateKey(
    process.env.SPENDING_PRIVATE_KEY!,  // only needed at sweep
    process.env.VIEWING_PRIVATE_KEY!,
    m.ephemeralPublicKey,
  );
  // Import `spendKey` into a viem account and transfer to your treasury.
}
```

The view-tag fast path filters ~255/256 of unrelated announcements with a
single byte compare before doing any elliptic-curve math. Always pass it.

## Security

- **Spending private key:** treat like an Ethereum mnemonic. Password manager
  or hardware-backed secret store. Never put it on a server that handles
  inbound HTTP.
- **Viewing private key:** safer (it can decrypt incoming payments but cannot
  spend them). Can live on a "view-only" scanner machine. Still secret — an
  attacker with the viewing key can link every payment they observe to your
  identity.
- **STEALTH_SEED:** if used, treat as equivalent to both private keys
  combined. Lose it (and the private keys) and the meta-address is dead.
- **Re-using ephemeral nonces** would collapse two payments to the same
  stealth address. The facilitator uses fresh CSPRNG randomness per settle;
  do not call `deriveStealthAddress(metaAddress, fixedNonce)` from your own
  code.

## Multi-instance providers

If you run multiple endpoints (e.g. `api-us.example.com` and
`api-eu.example.com`), register each one as a separate provider with its own
meta-address. This:

- Keeps revenue per region unlinkable from revenue elsewhere.
- Lets you rotate one region's keys without touching the other.
- Keeps the `fallbackPayTo` lookup unambiguous (each 0x fallback maps to
  exactly one provider).

Reuse the same `STEALTH_SEED` derivation pattern with different salts in your
secret manager if you want a single recovery story.

## Removing yourself

There is no `DELETE /api/providers/register` endpoint yet — registration is
designed to be sticky so existing inbound payments don't get orphaned.

To deregister today:

1. Stop the facilitator instance.
2. Edit `data/providers.json` on disk: remove the object whose
   `metaAddress` matches yours (or whose `id` matches the one the script
   printed at registration).
3. Restart the facilitator.

In-flight stealth payments already routed to your old meta-address remain
spendable as long as you keep the spending+viewing private keys.

A first-class deregistration endpoint is on the roadmap; track it via the
provider-registry route comments.

## Reference

- SDK: `packages/core/src/stealth.ts`
- Registry route: `src/app/api/providers/register/route.ts`
- One-command onboarding: `scripts/register-stealth-provider.ts`
- CI integration test: `scripts/test-stealth-roundtrip.sh`
- Offline SDK invariants: `scripts/test-stealth.ts`
- In-process route smoke: `scripts/test-providers-route.ts`
- Spec: ERC-5564 (<https://eips.ethereum.org/EIPS/eip-5564>)
