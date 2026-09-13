# Circuits reference

Each circuit zBase ships, its signal layout, and its deployment status.

## Inventory

| Circuit | File | Status | Purpose |
|---|---|---|---|
| `commitment` | `commitment.circom` | Live | Verify a freshly-formed commitment is well-formed at deposit time |
| `withdrawal` | `withdrawal.circom` | Live | Prove ownership of a deposit + membership in state and ASP roots |

## `commitment` signals

Public:

| Signal | Meaning |
|---|---|
| `commitment` | Poseidon(amount, label, precommitment) |
| `value` | Deposit amount (pre-fee public, post-fee in commitment) |
| `label` | `keccak256(SCOPE, nonce)` |

Private:

| Signal | Meaning |
|---|---|
| `nullifier` | Note nullifier |
| `secret` | Note secret |
| `precommitment` | `Poseidon(nullifier, secret)` |

## `withdrawal` signals

Public:

| Signal | Meaning |
|---|---|
| `stateRoot` | Current state Merkle root |
| `ASPRoot` | Current approved-subset root |
| `nullifierHash` | `Poseidon(nullifier)`; rejected if seen before |
| `newCommitment` | Change commitment to insert post-spend |
| `withdrawnAmount` | Amount paid |
| `context` | `keccak256(withdrawal, scope) % SNARK_FIELD` — binds recipient |

Private:

| Signal | Meaning |
|---|---|
| `nullifier`, `secret`, `value`, `label` | Note fields |
| `stateProof` | Merkle path to `stateRoot` |
| `aspProof` | Merkle path to `ASPRoot` |
| `newNullifier`, `newSecret`, `newValue` | Change-note components |

## Artifacts

Compiled outputs the facilitator and frontend load at runtime:

| Artifact | Path | Notes |
|---|---|---|
| WASM (witness generation) | `public/circuits/*.wasm` | Browser + server consume |
| Proving key (.zkey) | `trusted-setup/final-keys/*.zkey` | **Authoritative** — matches deployed verifier |
| Build-time zkey | `build/*.zkey` | Do not use — does not match the deployed verifier |
| Verification key (.json) | `public/circuits/*.vkey.json` | Browser-side verify |

Next → [SDK overview](sdk-overview.md)
