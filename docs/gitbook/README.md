# Introduction

**In one sentence:** when your AI agent pays for an API, zBase hides the link between your
wallet and that payment — while the seller still gets paid exactly as normal.

!!! tip "Get an agent paying in 2 minutes"
    **Agents — paste this and it does the rest** (routes itself to MCP or the CLI, sets up a wallet,
    funds it, and pays):

    ```text
    Fetch https://zbase.app/SKILL.md and follow the setup instructions
    ```

    Setting it up yourself? Install the wallet as an MCP: `claude mcp add zbase -- npx -y @zbase-protocol/mcp@latest`,
    then **create a new wallet or import yours** — see [Install zBase](install-mcp.md). Prefer code?
    `npm install @zbase-protocol/core`.

Today, every paid API call an agent makes is a public receipt on the blockchain: anyone can
see *your wallet paid this API this much, at this time*, forever. Over hundreds of small calls
that becomes a full, public spending profile. zBase removes that link. You deposit USDC once
into a shared privacy pool; after that, each payment is funded through a fresh, single-use
wallet, so the on-chain record never names you. The seller receives a completely standard
payment and delivers as usual — it can't even tell zBase was involved. New here?
[**How zBase compares to the alternatives**](how-zbase-compares.md).

Under the hood: zBase is a private settlement layer for x402 payments on Base. You deposit USDC
into a privacy pool, prove ownership with a Groth16 zero-knowledge proof, and settle paid API
calls from the pool — so the provider-payment transaction does not directly name your wallet.
Base is the active launch path.

This GitBook is the source of truth for setup, integration, architecture, and the
security disclosure surface. The sidebar is ordered task-first — do something before you
read the theory:

1. **Start here** — what zBase is, and pay privately in 5 minutes (mainnet).
2. **Integrate (SDK & MCP)** — `@zbase-protocol/core`, stealth, Merkle proofs, backend API.
3. **Run it yourself** — prereqs, install, config, local run + Sepolia/mainnet deploys.
4. **Under the hood** — why a facilitator, the two gates, cryptographic core, contracts, circuits.
5. **Security & Project** — trust + threat models, ceremony, roadmap, FAQ.

## Where to start

| Goal | Read |
|---|---|
| **Pay a real x402 API privately (mainnet)** | [**Pay privately in 5 minutes**](pay-privately-quickstart.md) |
| **How is this different from CDP / mixers / others?** | [**How zBase compares**](how-zbase-compares.md) |
| Understand why zBase is an app, not an L3 | [Why a facilitator on Base](why-base-facilitator.md) |
| Why both ASP *and* stealth | [The two gates](two-gates.md) |
| The architecture picture | [System architecture](system-architecture.md) |
| Integrate an agent or service | [SDK overview](sdk-overview.md) |
| Evaluate trust before testing | [Trust model](trust-model.md) |
| See attack-to-defense map | [Threat model](threat-model.md) |
| Check what just shipped | [CHANGELOG.md](../../CHANGELOG.md) — canonical release history + current state |

## Status snapshot

**Base mainnet: live (open pilot).** Private x402 payments work end-to-end on Base
mainnet today — deposit gaslessly, settle from the pool via a Groth16 ZK withdrawal, and
the seller delivers (HTTP 200). Proven against real Coinbase-CDP sellers: **BlockRun**
($0.028), **Nansen** ($0.01), and **MetaLend** ($0.001). Walk the whole thing in the
[$0.001 payment walkthrough](proven-private-pay-full-flow.md).

Open pilot means the anonymity set is still filling toward its **30-depositor** privacy
floor — payments settle and deliver, but aren't yet crowd-anonymous
(`result.privacy.private` tells you on every payment). The 30-depositor floor is *necessary,
not sufficient*: even past it, a unique amount or the timing of a withdrawal can narrow the
effective set. `result.privacy.private` reflects the on-chain payer→provider unlinkability —
see the [Threat model](threat-model.md) for what still leaks.

| Area | Status |
|---|---|
| **Base mainnet private x402** (deposit → ZK withdrawal → private pay) | **Live — open pilot** |
| Proven mainnet sellers (BlockRun, Nansen, MetaLend) | Delivered `200` + data |
| Gasless deposit + settlement (facilitator-sponsored) | Live |
| Exact-amount payment + seed-recoverable change notes | Live |
| Idempotent settlement (no double-pay on a lost response) | Live |
| `@zbase-protocol/core` SDK | Published on npm |
| `/api/health` + `/api/facilitator/supported` | Live |
| Anonymity set | Open pilot — filling toward the 30-depositor floor |
| Base Sepolia (testnet, for development only) | Available |

**Performance** (measured on a fresh setup): ZK proof generation ~0.7s; warm payment
~7–15s; cold payment ~21s (dominated by fetching pool state, not proving).

## Claim discipline

zBase is not described as completely anonymous. The current claim is that it removes the
direct on-chain settlement edge between the payer wallet and the provider wallet, proven on
**Base mainnet** — and that during the open pilot the anonymity set is still thin, so a
payment is unlinkable but not yet crowd-anonymous. See [Trust model](trust-model.md) for
what is defeated and what is not.

Next → [Why a facilitator on Base](why-base-facilitator.md)
