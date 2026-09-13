# zBase — ETHOnline 2026 (Continuity)

## What this is

zBase is a ZK privacy facilitator for x402 agent payments, built on Vitalik Buterin's Privacy
Pools design. For ETHOnline 2026's Continuity track, zBase extends its Base-only network layer to
speak Ethereum Sepolia, wiring against 0xbow's own canonical Ethereum Sepolia Privacy Pool
deployment.

## Pre-existing work (before 2026-09-13, not judged)

zBase deploys 0xbow Privacy Pools (Vitalik-co-authored, audited, vendored **unmodified**,
Apache-2.0) on Base Sepolia and Base mainnet, and adds a product layer on top: an x402 payment
facilitator (verify/settle, EIP-3009 USDC, x402 v2 payloads with the `accepted` field
CDP-facilitated sellers require), server-side Groth16 withdrawal proving with relay submission, an
Association Set Provider (ASP) compliance screener (OFAC SDN + a curated blocklist, fail-closed)
that posts the ASP root on-chain, a gasless "sweep" (one atomic Coinbase CDP ERC-4337 userOp:
receive → approve → deposit), ERC-5564 stealth recipients, Envio HyperSync indexing, a Next.js
app (`/app`) with a no-wallet live demo (`/app#try`, 7–15s per private payment on Base Sepolia),
and an MCP/CLI driver (`packages/mcp`: `sweep`, `probe`, `pay`).

**Proven on Base mainnet, 2026-07-19:** gasless sweep → privacy pool → ZK withdrawal → pay a
CDP-facilitated x402 seller that returns `200` and data, against BlockRun (`blockrun.ai`) and
Nansen.

Base Sepolia: Entrypoint `0x598ffaac79ae29b1aae571fd91899d4492183688`, USDC pool
`0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a`, USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
Base mainnet: Entrypoint `0x275faa86e2e316abe46807453c1d95f101d36431`, USDC pool
`0x46753ced1e87871ea1aaf24aed47dfa2d95855dd`, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
(full list, including verifiers: `docs/gitbook/contract-addresses.md`). Live app:
https://zbase.app (docs: https://docs.zbase.app).

Everything in the first commit of this repository, `97a4d00` ("pre-existing work snapshot"), is
pre-existing work; every commit after it was made on 2026-09-13 during the event. Verify with
`git log --oneline --reverse`.

## New work during ETHOnline (2026-09-13, branch `ethonline-2026`)

zBase's network layer was hardcoded to Base: a closed CAIP-2 union
(`"eip155:84532" | "eip155:8453"`) declared across 6 files, and repeated
`network === "eip155:8453" ? mainnet : sepolia` ternaries that silently treated *any* non-Base
network as Base Sepolia — a latent money-path bug for a third chain. This event adds a third
network, Ethereum Sepolia, and replaces the ternary pattern with explicit, fail-closed lookups.

1. **Chain-generic network core.** `StackNetwork` (`src/lib/contracts.ts`) gains `eth-sepolia`
   (`NEXT_PUBLIC_NETWORK=eth-sepolia`). The closed union becomes `FACILITATOR_NETWORKS`, adding
   `eip155:11155111`, with `isTestnetNetwork` / `chainIdForNetwork` / `viemChainForNetwork`
   helpers; every `? mainnet : sepolia` ternary (`src/lib/facilitator-authz.ts` and others) becomes
   an explicit keyed lookup that fails closed on an unrecognized network.
2. **`ETH_SEPOLIA_STACK`** (`src/lib/contracts.ts`): wired to **0xbow's own canonical Ethereum
   Sepolia Privacy Pool** (docs.privacypools.com/deployments), verified on-chain today via `cast`
   (SCOPE / ASSET / ENTRYPOINT / currentRoot consistent). Address table:
   `docs/integrate/ethereum-sepolia.md`.
3. **`hypersyncUrlFor(chainId)`** (`src/lib/hypersync.ts`) plus `HYPERSYNC_URL` / `HYPERSYNC_CHAINS`
   env vars replace 6 hardcoded Envio URLs. Without an entitled token, the indexer falls back to
   chunked `eth_getLogs`, with a per-stack `logChunkBlocks` (50,000 on Ethereum Sepolia via
   publicnode, 10,000 on Base).
4. **Per-chain USDC EIP-712 domain table** (`usdcDomainFor`, `src/lib/usdc-domain.ts`):
   Ethereum USDC is `"USDC"`/`"2"` on Sepolia, `"USD Coin"`/`"2"` on mainnet — the sweep signer
   previously hardcoded Base's domain.
5. **`externalAsp` stack flag + guards.** zBase isn't `ASP_POSTMAN` on 0xbow's pool, so
   `/api/withdraw`, `/api/asp-update`, and the root updater return **501 with an explicit reason**
   instead of attempting `updateRoot`.
6. **Frontend:** an Ethereum Sepolia chain entry, chain-aware explorer links
   (`sepolia.etherscan.io`), a wagmi transport (`src/lib/chain-context.tsx`, `src/lib/wagmi.ts`).
7. These docs (`HACKATHON.md`, video script, submission form, `docs/integrate/ethereum-sepolia.md`).

Commits: `d5fe4ea` (chain config + `ETH_SEPOLIA_STACK`), `fc8c5e4` (facilitator network registry),
`55f3fbd` (HyperSync helper, RPC fallback, USDC domain, `externalAsp` guards), `4cbbe59` (docs),
plus the commit that fills these references.

## What works now on Ethereum Sepolia

- `GET /api/facilitator/supported` reports the Ethereum Sepolia stack: `contracts.network` =
  "Ethereum Sepolia (11155111)", 0xbow's Entrypoint/pool addresses, the live anonymity set (286
  `Deposited` events read from L1 at test time), 0xbow's current `latestAspRoot`, and a
  `pricing.networks["eip155:11155111"]` entry. `supported[]` stays empty until the same
  production-readiness gates that govern Base (shared root-verified indexer + configured RPC)
  pass — the gate is unchanged, not bypassed.
- `GET /api/deposits/events` and the anonymity-set read index 0xbow's pool via the RPC fallback.
- The facilitator's verify path accepts `eip155:11155111` payment payloads.
- The app renders an Ethereum Sepolia chain entry.

## What does not (stated plainly)

- **ZK withdrawal / settle-from-pool** — zBase isn't 0xbow's ASP postman, so `/api/withdraw`
  returns 501. Needs our own pool deployment or inclusion in 0xbow's ASP.
- **Gasless sweep** — the CDP paymaster is Base-only; Pimlico or Alchemy is the planned path.
- **A live deposit** — no Sepolia ETH or USDC in the operator key tonight; the demo reads
  0xbow's existing pool state rather than adding to it.

## How to run it

```bash
yarn
NEXT_PUBLIC_NETWORK=eth-sepolia npm run dev -- -p 3011
curl localhost:3011/api/facilitator/supported
curl localhost:3011/api/deposits/events
```

See `docs/integrate/ethereum-sepolia.md` for env vars, the full address table, and the 501 list.

## Why Ethereum L1, and next steps

L1 gas makes per-payment withdrawal uneconomic: measured today on 0xbow's mainnet pool, `relay`
costs 557,454 gas — about $0.07 at 0.05 gwei, about $7 at 5 gwei. That favors a different shape on
L1: withdraw once to a stealth address, then make many x402 payments from it; or settle on Base
and anchor the privacy step on L1. Two other signals point the same way: ERC-8004 agent identity is
live on Ethereum mainnet and Sepolia and named on the EF's dAI team roadmap alongside x402, and
`ethereum/kohaku` ships its own `privacy-pools` package.

Next steps: deploy zBase's own plain 0xbow pool on Ethereum Sepolia with `DeployMainnetPool.s.sol`
(`USDC_ADDRESS` = Sepolia USDC, ~7M gas) so zBase is the postman and withdraw works; add a Pimlico
paymaster for the sweep; put an ERC-8004 agentId on the settlement receipt; try a mainnet pay demo
against Primev's `facilitator.primev.xyz`, the only live `eip155:1` x402 facilitator found.

## Demo video

`<<FILL: video URL>>`

## Judging-criteria map

- **Technicality** — a chain-generic network abstraction (closed union → keyed, fail-closed
  lookups) wired against a second, independently-deployed Privacy Pools instance.
- **Originality** — applies the facilitator to a chain where L1 gas economics change the design
  (withdraw-once, pay-many), not a cosmetic multi-chain badge.
- **Practicality** — the read path (supported networks, deposit events, ASP-aware verify) works
  tonight; the write path is gated behind a named blocker (postman access), not silently broken.
- **Usability (UI/UX/DX)** — one env var (`NEXT_PUBLIC_NETWORK=eth-sepolia`) switches the whole
  stack; `docs/integrate/ethereum-sepolia.md` gives exact commands and the address table.
- **WOW factor** — a live private payment on Base (`/app#try`), then the same facilitator talking
  to a Vitalik-co-authored pool on Ethereum Sepolia it did not deploy itself.

## License / attribution

Built on [0xbow Privacy Pools](https://github.com/0xbow-io/privacy-pools-core)
(Vitalik Buterin co-authored design, audited), vendored **unmodified** under its original
Apache-2.0 license. zBase's own code (facilitator, ASP screening, stealth recipients, indexing,
MCP driver, and this event's network layer) is the product layer on top.
