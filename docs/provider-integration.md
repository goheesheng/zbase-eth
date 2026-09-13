# Provider integration — ERC-5564 stealth recipients (Shipment B.1)

> This is the full/long-form design reference. The published, reader-facing summary
> is `docs/gitbook/stealth-recipients.md` (in the GitBook nav). Keep this as the
> deep reference; point integrators at the GitBook page first.

zBase routes every settlement to a **fresh on-chain address** derived from
your registered ERC-5564 meta-address. The consequence: a chain analyst
who watches your x402 endpoint sees N unrelated recipients instead of one
hot wallet receiving every payment. Buyer↔provider correlation goes from
"trivial graph join" to "discrete log on secp256k1".

This document explains the four steps to participate:

1. [Generate a meta-address](#1-generate-a-meta-address-one-time) (one-time, offline).
2. [Register it with zBase](#2-register-with-zbase).
3. [Run the scanner](#3-run-the-scanner) to find incoming payments.
4. [Sweep funds to treasury](#4-sweep-funds-to-treasury).

We also document the [view-tag optimization](#view-tag-optimization),
which reduces scan cost by ~256× on a busy facilitator.

---

## 1. Generate a meta-address (one-time)

A meta-address is two compressed secp256k1 public keys, encoded as
`st:base:0x<spendingPubKey:33B><viewingPubKey:33B>`. The corresponding
private keys must **never leave your environment**:

| Key | Purpose | Custody profile |
|---|---|---|
| **spending private key** | Signs withdrawals from stealth addresses | Cold/HSM; treat like a treasury cold key |
| **viewing private key** | Lets you (or a delegated worker) scan announcements | Warm; can be delegated to a scanner service |

Generate locally with the SDK:

```ts
// scripts/setup.ts — run once, write the output to a vault.
import { generateMetaAddress } from "@zbase-protocol/core";

const me = generateMetaAddress();

console.log("metaAddress (publish this):", me.metaAddress);
console.log("spending pubkey:",          me.spendingPublicKey);
console.log("viewing  pubkey:",          me.viewingPublicKey);
console.log("spending PRIVATE (cold):",  me.spendingPrivateKey);
console.log("viewing  PRIVATE (warm):",  me.viewingPrivateKey);
```

Or pass a deterministic seed (64 bytes; first 32 → spending, last 32 →
viewing) if you maintain a BIP-32-style key tree.

### Sanity check

The meta-address should round-trip through `parseMetaAddress` without
error and produce two distinct compressed pubkeys:

```ts
import { parseMetaAddress } from "@zbase-protocol/core";

const { spendingPublicKey, viewingPublicKey } = parseMetaAddress(me.metaAddress);
console.assert(spendingPublicKey.length === 33);
console.assert(viewingPublicKey.length === 33);
console.assert(!Buffer.from(spendingPublicKey).equals(Buffer.from(viewingPublicKey)));
```

---

## 2. Register with zBase

`POST https://zbase.app/api/providers/register`

```bash
curl -X POST https://zbase.app/api/providers/register \
  -H "Content-Type: application/json" \
  -d '{
    "providerName": "Acme Inference API",
    "metaAddress":  "st:base:0x027e...ff62040c",
    "contactEmail": "ops@acme.dev",
    "fallbackPayTo": "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21"
  }'
```

| Field | Required | Notes |
|---|---|---|
| `providerName` | yes | 2–120 chars; shown in the public registry |
| `metaAddress`  | yes | `st:base:0x<132 hex chars>`; validated as a real curve point |
| `contactEmail` | yes | breakglass + compliance contact only; not exposed publicly |
| `fallbackPayTo` | no | If your existing `402 Payment Required` response already hard-codes a Base EOA in `payTo`, register it here. zBase will rewrite settlements whose `payTo` equals this address to a fresh stealth recipient. |

After registration the settle response carries:

```jsonc
{
  "settled": true,
  "txHash": "0x...",
  "privacy": {
    "recipientStealth": true,
    "recipient":        "0x21f4c9f9ddc46048f5a86fc1d33c1337a3084d68",
    "ephemeralPubkey":  "0x03b1...c4",
    "viewTag":          "0xa3",
    "schemeId":         1,
    "providerId":       "prov_abcd1234",
    "providerName":     "Acme Inference API"
  }
}
```

The `ephemeralPubkey` is the value you scan for. The `recipient` is the
USDC destination on Base. The `viewTag` is the first byte of the hashed
shared secret — see [§ View-tag optimization](#view-tag-optimization).

---

## 3. Run the scanner

The scanner is a 50-line poller that watches Base for USDC transfers to
addresses derived from your meta-address. The reference loop:

```ts
// scripts/scan.ts — production this as a long-running service.
import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";
import {
  scanForPayments,
  computeStealthPrivateKey,
} from "@zbase-protocol/core";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

// Load these once at boot from your vault — NEVER hard-code.
const VIEW_PRIV  = process.env.STEALTH_VIEW_PRIV!;   // 0x... 32B
const SPEND_PRIV = process.env.STEALTH_SPEND_PRIV!;  // 0x... 32B  (HSM in prod)
const SPEND_PUB  = process.env.STEALTH_SPEND_PUB!;   // 0x... 33B compressed

const client = createPublicClient({ chain: base, transport: http() });

let cursor = await client.getBlockNumber();

async function tick() {
  // 1. Pull recent settle announcements from your zBase facilitator.
  //    Persist these in your own DB; the snippet below uses a stub fn.
  const announcements: { ephemeralPubkey: string; viewTag: string }[] =
    await fetchAnnouncementsSince(cursor);

  if (announcements.length === 0) return;

  // 2. Filter by view tag (1 byte) — cheap. Skips ~255/256 announcements
  //    that aren't ours before doing the expensive point arithmetic.
  const matches = scanForPayments(
    VIEW_PRIV,
    announcements.map((a) => a.ephemeralPubkey),
    SPEND_PUB,
    announcements.map((a) => a.viewTag),
  );

  // 3. For each match, derive the stealth privkey and confirm USDC arrived.
  for (const m of matches) {
    const sk = computeStealthPrivateKey(SPEND_PRIV, VIEW_PRIV, m.ephemeralPublicKey);
    // sk is 32 raw bytes; turn into a viem Account however you sign in prod.
    await persistMatch({
      stealthAddress: m.stealthAddress,
      privateKey:     "0x" + Buffer.from(sk).toString("hex"),
      ephemeralPubkey: m.ephemeralPublicKey,
    });
  }

  // 4. (Optional) Cross-check that USDC actually landed at the stealth addr,
  //    using a standard Transfer log query on the USDC contract.
  const now = await client.getBlockNumber();
  const logs = await client.getLogs({
    address: USDC, event: TRANSFER, fromBlock: cursor, toBlock: now,
    args: { to: matches.map((m) => m.stealthAddress as `0x${string}`) },
  });
  console.log(`[scanner] ${logs.length} confirmed deposits in ${now - cursor} blocks`);

  cursor = now + 1n;
}

setInterval(() => tick().catch(console.error), 5_000);
```

**Where do announcements come from?** Two options:

- **Polling the facilitator** (simplest). The settle response is the source
  of truth: persist `ephemeralPubkey`, `viewTag`, and `txHash` to your DB
  every time zBase calls back. Production teams typically do this in their
  402 handler after a successful settle.
- **On-chain Announcement event** (post-MVP). The roadmap includes emitting
  an EIP-5564 `Announcement(uint256 schemeId, address stealthAddress, address caller, bytes ephemeralPubKey, bytes metadata)` event from the pool contract; subscribe with `client.watchEvent`. Until then the
  settle-response path is the source.

---

## 4. Sweep funds to treasury

Stealth addresses hold value but cannot be used directly as a hot wallet
without leaking the link to your provider identity. The standard pattern:

1. Wait for `N` stealth addresses to accumulate (e.g. 50).
2. From each, send USDC to a 0xbow Privacy Pool deposit (the same pool
   zBase uses) — this re-anonymises the funds.
3. Withdraw a single round number to your treasury.

The "shielded sweep" matters: a naive sweep that batches all stealth
addresses into one tx **rejoins** them on-chain and undoes the stealth
benefit. Use one tx per stealth address, ideally spaced over hours.

A minimal sweep loop:

```ts
import { createWalletClient, http, parseUnits } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

for (const m of await loadUnswept()) {
  const account = privateKeyToAccount(m.privateKey);
  const client  = createWalletClient({ chain: base, transport: http(), account });
  await client.writeContract({
    address: USDC,
    abi:     ERC20_ABI,
    functionName: "transfer",
    args:    [ZBASE_POOL_FOR_SHIELDED_SWEEP, parseUnits("9.95", 6)],
  });
  await markSwept(m.stealthAddress);
  await sleep(Math.random() * 3600_000); // jitter to defeat timing
}
```

---

## View-tag optimization

The view tag is the most-significant byte of `keccak256(k_v · R)`. The
ScopeLift / Trail-of-Bits-audited construction lets a scanner reject an
announcement after **one byte comparison** instead of a full secp256k1
point addition. On real-world data the speedup is ~256× because only
~1/256 announcements are yours.

Cost model on a single CPU core (rough — secp256k1 is fast):

| Without view tags | With view tags (no match) | With view tags (match) |
|---|---|---|
| ECDH + keccak + point-add: ~120 µs | ECDH + keccak: ~30 µs, then byte compare: <1 µs | full path, ~120 µs |

For a facilitator processing 100 settlements/sec and ~10 of them
belonging to you, that's 100·30 µs + 10·90 µs = 3.9 ms per second per
provider — trivially scalable.

The zBase SDK calls this automatically; you only need to pass the
`expectedViewTags` argument:

```ts
const matches = scanForPayments(
  viewingPrivateKey,
  ephemeralPubkeys,
  spendingPublicKey,
  viewTags,        // ← optional fast path
);
```

---

## Security boundary

What this scheme defeats:

- **Chain-graph attackers.** Without your viewing private key, no on-chain
  observer can link an `ephemeralPubkey` to your meta-address (security
  reduces to the secp256k1 ECDH/DDH assumption).
- **Provider correlation across calls.** Two payments to the same x402
  endpoint land on two unrelated addresses on Base.

What this scheme does **not** defeat:

- **An attacker who controls the facilitator AND has your viewing key.**
  The viewing key is held by you; the facilitator never sees it. Custody
  hygiene matters.
- **Behavioural fingerprinting at scale.** Stealth addresses hide the
  recipient identity but not the pattern of payments (sizes, cadence). The
  rest of this shipment (decoy withdrawals + opt-in delay window) is the
  defence here.
- **Provider-side surveillance.** Once your service receives the prompt /
  query / payload, no math can re-anonymise it; that's your service's
  problem to design around.

zBase ships its [trust model](./gitbook/trust-model.md) and
[threat model](./gitbook/threat-model.md) alongside this feature; both
documents are kept in sync with what the code actually defeats.
