# Ethereum Sepolia integration (ETHOnline 2026)

zBase's facilitator, built for Base, now also speaks Ethereum Sepolia — wired against
**0xbow's own canonical Ethereum Sepolia Privacy Pool** deployment, not a redeploy of zBase's
contracts. This page covers what's live, what isn't, and how to run it.

## Env vars

| Var | Required | Default | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_NETWORK=eth-sepolia` | yes | `sepolia` (Base) | Selects the Ethereum Sepolia stack. |
| `ETH_SEPOLIA_RPC` | no | a public Sepolia RPC | Server-side read/write RPC override. |
| `NEXT_PUBLIC_ETH_SEPOLIA_RPC` | no | a public Sepolia RPC | Client-side (wagmi) RPC override. |
| `LOG_CHUNK_BLOCKS` | no | `50,000` on Ethereum Sepolia (publicnode), `10,000` on Base | `eth_getLogs` chunk size for the RPC-fallback indexer path. |
| `HYPERSYNC_URL` / `HYPERSYNC_CHAINS` | no | built-in per-chain URLs | Override the Envio HyperSync endpoint used for a given chain ID. |

## Addresses (Ethereum Sepolia, chain `eip155:11155111`)

Explorer: [sepolia.etherscan.io](https://sepolia.etherscan.io). Deploy block `8,587,064`.
These are **0xbow's** addresses, not zBase's — verified on-chain via `cast` (SCOPE / ASSET /
ENTRYPOINT / current Merkle root all consistent) before wiring in.

| Contract | Address |
|---|---|
| Entrypoint (proxy) | [`0x34A2068192b1297f2a7f85D7D8CdE66F8F0921cB`](https://sepolia.etherscan.io/address/0x34A2068192b1297f2a7f85D7D8CdE66F8F0921cB) |
| Privacy Pool (USDC, PrivacyPoolComplex) | [`0x0b062Fe33c4f1592D8EA63f9a0177FcA44374C0f`](https://sepolia.etherscan.io/address/0x0b062Fe33c4f1592D8EA63f9a0177FcA44374C0f) |
| Withdrawal Verifier | [`0x822f33Ed5Ac1d33ceed4EEC60A99b06e5053A00a`](https://sepolia.etherscan.io/address/0x822f33Ed5Ac1d33ceed4EEC60A99b06e5053A00a) |
| Ragequit Verifier | [`0xb4b9cE9aEbD6A2C82A7ba5B64E33Cc7Fb6eC1b60`](https://sepolia.etherscan.io/address/0xb4b9cE9aEbD6A2C82A7ba5B64E33Cc7Fb6eC1b60) |
| USDC (Circle, external) | [`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`](https://sepolia.etherscan.io/address/0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238) |

USDC's EIP-712 domain on Ethereum Sepolia is `"USDC"` / `"2"` — different from mainnet's
`"USD Coin"` / `"2"`, and different from Base's domain. The facilitator resolves this per chain
(`usdcDomainFor`); it used to be hardcoded to Base's.

## Run it

```bash
yarn
NEXT_PUBLIC_NETWORK=eth-sepolia npm run dev -- -p 3011
curl localhost:3011/api/facilitator/supported
curl localhost:3011/api/deposits/events
```

The first `deposits/events` call on a chain without a HyperSync entitlement scans over the
chunked `eth_getLogs` RPC fallback and takes roughly 30–50 seconds; later calls are faster once
the local cache is warm.

## What works vs. returns 501

| Endpoint | Status |
|---|---|
| `GET /api/facilitator/supported` | Works — reports the Ethereum Sepolia contracts, live anonymity set, 0xbow's ASP root and a `pricing.networks["eip155:11155111"]` entry. `supported[]` is empty until the shared indexer + RPC readiness gates pass (same gate as Base). |
| `GET /api/deposits/events` | Works — reads 0xbow's Ethereum Sepolia pool via the RPC fallback. |
| Anonymity-set read (`/anonymity-set-disclosure`) | Works — same read path. |
| `POST /api/facilitator/verify` | Works — accepts `eip155:11155111` payment payloads. |
| `POST /api/withdraw` | **501** — zBase is not 0xbow's ASP postman on this pool, so proof relay is refused with an explicit reason instead of attempted. |
| `POST /api/asp-update` (root updater) | **501** — same reason; zBase does not control this pool's ASP root. |
| Gasless sweep | Not wired — the CDP paymaster used on Base does not cover Ethereum; Pimlico/Alchemy is the planned path. |

The 501s are stated, not a bug: settling a withdrawal from a pool zBase doesn't administer needs
either zBase's own pool on Ethereum Sepolia, or a seat on 0xbow's ASP signer set. Neither exists yet.
