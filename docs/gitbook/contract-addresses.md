# Contract addresses

Every zBase contract, per network, with a block-explorer link. The **Entrypoint proxy** is the
public deposit/withdraw entry; the **Pool** holds all shielded USDC. For the full description of
what each contract does, see [Contracts reference](contracts-reference.md).

!!! note
    The **postman** (relay signer) address is not a fixed constant — read it live from
    `GET /api/forwarding/postman` (see the [Live API playground](api.md)). It rotates independently
    of the contract stack.

## Base mainnet (`eip155:8453`)

Explorer: [basescan.org](https://basescan.org)

| Contract | Address | Purpose |
|---|---|---|
| **Entrypoint (proxy)** | [`0x275faa86e2e316abe46807453c1d95f101d36431`](https://basescan.org/address/0x275faa86e2e316abe46807453c1d95f101d36431) | Public deposit + withdraw entry (ERC-1967 proxy) |
| **Privacy Pool (USDC)** | [`0x46753ced1e87871ea1aaf24aed47dfa2d95855dd`](https://basescan.org/address/0x46753ced1e87871ea1aaf24aed47dfa2d95855dd) | Shielded USDC pool (deposits held idle) |
| Withdrawal Verifier | [`0x8044fdf75756deba3d09d401946c3aa6056d6eb4`](https://basescan.org/address/0x8044fdf75756deba3d09d401946c3aa6056d6eb4) | Groth16 verifier — withdrawal circuit |
| Commitment Verifier | [`0x72ac77e63ab3b65d3bfdda15afa72e8ecb662e6a`](https://basescan.org/address/0x72ac77e63ab3b65d3bfdda15afa72e8ecb662e6a) | Groth16 verifier — commitment circuit |
| Entrypoint (implementation) | [`0x0c7468563b35184e363600ebc71cb9a5c5e5aee3`](https://basescan.org/address/0x0c7468563b35184e363600ebc71cb9a5c5e5aee3) | Logic behind the proxy (do not call directly) |
| PoseidonT3 | [`0xc8b10d4f14dcaf820cf96dd5f6d15e78d160d693`](https://basescan.org/address/0xc8b10d4f14dcaf820cf96dd5f6d15e78d160d693) | Poseidon hash (arity 3) library |
| PoseidonT4 | [`0x02e2f7e55a82a7cb96a9b9a45dc30250dc9ea84e`](https://basescan.org/address/0x02e2f7e55a82a7cb96a9b9a45dc30250dc9ea84e) | Poseidon hash (arity 4) library |
| USDC (external) | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) | Circle canonical USDC on Base |

## Base Sepolia (`eip155:84532`)

Explorer: [sepolia.basescan.org](https://sepolia.basescan.org). Full testnet reference with the
retired addresses: [Contracts reference](contracts-reference.md).

| Contract | Address | Purpose |
|---|---|---|
| **Entrypoint (proxy)** | [`0x598ffaac79ae29b1aae571fd91899d4492183688`](https://sepolia.basescan.org/address/0x598ffaac79ae29b1aae571fd91899d4492183688) | Public deposit + withdraw entry |
| **Privacy Pool (USDC)** | [`0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a`](https://sepolia.basescan.org/address/0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a) | Shielded USDC pool |
| Withdrawal Verifier | [`0x5f5505242730dfc8a2c2637eb5258dc2c6622641`](https://sepolia.basescan.org/address/0x5f5505242730dfc8a2c2637eb5258dc2c6622641) | Groth16 verifier — withdrawal circuit |
| Commitment Verifier | [`0x293400accdeb0c1c2d419868303a8e96c09900ab`](https://sepolia.basescan.org/address/0x293400accdeb0c1c2d419868303a8e96c09900ab) | Groth16 verifier — commitment circuit |
| USDC (external) | [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) | Base Sepolia USDC |

## Verify these yourself

Never trust an address from a doc alone. The live facilitator publishes its active contract stack at
`GET /api/facilitator/supported` under `contracts` — fetch it and diff against the table above (try
it on the [Live API playground](api.md)). The 0xbow privacy-pool code is vendored under
`vendor/0xbow/**` and covered by 0xbow's own audit and trusted setup.
