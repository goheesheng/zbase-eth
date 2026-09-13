# How zBase compares

zBase is the **first x402 facilitator that makes agent payments private without giving anything
up.** The seller is still paid with a completely standard payment, the funds are still
compliance-screened, the agent still holds no gas, and it's still one call. Every other approach
makes you trade at least one of those away.

Plain-English version: today, when an AI agent pays for an API, the payment is a public receipt —
anyone can read the chain and see *your wallet paid this API, this much, at this time*, forever.
zBase makes the same payment work exactly as before for the seller, but the public receipt no
longer names you — and it's the first to do that while staying standard, compliant, and gasless.

## The one-glance table

**zBase is the only option that is green across the board.** Every other approach is missing at
least two of the six.

<table class="zb-compare" markdown="0">
  <thead>
    <tr>
      <th>Approach</th>
      <th>Private<br><small>payer↔payment unlinkable</small></th>
      <th>Standard x402<br><small>any CDP seller, unchanged</small></th>
      <th>Compliant<br><small>ASP, not a blind mixer</small></th>
      <th>Gasless<br><small>agent holds no ETH</small></th>
      <th>Money-safe<br><small>no double-pay</small></th>
      <th>Agent-native<br><small>one call</small></th>
    </tr>
  </thead>
  <tbody>
    <tr class="zb-row">
      <td><strong>zBase</strong></td>
      <td>✅</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td>
    </tr>
    <tr>
      <td>Standard x402 facilitator (no privacy)</td>
      <td>❌</td><td>✅</td><td>—</td><td>❌</td><td>⚠️</td><td>✅</td>
    </tr>
    <tr>
      <td>One-hop forwarding / stealth address</td>
      <td>⚠️</td><td>⚠️</td><td>❌</td><td>❌</td><td>⚠️</td><td>⚠️</td>
    </tr>
    <tr>
      <td>Blind mixer</td>
      <td>✅</td><td>❌</td><td>❌</td><td>❌</td><td>❌</td><td>❌</td>
    </tr>
    <tr>
      <td>General privacy system</td>
      <td>✅</td><td>❌</td><td>⚠️</td><td>❌</td><td>❌</td><td>❌</td>
    </tr>
  </tbody>
</table>

<small>✅ full · ⚠️ partial or caveated · ❌ no · — not applicable. What each approach is, and where
it stops, is below.</small>

## Where the other approaches stop

**The standard x402 facilitator (no privacy).** What almost every buyer uses today. It settles
reliably, but privacy was never a goal: the transaction is a direct, permanent on-chain link from
*your wallet* to *the seller you paid*. For an agent making hundreds of small calls, that is a
complete public spending profile — and the wallet has to hold ETH for gas. zBase keeps the
reliability and seller-compatibility (the seller can't tell the difference) and removes the link
and the gas.

**One-hop forwarding and stealth addresses.** These send funds to a fresh address that either
forwards them straight to the recipient, or is a per-payment recipient the sender still funds
directly. It breaks the *direct* address-to-address link, and for some uses that is enough. But it
is a **hop, not an anonymity set**, and that is the whole game:

- **Timing + amount correlation.** Money lands in the fresh address and leaves for the recipient in
  the same instant, for the same amount. An observer watching the sender sees `A → fresh → B`
  seconds apart — a speed bump, not a crowd. zBase funds the payer **from a shared pool** of many
  independent depositors, and a Groth16 proof hides *which* deposit funded it. There is no
  `you → payer` trail, because the money comes from the pool, not from you.
- **No compliance gate.** A pass-through can't prove funds are *not* in the known-illicit set.
  zBase's **ASP** gives honest users exactly that — the property blind approaches can't offer, and
  the reason they get sanctioned.

**Blind mixers.** They hide the link — but with no compliance (honest deposits mix with illicit
ones, which is why they get sanctioned) and no x402 rail. Using one means withdrawing to a fresh
wallet by hand, funding it with gas, then paying — the agent flow is gone.

**General privacy systems (privacy L2s / shielded-transfer protocols).** Real privacy for transfers
and DeFi, but not x402 payment rails. There is no "pay this API URL and get the data back in one
call" — the agent has to bridge assets in, transact, and bridge context back.

## Why zBase is first — the technical reasons

1. **Private and standard at the same time.** The seller is paid by a fresh, single-use wallet that
   a Groth16 zero-knowledge withdrawal funded from the pool. The seller receives a normal EIP-3009
   `exact` payment and delivers exactly as it would for any standard payment — it never knows zBase
   was involved. Nothing else gives you unlinkability **and** works with sellers unchanged. (See
   [How the money flows](how-the-money-flows.md).)

2. **Compliance-aware privacy, not a blind mixer.** zBase is built on the **Privacy Pools** model:
   an Association Set Provider (ASP) lets honest users prove their funds are *not* in the set of
   known-illicit deposits, without revealing which deposit is theirs. (See
   [The two gates](two-gates.md), [Trust model](trust-model.md).)

3. **Two gates, not one.** ASP screens *who may withdraw*; stealth addresses hide *who receives*.
   Two independent mechanisms, so breaking one does not unmask a payment.

4. **Gasless for the agent.** A sponsored relayer signs the on-chain settlement, so the agent holds
   only USDC — never ETH.

5. **Money-safe by construction.** The note is spent **once**: settlement is idempotent, so a
   dropped response replays the same payment instead of paying twice, and the change note is always
   seed-recoverable. (See [Handling failures safely](pay-privately-quickstart.md).)

6. **Built for agents.** One SDK call or one MCP command runs the whole loop — free-probe the seller,
   hit the 402, settle privately, retry with the payment header, return the data. Proven on Base
   mainnet against real sellers at **$0.028, $0.01, and $0.001**.

## The honest limitation

Privacy comes from a **crowd**: your withdrawal hides among other people's deposits. The pool is
still filling toward its launch minimum of **30 independent depositors**, so today **payments settle
and deliver, but they are not crowd-anonymous yet** — with a small set an observer could still link a
withdrawal to a deposit. Every payment reports this in `result.privacy.private`. The 30-depositor
floor is *necessary, not sufficient*: even past it, a unique amount or the timing of a withdrawal can
narrow the effective set (see the [Threat model](threat-model.md)). We would rather tell you this
plainly than overclaim.

Bottom line: zBase is the **first and only** x402 option that is private, compliance-aware,
standard-compatible, gasless, and money-safe in a single agent-native call. See
[Pay privately in 5 minutes](pay-privately-quickstart.md) to try it.
