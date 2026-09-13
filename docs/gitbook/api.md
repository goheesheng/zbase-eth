# Live API playground

Fire real requests against the **live mainnet facilitator** below. Everything in the interactive
panel is read-only and safe — it moves no funds and needs no secrets. Click an operation, then
**Send** (or **Test Request**) to see the real response. The most useful one is
`GET /api/facilitator/supported` — it returns the live anonymity set and whether payments are
crowd-private yet.

!!! warning "The money path is not in the playground — by design"
    Paying, settling, withdrawing, and verifying require a **signed EIP-3009 payload** and a
    **single-use spend secret**, and they move real USDC. Firing them from a public page is unsafe,
    so they are not in the interactive spec. Use the SDK — it builds the signatures for you (see
    [Integrate zBase as your facilitator](use-zbase-as-facilitator.md)). Reference request/response shapes are below.

<script
  id="api-reference"
  data-url="/openapi.yaml"
  data-configuration='{"hideDownloadButton":false,"hideTestRequestButton":false,"servers":[{"url":"https://zbase.app","description":"Base mainnet facilitator (live)"}]}'></script>
<!-- Scalar pinned to an exact version with Subresource Integrity: a compromised or swapped CDN
     bundle fails the hash check and does not execute. Bump the version + regenerate the hash
     (openssl dgst -sha384 -binary <file> | openssl base64 -A) together, never separately. -->
<script
  src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.62.9"
  integrity="sha384-oBiNNPts22DP4xagXD0sZE4A/PyTMc+sYcxwx+v692dheBqr5zHQTp58ufiOqJH2"
  crossorigin="anonymous"></script>

## Money endpoints (reference — use the SDK)

These move real USDC and require a signed payload + spend secret, so they have **no live Send** and
are shown as **request / response shapes, not runnable commands**. The SDK constructs the signature,
the ZK proof, and the note selection for you — always call these through it, never by hand.

!!! danger "These are not copy-paste curls — use the SDK"
    A note's `secret` / `nullifier` are bearer credentials. The shapes below use placeholders
    (`<secret>`, `0x…`) and will not run as-is; hand-rolling the call means building an EIP-3009
    authorization and a Groth16 proof yourself. The SDK keeps the secrets off the wire except to the
    facilitator you pin. Use the `payAndFetch` snippet below.

### `POST /api/facilitator/settle-x402` — private pay + settle

Withdraws from the pool via a ZK proof, funds a single-use payer EOA, and returns the standard
`X-PAYMENT` header the seller's CDP facilitator will accept.

Request body (`POST`, `Content-Type: application/json`) — shape only, filled in by the SDK:

```json
{
  "accepts": { "scheme": "exact", "network": "eip155:8453", "asset": "0x833589fCD6…2913", "payTo": "0x…", "maxAmountRequired": "1000" },
  "zbaseDeposit": { "nullifier": "<secret>", "secret": "<secret>", "value": "…", "commitment": "…", "label": "…" },
  "nextNullifier": "<seed-derived>", "nextSecret": "<seed-derived>"
}
```

Response:

```json
{ "settled": true, "xPayment": "<base64>", "payer": "0x…", "fundingTxHash": "0x…", "nextDeposit": { "…": "…" } }
```

How you actually make this call — the SDK does the signing, proof, and note rotation, with safe
failure semantics:

```ts
import { createFacilitatorClient } from "@zbase-protocol/core";
const zbase = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453" });
const res = await zbase.payAndFetch("https://api.seller.com/endpoint", { method: "GET" }, {
  deposit: myNote, onNoteRotate: (n) => db.save(n), acceptNotPrivate: true,
});
// res.paid, res.status, res.response, res.fundingTxHash, res.nextDeposit ...
```

The other money endpoints follow the same rule — request/response shapes only, filled in by the SDK.

### `POST /api/facilitator/verify` — pre-settle check

Confirms a `zbaseDeposit` covers an invoice, without spending it.

```json
{
  "paymentDetails": { "scheme": "exact", "payTo": "0x…", "maxAmountRequired": "1000", "networkId": "eip155:8453" },
  "zbaseDeposit": { "nullifier": "<secret>", "secret": "<secret>", "value": "…", "commitment": "…", "label": "…" }
}
```

```json
{ "valid": true, "anonymitySet": 72 }
```

### `POST /api/facilitator/settle` — generic (non-x402) settle

Proof + relay, returns the rotated `nextDeposit`. Use `settle-x402` for the x402 payment flow.

```json
{
  "paymentDetails": { "payTo": "0x…", "maxAmountRequired": "1000" },
  "zbaseDeposit": { "nullifier": "<secret>", "secret": "<secret>", "value": "…", "commitment": "…", "label": "…" }
}
```

```json
{ "settled": true, "txHash": "0x…", "amount": "1000", "remainingValue": "…", "nextDeposit": { "…": "…" } }
```

### `POST /api/withdraw` — low-level ZK withdrawal

Lower-level than the facilitator: USDC leaves the pool to `recipient`. `amountAtomic` does a
partial-note withdrawal; omit it only to withdraw the full note.

```json
{
  "nullifier": "<secret>", "secret": "<secret>", "value": "…", "commitment": "…", "label": "…",
  "recipient": "0x…", "amountAtomic": "1000"
}
```

### `POST /api/x402-pay` — one-call private payment

Convenience endpoint for custom integrations that want a single direct private payment.

```json
{
  "provider": "0x…", "amountAtomic": "1000",
  "nullifier": "<secret>", "secret": "<secret>", "value": "…", "commitment": "…", "label": "…"
}
```

Full field-by-field docs, the `X-ZBase-Settlement` retry header, and the error taxonomy are on
[API overview & error codes](api-reference.md).
