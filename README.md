# zBase

Private x402 payments for AI agents. Apache 2.0.

> **ETHOnline 2026 (Continuity submission).** This branch (`ethonline-2026`) builds on the
> pre-existing zBase product described below — 0xbow Privacy Pools + an x402 facilitator, proven
> end-to-end on Base mainnet 2026-07-19. New this event: a chain-generic network core that adds
> **Ethereum Sepolia**, wired to 0xbow's own canonical Ethereum Sepolia Privacy Pool deployment.
> See [`HACKATHON.md`](HACKATHON.md) for what's pre-existing vs. new, and
> [`docs/integrate/ethereum-sepolia.md`](docs/integrate/ethereum-sepolia.md) to run it.

```ts
import { createFacilitatorClient } from '@zbase-protocol/core';

const zbase = createFacilitatorClient({
  baseUrl: 'https://zbase.app',
  network: 'eip155:8453', // Base mainnet (testnet.zbase.app + eip155:84532 for Sepolia)
});

// One-time setup: prepare a privacy-pool deposit, then send the on-chain
// pool.deposit() transaction from your wallet with prep.precommitment.
const prep = zbase.prepareDeposit(10_000_000n); // 10 USDC, atomic units

// After the Deposited event gives you value/label/commitment, settle privately.
const deposit = {
  ...prep.secrets,
  value: '9900000',
  label: '0x...',
  commitment: '0x...',
};
await zbase.settlePrivately({
  payTo: '0xProviderAddress',
  amountAtomic: 500_000n,
  deposit,
});
```

The provider sees a payment from the pool, optionally to a fresh stealth address
if the provider registered one. The chain sees no direct payer-to-provider edge.

---

## What it does

zBase is a ZK privacy facilitator built on [Vitalik Buterin's Privacy Pools](https://github.com/0xbow-io/privacy-pools-core) research. AI agents deposit USDC into a shielded pool, prove ownership with a Groth16 proof, and pay providers from the pool — so the provider-payment transaction never names the agent's wallet.

An Association Set Provider (ASP) blocks illicit funds from being withdrawn privately. **This is compliant privacy, not Tornado Cash.** US Treasury (March 2026) acknowledged that crypto mixers have "legitimate privacy uses." zBase is built for that legitimate case.

**Three rails, one Base pool:**

- **Private payment** — deposit USDC, prove ownership, pay a provider from the pool. The payment tx never names the payer's wallet. *(Base mainnet live at zbase.app since 2026-07-13 — early, internally-reviewed, small anonymity set; Base Sepolia at testnet.zbase.app for testing; Solana paused pending audit fixes.)*
- **Private trading / cross-asset settlement** — an agent pays in USDC and the seller receives a *different* token (a whitelisted swap), unlinkably, in one settlement via the `ExecutorProcessooor`. Hides *who* funded the trade; the swap itself stays public. *(Built + internally audited; mainnet-gated on an external audit — see [`docs/security/external-audit-scope.md`](docs/security/external-audit-scope.md).)*
- **Auto-privatize / payer-agnostic receive** — publish one receiving address; a **privacy-unaware payer sends an ordinary transfer**, and a bounded relayer auto-deposits the (screened) funds into the pool at a commitment derived from *your* seed (D3), so it can deposit but never spend. *(Built + fund-safety-tested; deposit wiring is operator-gated for deploy. Design: [`docs/superpowers/specs/2026-07-09-private-funding-rail-design.md`](docs/superpowers/specs/2026-07-09-private-funding-rail-design.md).)*

## What's running where

| Layer | What | Where |
|---|---|---|
| **Core SDK** | `@zbase-protocol/core` — facilitator client, ZK primitives, stealth, forwarding notes | **published on npm** (`npm i @zbase-protocol/core`, v0.1.2+) |
| **Solana SDK** | `@zbase-protocol/svm` — Solana-native deposit/withdraw/pay | this repo; paused for Base mainnet launch |
| **MCP server** | `@zbase-protocol/mcp` — Claude Desktop / Cursor integration | this repo; build locally until published |
| **Contracts** | Privacy Pool implementation built on 0xbow's Apache 2.0 codebase | this repo; Base mainnet LIVE (pool `0x46753C…`, block 48571589) + Base Sepolia |
| **Circuits** | Groth16 + Poseidon | this repo, `public/circuits/` |
| **Hosted facilitator** | `zbase.app/api/facilitator/*` | hosted by zBase, free for now |
| **Live demo** | `zbase.app/app#try` — private payment in ~15s, no wallet needed | hosted by zBase |

You can self-host the entire stack. Most teams will point at the hosted facilitator and skip the ops.

## Try it in 60 seconds

```bash
# The core SDK is on npm — install it directly:
npm install @zbase-protocol/core
```

```ts
import { createFacilitatorClient } from '@zbase-protocol/core';
const zbase = createFacilitatorClient({ baseUrl: 'https://zbase.app', network: 'eip155:8453' });

const cfg  = zbase.getDepositConfig();          // USDC + entrypoint + pool for the network
const prep = zbase.prepareDeposit(amountAtomic); // KEEP prep.secrets

// On-chain, from YOUR wallet: approve USDC to the ENTRYPOINT, then deposit THROUGH it:
//   USDC.approve(cfg.entrypoint, amountAtomic)
//   Entrypoint.deposit(cfg.asset, amountAtomic, prep.precommitment)   // gas ~1,000,000
// Then read the pool's `Deposited` event from the receipt for { value, label, commitment }:
const deposit = { ...prep.secrets, value, label, commitment };

const result = await zbase.settlePrivately({ payTo, amountAtomic, deposit });
```

Or hit the live demo with no install at all: **[testnet.zbase.app/app#try](https://testnet.zbase.app/app#try)** — Base Sepolia, pre-funded demo wallet, no MetaMask, real testnet transaction in ~15s. (The apex `zbase.app` now serves Base mainnet.)

## What this is NOT

- **Not Tornado Cash.** Vitalik co-authored the Privacy Pools paper this implements. An ASP layer blocks illicit funds from withdrawing privately.
- **Not a Bitcoin/Monero mixer.** zBase is settlement-layer privacy for agent payments — it sits between an x402 API and the recipient, not at the chain level.
- **Not a token.** No ICO, no airdrop, no governance token. Apache 2.0 protocol + hosted service. Revenue model: per-deposit access fee + a single **5% per-settle take** (compliant by default — OFAC/ASP screening runs on every settle, so there's no separate paid compliance tier), enforced on-chain. Enterprise is a flat subscription ($2.5–25K/mo) plus a self-sovereign data product (an enterprise's own agents' transactions, viewing-key-gated, for their AML/reporting). **Testnet (Base Sepolia) is free for development** — fund a faucet wallet, integrate against the SDK, see real bills in Sepolia USDC before flipping to mainnet.
- **Not financial advice.** See [LICENSE](LICENSE) for the disclaimer that comes free.

## Why Base first, Solana later

Solana already has the agent infrastructure stack: [Eliza](https://github.com/elizaOS/eliza), [Virtuals](https://app.virtuals.io), [Sendai](https://docs.sendai.fun), [Solana AgentKit](https://github.com/sendaifun/solana-agent-kit), and the [Coinbase CDP x402 facilitator](https://docs.cdp.coinbase.com/x402). All of them route paid API calls on-chain. None of them have a private settlement option.

Multiple chain-analytics firms are now selling agent-wallet surveillance products. Competitors can map an agent's full spending history. Adversaries can profile what APIs it queries. zBase is the missing privacy primitive for x402-style agent settlement.

Base is the current launch path because the live Sepolia stack, hosted
facilitator, SDK surface, and mainnet deploy runbooks all target Base. The
Solana program remains a devnet artifact. A client-proved x402 v2
`private-exact` path and additional SVM safety fixes exist locally, but the live
devnet binary is older than that reviewed build. The Solana surface stays
paused until the in-place upgrade and post-upgrade E2E gates pass.

## Quick links

- **Docs**: [docs.zbase.app](https://docs.zbase.app)
- **Live demo**: [zbase.app/app#try](https://zbase.app/app#try)
- **Architecture overview**: [docs/gitbook/system-architecture.md](docs/gitbook/system-architecture.md)
- **Trust model**: [docs/gitbook/trust-model.md](docs/gitbook/trust-model.md)
- **Threat model**: [docs/gitbook/threat-model.md](docs/gitbook/threat-model.md)
- **Status page**: [zbase.app/api/health](https://zbase.app/api/health)
- **Anonymity set**: [zbase.app/anonymity-set](https://zbase.app/anonymity-set)
- **Solana program**: [7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM](https://solscan.io/account/7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM?cluster=devnet)
- **Twitter / X**: [@zbase__](https://x.com/zbase__)

## Three ways to integrate

### SDK (EVM) — `@zbase-protocol/core`

```ts
import { createFacilitatorClient } from '@zbase-protocol/core';

// Chain-agnostic: pass the CAIP-2 network. Defaults to Base Sepolia.
const client = createFacilitatorClient({
  baseUrl: 'https://zbase.app',
  network: 'eip155:8453', // Base mainnet — use 'eip155:84532' + testnet.zbase.app for Sepolia
});

// 1) prepare a deposit → precommitment + the secrets to keep locally
const prep = client.prepareDeposit(amountAtomic);
// On-chain: USDC.approve(entrypoint, amt); Entrypoint.deposit(asset, amt, prep.precommitment).
// Read the pool's Deposited event for { value, label, commitment }, then:
const deposit = { ...prep.secrets, value, label, commitment };

// 2) settle privately to a provider through a trusted facilitator URL
const result = await client.settlePrivately({ payTo, amountAtomic, deposit });
```

Today `settlePrivately()` uses server-side proving, so the configured facilitator
URL is trusted with the note spend secrets. The SDK enforces HTTPS for non-local
URLs; pin `baseUrl` to an endpoint you operate or trust. Client-side proving is
the roadmap path that removes server custody.

> Published surface is the **deployed** primitives (facilitator client, account/
> Merkle/proof helpers, ERC-5564 stealth, forwarding D3 notes). The unfinished
> UTXO scaffold lives on the opt-in `@zbase-protocol/core/experimental` subpath
> and is **not** production-ready — see [SECURITY.md](SECURITY.md).

### SDK (Solana — paused)

```ts
import { Connection } from '@solana/web3.js';
import { SvmPool } from '@zbase-protocol/svm';

const pool = new SvmPool({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: relayerKeypair,
  network: 'devnet',
  circuitsUrl: '/path/to/circuits',
});

const prepared = await pool.prepareWithdrawal(
  localNoteSecrets,
  merchantAddress,
  amountAtomic,
);
```

Do not use the Solana SDK for production funds until the SVM fixes are deployed,
the on-chain binary hash is verified, and the devnet checklist passes.
`prepared.payment` contains the client-generated proof; the note secrets and
`prepared.nextDeposit` must remain local.

### x402 Facilitator

The hosted Base facilitator and the paused Solana facilitator do not have the
same trust boundary. Solana `private-exact` requires
`PrivateExactSvmClientScheme` so the buyer generates its proof locally; it is
not a zero-code swap for an ordinary `exact` SVM client. The standalone devnet
server exposes standard x402 v2 `/supported`, `/verify`, and `/settle` paths but
advertises no usable private kind while paused. Readiness requires both the
operator deployment gate and an automatic RPC hash of the live ProgramData;
setting the environment flag alone cannot enable private settlement.

```bash
curl -X POST http://localhost:4020/verify \
  -H "Content-Type: application/json" \
  -d '{ "x402Version": 2, "paymentPayload": { ... }, "paymentRequirements": { ... } }'
```

### MCP server (Claude Desktop / Cursor agents)

> ⚠️ Not yet on npm — `npx @zbase-protocol/mcp` will 404 today. Until published,
> build the MCP server from the repo (`packages/mcp`) and point `command` at the
> built `dist/index.js`. The config below is what it WILL be once published.

```json
// claude_desktop_config.json (once published — not live yet)
{
  "mcpServers": {
    "zbase": {
      "command": "npx",
      "args": ["-y", "@zbase-protocol/mcp"]
    }
  }
}
```

Restart Claude. Use the MCP tools to run the demo flow or hand off a payment
intent. The MCP server is a thin client over a facilitator; it is not a wallet
or a custody boundary for production funds.

## What the grant funds

zBase is applying to the Solana Foundation Malaysia grant for $10,000 across 10 weeks ([deck](./decks/zbase-grant-pitch-20260604-153753.pdf) — local file, not tracked).

- **Tranche 1** ($2,500): open-source SDK + MCP server + 25 devnet payments + 3 design partners
- **Tranche 2** ($3,500): 50 devnet payments + stealth-recipient registry + live anonymity dashboard + 1 named partner shipping
- **Tranche 3** ($4,000): 100 devnet payments + technical case study + threat model + 3 partners in production

All metrics on-chain verifiable.

## Decoy traffic (timing-correlation defense)

A Vercel cron at `/api/cron/decoy` fires probabilistically (~40% of every 20-minute tick, ~50 min mean inter-arrival) to inject dummy withdrawals into the pool. This defeats trivial FIFO timing-correlation attacks where a lone withdrawal in a quiet window can be linked back to its depositor by timestamp alone.

- **Disable in emergencies**: set `ZBASE_DECOY_DISABLED=true` in Vercel env (no redeploy needed).
- **Authentication**: Vercel cron sends `Authorization: Bearer $CRON_SECRET`; unauthorized hits return `401`.
- **Tune cadence**: edit `vercel.json` `crons[].schedule` (base rate) or `ZBASE_DECOY_FIRE_PROBABILITY` (jitter probability).
- **Status today**: cron infrastructure (auth + jitter + kill switch) is live; per-iteration deposit/withdraw is scaffolded — see `src/app/api/cron/decoy/route.ts` header for the porting plan.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports via GitHub issues; security via the channel in [SECURITY.md](SECURITY.md); questions via [@zbase__](https://x.com/zbase__) on Twitter.

## License

Apache 2.0 — see [LICENSE](LICENSE).

zBase is built on Vitalik Buterin's [Privacy Pools research](https://github.com/0xbow-io/privacy-pools-core) (Apache 2.0, co-authored by Vitalik, integrated into the Ethereum Foundation's Kohaku wallet) and the 0xbow reference implementation. The cryptographic primitives are adapted from that audited codebase; zBase ports them to Solana and adds the x402 facilitator + ASP + agent identity layers as new code (~6,929 lines).
