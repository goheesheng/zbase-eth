# ETHGlobal submission form — zBase (ETHOnline 2026, Continuity)

Fields as they appear on the ETHGlobal submission form. Copy verbatim; word/character limits
noted per field.

## Project name

zBase

## Tagline (≤ 100 chars)

Private x402 payments for AI agents — now speaking Ethereum, not just Base.

(74 characters)

## Description (≤ 250 words)

New tonight: zBase's network layer was hardcoded to two Base networks — a closed CAIP-2 union and
repeated `mainnet : sepolia` ternaries that silently mis-routed any third chain, a latent
money-path bug. We replaced it with an explicit, fail-closed network table and added Ethereum
Sepolia, wired against **0xbow's own canonical Ethereum Sepolia Privacy Pool** deployment (not a
redeploy of our contracts — their independently-deployed instance, verified on-chain via `cast`
today). The facilitator now reports the Ethereum Sepolia stack (`eip155:11155111`), reads deposit events and the anonymity
set from 0xbow's Ethereum pool over an RPC fallback (with a per-chain HyperSync path when
entitled), and resolves the right USDC EIP-712 domain and chain per network instead of assuming
Base's.

What this builds on: zBase is a ZK privacy facilitator for AI agent x402 payments, deployed on
Base Sepolia and Base mainnet on top of 0xbow's Privacy Pools (Vitalik Buterin co-authored,
audited, vendored unmodified). An agent deposits USDC into a shielded pool, proves membership with
a Groth16 proof, and pays an x402 seller from the pool — so the payment transaction never names
the payer's wallet — with an Association Set Provider blocking sanctioned funds from privately
withdrawing. Proven end-to-end on Base mainnet on 2026-07-19: gasless sweep → pool → ZK withdrawal
→ paid x402 response from a CDP-facilitated seller (BlockRun, Nansen).

Stated plainly: ZK withdrawal on Ethereum Sepolia doesn't work yet (zBase isn't 0xbow's ASP
postman there), and the gasless sweep is Base-only tonight (no Ethereum paymaster wired). Both are
named next steps, not hidden gaps.

## How it's made (≤ 200 words)

Next.js app router frontend, viem for chain reads/writes, snarkjs for Groth16 proof generation
(withdrawal circuit, server-side), Envio HyperSync for fast log indexing with a chunked
`eth_getLogs` RPC fallback on chains without an entitled token, Coinbase CDP for the gasless
ERC-4337 sweep, and ERC-5564 for stealth recipient addresses. The 0xbow Privacy Pools contracts
(Solidity, Groth16 verifiers, Poseidon Merkle tree) are vendored unmodified under Apache-2.0 — we
don't touch their audited code.

The notable bit for tonight: we did **not** deploy our own Ethereum Sepolia pool. We pointed the
existing facilitator at 0xbow's own Ethereum Sepolia Privacy Pool deployment and verified its
state (SCOPE, ASSET, ENTRYPOINT, current Merkle root) on-chain with `cast` before wiring it in —
so the read path (`/api/facilitator/supported`, `/api/deposits/events`, verify) is against a real,
independently-operated instance of the same audited contracts, not a mock. The write path is
honestly gated: zBase isn't the ASP postman on that pool, so `/api/withdraw` returns 501 with the
reason, instead of silently failing or faking success.

## Track

Continuity

## Partner prizes

None — no sponsor track for this edition fits without a sponsor-chain port.

## Repo URL

`https://github.com/goheesheng/zbase-eth`

## Video

`<<FILL: video URL>>`

## Live demo

https://zbase.app
