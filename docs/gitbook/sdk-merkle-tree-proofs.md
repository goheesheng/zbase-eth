# Merkle tree & proofs

How the state tree gets built off-chain, how Groth16 proofs get generated, and
the failure modes that come from stale state.

## State tree reconstruction

The on-chain pool emits one `LeafInserted(index, leaf)` per insert. Inserts
happen on both:

- `deposit()` — the depositor's new commitment
- `withdraw()` / `relay()` — the change commitment from the withdrawal

To compute a proof, the SDK rebuilds the tree from **all** `LeafInserted`
events since `Deploy block 40668000`.

> Common bug: rebuilding from only `Deposited` events misses change
> commitments and produces the wrong state root. The proof verifies locally
> (against the wrong root) then fails on-chain as `InvalidProof`.

```ts
// Pseudocode for the rebuild loop
const events = await getLogs({
  fromBlock: DEPLOY_BLOCK,
  toBlock: 'latest',
  topics: [LEAF_INSERTED_TOPIC],
  chunkSize: 9000,             // public RPCs cap at 10K
  delayBetweenChunks: 500,
});
const tree = new LeanIMT(POSEIDON);
for (const ev of events.sort(byIndex)) tree.insert(ev.leaf);
```

## RPC realities

| Constraint | Detail |
|---|---|
| Public Base Sepolia RPC | 10K-block `eth_getLogs` cap |
| Infura on Base Sepolia | 429-rate-limits aggressive paging |
| HyperRPC (envio) | Recommended path — `HYPERSYNC_TOKEN` env var |

Use HyperRPC for the rebuild in production. The dev path tolerates public
RPCs but is slow on a cold cache.

## ASP root freshness

The ASP root goes stale after every new deposit. The facilitator's
`/api/asp-update` endpoint:

1. Fetches recent `Deposited` events.
2. Runs the off-chain risk pipeline against each label.
3. Builds the approved-subset Merkle tree.
4. Calls `updateRoot()` on the entrypoint with the new root.

A proof generated against a stale ASP root fails verification. The facilitator
calls `/api/asp-update` automatically after each deposit, but integrators
running their own deposit flow must trigger this themselves.

> `updateRoot()` needs explicit `gas: 200_000n`. Gas estimation fails on this
> path and returns the block gas limit, which the RPC then refuses.

## Proof generation

Proof generation uses `snarkjs.groth16.fullProve` with:

- WASM circuit at `public/circuits/<circuit>.wasm`
- proving zkey at `trusted-setup/final-keys/<circuit>.zkey`

```ts
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  inputSignals,
  '/circuits/withdrawal.wasm',
  '/trusted-setup/final-keys/withdrawal.zkey',
);
```

> Always use `trusted-setup/final-keys/` — not `build/`. The `build/` zkey is
> from a fresh local compile and will not match the deployed verifier contract.

## Proof verification path

| Layer | What it does |
|---|---|
| Client-side `snarkjs.verify` | Sanity check before relay |
| `WithdrawalVerifier` (on-chain) | Solidity pairing verifier — source of truth |

Even if local verify passes, an on-chain reject is the authoritative answer.
The two diverge most often on stale state roots.

## Retry on change-commitment lag

After a settle, the change commitment is inserted in the pool's tree. The
next settle from `nextDeposit` will fail until the indexer sees the insert.
The facilitator retries briefly to absorb this lag. If you're driving
`/api/withdraw` directly, retry with a short delay before treating an
`InvalidProof` as a real failure.

## Gas tips

| Tx | Gas hint | Why |
|---|---|---|
| `deposit()` | `1_000_000n` | Poseidon hashing + LeanIMT insert in the plain 0xbow pool |
| `updateRoot()` | `200_000n` | Estimation fails; supply explicit |
| `relay()` (withdrawal) | RPC-estimated is fine | Verifier + transfer |

Next → [Wallet backend API](wallet-backend-api.md)
