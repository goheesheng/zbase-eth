# How the Money Flows

Walking through the architecture as a money trail. Six actors, three vaults,
four distinct money movements per full cycle.

## The actors

| Actor | Role |
|---|---|
| **Agent operator** | Has USDC, wants to pay APIs privately |
| **Agent** (autonomous code) | Makes x402 calls on the operator's behalf |
| **Provider** (OpenAI, Tavily, etc.) | Sells an API for USDC |
| **Facilitator** (zBase) | Orchestrates verify/settle, generates proofs, relays tx |
| **Postman** | Curates the ASP root (single-key today, 3-of-5 threshold in a future release) |
| **Chain** (Base today) | Executes settle, verifies proof |

## The three vaults — where USDC actually sits

| Vault | Holds | Controlled by |
|---|---|---|
| **Operator wallet** | USDC pre-deposit | Operator's private key |
| **Privacy Pool contract** | All shielded USDC | ZK proof + ASP root + nullifier check |
| **Stealth recipient address** | A single payment, briefly | Provider's scanning key derives the address |

The pool contract is the **only place** money pools across users. That's what
creates the anonymity set — your deposit commitment sits with other historical
commitments. The pool holds USDC in the pool contract until it is withdrawn.

## Money flow #1 — Deposit (cold path, once per top-up)

```
Operator wallet         Privacy Pool contract
─────────────           ─────────────────────
[1000 USDC] ─────────► [pool +1000 USDC]
                       commitment hash
                       stored in Merkle tree
```

1. Operator calls `pool.deposit(amount, commitmentHash)`. The commitment is
   `Poseidon(amount, label, precommitment)` — a hash only the operator can later
   prove they own.
2. **USDC moves: Operator → Pool contract.** Public on chain.
3. Pool emits `Deposited` event with the commitment hash and label.
4. **Postman watches** the deposit, runs the ASP risk check (sanctions, mixer
   exposure, source-of-funds). If approved, label enters the ASP Merkle root.
5. Operator now holds the deposit spend secrets (`nullifier`, `secret`, plus
   event-derived `value`, `label`, and `commitment`). Current hosted proving
   sends these secrets to the trusted facilitator at settle time; client-side
   proving is the roadmap path that removes this trust.

**What observers see:** "Wallet X deposited some USDC into the pool." That's it.

## Money flow #2 — Payment via x402 (hot path, ~7-15s per payment after initial deposit)

```
Agent                Facilitator             Pool contract           Stealth address
─────                ───────────             ─────────────           ───────────────
GET /api ──────────► [402 Payment Required]
                     payTo: meta-addr
                     amount: $0.50

[receive 402] ─────► /facilitator/settle
                     { note, providerMeta }

                     [Gate 2 policy check]
                     ✓ provider allowlisted
                     ✓ within tx + daily cap

                     [derive stealth addr] ───────────────────────► [stealth_addr_for_this_call]

                     [generate Groth16 proof]
                     [relay tx on-chain] ───► [verify proof]
                                              [check nullifier unspent]
                                              [check ASP root matches]
                                              [transfer to stealth_addr] ─► [receives $0.50]
                                              [insert new change commitment]

[retry with txhash] ─[200 OK + API response]                                      Provider scans,
                                                                                  sees $0.50 arrived
```

1. Agent calls `https://api.openai.com/v1/...`. Provider responds `HTTP 402`
   with meta-address and amount.
2. Agent SDK forwards to **facilitator's `/settle` endpoint** with the encrypted
   note reference.
3. **Facilitator's Gate 2 checks** (in memory, no on-chain cost): provider
   allowlist, per-tx cap, daily cap, velocity. Reject otherwise.
4. **Facilitator derives a fresh stealth address** for this one payment via
   ERC-5564. Only the provider's scanning key can recognize it.
5. **Facilitator generates Groth16 proof.** Private inputs: note details,
   Merkle path. Public inputs: nullifier hash, new commitment, ASP root, paid
   amount, recipient binding context.
6. **On-chain execution:**
   - Verify Groth16 proof
   - Check nullifier unspent
   - Check ASP root matches
   - Transfer to stealth address (USDC: Pool → Stealth address)
   - Insert new change commitment in Merkle tree
7. Agent retries the API call with the settlement tx hash. Provider sees the tx,
   returns the data.
8. **Provider's background scanner** runs over recent block events with the
   scanning key, recognizes the stealth address as theirs, sweeps to treasury.

**What observers see:** a Groth16 verification + a USDC transfer to an unknown
address. No payer, no provider, no amount link.

**Spent once, even if the response is lost.** The withdrawal in step 6 is the only place the
note is spent, and settlement is **idempotent on the note's nullifier**: the facilitator
reserves the nullifier before withdrawing and records the signed payment header after, so a
lost or timed-out response replays the same payment instead of withdrawing a second time. An
on-chain `nullifierHashes` check backstops a lost record. The buyer SDK mirrors this with a
tri-state — a `settled:false` throw means *provably* unspent (safe to retry), an `uncertain`
result means *maybe spent* (retry the same call, never pay from a different note). See
[Handling failures safely](pay-privately-quickstart.md) and the idempotency spec in
`docs/strategy/settlement-idempotency-spec-2026-07-20.md`.

## Money flow #3 — Provider sweep (when they feel like it)

```
Stealth addresses          Provider treasury
─────────────────          ─────────────────
[$0.50, $0.40, $1.20 ────► [aggregated revenue]
 across N stealth addrs]
```

Provider runs a scanner, finds incoming transfers matching their scanning key,
sweeps to main treasury. Standard transfers — no privacy gymnastics needed.

Tax + audit friendly: provider can prove (via accounting) which stealth
addresses belong to them, without exposing individual customers.

## Money flow #4 — Operator cash-out

```
Pool contract             Operator's fresh withdrawal address
─────────────             ───────────────────────────────────
[USDC principal] ────────► [operator gets principal, minus any configured take]
```

1. Operator generates a withdrawal proof (same circuit as payment, paying
   themselves to a fresh address).
2. Pool verifies proof, checks nullifier + ASP root.
3. Pool transfers USDC directly to the fresh address.
4. Operator has cashed out. The fresh address has zero on-chain link to the
   original deposit wallet.

## What the chain reveals at each step

| Action | Public on chain | Hidden |
|---|---|---|
| Deposit | wallet, pool contract, amount | which provider you'll pay |
| ASP root update | new ASP root hash | which deposit was approved |
| Settle (current single-value) | proof, nullifier, amount, new commitment, recipient or stealth address | payer wallet, direct payer→provider link |
| Provider sweep | stealth addr → provider treasury | which customer the funds came from |
| Cash-out | new commitment + pool → fresh wallet | link to original deposit wallet |

## What the facilitator can see today

- Deposit spend secrets during server-side proving (`nullifier` + `secret`).
- Payment amount and recipient / stealth derivation inputs.
- The request context after middleware strips common metadata headers.

This is why SDK docs say to pin `baseUrl` to a facilitator you operate or trust.
Client-side proving is the planned way to stop sending spend secrets to the
facilitator.

That's the architecture. Per-layer detail in the **Privacy Layers** sidebar.
