# Contracts reference

What each deployed contract does, and which withdrawal verifier the on-chain proof binds
against. For the canonical addresses on each network, see
[Contract addresses](contract-addresses.md).

> zBase is **live on Base mainnet**. The addresses below are the Base Sepolia testnet stack
> (`eip155:84532`), kept here for development reference; the **mainnet** addresses live on the
> [Contract addresses](contract-addresses.md) page.

## Current — privacy pool (live)

> The live pool is a plain 0xbow Privacy Pool: deposits sit idle.

| Contract | Address | Purpose |
|---|---|---|
| Entrypoint (proxy) | `0x598ffaac79ae29b1aae571fd91899d4492183688` | Public deposit + withdraw entry |
| USDC Pool | `0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a` | Privacy pool; deposits held idle |
| Withdrawal Verifier | `0x5f5505242730dfc8a2c2637eb5258dc2c6622641` | Solidity Groth16 verifier — withdrawal circuit |
| Commitment Verifier | `0x293400accdeb0c1c2d419868303a8e96c09900ab` | Solidity Groth16 verifier — commitment circuit |
| USDC token | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | External — Base Sepolia USDC |
| Admin / Owner / Postman | `0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843` | Single-key today; replaced by `ThresholdEntrypoint` in a future release |
| Deploy block | `40668000` | Start of relevant `LeafInserted` history |

> Single-key postman until the threshold deploys. Three-of-five
> `ThresholdEntrypoint` is scaffolded
> and tested but **not yet deployed** — it's a roadmap item, not live. See the
> [Roadmap](build-roadmap.md) and `docs/governance/` for the signer-recruitment plan.

## On-chain settings

| Setting | Value | Notes |
|---|---|---|
| `SCOPE` | per-pool constant | Used in `label = keccak256(SCOPE, nonce)` |
| Deposit vetting fee | `1%` | Deducted at deposit; the commitment carries `value - fee` |

> A 1 USDC deposit becomes `990000` raw units inside the commitment. The
> facilitator handles this automatically; integrators using `/api/withdraw`
> directly should be aware.

## Explorer

All addresses above can be inspected on
[Base Sepolia BaseScan](https://sepolia.basescan.org).

Next → [Circuits reference](circuits-reference.md)
