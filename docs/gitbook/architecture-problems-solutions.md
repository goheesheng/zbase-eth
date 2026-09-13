# Architecture Problems and Solutions

Last updated: **2026-07-21**

This page translates the architecture docs into the problems a tester,
integrator, or reviewer should understand before using zBase. `STATUS.md` is
the source of truth for release state if any public copy conflicts.

## Current Scope

| Area | Current state |
|---|---|
| **Base mainnet private x402** | **Live — open pilot** (proven against BlockRun, Nansen, MetaLend) |
| Anonymity set | Filling toward the 30-depositor privacy floor |
| Base Sepolia | Available for development |
| ASP/postman decentralization | Roadmap (single-key today) |

## Problem 1: x402 Creates a Public Counterparty Graph

Standard x402 settlement is useful because an API can return `HTTP 402 Payment
Required`, then the agent pays and retries. The privacy problem is that vanilla
settlement usually leaves a direct on-chain edge:

```text
payer wallet -> provider wallet -> amount -> timestamp
```

For an AI agent, that edge can reveal which model, data, search, or inference
provider it uses and how often it pays them.

### zBase Solution

zBase separates funding from settlement:

```text
payer wallet -> privacy pool
privacy pool -> provider wallet
```

The agent proves it owns an approved note in the pool with a Groth16 proof. The
provider receives payment from the pool, so the provider-payment transaction
does not directly reveal the payer wallet.

### Boundary

This is not complete anonymity. Timing, amount, endpoint metadata, application
logs, and small anonymity sets can still leak information. The current claim is
that zBase removes the direct payer-to-provider settlement edge, proven on Base
mainnet.

## Problem 2: Agent Payments Are Repeated, Not One-Off

An agent can make many small API payments in a row. A privacy pool that spends a
whole note for every payment is awkward for agents because each payment would
require a fresh deposit or manual note management.

### zBase Solution

Base mainnet (and Base Sepolia) support exact-amount settlement:

```text
funded note value: 1.0098 USDC
invoice amount:   0.5000 USDC
remaining note:   0.5098 USDC
```

When value remains, settlement returns `nextDeposit`. Agents must save that
`nextDeposit` immediately and use it for the next payment. The original note is
spent and cannot be reused.

### Boundary

This is testnet note management. Production needs encrypted note storage,
recovery UX, and safer agent custody before users should rely on it with real
funds.

## Problem 3: Compliance Screening Cannot Block Every Micro-Payment

If every agent payment required a fresh external compliance screen, ASP checks
would add latency to the hot path and make private x402 unattractive for
high-frequency agents.

### zBase Solution

The ASP model screens at the label-set level. A deposit label enters the
approved set, the postman publishes an ASP root, and later withdrawals prove
membership in that approved set. A payment does not need to ask the ASP to run a
new external screen on every API call; it proves that the note belongs to the
current approved set.

```text
deposit label -> ASP approved set -> ASP root
payment proof -> "my note is in this approved root"
```

### Boundary

The ASP curator is centralized today. The postman/ASP can affect which labels
are eligible for private withdrawal. On the verified path, proof constraints
bind the recipient, so the postman cannot redirect a valid withdrawal to a
different recipient, but ASP governance is still a production-hardening item.

## Problem 4: The Merkle Tree Must Include Change Commitments

Private change notes are inserted back into the pool. If the local state tree
only indexes deposits and misses `LeafInserted` change commitments, the next
proof is generated against the wrong state root and settlement fails.

### zBase Solution

The Base Sepolia withdrawal path reconstructs the state tree from all
`LeafInserted` events, not only deposit events. It also retries briefly after a
change commitment is inserted so a second immediate payment can survive
HyperRPC indexing lag.

### Boundary

The indexer is operational infrastructure, not cryptography. If RPC/indexer
state is stale or unavailable, proofs may fail even when the note is valid.
Testers should retry after a short delay before treating that as a protocol
failure.

## Problem 5: Relay Privacy Requires a Postman

If the payer submits the withdrawal directly, the payer wallet appears as the
transaction sender or fee payer. That defeats the purpose of private settlement.

### zBase Solution

The postman relays the withdrawal. The payer's wallet funds the note earlier;
the postman submits the withdrawal transaction later; the pool pays the
provider. The proof binds the withdrawal context, including the recipient, so a
valid withdrawal cannot be redirected without invalidating the proof.

### Boundary

The postman is centralized today. It can censor or delay relay service. The
production roadmap should move this role to multi-sig, threshold relayers, or a
competitive relay set.

## Problem 6: Anonymity Sets Need History

A privacy pool with few approved commitments gives weak privacy. Agents need a
large historical commitment set so one payment is not easy to correlate with one
deposit. Current TVL is a withdrawal-capacity metric; the privacy metric is the
approved commitment set.

### zBase Solution

The live Base Sepolia pool is a plain 0xbow PrivacyPool. The anonymity set
grows through real and seeded deposits. Historical
commitments remain in the Merkle tree even after withdrawals, so the set can
remain useful even when TVL changes.

The 2026-07-11 Base Sepolia reference run measured a cold full flow against the
live pool: deposit → ASP update → private withdrawal in ~37s, with the private
withdrawal itself at ~21s cold and earlier warm-path payments at ~7-15s.

### Boundary

Anonymity set size is dynamic. It can grow or shrink as deposits enter, notes
are spent, and ASP policy changes. Docs should report observed test values, not
promise a fixed privacy level.

## Problem 7: Testnet UX Can Leak Secrets

The current demos pass note secrets through local scripts, localStorage, or API
requests. That is acceptable for testnet verification, but it is not a final
wallet-grade custody model.

### zBase Solution

The testnet path keeps the note fields explicit so auditors and testers can
replay the flow:

- `nullifier`
- `secret`
- `value`
- `label`
- `commitment`
- optional `nextDeposit`

### Boundary

Production needs encrypted note storage, safer signing boundaries, and a
recovery model before real funds are supported.
