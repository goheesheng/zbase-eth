# X article — "How zBase works: the private x402 facilitator"

Draft for @zbase__. Two formats below: a **thread** (recommended for X) and a
**single long-post** version. Honest by construction — everything here is true
today (live on Base Sepolia, on-chain proof). What's NOT claimed: mainnet, real
revenue, amount-hiding, trading. Edit freely; this is a starting draft.

---

## FORMAT A — Thread (10 posts)

**1/**
Every x402 payment an AI agent makes is public.

Anyone can see which agent paid which service, when, how much — a full spending
graph, on-chain, forever.

We built the fix: a private x402 facilitator. Here's how it works. 🧵

**2/**
Quick context: x402 is the HTTP-native payment standard for AI agents. Agent hits
a paid endpoint → gets a 402 → pays in USDC → gets the resource.

Facilitators (Coinbase's, x402.org's) settle that payment. They work great. But
the settlement is public — payer → payee, visible to everyone.

**3/**
zBase is an x402 facilitator too — same verify / settle / supported interface.

The difference: we settle the payment *through a ZK privacy pool*. The service
gets paid in clean USDC, but there's no on-chain link between the agent's wallet
and the payment.

Same plumbing. Private settlement.

**4/**
How it actually works, end to end:

→ Agent deposits USDC into the pool once (gets ZK secrets)
→ Agent hits a paid service, gets a 402
→ Calls our /verify, then /settle
→ We generate a Groth16 proof of pool membership, pay the service *from the pool*,
   and mark the agent's note spent

No transfer from the agent's wallet. That's the privacy.

**5/**
The service doesn't change anything. It sees an ordinary x402 payment and gets
clean USDC — at a fresh stealth address (ERC-5564), a new one per payment.

So a service can accept private payments without doxxing its revenue, its
counterparties, or its on-chain graph.

**6/**
"Isn't this just a mixer?" No.

It's a fork of @0xbow_'s Privacy Pools — the compliant-privacy design Vitalik
co-authored. Only deposits from clean addresses (an Association Set Provider's
approved set) can withdraw. Privacy with a compliance gate, not a black box.

**7/**
It's live on Base Sepolia today, and we proved the whole loop on-chain:

deposit → pay access fee → authorize → settle $0.70 to a service → the fee split
landed exactly: service got 0.693, treasury got the take, payer↔payee unlinkable.

Real tx, real Groth16 proof, on testnet. Not a mockup.

**7b/ (the receipt — post the proof)**
Don't take our word. The full loop, on-chain (Base Sepolia):

Deposit 1 USDC → 0.99 after vetting fee ✅
Access fee $0.001 → treasury ✅
Authorize → tier set ✅
Settle $0.70 → service, payer↔payee NOT linkable ✅

The split: service got 0.693 USDC, treasury got 0.007 (1% of $0.70). Exact.

Settle tx 👇
sepolia.basescan.org/tx/0xe8112fecdfa4f84459e7a72d2055c723b5efa17d6f48fad8d7a172d8d792dc1f

(Deposit: …d66c5d9 · Access fee: …891934b — all confirmed on-chain.)

**8/**
The model: free to transact, the *receiving* side pays a thin take to get paid
privately. No token. No "hold 2,500 of our coin to qualify" gate. Bring USDC, done.

Coinbase settles x402 for free — but free settlement is public. The take is the
price of *unlinkable* revenue.

**9/**
Why the seller side? Because nobody serves it. The biggest private-payments
project on Base says, in their own docs, they're "not an x402 facilitator…
payer-side only" — they make the buyer private.

We make the service *get paid* privately. Different side of the market. Open lane.

**10/**
Base + Solana. Compliant by design. No token.

If you run an agent service / API / data feed and want private USDC payouts —
or you're building agent payment infra — DM @zbase__.

Built on Privacy Pools (Vitalik-co-authored, @0xbow_, Apache-2.0).

— end —

---

## FORMAT B — Single long-post

**Every x402 payment an AI agent makes is public — a full spending graph on-chain,
forever. We built a private x402 facilitator to fix it. Here's how it works.**

x402 lets AI agents pay for things over HTTP: hit a paid endpoint, get a 402, pay
USDC, get the resource. Facilitators (like Coinbase's) settle that payment — but
publicly. Anyone can see payer → payee.

zBase is an x402 facilitator with the same interface (verify / settle / supported),
but it settles *through a ZK privacy pool*. The flow: an agent deposits USDC once,
then to pay a service we generate a Groth16 proof of pool membership and pay the
service *from the pool* — never from the agent's wallet. The service gets clean
USDC at a fresh stealth address; there's no on-chain link back to the agent.

It's a fork of 0xbow's Privacy Pools — the compliant-privacy design Vitalik
co-authored — so only clean (ASP-approved) deposits can withdraw. Not a mixer.

Live on Base Sepolia today. We proved the full loop on-chain: deposit → access fee
→ authorize → settle $0.70 to a service, fee split landed exactly (service 0.693,
treasury the take), payer↔payee unlinkable. Real Groth16 proof on testnet.

Free to transact; the receiving side pays a thin take to get paid privately. No
token, no hold-to-qualify gate — bring USDC. Coinbase settles x402 for free, but
free settlement is public; the take is the price of *unlinkable* revenue.

Base + Solana, compliant by design. If you run an agent service and want private
USDC payouts, or you're building agent payment infra — DM @zbase__.

---

## Honesty guardrails (do NOT claim in any version)
- ❌ "Mainnet" — it's Base Sepolia (testnet). Say "live on Base Sepolia" / "testnet".
- ❌ Real users / revenue / TVL — the proof used a demo wallet paying a fake
  provider. Don't imply traction you don't have.
- ❌ "Amount-hiding" / "fully private" — only the LINK between payer and payment is
  hidden; amounts are on-chain in plaintext (UTXO notes for amount-hiding are
  roadmap, pre-ceremony). Say "unlinkable," not "fully anonymous."
- ❌ "Private trading" / DEX swaps — not built. Stick to private *payments/settlement*.
- ✅ Safe: live on Sepolia, on-chain proof (cite the settle tx if you want:
  sepolia.basescan.org/tx/0xe8112fecdfa4f84459e7a72d2055c723b5efa17d6f48fad8d7a172d8d792dc1f),
  x402 facilitator, ZK/Groth16, Privacy Pools fork, compliant (ASP), Base+Solana,
  no token, seller-side wedge.

## Notes for posting
- Lead post must hook in the first line (the "every payment is public" framing).
- Tag @0xbow_ (attribution + credibility) and consider @base.
- Don't name-attack the competitor — "the biggest project says, in their docs…" is
  factual and stronger than naming. (Their "not an x402 facilitator, payer-side
  only" line is public.)
- A screenshot of the on-chain settle (BaseScan, showing the split + no link) would
  be the strongest single visual.
