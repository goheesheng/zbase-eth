# @zbase-protocol/core

> Chain-agnostic ZK privacy primitives for x402 AI agent payments.

> **Agents:** read [`node_modules/@zbase-protocol/core/AGENTS.md`](./AGENTS.md) before implementing
> payments. It links the bundled `docs/` (esp. `docs/result-contract.md`) and runnable `examples/`.
> The one rule: `payAndFetch` returns a tri-state (`result.outcome`) and throws on a provably-unspent
> note — on `"uncertain"`, retry the SAME note (idempotent); never pay from a different note.

[![npm](https://img.shields.io/npm/v/@zbase-protocol/core.svg)](https://www.npmjs.com/package/@zbase-protocol/core)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

🟢 **Status: Base mainnet live** (2026-07-13). The hosted facilitator at
[zbase.app](https://zbase.app) serves **Base mainnet** (`eip155:8453`, real
USDC). Base Sepolia stays available for testing at
[testnet.zbase.app](https://testnet.zbase.app) (`eip155:84532`, testnet USDC).
The SDK is chain-agnostic — pass the CAIP-2 `network` to target either.

**Deployed Base mainnet contracts** (chainId 8453):

| Contract | Address |
|---|---|
| Entrypoint (proxy) | `0x275fAA86e2E316Abe46807453c1D95f101d36431` |
| PrivacyPool | `0x46753CED1E87871eA1aaF24Aed47DFA2D95855Dd` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Deploy block | `48571589` |

> ⚠️ **Early mainnet.** The contract is internally reviewed but **not yet
> externally audited**, and the anonymity set is small at launch — privacy
> strength grows with the number of deposits (see "Anonymity-set size is the
> privacy metric" below). Size your risk accordingly.

## Privacy model (honest)

Before you integrate, know exactly what this gives your users.

**Provides today (live on Base mainnet + Sepolia):**
- **Sender/receiver unlinkability.** The recipient address has no on-chain link to the depositor's wallet. The link is broken by a Groth16 proof of pool membership + a nullifier that marks the note spent.
- **Compliance-gated privacy.** Only deposits from clean addresses (ASP-approved subset) can withdraw. This is the Vitalik-Buterin-coauthored design, not Tornado Cash.

**Does NOT provide today:**
- **Amount hiding.** `_value` is emitted in plaintext on both `Deposited` and the withdrawal/settle event. Anyone watching the chain sees deposit amounts and withdrawal amounts — only the *link* between them is broken.
- **Timing-correlation defense.** The decoy scheduler (`scripts/decoy-scheduler.ts`) exists but is not running in prod. A single withdrawal in a quiet window is trivially attributable.
- **Amount-frequency-attack defense.** A `$99.99` deposit followed by a `$99.99` settle is correlatable.

**Roadmap (scaffolded, not deployed):**
- UTXO notes (`circuits/note_spend.circom`, `createNote` / `splitNote` / `mergeNotes` in this SDK) → true amount hiding. Needs trusted setup ceremony.
- Threshold-signed ASP (`ThresholdEntrypoint.sol`) → distributed compliance trust.
- Decoy scheduler in prod → defeats FIFO temporal de-anon.

**Anonymity-set size is the privacy metric, not TVL.** The set = the count of
commitments in the Merkle tree (it grows on every deposit, never shrinks on
withdrawal), so *low TVL* alone doesn't hurt your privacy. But *a small
commitment count does*: if few deposits have ever been made, there are few
positions to hide among. The **current Base mainnet pool is bootstrapping** —
`GET /api/health` reports `anonymitySet: 0` at the time of writing. Check it and
size your privacy expectation to the actual number; early deposits into a near-
empty pool have weak anonymity until deposits accumulate.

Full deep-dive: **[docs.zbase.app/threat-model/](https://docs.zbase.app/threat-model/)**.

zBase is built on Vitalik Buterin's [Privacy Pools research](https://github.com/0xbow-io/privacy-pools-core) (Apache 2.0, audited reference implementation by 0xbow). This package contains the chain-agnostic primitives shared across all chain implementations.

## Install

```bash
npm install @zbase-protocol/core
```

## Quickstart

```ts
import {
  generateDepositSecrets,
  computeCommitment,
  computeNullifierHash,
} from "@zbase-protocol/core";

// 1. Generate fresh nullifier + secret for a deposit
const secrets = generateDepositSecrets();

// 2. Compute the commitment hash (what goes on-chain)
//    value is atomic USDC (6 decimals): 1_000_000 = 1 USDC
const commitment = computeCommitment(
  1_000_000n,
  secrets.nullifier,
  secrets.secret
);

// 3. Settle a private payment via a trusted facilitator
const response = await fetch("https://zbase.app/api/facilitator/settle", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    paymentDetails: {
      scheme: "exact",
      networkId: "eip155:8453", // Base mainnet (use eip155:84532 + testnet.zbase.app for Sepolia)
      payTo: "0xProviderAddress",
      maxAmountRequired: "500000", // 0.5 USDC
    },
    zbaseDeposit: { ...secrets, value: "990000", label: "...", commitment: "..." },
  }),
});
```

### Using the typed client (recommended)

```ts
import { createFacilitatorClient, BASE_MAINNET } from "@zbase-protocol/core";

const zbase = createFacilitatorClient({
  baseUrl: "https://zbase.app",
  network: "eip155:8453", // Base mainnet
});

// Deposit config for the target network (USDC + entrypoint + pool + deploy block)
const cfg = zbase.getDepositConfig(); // === BASE_MAINNET
// cfg.entrypoint → approve USDC to this, then call its deposit(asset, amount, precommitment)

const prep = zbase.prepareDeposit(1_000_000n);         // 1 USDC; keep prep.secrets
// ...send the on-chain deposit() with prep.precommitment, read Deposited event for value+label...
const ok = await zbase.verifyPayment({ payTo, amountAtomic: "500000", deposit });
const res = await zbase.settlePrivately({ payTo, amountAtomic: "500000", deposit });
```

For a full end-to-end test (deposit → settle → withdraw), see [`scripts/integration-sdk-vs-facilitator.mjs`](https://github.com/goheesheng/zBase/blob/main/scripts/integration-sdk-vs-facilitator.mjs). Run it against `testnet.zbase.app` (Sepolia, free) before touching mainnet.

Security note: the current hosted facilitator generates proofs server-side, so
`settlePrivately()`/direct `/settle` calls send note spend secrets to the
configured `baseUrl`. Use HTTPS and only point at a deployment you operate or
trust. The exported client rejects insecure non-local HTTP URLs by default.

## What's exported

| Area | Symbols |
|---|---|
| **Account / secrets** | `generateDepositSecrets`, `computeCommitment`, `computePrecommitment`, `computeNullifierHash`, `computeLabel`, `feToBE32`, `SNARK_SCALAR_FIELD`, `createAccount`, `serializeAccount`, `deserializeAccount` |
| **ZK proofs** | `generateWithdrawalProof`, `verifyProofLocally` (Groth16 via snarkjs) |
| **Merkle tree** | `buildMerkleTree`, `generateMerkleProof`, `getTreeDepth` (LeanIMT) |
| **UTXO notes** (scaffold) | `createNote`, `commitmentOf`, `nullifierHashOf`, `splitNote`, `mergeNotes`, `planSpend`, `serializeNote`, `deserializeNote`, `generateViewingKey`, `encryptNote`, `decryptNote`, `scanNotes` |
| **ERC-5564 stealth** | `generateMetaAddress`, `parseMetaAddress`, `deriveStealthAddress`, `scanForPayments`, `computeStealthPrivateKey`, `STEALTH_SCHEME_ID` |
| **Privacy scanner** | `analyzeTransfers` |

Full TypeScript types exported alongside. 38 named exports total.

## Status of the hosted facilitator

- `https://zbase.app` → **Base mainnet** (`eip155:8453`, real USDC).
- `https://testnet.zbase.app` → **Base Sepolia** (`eip155:84532`, testnet USDC).

Check live status of either:

```bash
curl https://zbase.app/api/facilitator/supported          # mainnet
curl https://testnet.zbase.app/api/facilitator/supported  # sepolia
```

## How to test

Three paths, depending on persona:

- **Browser**: [testnet.zbase.app/test](https://testnet.zbase.app/test) — connect wallet, get Sepolia USDC, deposit + withdraw privately (free, no risk)
- **Agent (curl)**: pure HTTP, no SDK required. See [`/api/skill`](https://zbase.app/api/skill) for AI coding agents
- **SDK**: this package. See `scripts/integration-sdk-vs-facilitator.mjs` in the repo for a runnable smoke test

**Always dry-run on Sepolia (`testnet.zbase.app`, `eip155:84532`) before sending real USDC on mainnet.**

## Links

- 🌐 [zbase.app](https://zbase.app)
- 📖 [Documentation](https://docs.zbase.app)
- 🐙 [GitHub](https://github.com/goheesheng/zBase)
- 🐦 [@zbase__](https://twitter.com/zbase__)
- 🐰 Companion: `@zbase-protocol/svm` (Solana) — repo-local and paused for Base mainnet launch
- 🤖 Companion: `@zbase-protocol/mcp` (Claude Desktop / Cursor) — repo-local until published

## License

Apache 2.0. Built on Vitalik Buterin's [Privacy Pools research](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4563364) and the [0xbow reference implementation](https://github.com/0xbow-io/privacy-pools-core).
