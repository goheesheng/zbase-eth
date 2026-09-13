# zBase Architecture — Base (EVM)

> This document covers the **Base Sepolia** deployment. zBase is multi-chain — for the
> Solana V1 deployment (Anchor program, on-chain Groth16 via Light Protocol, Kamino yield),
> see **[ARCHITECTURE_SOLANA.md](./ARCHITECTURE_SOLANA.md)**.

## The Problem

Every on-chain payment creates a permanent public record:

```
Sender Wallet --> $50 USDC --> Recipient Wallet
   0xABC                         0xDEF

Anyone can see: who paid, who received, how much, when
```

AI agents are now making millions of x402 payments per month, all of them public.
Competitors can map an agent's full spending history. Adversaries can profile an
agent's research queries. zBase focuses on the missing agent-payment primitive:
private x402 settlement on Base without exposing the payer-to-provider edge.

## The Solution

zBase breaks the link between sender and recipient using a shielded pool plus a
Groth16 zero-knowledge proof. The pool is built on Vitalik Buterin's Privacy Pools
design (Apache 2.0, audited reference implementation by 0xbow, EF-endorsed
cryptography) — adapted to Base + Solana with x402 facilitator + agent identity
layers added as new code.

```
DEPOSIT (public --> private):
  Your Wallet --> USDC --> Privacy Pool (plain 0xbow pool; deposits sit idle, no yield)

WITHDRAW (private --> public):
  Privacy Pool --> ZK Proof (Groth16) --> Fresh Address gets USDC
  Your wallet is not the sender in the withdrawal transaction
```

Privacy improves as the approved pool set grows. The current claim is narrower
than complete anonymity: the provider payment is made from the pool, so the
settlement transaction does not directly reveal which payer wallet funded it.
The live Base Sepolia pool is a plain 0xbow Privacy Pool with no yield. A
Morpho-backed variant exists on disk but was never deployed (see
[Morpho Yield Integration](#morpho-yield-integration) below).

## How zBase Differs from Competitors

Read this table top-to-bottom: each row is a capability, each column is a
project. zBase's column is a stack of green checks; every competitor has at
least one — usually most — of these missing.

| Capability             | **zBase**                | Tornado Cash             | Railgun                  | 0xbow Privacy Pools      | Hinkal                   | Aztec                    |
| ---------------------- | ------------------------ | ------------------------ | ------------------------ | ------------------------ | ------------------------ | ------------------------ |
| Chain                  | ✅ Base + Solana         | Ethereum                 | ETH/Polygon/Arb/BSC      | Ethereum mainnet         | EVM                      | Aztec L2                 |
| Open source            | ✅ Apache 2.0            | ✅ Yes                   | ✅ Yes                   | ✅ Apache 2.0            | ❌ Closed                | ✅ Yes                   |
| Compliant by design    | ✅ ASP (Vitalik design)  | ❌ none — sanctioned     | ⚠ Partial (private screen) | ✅ ASP                   | ✅ enterprise compliance | ⚠ Partial                |
| x402 facilitator       | ✅ Base Sepolia          | ❌                       | ❌                       | ❌                       | ❌                       | ❌                       |
| Yield on idle deposits | ❌ (none on live pool)    | ❌                       | ❌                       | ❌                       | ❌                       | ❌                       |

The shorter version: **Tornado** got sanctioned because it had no compliance layer —
zBase has one built in (the Association Set Provider blocks illicit funds before they
can withdraw privately). **Railgun and Aztec** focus on private DeFi but don't speak
x402, so AI agent payments leak. **0xbow's reference implementation** doesn't run on Base and doesn't
have a facilitator — zBase adds both. **Hinkal** is
closed source, which is a non-starter for privacy infrastructure where users need to
audit what they're trusting.

The single sentence: zBase combines compliant ZK privacy, x402 agent payments,
and open source testnet infrastructure on Base.

## Overview

zBase is a privacy-preserving x402 facilitator on Base that combines ZK proofs
and compliant privacy. It lets AI agents and users make payments
without exposing a direct payer-to-provider settlement edge. (The live pool holds
no yield; the Morpho integration below is an on-disk variant that was never deployed.)

```
┌─────────────────────────────────────────────────────────────┐
│                         AI Agent / User                     │
│       (RainbowKit, MetaMask, or any wagmi-compatible wallet)│
└──────────────────────────┬──────────────────────────────────┘
                           │  HTTPS x402
                ┌──────────▼──────────┐
                │  zBase Facilitator  │   Next.js App Router
                │  (API routes)       │
                └──────────┬──────────┘
              ┌────────────┼────────────┐
              │ snarkjs    │ relay      │
              │ Groth16    │ submit_tx  │
              ▼            ▼            ▼
        proof.json    ┌────────────────────────┐
                      │  Solidity Contracts    │   Base
                      │  Entrypoint 0x598f…    │   ~250K gas verify
                      ├────────────────────────┤
                      │  deposit               │
                      │  relay (withdrawal) ◀──┼──── proof
                      │  updateRoot (ASP)      │
                      │  registerAgent         │
                      │  supplyToMorpho        │
                      │  redeemFromMorpho      │
                      └──────────┬─────────────┘
                                 │
                                 ▼
                       ┌─────────────────┐
                       │  Morpho Blue    │
                       │  (USDC market)  │
                       └─────────────────┘
```

**Entrypoint (proxy, Base Sepolia):** `0x598ffaac79ae29b1aae571fd91899d4492183688`

## How Privacy Works

### The Problem

Every on-chain payment creates a permanent public record:

```
Sender Wallet → Amount → Recipient Wallet
   0xABC     →  $50   →    0xDEF

Anyone can see: who paid, who received, how much, when
```

### The Solution: Shielded Pool + ZK Proofs

```
DEPOSIT (public → private):
  User Wallet → USDC → Entrypoint → Privacy Pool → Morpho (yield)
  
  On-chain: "User deposited to pool" (one of many depositors)
  Pool stores: Poseidon commitment = hash(value, label, hash(nullifier, secret))
  User saves: nullifier + secret (needed to withdraw later)

WITHDRAW (private → public):
  Server generates Groth16 ZK proof:
    "I know a valid (nullifier, secret) whose commitment is in the Merkle tree"
  
  The proof reveals NOTHING about which deposit it corresponds to.
  
  Relay submits proof → Entrypoint → Pool verifies → USDC sent to recipient
  
  On-chain: "Pool paid recipient" (no link to any specific depositor)
```

### Why the Relay?

If you submitted the withdrawal transaction yourself, your wallet address would appear as `msg.sender`, linking you to the withdrawal. The relay solves this:

```
Without relay:  Your Wallet → withdraw() → your address on-chain → PRIVACY BROKEN
With relay:     Server → relay() → Entrypoint → withdraw() → recipient gets USDC
                Your wallet is absent from the provider-payment transaction
```

### The ZK Proof

The Groth16 proof simultaneously proves:
1. "I have a valid deposit" — commitment exists in the state Merkle tree
2. "I'm in the approved set" — label is in the ASP tree (compliance)
3. "I'm not double-spending" — nullifier hasn't been used before
4. "The withdrawal context is correct" — binds proof to specific recipient

It does NOT reveal: which deposit, when deposited, depositor's address.

### The ASP (Association Set Provider)

The ASP is a compliance layer. It maintains a Merkle tree of "approved" deposit labels. To withdraw privately, your deposit must be in the ASP set. This prevents illicit funds from being withdrawn privately.

```
Deposit → label added to ASP tree → POSTMAN calls updateRoot()
Withdrawal → proof must show label is in ASP tree → blocks non-approved deposits
```

This is what separates zBase from Tornado Cash. Tornado had no compliance layer and was sanctioned. zBase (via 0xbow's Privacy Pools research, co-authored by Vitalik Buterin) includes compliance by design.

## Morpho Yield Integration

> **Not deployed.** This describes the on-disk `PrivacyPoolMorpho.sol` variant.
> The live Base Sepolia pool is a plain 0xbow Privacy Pool with no Morpho
> integration and no yield — it reverts on every Morpho/yield getter. This
> variant was never deployed and is not on the roadmap.

```
NORMAL PRIVACY POOL:
  User deposits $100 → sits idle → withdraws $100 later

ZBASE PRIVACY POOL (with Morpho):
  User deposits $100 → Pool supplies to Morpho Blue → earns yield
  User withdraws → gets $100 + proportional yield bonus
  
  Pool contract overrides:
    _pull(): receive USDC → approve Morpho → supply to lending market
    _push(): withdraw from Morpho → send USDC + yield to recipient
```

The ZK circuit doesn't care where the money is held. It only validates commitments. So Morpho integration doesn't break any proofs.

## x402 Facilitator

zBase implements the standard x402 facilitator protocol with a privacy extension:

```
Standard x402:
  Client → 402 Payment Required → sign USDC transfer → pay provider (PUBLIC)

zBase x402:
  Client → 402 Payment Required → provide deposit secrets →
  zBase generates ZK proof → pays provider from pool (PRIVATE)
```

### Facilitator Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/facilitator/supported` | GET | Discovery: networks, privacy, yield capabilities |
| `/api/facilitator/verify` | POST | Validate ZK-ready deposit exists |
| `/api/facilitator/settle` | POST | Generate ZK proof + relay private payment |

Any x402 client can use zBase by pointing their facilitator URL to these endpoints.

## Event Indexing (HyperSync)

The withdrawal flow needs the full history of deposits to rebuild the Merkle tree and generate proofs. zBase uses Envio's HyperRPC (powered by HyperSync) for this:

```
OLD APPROACH (RPC):
  Query eth_getLogs in 10K block chunks → multiple calls → rate limits → slow

HYPERSYNC APPROACH:
  Single query from deploy block to latest → all events instantly → no limits
```

HyperRPC is a standard JSON-RPC endpoint that supports unlimited `eth_getLogs` ranges. The withdraw API uses it for log queries and falls back to Infura for `eth_call` (which HyperRPC doesn't support).

## Contract Architecture

### Entrypoint (Proxy)

The central router. Handles deposits, relayed withdrawals, ASP root updates, and pool registration.

- `deposit(asset, amount, precommitment)` — ERC20 deposit
- `deposit(precommitment)` — ETH deposit (payable)
- `relay(withdrawal, proof, scope)` — submit ZK withdrawal proof
- `updateRoot(root, ipfsCID)` — update ASP root (POSTMAN only)
- `registerPool(asset, pool, minDeposit, vettingFee, maxRelayFee)` — register a new pool

### PrivacyPoolMorpho

Extended privacy pool that supplies idle USDC to Morpho Blue.

- Built on `PrivacyPool` (0xbow's audited reference contract)
- `_pull()`: receives USDC → supplies to Morpho
- `_push()`: withdraws from Morpho → sends USDC + yield bonus
- `getYieldEarned()`: total yield accrued
- `totalCommitted`: tracks sum of active deposits

### Groth16 Verifiers

Auto-generated Solidity contracts from the ZK circuit trusted setup:

- `WithdrawalVerifier`: verifies withdrawal proofs (8 public signals)
- `CommitmentVerifier`: verifies commitment proofs for ragequit (4 public signals)

### State Management

- **State Merkle Tree**: LeanIMT (Lean Incremental Merkle Tree) with Poseidon hash. Stores all commitments (deposits + withdrawal change commitments).
- **Root History**: Circular buffer of last 30 roots. Allows proofs generated against recent (not just current) state.
- **Nullifier Set**: Tracks spent nullifiers to prevent double-withdrawals.
- **ASP Roots**: Array of Association Set roots with IPFS CIDs and timestamps.

## Data Flow

### x402 agent flow (six-step end-to-end)

The full six-step flow an AI agent walks through when paying a paid x402 endpoint
privately on Base. Same shape as the Solana flow in
[`ARCHITECTURE_SOLANA.md`](./ARCHITECTURE_SOLANA.md) — chain-specific differences are
the verifier (Solidity vs Anchor), the settlement instruction (`relay()` vs
`relay_withdrawal`), and the yield protocol (Morpho vs Kamino).

```
[Agent]                                [zBase API routes]                       [Base Sepolia]
   │                                            │                                       │
   │ 1. GET /api/facilitator/supported          │                                       │
   │ ──────────────────────────────────────────▶│                                       │
   │ ◀──────────────────────────── { chain, fee }│                                      │
   │                                            │                                       │
   │ 2. POST /api/zbase/privacy-check           │                                       │
   │ ──────────────────────────────────────────▶│                                       │
   │ ◀──────────────────────────── HTTP 402 + price                                     │
   │                                            │                                       │
   │ 3. (load local deposit secrets)            │                                       │
   │                                            │                                       │
   │ 4. POST /api/withdraw                      │                                       │
   │    { nullifier, secret, value, label,      │                                       │
   │      commitment, recipient }               │                                       │
   │ ──────────────────────────────────────────▶│                                       │
   │                                            │ build state + ASP Merkle proofs       │
   │                                            │ generate Groth16 proof (snarkjs)      │
   │                                            │ submit relay() ──────────────────────▶│
   │                                            │                                       │ verify proof
   │                                            │                                       │ pool → recipient
   │                                            │                                       │ redeem Morpho yield
   │                                            │ ◀────────────────── txHash, confirmed │
   │ ◀────────────────────── { txHash, fromPool }│                                      │
   │                                            │                                       │
   │ 5. POST /api/zbase/privacy-check           │                                       │
   │    X-ZBase-Settlement: txHash              │                                       │
   │ ──────────────────────────────────────────▶│                                       │
   │                                            │ cache.has(txHash) → true              │
   │ ◀────────────────────── 200 OK + real data │                                       │
   │                                            │                                       │
   │ 6. inspect on-chain: recipient sees pool   │                                       │
   │    address, NOT agent's wallet ✅          │                                       │
```

If all six steps print green, the thesis is proven end-to-end.

### Complete deposit → withdraw (without the agent loop)

```
1. USER DEPOSITS
   Browser → generateDepositSecrets() → {nullifier, secret, precommitment}
   Browser → approve USDC → call deposit(USDC, amount, precommitment)
   Entrypoint → deducts 1% fee → calls pool.deposit()
   Pool → computes label = keccak256(SCOPE, nonce) % SNARK_FIELD
   Pool → computes commitment = Poseidon(value, label, precommitment)
   Pool → inserts commitment into Merkle tree
   Pool → supplies USDC to Morpho Blue
   Pool → emits Deposited(depositor, commitment, label, value, precommitment)
   Browser → parses event → saves {nullifier, secret, label, value, commitment} to localStorage

2. ASP UPDATE (automatic)
   Frontend → calls /api/asp-update
   API → fetches all Deposited events via HyperRPC
   API → builds Poseidon Merkle tree from all labels
   API → compares with on-chain latestRoot()
   API → if different: calls updateRoot(newRoot, ipfsCID)

3. USER WITHDRAWS
   Browser → calls /api/withdraw with {nullifier, secret, value, label, commitment, recipient}
   API → fetches ALL Deposited events via HyperRPC
   API → fetches ALL LeafInserted events via HyperRPC
   API → builds state tree from LeafInserted leaves
   API → builds ASP tree from Deposited labels
   API → generates Merkle proofs (state + ASP) for the user's commitment
   API → computes context = keccak256(Withdrawal, scope) % SNARK_FIELD
   API → generates Groth16 withdrawal proof via snarkjs (WASM + trusted setup zkey)
   API → verifies proof locally
   API → submits relay(withdrawal, proof, scope) to Entrypoint via public RPC
   Entrypoint → calls pool.withdraw(withdrawal, proof)
   Pool → verifies ZK proof on-chain (Groth16 verifier)
   Pool → checks state root is known
   Pool → checks ASP root is latest
   Pool → checks context matches
   Pool → marks nullifier as spent
   Pool → inserts new commitment (change) into tree
   Pool → withdraws USDC from Morpho + yield bonus
   Pool → sends USDC to recipient
```

## File Structure

```
src/
├── app/
│   ├── page.tsx              — Frontend (Deposit/Withdraw/Pay Agent/Pool Stats)
│   ├── layout.tsx            — Next.js layout
│   ├── providers.tsx         — RainbowKit + wagmi providers
│   └── api/
│       ├── withdraw/route.ts — Server-side ZK proof generation + relay
│       ├── asp-update/route.ts — ASP root auto-updater
│       ├── x402-pay/route.ts — Private x402 payment proxy
│       └── facilitator/      — Standard x402 facilitator endpoints
│           ├── verify/route.ts
│           ├── settle/route.ts
│           └── supported/route.ts
├── lib/
│   ├── wagmi.ts              — Contract addresses + ABIs
│   ├── privacy.ts            — Poseidon commitments, Merkle trees, proof generation
│   ├── stealth.ts            — Stealth addresses (deprecated, kept for reference)
│   └── escrow.ts             — Old escrow (deprecated, pre-zBase)
├── types/
│   └── snarkjs.d.ts          — TypeScript declarations for snarkjs
public/
└── circuits/
    ├── withdraw/
    │   ├── withdraw.wasm     — ZK circuit (2.5MB)
    │   ├── groth16_pkey.zkey — Proving key from trusted setup (17MB)
    │   └── groth16_vkey.json — Verification key
    └── commitment/
        ├── commitment.wasm   — Commitment circuit
        └── groth16_pkey.zkey — Commitment proving key

sdk/
├── src/
│   ├── index.ts              — SDK exports
│   ├── zbase.ts              — Main SDK class (deposit, withdraw, pay, wrapFetch)
│   ├── account.ts            — Private account management
│   └── types.ts              — TypeScript types + Base Sepolia defaults
└── README.md                 — SDK documentation

zbase-protocol/                — 0xbow Privacy Pools reference implementation (Apache 2.0)
└── packages/
    ├── contracts/src/
    │   ├── contracts/
    │   │   ├── Entrypoint.sol
    │   │   ├── PrivacyPool.sol
    │   │   ├── State.sol
    │   │   └── implementations/
    │   │       ├── PrivacyPoolComplex.sol  — Standard ERC20 pool
    │   │       ├── PrivacyPoolMorpho.sol   — Yield pool (Morpho Blue)
    │   │       └── PrivacyPoolSimple.sol   — Native ETH pool
    │   └── verifiers/
    │       ├── WithdrawalVerifier.sol      — Auto-generated from circuit
    │       └── CommitmentVerifier.sol
    ├── circuits/              — Circom ZK circuits
    │   ├── circuits/
    │   │   ├── withdraw.circom
    │   │   ├── commitment.circom
    │   │   └── merkleTree.circom
    │   └── trusted-setup/final-keys/      — Ceremony keys (MUST match verifiers)
    ├── sdk/                   — 0xbow's TypeScript SDK
    └── relayer/               — Relayer service
```

## Deployed Contracts (Base Sepolia)

> Live pool is a PLAIN 0xbow PrivacyPool — NO yield, NO Morpho (verified on-chain;
> the contract reverts on every Morpho getter). Yield is something we're exploring,
> not deployed. The diagrams/data-flow below that mention "supplies to Morpho"
> describe the on-disk `PrivacyPoolMorpho.sol` variant, which was never deployed.

| Contract | Address | Role |
|---|---|---|
| Entrypoint (proxy) | `0x598ffaac79ae29b1aae571fd91899d4492183688` | Central router |
| USDC Privacy Pool (plain 0xbow, no yield) | `0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a` | Privacy (deposits held idle) |
| Withdrawal Verifier | `0x5f5505242730dfc8a2c2637eb5258dc2c6622641` | ZK proof check |
| Commitment Verifier | `0x293400accdeb0c1c2d419868303a8e96c09900ab` | Ragequit proof |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Base Sepolia USDC |

## Security Model

| Threat | Mitigation |
|---|---|
| Double-spend | Nullifier set prevents reuse |
| Illicit funds | ASP blocks non-approved deposits |
| Front-running | ZK proof is bound to specific context (recipient + scope) |
| Relayer censorship | Ragequit allows direct withdrawal (no relay needed) |
| State root staleness | Pool stores last 30 roots in circular buffer |
| Key compromise (POSTMAN) | Can post fake ASP roots but CANNOT steal funds (ZK proof still required) |

## Differences from the Solana deployment

If you've read [`ARCHITECTURE_SOLANA.md`](./ARCHITECTURE_SOLANA.md), here's the
parts-list delta. The facilitator API surface (`/api/facilitator/*`) is identical
between the two — that's what lets the SDK work multi-chain. Same protocol, two
backends.

| Layer                 | Base (this doc, EVM)                          | Solana (SVM)                                 |
| --------------------- | --------------------------------------------- | -------------------------------------------- |
| Smart contract        | Solidity, EntrypointSimple proxy + Morpho pool | Anchor program (single program, all logic)   |
| Groth16 verifier      | Solidity verifier contract (~250K gas)        | `groth16-solana` (~148K compute units)       |
| Poseidon hasher       | Custom Solidity                               | `light-poseidon` (BN254)                     |
| Merkle tree           | `lean-imt.sol`                                | LeanIMT in Rust (same scheme)                |
| Yield protocol        | none (not deployed — Morpho variant on disk)  | none (not deployed — Kamino variant planned) |
| Indexer               | HyperSync (Envio)                             | Solana RPC `getProgramAccounts`              |
| Wallet                | wagmi / RainbowKit                            | `@solana/wallet-adapter`                     |
| Native fees           | ETH                                           | SOL                                          |
| User-facing UI today  | Deposit + Withdraw tabs (live)                | CLI-driven (`npm run test:svm-x402-agent`)   |

## References

- [Vitalik's Privacy Pools paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4563364)
- [0xbow Privacy Pools](https://github.com/0xbow-io/privacy-pools-core)
- [Morpho Blue](https://morpho.org/)
- [x402 Protocol](https://www.x402.org/)
- [Groth16 ZK-SNARKs](https://eprint.iacr.org/2016/260)
- [LeanIMT (Merkle Tree)](https://github.com/privacy-scaling-explorations/zk-kit)
- [Envio HyperSync](https://docs.envio.dev/docs/HyperSync/overview)
- This repo's preflight + reconciliation notes: [`../CLAUDE.md`](../CLAUDE.md)
