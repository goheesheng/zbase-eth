# Concepts & glossary

A reference for the terms you will see repeatedly across these docs. If a
definition here contradicts code, the code wins — file a doc fix.

## Cryptographic primitives

**Groth16** — the zk-SNARK proof system zBase uses. Constant-sized proofs
(~200 bytes), constant verification time, requires a per-circuit trusted setup.
The on-chain verifier contract is the deployed `WithdrawalVerifier` on Base
Sepolia.

**Poseidon** — the ZK-friendly hash function used for commitment computation
inside the circuits. Far cheaper than Keccak inside an arithmetic circuit.

**BN254** — the pairing-friendly elliptic curve used by Groth16 on Ethereum.
Both Solidity and Solana have native precompiles or programs for BN254 ops.

**LeanIMT** — Lean Incremental Merkle Tree. The append-only Merkle structure the
pool uses for the state root. Updates require only the new leaf path, not a
full rebuild.

## Pool objects

**Commitment** — a Poseidon hash of `(amount, label, precommitment)`. Stored
in the state tree on deposit. Spending a note proves you know the preimage
without revealing it.

**Nullifier** — a deterministic derivation from the note secret that gets
published on spend. The pool rejects any nullifier it has seen before. This is
how double-spend is prevented without linking the spend to the deposit.

**Note** — the off-chain bundle the depositor keeps: `nullifier`, `secret`,
`value`, `label`, `commitment`. The note is encrypted under the user's viewing
key.

**Label** — a unique per-deposit identifier computed on-chain as
`keccak256(SCOPE, nonce)`. The ASP curates approval at label granularity.

**Anonymity set** — the number of approved commitments in the current ASP root
at the time of a withdrawal. Privacy is at most one-in-`N`. The latest Base
Sepolia run reported `anonymitySet = 77`.

## Compliance objects

**ASP (Association Set Provider)** — the postman role that screens deposit
labels (against the OFAC SDN list ∪ a curated Tornado/hack overlay) and
publishes an `ASPRoot` containing the approved subset. Today: single key. In a
future release: a roadmap 3-of-5 threshold (see the [Roadmap](build-roadmap.md)).
See the [Trust model](trust-model.md) for how live screening works.

**ASPRoot** — Merkle root of the currently approved labels. A withdrawal proof
must show membership in both the `stateRoot` (any deposit) and the `ASPRoot`
(approved deposits).

**Postman** — the operator that relays a withdrawal transaction on the user's
behalf so the payer wallet is not the transaction sender. The postman is
recipient-bound by the proof's `context` public signal — it cannot redirect
funds.

## Privacy primitives

**Stealth address** — an ERC-5564 secp256k1 address derived per payment from the
provider's published meta-address. Two payments to the same provider land at
two different addresses. See [Stealth addresses](stealth-recipients.md).

**Meta-address** — the long-lived public identifier a provider registers once.
The facilitator uses it + an ephemeral nonce to derive a fresh stealth address
per call.

**Decoy withdrawal** — a real Groth16-proved withdrawal to a burn address,
emitted at Poisson-distributed intervals to break the FIFO timing heuristic.
Scaffolded, **not running in production** today.

## x402 terms

**`paymentDetails`** — the body a provider returns with `HTTP 402` describing
amount, recipient, scheme, and network.

**`zbaseDeposit`** — the note bundle a trusted client/backend sends to the
configured facilitator on `/verify` and `/settle`. Its `nullifier` + `secret`
are spend authority; users should never paste it into an LLM chat or give it to
an untrusted agent.

**`nextDeposit`** — the change-note bundle returned by `/settle` when value
remains. The original note is spent after a settle; the agent must save
`nextDeposit` for the next payment.

**`X-Zx402-Settlement`** — the response header the agent attaches to the retry
of the originally-402'd call. Carries the settlement transaction hash so the
provider can confirm payment.
