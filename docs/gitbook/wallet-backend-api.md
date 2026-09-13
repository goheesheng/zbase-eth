# Wallet backend API

The Next.js routes the consumer app and the facilitator expose. This page
documents the surface integrators actually call; the lower-level details live
in [API reference](api-reference.md).

## Base URL

Point the SDK at the **hosted facilitator** — the default, and the only option today:

```text
https://zbase.app
```

The mainnet path is gated by `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` **on the server** — you don't
supply these; the facilitator does. The `@zbase-protocol/core` SDK is a **client**: it *calls* a
facilitator, it doesn't run one, so installing it does not let you self-host. `http://localhost:3009`
only applies if you run the zBase app itself from source (internal today). Self-hosting your own
facilitator arrives when the app is open-sourced — see the [Roadmap](build-roadmap.md).

## Routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/facilitator/supported` | Capability + network advertisement |
| POST | `/api/facilitator/verify` | Confirm a `zbaseDeposit` covers an invoice |
| POST | `/api/facilitator/settle` | Generate proof, relay, return `nextDeposit` |
| POST | `/api/withdraw` | Lower-level direct withdraw |
| POST | `/api/asp-update` | Refresh the ASP root after deposits |
| POST | `/api/providers/register` | Register a stealth meta-address |
| GET | `/api/providers/register` | List registered providers (public) |
| POST | `/api/x402-pay` | Direct private payment convenience |

## Middleware

The facilitator middleware intercepts every facilitator route **before** the handler
sees the request and:

| Action | Headers |
|---|---|
| Strips on request | `x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`, `true-client-ip`, `user-agent`, `accept-language`, `referer`, `cookie` |
| Stamps on response | `Cache-Control: no-store, no-cache, must-revalidate`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Permissions-Policy: interest-cohort=()` |

The middleware contains zero `console.*` calls by design.

> The middleware strips at the facilitator's TLS endpoint. It does not protect against
> hostile network upstream (ISP, DNS, Cloudflare edge). See
> [Facilitator metadata hygiene](metadata-hygiene.md).

## Common request shapes

`paymentDetails`:

```json
{
  "scheme": "exact",
  "payTo": "0xProviderOrMetaAddress",
  "maxAmountRequired": "500000",
  "networkId": "eip155:84532"
}
```

`zbaseDeposit`:

```json
{
  "nullifier": "0x...",
  "secret": "0x...",
  "value": "1009800",
  "label": "0x...",
  "commitment": "0x..."
}
```

## Settle response

```json
{
  "settled": true,
  "txHash": "0x...",
  "amount": "500000",
  "remainingValue": "509800",
  "nextDeposit": { "nullifier": "...", "secret": "...", "value": "509800", "label": "...", "commitment": "..." },
  "proofTimeMs": 6212
}
```

If `nextDeposit` is present, **save it immediately**. The original note is
spent.

## Settlement header

After settlement, retry the originally-402'd call with:

```text
X-Zx402-Settlement: 0xSettlementTxHash
```

This header name is part of the bypass middleware contract and intentionally
keeps the `Zx402` prefix; see the reconciliation note in `CLAUDE.md`.

## Provider registration

`POST /api/providers/register` body:

```json
{
  "name": "Example provider",
  "metaAddress": "st:base:...",
  "chainTag": "base"
}
```

Persisted to `data/providers.json`. The facilitator looks up `paymentDetails.payTo`
against this registry; if it matches a meta-address, settle derives a fresh
stealth address. If it doesn't, settle pays the plain address as before
(stealth is opt-in, backwards compatible).

## Error taxonomy

| Error | Likely cause | First fix |
|---|---|---|
| `Missing server config` | env not loaded | `set -a; source .env.local; set +a` |
| `Invalid payment amount` | `maxAmountRequired` zero/missing/malformed | Pass atomic USDC string |
| `Deposit not found` | State tree didn't see commitment | Wait for indexer or refresh |
| `Invalid proof` | Stale state or ASP root | Trigger `/api/asp-update`, retry |
| `Already spent` | Reused old note | Use `nextDeposit` |

Next → [API overview & error codes](api-reference.md)
