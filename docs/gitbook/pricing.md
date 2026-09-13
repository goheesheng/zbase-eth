# Enterprise

Short version: **you pay a small percentage per private payment, and enterprises pay for
self-custodied compliance data.** Testnet is free.

## What you pay

| Tier | Who it's for | Cost |
|---|---|---|
| **Standard** | Any agent / buyer | A small percentage per private payment, with a low per-call floor. A one-time unlock per deposit then covers unlimited settles from that note. |
| **Enterprise** | Teams needing compliance data | Custom — a self-custodied compliance-data product. [Contact us](mailto:hello@zbase.app). |
| **Testnet** | Development | Free. |

**Compliance is built in, not a separate product.** The ASP compliance gate is enforced inside the
ZK withdrawal circuit, so a withdrawal must prove membership in the approved set. The ASP screens
**every deposit** against the OFAC SDN list plus a curated Tornado/hack overlay and excludes flagged
deposits; deeper graph-taint KYT (funds a few hops from a flagged source) is on the
[roadmap](build-roadmap.md). There is no separate "compliance" tier to buy.

!!! note "How the fee is taken, and where the number lives"
    The per-settle take is **deducted from the settled amount** — the recipient gets the amount
    minus the take, so you never pay more than the payment itself. The exact current rate and floor
    are returned by `GET /api/facilitator/supported` under `pricing` — fetch it (or use the
    [Live API playground](api.md)) for the precise numbers your integration will pay. That endpoint
    is the source of truth; this page is the plain-English overview.

## What Enterprise includes

Enterprise is a **contact-us engagement**, not a self-serve tier. It's for teams whose agent spend is
sensitive — automated procurement, trading and data-buying desks, or any org that must report on its
agents' payments. The bundle:

- **Self-custodied compliance data** *(live)* — a viewing-key-gated dataset of your **own** agents'
  transactions for AML screening and reporting, held by you, never by us.
- **Org-scoped pool + priority settlement** *(design-partner engagement)* — a segregated, org-scoped
  anonymity cohort with higher limits and priority relay, so your spend isn't diluted into the shared
  pilot pool.
- **SLA + direct support** *(engagement)* — a support channel and an uptime commitment.
- **Signed clean-funds attestation API** *(roadmap)* — prove a payment's source funds are not in the
  sanctioned set, so a counterparty can accept agent payments without running their own KYT. Gated on
  deeper graph-taint KYT + the 3-of-5 quorum + an external audit — see the [Roadmap](build-roadmap.md).

Pricing is a **fixed platform subscription + a settlement minimum**, not per-payment bps.
[Contact us](mailto:hello@zbase.app).

## The premium product: self-sovereign compliance data

The enterprise offering isn't "the same thing, cheaper at volume." It's a **different product**: a
viewing-key-gated, self-custodied dataset of the enterprise's **own** agents' transactions — the data
they need for AML screening and reporting, held by them, not by us.

Only a privacy-native facilitator can offer *"self-custody your compliance data."* A normal
facilitator either sees everything (so you must trust them with it) or nothing (so you can't report).
zBase gives the enterprise a private ledger only their viewing key can read.

## Why privacy is priced as a premium

Privacy is the product, not a discount lever. zBase settles the standard `exact` EIP-3009 payment any
Coinbase-CDP seller already accepts, screens every deposit against the OFAC + hack list, and has no token
to farm or inflate — the fee is the business, cleanly. Competing to be the cheapest facilitator is a
weak position; being the private, compliant one that still works with the sellers you already pay is
the durable one. See [How zBase compares](how-zbase-compares.md).
