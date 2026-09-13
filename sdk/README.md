# Legacy zBase SDK

This directory is a legacy local SDK snapshot. It is not the active public
integration surface for the Base mainnet launch.

Use the maintained package instead:

```bash
npm install @zbase-protocol/core
```

```ts
import { createFacilitatorClient } from "@zbase-protocol/core";

const zbase = createFacilitatorClient({
  baseUrl: "https://zbase.app",
  network: "eip155:84532", // Base Sepolia
});

const prep = zbase.prepareDeposit(1_000_000n);
```

Important current-state facts:

- The active pool is a plain 0xbow USDC PrivacyPool. There is no deployed Morpho
  yield leg.
- Base Sepolia is the live testnet path. Base mainnet requires the deployed
  `BASE_MAINNET_*` contract env, Upstash, ASP root initialization, and a
  launch-ready postman signer.
- Solana/SVM is paused while audit fixes are applied.
- Current hosted settlement uses server-side proving, so
  `settlePrivately()` sends note spend secrets to the configured facilitator.
  Pin `baseUrl` to a deployment you operate or trust.

Do not publish or recommend this `sdk/` package without a separate audit and
API reconciliation pass.
