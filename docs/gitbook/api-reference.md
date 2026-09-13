# API Reference

Last updated: **2026-07-21**

This reference documents the zBase facilitator API, live on Base mainnet
(`eip155:8453`). Base Sepolia (`eip155:84532`) is available for development.

## Base URL

The hosted facilitator — point the SDK here:

```text
https://zbase.app
```

## Common Objects

### `paymentDetails`

```json
{
  "scheme": "exact",
  "payTo": "0xProviderAddress",
  "maxAmountRequired": "500000",
  "networkId": "eip155:84532"
}
```

Fields:

| Field | Required | Notes |
|---|---:|---|
| `scheme` | verify only | Use `exact` for current tests. |
| `payTo` | yes | Provider address that receives settlement. |
| `maxAmountRequired` | yes | Invoice amount in atomic USDC units. |
| `networkId` | verify recommended | Base Sepolia is `eip155:84532`. |

### `zbaseDeposit`

```json
{
  "nullifier": "...",
  "secret": "...",
  "value": "1009800",
  "label": "...",
  "commitment": "..."
}
```

Use `zbaseDeposit` for new integrations. Older compatibility field names may
exist in code, but public docs should use the zBase name.

## `GET /api/facilitator/supported`

Returns the facilitator capability surface.

Use this before integration to confirm:

- supported network;
- supported token;
- privacy capability;
- the current pricing (rate, floor, access fee).

Example:

```bash
curl https://zbase.app/api/facilitator/supported
```

## `POST /api/facilitator/verify`

Checks whether a deposit can cover a requested payment before settlement.

Request:

```json
{
  "paymentDetails": {
    "scheme": "exact",
    "payTo": "0xProviderAddress",
    "maxAmountRequired": "500000",
    "networkId": "eip155:84532"
  },
  "zbaseDeposit": {
    "nullifier": "...",
    "secret": "...",
    "value": "1009800",
    "label": "...",
    "commitment": "..."
  }
}
```

Expected success:

```json
{
  "valid": true,
  "anonymitySet": 72
}
```

## `POST /api/facilitator/settle`

Generates a proof and settles the exact invoice amount privately.

Request:

```json
{
  "paymentDetails": {
    "payTo": "0xProviderAddress",
    "maxAmountRequired": "500000"
  },
  "zbaseDeposit": {
    "nullifier": "...",
    "secret": "...",
    "value": "1009800",
    "label": "...",
    "commitment": "..."
  }
}
```

Response:

```json
{
  "settled": true,
  "txHash": "0x...",
  "amount": "500000",
  "remainingValue": "509800",
  "nextDeposit": {
    "nullifier": "...",
    "secret": "...",
    "value": "509800",
    "label": "...",
    "commitment": "..."
  },
  "proofTimeMs": 6212
}
```

If `nextDeposit` is present, save it immediately. The original note is spent.

## `POST /api/withdraw`

Direct withdrawal endpoint. This is lower-level than the x402 facilitator.

Request:

```json
{
  "nullifier": "...",
  "secret": "...",
  "value": "1009800",
  "label": "...",
  "commitment": "...",
  "recipient": "0xRecipient",
  "amountAtomic": "500000"
}
```

Use `amountAtomic` for partial-note settlement. Omit it only when intentionally
withdrawing the full note.

## `POST /api/x402-pay`

Convenience payment endpoint for custom integrations that want one direct
private payment call.

Request:

```json
{
  "provider": "0xProviderAddress",
  "amountAtomic": "500000",
  "nullifier": "...",
  "secret": "...",
  "value": "1009800",
  "label": "...",
  "commitment": "..."
}
```

## Settlement Header

After settlement, the agent retries the paid API with:

```text
X-ZBase-Settlement: 0xSettlementTxHash
```

`X-ZBase-Settlement` is the public header name. Older aliases are compatibility
only.

## Error Classes

| Error class | Likely cause | First fix |
|---|---|---|
| Missing server config | `.env.local` missing RPC, postman key, or HyperSync token | Check env and restart server |
| Invalid payment amount | `maxAmountRequired` missing, zero, malformed, or too high | Send atomic USDC string |
| Deposit not found | State tree did not find commitment | Check note fields and indexer state |
| Invalid proof | Wrong tree, stale ASP root, spent note, or malformed note | Refresh ASP/root state and retry |
| Already spent | Reusing old note after settlement | Use `nextDeposit` |
