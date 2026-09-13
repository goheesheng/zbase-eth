# Anonymity-Set Disclosure

**Last updated:** 2026-06-09
**Maintainer:** zBase team (treasury: `0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843`)
**Next update:** 2026-08-29 (quarterly cadence; see [Schedule](#schedule))

---

## TL;DR

zBase pools are seeded by the treasury at launch so the first organic
depositor is not the only person hiding in the crowd. We tell you exactly
how many seed notes exist, in which denominations, and we pledge to keep
publishing the seed-vs-organic split every quarter. The seed value will be
reclaimed by the treasury after **2026-12-01**, but the seed commitments stay
in the anonymity set forever — once a commitment is in the Merkle tree it
cannot be removed.

This document mirrors the disclosure practice of [0xbow Privacy
Pools](https://privacypools.com), whose initial anonymity set was seeded by
Vitalik Buterin with [$113K](https://x.com/0xbowio/status/1763213175837880464)
in March 2024. The Privacy Pools research paper, co-authored by Vitalik,
explicitly endorses transparent seeding as an honest bootstrap mechanism.

---

## Why seeding is necessary (the math)

A privacy pool's anonymity set is the set of deposits that could plausibly
fund a given withdrawal. If only 5 commitments exist, an observer guesses
correctly 1-in-5 — that is **not privacy**, that is a one-bit obfuscation.

Industry consensus from [Privacy Pools (Buterin et al., 2023)][pp] and the
[Tornado Cash anonymity-set
analysis (Béres et al., 2021)][beres] is that meaningful unlinkability needs
**≥100 deposits per denomination** and ideally 1,000+. We seed to 100 per
denom on day one so the first real depositor lands in a pool of 101, not a
pool of 1.

[pp]: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4563364
[beres]: https://arxiv.org/abs/2005.14051

---

## Current pool composition

> **How to verify these numbers:** every commitment is published on-chain via
> the `LeafInserted` event on the pool contract. The seed commitments are
> also listed in plaintext in `data/seed-notes.encrypted.json` under the
> `pools[*].commitments` array (this metadata is NOT encrypted — only the
> spending material is). Anyone can replay our deposit transactions from the
> seed timestamp and confirm the counts.

### Base Sepolia — USDC pool (plain 0xbow PrivacyPool, no yield)

- **Pool address:** `0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a`
- **Seed cutoff timestamp:** TBD (filled in by the seed script after first run)

| Denomination | Seed notes | Organic notes | Treasury share |
|--------------|-----------:|--------------:|---------------:|
| 1 USDC       | 25         | TBD           | TBD %          |
| 10 USDC      | 25         | TBD           | TBD %          |
| 100 USDC     | 25         | TBD           | TBD %          |
| 1,000 USDC   | 25         | TBD           | TBD %          |
| **Total**    | **100**    | **TBD**       | **TBD %**      |

> The values above are the design intent. The live counts are derived from
> the on-chain `Deposited` events and the seed manifest published with each
> quarterly update.

### Base mainnet — USDC pool

Pending mainnet deployment (tracked under `CEO_GOAL_MAINNET.md`). The mainnet
seed will mirror Base Sepolia at first, then ramp per the funding plan in
[`docs/grants/base-ecosystem-fund-application.md`](./grants/base-ecosystem-fund-application.md).

---

## How "reclaim" affects the anonymity set

The treasury can withdraw the *value* of its seed deposits after the lock
period (`2026-12-01`), but it cannot withdraw the *commitments*. Here is the
distinction in plain language:

1. **A commitment is a Merkle-tree leaf.** It is a one-way Poseidon hash that
   binds together a value, a label, a nullifier and a secret. Once inserted,
   it can never be removed from the tree.
2. **A withdrawal burns a nullifier.** It proves "some commitment in this
   tree is mine, here is its nullifier-hash, please pay X." The commitment
   is NOT removed from the tree — only the nullifier is marked spent.
3. **Therefore reclaim does NOT shrink the anonymity set.** The seed
   commitments continue to provide cover for organic withdrawals forever,
   even after the treasury has pulled its USDC back out.

This is the same reason Vitalik's $113K seed of 0xbow continues to provide
cover today, even though most of those funds have long since been recycled.

### Why the nominal count is not the effective count

The on-chain commitment count is the **nominal** anonymity set. It is the
number reported by `/api/anonymity-set`. The **effective** anonymity set
for a given organic user is strictly smaller, for three reasons that
compound:

1. **Seed commitments are publicly attributable.** The seed depositor is the
   treasury address `0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843`. The
   anonymity-set endpoint itself tags every deposit as `seeded` vs `organic`
   by checking the depositor (`src/app/api/anonymity-set/route.ts:301-311`).
   A chain analyst applies the same heuristic and subtracts those
   commitments when modeling organic privacy.
2. **Amount buckets are public.** `_value` is plaintext in the `Deposited`
   event. A withdrawal of `1.000000 USDC` is restricted to commitments with
   that exact post-fee value. See [Threat model — What we currently leak](gitbook/threat-model.md#what-we-currently-leak-operational-honesty).
3. **ASP-approved subset.** The withdrawal circuit enforces label
   membership in the ASP tree. Today this equals the full state set; under
   active compliance filtering it will be a strict subset.

Worked example using current Base Sepolia integration-test numbers (126
commitments, ~30 publicly attributable as treasury seeds, four supported
denominations `1 / 10 / 100 / 1000 USDC`):

```
nominal_set          = 126
post-seed-subtract   = 126 − 30 ≈ 96       (publicly visible)
post-amount-bucket   ≈ 96 / 4   ≈ 24       (if denominations are equi-distributed)
post-ASP-filter      ≈ 24                  (today; equal to above)
```

A worst-case effective anonymity set for an early organic 1-USDC depositor
is therefore on the order of 20-40, not 126. This is why we treat 100
seeds **per denomination** as the floor, not 100 seeds total.

---

## What the seed cannot hide

We want to be precise about the limits of seeding, because lying about
privacy is worse than admitting its boundaries:

- **Seeding does not protect against the FIFO timing attack** [(arXiv
  2510.09433)][fifo]. A withdrawal that happens within seconds of a deposit
  is correlatable regardless of pool size. zBase enforces a 60-second
  minimum delay (`ZBASE_MIN_DEPOSIT_DELAY_SECONDS`) in
  `src/app/api/withdraw/route.ts`. Seeding is orthogonal.
- **Seeding does not protect against amount-correlation.** If only one
  organic depositor ever puts in `42.0001 USDC`, no anonymity set will save
  them. Always use round denominations; the API will refuse atypical amounts
  on mainnet.
- **The treasury knows which commitments are seeds.** We do. That is a
  trust boundary you accept when you use zBase — we promise (and verify via
  this disclosure) that we publish counts honestly and never use that
  knowledge to de-anonymize an organic user.

[fifo]: https://arxiv.org/abs/2510.09433

---

## What the seed IS doing

- **Hiding the first 100 organic depositors.** The most vulnerable users are
  the first 5-10 — without a seed they are trivially identifiable. Our seed
  ensures they walk into a pool of 100+ commitments.
- **Seed value sits idle.** The live pool is a plain 0xbow PrivacyPool — no yield
  (deposits, seed or organic, earn nothing). Yield on idle deposits is something
  we're exploring (not deployed); if shipped, the treasury's reclaim would not
  strip yield from organic depositors.
- **Demonstrating skin in the game.** The treasury locks USDC of its own for
  >6 months before any reclaim. Mirroring Vitalik's signal at 0xbow.

---

## Schedule

We publish an updated composition report on the **last Wednesday of each
quarter**, signed by `0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843`, and link
it from this document.

| Quarter | Publication target | URL                                                |
|---------|--------------------|----------------------------------------------------|
| Q2 2026 | 2026-06-24         | pending                                            |
| Q3 2026 | 2026-09-30         | pending                                            |
| Q4 2026 | 2026-12-29         | pending (first post-reclaim composition)           |
| Q1 2027 | 2027-03-31         | pending                                            |

---

## Reproducibility

To verify the seed at any time, anyone can:

```bash
# 1. Fetch all Deposited events from the pool contract on Base.
cast logs --address 0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a \
  --from-block <SEED_BLOCK> --to-block <SEED_BLOCK_END> \
  'Deposited(address,uint256,uint256,uint256,uint256)'

# 2. Count the events emitted by the treasury address.
#    These are the seed deposits.

# 3. Cross-reference with the published commitments list in
#    data/seed-notes.encrypted.json -> pools[*].commitments
```

The seed script source (`scripts/seed-pools.ts`) and the encrypted notes
metadata are both committed to the repo. Only the spending material
(nullifiers + secrets) is encrypted, so the count of seed notes is always
publicly verifiable.

---

## Honest precedent

The differentiator between zBase and a privacy-washing project is not
"we don't seed" — it is "we tell you we seed, and we tell you exactly how
much." Privacy products that hide their bootstrap deposits are *lying*; we
choose the same path Vitalik chose at 0xbow: lock real money, publish the
count, and pledge to keep publishing.

If the counts above ever drift from what you observe on-chain, that is a bug
or a breach of our pledge — please open an issue at
<https://github.com/goheesheng/zx402/issues> and we will respond within 48h.
