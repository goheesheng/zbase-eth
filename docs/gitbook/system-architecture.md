# System architecture

TL;DR — zBase is a facilitator app on Base (Solidity, plain 0xbow
PrivacyPool). Base mainnet is the current launch path; Base Sepolia is the
testnet path for development.

## High-level diagram

```mermaid
flowchart TB
    A["Agent<br/>x402 client · holds deposit notes"]
    S["Provider — paid API<br/>returns 402 + meta-address + amount"]
    F["zBase facilitator<br/>/verify · /settle · /supported<br/>strips IP / UA / cookie"]
    R["Provider registry<br/>stealth meta-addresses"]
    P["Postman<br/>relays the withdrawal<br/>single key today · 3-of-5 roadmap"]
    B["Base — live<br/>Entrypoint + PrivacyPool"]

    A -->|1. GET, receive 402| S
    A -->|2. settle over HTTPS| F
    F -->|derive fresh stealth| R
    F -->|3. relay| P
    P -->|ZK withdrawal funds payer| B
    A -->|4. pay with X-PAYMENT, receive 200| S

    style F fill:#e7eef8,stroke:#365f9f,color:#18191b
    style B fill:#e4f0e6,stroke:#4a7a52,color:#18191b
    style P fill:#eef1f4,stroke:#9aa0a6,color:#18191b
    style R fill:#eef1f4,stroke:#9aa0a6,color:#18191b
```

## Roles

| Role | Today | Roadmap |
|---|---|---|
| Agent | x402 client (any SDK) | Same |
| Facilitator | Next.js app, single host | Multiple hosts running same code |
| Postman | Single key (`0xcDB447...`) | 3-of-5 threshold (scaffolded) |
| ASP curator | Single off-chain risk pipeline | Diverse 5-signer panel (scaffolded) |
| Pool | Base mainnet single-value 0xbow PrivacyPool (live) | Wider anonymity set as it fills |
| Provider | EOA today | ERC-5564 meta-address after onboarding |

## The Base (EVM) stack

| Layer | Base |
|---|---|
| Contract runtime | Solidity |
| Proof verifier | Solidity Groth16 verifier |
| Indexing | HyperRPC + events |
| Settlement command | `relay()` |

The facilitator API (`/api/facilitator/supported`, `/verify`, `/settle`) is the stable
surface, live on Base mainnet.

## End-to-end settlement sequence

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent
  participant M as Paid API
  participant F as zBase Facilitator
  participant P as Pool (Base Sepolia)
  participant S as Stealth address
  A->>M: GET /paid-endpoint
  M-->>A: 402 + paymentDetails(payTo=metaAddress, amount)
  A->>F: POST /verify (zbaseDeposit, paymentDetails)
  F-->>A: { valid:true, anonymitySet }
  A->>F: POST /settle (zbaseDeposit, paymentDetails)
  F->>F: derive stealth address
  F->>F: generate Groth16 proof
  F->>P: relay(proof, publicSignals)
  P->>P: verify proof + nullifier + ASPRoot
  P->>S: transfer USDC to stealth address
  P->>P: insert change commitment in tree
  F-->>A: { txHash, nextDeposit }
  A->>M: retry with X-Zx402-Settlement: txHash
  M-->>A: 200 + data
```

## Privacy boundaries summary

| Adversary | Defeated by | Layer |
|---|---|---|
| Direct payer→provider edge in single tx | Pool intermediary | Already live |
| FIFO timing correlation | Decoys + delay | Verified in dry-run |
| Facilitator-log IP/UA leak | Middleware | Live |
| Provider-side recipient correlation | Stealth | SDK + registry live |
| Single-postman censorship | 3-of-5 ASP | Scaffold — pre-signers |
| Day-1 thin pool | Seed | Plan validated |

For the audit-grade trust + threat tables read [Trust model](trust-model.md)
and [Threat model](threat-model.md).

Next → [The cryptographic core](cryptographic-core.md)
