# zBase — Privacy Infrastructure for Base

## What is zBase?

zBase is a ZK privacy pool on Base with an x402 facilitator for AI agent payments. It lets agents and users deposit USDC and pay or withdraw privately using zero-knowledge proofs. Nobody on-chain can link the payer to the payment. (The live Base Sepolia pool is a plain 0xbow Privacy Pool — there is no yield. A Morpho-backed yield variant exists on disk but was never deployed.)

---

## The Problem

### 1. Every agent payment on Base is public

AI agents make payments using the x402 protocol. When an agent pays Anthropic for inference or Perplexity for search, the entire transaction is visible on-chain:

```
WHAT EVERYONE CAN SEE:

  Agent Wallet 0xABC  ──── $1.00 USDC ────▶  Anthropic 0xDEF

  ✗ WHO paid (agent's wallet address)
  ✗ WHAT service was purchased (Anthropic inference)
  ✗ HOW MUCH was paid ($1.00)
  ✗ WHEN it was paid (block timestamp)
  ✗ The agent's ENTIRE transaction history
```

This means:
- Competitors can reverse-engineer your AI strategy by watching your agent's payments
- Adversaries can see your research queries and tool usage
- Your spending patterns are permanently recorded on a public ledger

**Scale:** 2.25 million x402 transactions last month. $49.5 million in volume. 118,752 buyers. All public. (Source: agentic.market)

### 2. Zero privacy infrastructure on Base

233,659 ETH is shielded across privacy protocols globally, but none of them are on Base:

| Protocol | Chain | On Base? | Issue |
|---|---|---|---|
| Railgun | ETH, Polygon, Arbitrum, BSC | No | Not deployed on Base |
| Tornado Cash | ETH | No | Sanctioned by US Treasury |
| Privacy Pools (0xbow) | ETH mainnet | No | Only on Ethereum |
| Hinkal | Base | Partially | Closed source, enterprise-only |
| Zcash | Own chain | No | Separate blockchain entirely |
| **zBase** | **Base** | **Yes** | **First ZK privacy pool on Base** |

Base is the biggest L2 with the most AI agent activity. Jesse Pollak (Base creator) has publicly stated "privacy is a fundamental human right" and "privacy must be a core part of the global onchain economy." But nobody has built it on his chain. Until zBase.

### 3. Agents lack core infrastructure (a16z, April 2026)

a16z published "The missing infrastructure for AI agents: 5 ways blockchains can help":

> "There is still no broadly adopted, interoperable way for one agent to prove to another who it represents, what it's allowed to do, and how it gets paid."

Three gaps:
- **Identity:** Agents can't prove who they represent
- **Permissions:** Agents can't prove what they're allowed to do
- **Payments:** No standard for how agents get paid (privately)

---

## The Solution

zBase is three layers in one protocol:

```
┌────────────────────────────────────────────────────────────────┐
│                        zBase Protocol                          │
├───────────────────┬───────────────────┬────────────────────────┤
│                   │                   │                        │
│  LAYER 1          │  LAYER 2          │  LAYER 3               │
│  ZK Privacy Pool  │  Yield (NOT       │  x402 Facilitator      │
│                   │  deployed)        │  + Agent Registry      │
│  The core         │  On-disk variant, │  The                   │
│                   │  never shipped    │  distribution          │
│                   │                   │                        │
├───────────────────┼───────────────────┼────────────────────────┤
│                   │                   │                        │
│  Groth16 ZK       │  Live pool is a   │  Any x402 agent gets   │
│  proofs           │  plain 0xbow      │  privacy by changing   │
│                   │  Privacy Pool —   │  one URL               │
│  Vitalik's        │  NO yield. A      │                        │
│  Privacy Pools    │  Morpho variant   │  Agent identity with   │
│  (compliant)      │  exists on disk   │  spend limits and      │
│                   │  but was never    │  provider whitelists   │
│  Association Set  │  deployed and is  │                        │
│  Provider blocks  │  not on the       │  SDK, OpenClaw skill,  │
│  illicit funds    │  roadmap.         │  one-command install   │
│                   │                   │                        │
└───────────────────┴───────────────────┴────────────────────────┘
```

### Layer 1: ZK Privacy Pool (the core)

The privacy pool is a fork of 0xbow Privacy Pools (Apache 2.0, audited, Vitalik Buterin co-authored the research paper, Ethereum Foundation endorsed).

How it works:

```
DEPOSIT (public to private):
  Your Wallet ──▶ USDC ──▶ Privacy Pool
  
  The pool computes a Poseidon hash commitment and inserts it
  into a Merkle tree. Your deposit secrets (nullifier + secret)
  are saved locally. These are the keys to withdraw later.

WITHDRAW (private to public):
  Server generates a Groth16 ZK proof that simultaneously proves:
    1. "I own a valid deposit" (commitment exists in the Merkle tree)
    2. "I'm in the approved set" (ASP compliance check)
    3. "I'm not double-spending" (nullifier hasn't been used)
    4. "The withdrawal context is correct" (bound to specific recipient)

  The proof reveals NOTHING about which deposit it corresponds to.

  A relay submits the proof on-chain. Your wallet never appears
  as msg.sender. The pool verifies the proof and sends USDC
  to the recipient.
  
  On-chain: "Pool paid 0xRecipient"
  NOT on-chain: any link to your deposit wallet
```

With 30+ depositors in the pool, nobody can determine which deposit funded which withdrawal.

### Layer 2: Yield (NOT deployed)

The live Base Sepolia pool is a plain 0xbow Privacy Pool — deposits sit idle and
there is **no yield**.

```
LIVE ZBASE PRIVACY POOL (Base Sepolia, today):
  Deposit $100 ──▶ sits in the pool ──▶ withdraw $100 later (no yield)
```

A Morpho-backed yield variant (`PrivacyPoolMorpho.sol`, which overrides `_pull()`
and `_push()` to supply/redeem from Morpho Blue) exists in the repo but **was
never deployed** and is **not on the roadmap**. The deployed pool reverts on
every Morpho/yield getter. Treat any "earns yield" framing elsewhere as
describing that unshipped variant, not the live pool.

### Layer 3: x402 Facilitator + Agent Registry (the distribution)

This is how agents use the privacy pool. The facilitator is an API wrapper around the privacy pool that speaks the standard x402 protocol, so any x402 agent can use it without custom code.

**Standard x402 vs zBase x402:**

```
┌────────────────────────────────────────────────────────────────┐
│  STANDARD x402 (Coinbase CDP facilitator)                      │
│                                                                │
│  Agent signs USDC transfer                                     │
│       ──▶ CDP verifies signature                               │
│       ──▶ CDP submits transfer on-chain                        │
│       ──▶ Provider gets USDC                                   │
│                                                                │
│  Result: PUBLIC. Agent wallet visible in the transaction.      │
├────────────────────────────────────────────────────────────────┤
│  zBase x402 (privacy facilitator)                              │
│                                                                │
│  Agent provides deposit secrets                                │
│       ──▶ zBase checks agent identity + permissions            │
│       ──▶ zBase generates Groth16 ZK proof (~10s)              │
│       ──▶ zBase submits relay tx (agent wallet never appears)  │
│       ──▶ Provider gets USDC from privacy pool                 │
│                                                                │
│  Result: PRIVATE. No on-chain link between agent and payment.  │
└────────────────────────────────────────────────────────────────┘
```

**How each endpoint works internally:**

| Endpoint | What it does | What it calls internally |
|---|---|---|
| `GET /supported` | Returns capabilities JSON (networks, tokens, privacy, yield, agent registry) | Static response, no on-chain call |
| `POST /verify` | Checks deposit value >= payment amount. If `agentId` provided, checks per-tx limit, daily limit, provider whitelist | Reads pool tree size on-chain. Reads agent registry (in-memory) |
| `POST /settle` | Generates ZK proof + submits relay transaction | Calls `/api/withdraw` internally, which fetches all events via HyperRPC, builds Merkle trees, generates Groth16 proof, submits relay via POSTMAN key |

The three endpoints are wrappers. The real work happens in `/api/withdraw`. The facilitator just formats it into the x402 standard so any agent can use it.

Any existing x402 agent (AgentCash, Claude Code, Cursor, OpenClaw) can use zBase by changing one URL from Coinbase CDP to zBase. Zero code changes on the agent side.

**Agent Registry** solves the a16z gaps:

```
POST /api/agent/register
{
  "name": "Research Bot",
  "owner": "0xOwnerWallet",
  "permissions": {
    "maxSpendPerTx": "1000000",     // $1 max per transaction
    "maxSpendPerDay": "5000000",    // $5 max per day
    "allowedCategories": ["inference", "search"],
    "allowedProviders": []          // empty = any provider
  }
}
```

The facilitator checks permissions before every payment. Agent tries to overspend? Rejected. Agent tries to pay an unauthorized provider? Rejected. All enforced at the API level.

---

## How It Differs From Others

```
┌─────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│                 │  zBase   │ Railgun  │ PRXVT    │ Hinkal   │ Privacy  │
│                 │          │          │ (px402)  │          │ Pools    │
│                 │          │          │          │          │ (0xbow)  │
├─────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤
│ On Base         │ YES      │ No       │ Unknown  │ Partial  │ No       │
│ Privacy method  │ ZK pool  │ ZK + PoI │ Burner   │ ZK + KYC │ ZK pool  │
│                 │          │          │ wallets  │          │          │
│ Yield on idle   │ No       │ No       │ No       │ No       │ No       │
│ deposits        │ (none)   │          │          │          │          │
│ Compliance      │ ASP      │ PoI      │ No       │ Chain-   │ ASP      │
│                 │          │          │          │ alysis   │          │
│ x402 facilitator│ YES      │ No       │ Yes      │ No       │ No       │
│ Agent identity  │ YES      │ No       │ No       │ No       │ No       │
│ Agent           │ YES      │ No       │ No       │ No       │ No       │
│ permissions     │          │          │          │          │          │
│ Open source     │ Apache   │ Yes      │ Yes      │ No       │ Apache   │
│                 │ 2.0      │          │          │          │ 2.0      │
│ One-command     │ YES      │ No       │ No       │ No       │ No       │
│ install         │          │          │          │          │          │
└─────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
```

**What makes zBase unique:** The only protocol that combines ZK privacy + x402 facilitator + agent identity + agent permissions + compliance. On Base. First mover on the biggest L2.

### zBase vs Railgun (detailed)

```
┌──────────────────────────┬────────────────────────────┐
│        RAILGUN            │         zBASE              │
├──────────────────────────┼────────────────────────────┤
│                          │                            │
│  Privacy wallet for      │  Privacy infrastructure    │
│  humans doing DeFi       │  for AI agents paying      │
│                          │  for services              │
│                          │                            │
│  User generates proofs   │  Server generates proofs   │
│  in browser/wallet       │  (user sends secrets)      │
│                          │                            │
│  User submits own tx     │  Relayer submits tx        │
│  (or optional relayer)   │  (privacy by default)      │
│                          │                            │
│  No yield on deposits    │  No yield on deposits      │
│                          │                            │
│  No x402 support         │  Drop-in x402 facilitator  │
│                          │                            │
│  No agent identity       │  Agent registry with       │
│                          │  spend limits + whitelists │
│                          │                            │
│  Download Railway wallet  │  curl zbase.xyz/skill.md  │
│                          │                            │
│  Multi-chain (ETH, Poly, │  Base only (for now)       │
│  Arbitrum, BSC)          │                            │
│                          │                            │
│  Proof of Innocence      │  Association Set Provider  │
│  (compliance)            │  (compliance)              │
│                          │                            │
│  RAIL governance token   │  No token                  │
│                          │                            │
└──────────────────────────┴────────────────────────────┘
```

Railgun is a privacy wallet for humans. zBase is privacy infrastructure for AI agents. Different problem, different user, different architecture.

### Relay Cost (Base L2)

| Action | Gas | Cost (0.01 gwei) | Cost (1 gwei peak) |
|---|---|---|---|
| Deposit | ~600K | ~$0.001 | ~$0.10 |
| Relay (withdraw/pay) | ~800K | ~$0.001 | ~$0.13 |
| ASP update | ~200K | ~$0.0003 | ~$0.03 |

On Base, gas is nearly free. Even 10,000 relay txs/day = ~$10/day. The relayer wallet just needs ETH for gas.

---

## The Full Agent Payment Flow

```
Step 1: CALL
  Agent ──▶ GET api.anthropic.com/inference
  Service ──▶ 402 "Pay $0.50 USDC first"

Step 2: DEPOSIT (one-time)
  Agent ──▶ deposit(USDC, 1.0) ──▶ Privacy Pool
  Agent saves secrets: {nullifier, secret, value, label, commitment}

Step 3: VERIFY
  Agent ──▶ POST zBase/facilitator/verify
  Facilitator checks: agent registered? permissions ok? deposit sufficient?
  Response: "valid, 30 depositors in anonymity set"

Step 4: SETTLE (money moves)
  Agent ──▶ POST zBase/facilitator/settle
  Server: generates Groth16 proof (~10 seconds)
  Server: submits relay tx (agent wallet never appears)
  On-chain: "Pool paid Anthropic $0.50"
  NOT on-chain: any link to the agent

Step 5: RETRY (data moves)
  Agent ──▶ GET api.anthropic.com/inference
  Headers: X-Payment-TxHash: 0xabc...
  Service: verifies payment, returns inference data
  Agent: got the data. Nobody knows who paid.
```

---

## Why Now

- **Jesse Pollak** (Jan 2025): "privacy is a fundamental human right"
- **Jesse Pollak** (Apr 2025): "privacy must be a core part of the global onchain economy"
- **Coinbase** (Nov 2024): Won Tornado Cash lawsuit, Fifth Circuit ruled sanctions on smart contracts unlawful
- **US Treasury** (Mar 2026): Acknowledged "legitimate privacy uses" for crypto mixers
- **a16z** (Apr 2026): Published the exact infrastructure gap zBase solves
- **Grayscale** (Q4 2025): "A Preference for Privacy" report, privacy tokens outperformed market

The regulatory window is open. The demand is real. Nobody has built it on Base.

---

## Links

- **GitHub:** https://github.com/goheesheng/zx402
- **Public demo:** https://zbase.app/app#try
- **Wallet-connected test surface:** https://zbase.app/test
- **Architecture:** https://github.com/goheesheng/zx402/blob/main/docs/ARCHITECTURE.md
- **Agent skill:** `curl http://localhost:3009/skill.md`
