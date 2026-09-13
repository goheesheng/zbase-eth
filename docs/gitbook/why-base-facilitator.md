# Why a facilitator on Base

TL;DR — zBase is an **application on Base**, not a sovereign chain or
rollup. The facilitator pattern wraps the chain your users already hold balances on,
runs 0xbow's audited Privacy Pool (unmodified) on it, and never asks anyone to bridge.

For the failure-mode analysis vs privacy L3s, see the [FAQ entry on L3s](faq.md).

## The architecture choice

| Choice | Cost | Benefit |
|---|---|---|
| New privacy L3 (Aztec Connect, shh.gg shape) | Sequencer, bridge, prover network, new-chain bootstrap | Sovereignty over execution |
| Application on existing L2 (zBase) | None of those | Inherits Base's USDC liquidity + wallet + CEX integration |

Aztec Connect was sunset in March 2023 after serving 100K+ users — the team's own
[Sunset Memo](https://medium.com/aztec-protocol/sunsetting-aztec-connect-a786edce5cae)
named "not able to commit sufficient resources to simultaneously support [the
product] and the development of [the next thing]" as the cause. A small team
cannot run a sequencer + bridge + prover + ASP + docs and ship product.

## What "facilitator" means in x402

x402 is an HTTP-level payment protocol — a provider returns `HTTP 402 Payment
Required` with `paymentDetails`, the agent settles, the agent retries with a
settlement proof. The **facilitator** is the verify/settle endpoint pair
(`/api/facilitator/verify`, `/api/facilitator/settle`) that orchestrates the
on-chain side.

zBase ships a facilitator that:

- Verifies an incoming `zbaseDeposit` against the on-chain pool.
- Generates a Groth16 proof of pool membership for the payer's note.
- Derives a fresh ERC-5564 stealth address for the provider per call.
- Relays the withdrawal through the postman so the payer wallet is not the
  transaction sender.
- Returns `nextDeposit` when value remains, so an agent can settle multiple
  invoices from one deposit.

## Why Base specifically

| Reason | Detail |
|---|---|
| x402 origin chain | x402 was launched on Base by Coinbase. The largest x402 volume sits there (~$49.5M / 30D as of May 2026). |
| USDC liquidity | Native USDC on Base means no bridged-token risk. |
| Compatible verifier tooling | Solidity Groth16 verifier deploys cleanly; `forge`-based dev loop. |

## Why not deposit-time KYC instead

A pre-deposit KYC gate destroys the property the ASP is
designed to preserve: at deposit time the depositor is still publicly identifiable
on chain, so an ASP screen costs them no anonymity. KYC at the door drops the
anonymity set to "users who passed our specific KYC vendor's check," which is
both smaller and links a real identity to the deposit address.

The Privacy Pools design (Buterin, Sun, Hu, Illum, Mahmoody 2023) trades a
one-time **deposit-time label check** for **permanent payment-time anonymity**,
without ever asking the depositor to identify themselves to zBase.

Next → [The two gates](two-gates.md)
