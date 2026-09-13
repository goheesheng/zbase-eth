# Vendored: 0xbow privacy-pools-core (Apache-2.0)

These are **unmodified upstream contracts** from
[0xbow-io/privacy-pools-core](https://github.com/0xbow-io/privacy-pools-core),
vendored into this repo so zBase can **deploy the single-value pool to Base
mainnet** (0xbow is not deployed on Base mainnet, and the live Sepolia pool's
source was never in this repo — see `docs/release/0xbow-vendor-deploy-rehearsal-2026-06-26.md`).

## License + attribution (do NOT remove)

The original work is licensed under **Apache License 2.0**. Per §4 of that
license, the `LICENSE` file in this directory is retained and these files keep
their original `// SPDX-License-Identifier: Apache-2.0` headers and copyright
notices. zBase has made **no modifications** to the `contracts/` and
`interfaces/` Solidity sources — they are byte-for-byte the upstream files at the
clone used 2026-06-28. If any are ever modified, that change must be noted here
per Apache-2.0 §4(b).

## What's here

- `contracts/` + `interfaces/` — the 15 upstream Solidity sources (PrivacyPool,
  State, Entrypoint, PrivacyPoolSimple/Complex, libs, verifiers, interfaces).
- `deps/` — the exact upstream Solidity dependencies copied from the 0xbow
  clone's `node_modules` so the build is self-contained (no node_modules dep):
  `oz` (@openzeppelin/contracts), `oz-upgradeable`
  (@openzeppelin/contracts-upgradeable), `lean-imt` (@zk-kit/lean-imt.sol),
  `poseidon` (poseidon-solidity, provides PoseidonT4).
- `LICENSE` — 0xbow's Apache-2.0 license, retained verbatim.

## Building

These compile under `solc 0.8.28` (the upstream pin) via a dedicated foundry
profile that does NOT disturb the main zBase suite (which is pinned to 0.8.20):

```
forge build --profile vendor
```

The `[profile.vendor]` in `foundry.toml` sets `solc_version = 0.8.28` and the
remappings (`contracts/`, `interfaces/`, `@oz/`, `@oz-upgradeable/`, `lean-imt/`,
`poseidon/`) that resolve into this vendored tree.

## For mainnet deploy

The deploy script `zbase-protocol/pkg/contracts/script/DeployMainnetPool.s.sol`
deploys these (Entrypoint → PrivacyPoolComplex → registerPool) to Base mainnet.
Operator-run only; reuses 0xbow's chain-agnostic verifiers where applicable.
