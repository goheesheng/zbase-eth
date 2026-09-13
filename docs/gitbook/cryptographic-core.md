# The cryptographic core

The math and data structures every other doc page assumes you understand.

## Proof system — Groth16 over BN254

zBase uses Groth16 zk-SNARKs over the BN254 pairing-friendly curve.

| Property | Value |
|---|---|
| Proof size | ~200 bytes (3 group elements) |
| Verifier time | Constant — one pairing equation |
| Setup | Per-circuit trusted setup required |
| Curve | BN254 (alt_bn128) |
| On-chain verifier | Solidity `WithdrawalVerifier` deployed at `0x5f5505242730dfc8a2c2637eb5258dc2c6622641` (Base Sepolia) |

Two circuits are in scope:

| Circuit | Status | Source |
|---|---|---|
| `commitment` | Live | 0xbow, audited + unmodified |
| `withdrawal` | Live | 0xbow, audited + unmodified |

These are the vendored 0xbow Privacy Pool circuits. Their Groth16 trusted setup was
performed and audited by 0xbow; zBase inherits it and does not run its own ceremony.

## Hash — Poseidon

Inside the circuits, every hash is **Poseidon** (a ZK-friendly hash). Poseidon
is dramatically cheaper than Keccak inside an arithmetic circuit.

Where Poseidon shows up:

| Object | Definition |
|---|---|
| `commitment` | `Poseidon(amount, label, precommitment)` |
| `precommitment` | `Poseidon(nullifier, secret)` |
| `nullifierHash` | `Poseidon(nullifier)` |
| Merkle parent | `Poseidon(left, right)` (LeanIMT) |

`label` is the one exception — it is computed on-chain as
`keccak256(SCOPE, nonce)` because the depositor doesn't need to prove it inside
the circuit at deposit time.

## State tree — LeanIMT

The on-chain pool maintains the state tree as a **Lean Incremental Merkle Tree**.
LeanIMT is append-only, supports O(log n) inserts, and only requires storing the
right-hand path of the rolling root.

Key behaviors:

- Inserts emit a `LeafInserted` event with `(index, leaf)`.
- The off-chain state tree must reconstruct from **all** `LeafInserted` events,
  not only `Deposited` events. Withdrawal change commitments also insert leaves.
- Tree depth is fixed per pool; the vendored 0xbow pool uses depth 32.

> Common bug: rebuilding the state tree from only `Deposited` events misses
> change commitments from prior withdrawals and produces the wrong state root,
> which fails as `InvalidProof`.

## Public signals on settle

When a Base Sepolia withdrawal lands, the on-chain verifier checks a Groth16
proof with these public signals:

| Signal | Purpose |
|---|---|
| `stateRoot` | The pool's state Merkle root the proof is bound to |
| `ASPRoot` | The approved-subset root the proof is bound to |
| `nullifierHash` | Spent-note marker; rejected if seen before |
| `newCommitment` | The change commitment to insert after spend |
| `context` | `keccak256(withdrawal, scope) % SNARK_FIELD` — binds recipient |
| `withdrawnAmount` | Amount paid out (visible today; encrypted in a future release) |

`context` is the recipient binding: a postman that rewrites the recipient
address changes `keccak256(withdrawal, ...)`, which fails verification.

## Nullifier accounting

Each note has a single nullifier. The pool stores a `nullifierUsed[hash]`
mapping. Any attempt to reuse the nullifier reverts. This is how double-spend
is prevented without linking the spend to the deposit.

## Where the keys live

| Artifact | Path | Notes |
|---|---|---|
| Compiled WASM (browser proof gen) | `public/circuits/*.wasm` | Served to the browser/server at runtime |
| Compiled zkey (proving key) | `trusted-setup/final-keys/*.zkey` | **Authoritative** — matches deployed verifier |
| Build artifacts zkey | `build/*.zkey` | **Do not use** — does not match the deployed verifier |
| Verifier contract bytecode | Deployed on Base Sepolia | Address in [Contracts reference](contracts-reference.md) |

> Common bug: using `build/` zkeys instead of `trusted-setup/final-keys/`. The
> `build/` keys are from a fresh local compile and will not match the on-chain
> verifier — proofs will validate locally and fail on chain.
