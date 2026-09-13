/**
 * zBase Privacy Library
 *
 * Handles Poseidon-based commitments, Merkle tree operations,
 * and Groth16 ZK proof generation in the browser using snarkjs.
 */

import { poseidon2, poseidon3 } from "poseidon-lite";
import { LeanIMT, type LeanIMTMerkleProof } from "@zk-kit/lean-imt";
import { encodeAbiParameters, keccak256 } from "viem";

// BN254 scalar field
const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ═══ TYPES ═══

export interface DepositSecrets {
  nullifier: bigint;
  secret: bigint;
  precommitment: bigint;
  commitment: bigint;
  label: bigint;
  value: bigint;
}

export interface WithdrawalInputs {
  withdrawnValue: bigint;
  stateRoot: bigint;
  stateTreeDepth: bigint;
  ASPRoot: bigint;
  ASPTreeDepth: bigint;
  context: bigint;
  label: bigint;
  existingValue: bigint;
  existingNullifier: bigint;
  existingSecret: bigint;
  newNullifier: bigint;
  newSecret: bigint;
  stateSiblings: bigint[];
  stateIndex: bigint;
  ASPSiblings: bigint[];
  ASPIndex: bigint;
}

// ═══ RANDOM GENERATION ═══

export function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result % SNARK_FIELD;
}

// ═══ COMMITMENT GENERATION ═══

export function generateDepositSecrets(value: bigint, scope: bigint): DepositSecrets {
  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const precommitment = poseidon2([nullifier, secret]);
  const label = scope; // placeholder — real label comes from on-chain event
  const commitment = poseidon3([value, label, precommitment]);

  return { nullifier, secret, precommitment, commitment, label, value };
}

// ═══ MERKLE TREE ═══

export function buildMerkleTree(leaves: bigint[]): LeanIMT<bigint> {
  const tree = new LeanIMT<bigint>((a: bigint, b: bigint) => poseidon2([a, b]));
  if (leaves.length > 0) {
    tree.insertMany(leaves);
  }
  return tree;
}

function padSiblings(siblings: bigint[], targetLength: number = 32): bigint[] {
  if (siblings.length >= targetLength) return siblings;
  return [...siblings, ...Array(targetLength - siblings.length).fill(0n)];
}

export function generateMerkleProof(
  leaves: bigint[],
  leaf: bigint
): LeanIMTMerkleProof<bigint> {
  const tree = buildMerkleTree(leaves);
  const index = tree.indexOf(leaf);
  if (index === -1) {
    throw new Error("Leaf not found in Merkle tree");
  }
  const proof = tree.generateProof(index);
  proof.siblings = padSiblings(proof.siblings);
  return proof;
}

// ═══ CONTEXT COMPUTATION ═══

/**
 * Compute the withdrawal context hash, matching the on-chain check:
 * context = uint256(keccak256(abi.encode(Withdrawal{processooor, data}, scope))) % SNARK_FIELD
 */
export function computeContext(
  processooor: `0x${string}`,
  data: `0x${string}`,
  scope: bigint
): bigint {
  const encoded = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "processooor", type: "address" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "scope", type: "uint256" },
    ],
    [{ processooor, data }, scope]
  );
  return BigInt(keccak256(encoded)) % SNARK_FIELD;
}

// ═══ WITHDRAWAL DATA ENCODING ═══

/**
 * Encode RelayData for the withdrawal.data field
 */
export function encodeRelayData(
  recipient: `0x${string}`,
  feeRecipient: `0x${string}`,
  relayFeeBPS: bigint
): `0x${string}` {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "recipient", type: "address" },
          { name: "feeRecipient", type: "address" },
          { name: "relayFeeBPS", type: "uint256" },
        ],
      },
    ],
    [{ recipient, feeRecipient, relayFeeBPS }]
  );
}

// ═══ ZK PROOF GENERATION ═══

/**
 * Generate a full private withdrawal proof in the browser.
 * This proves you own a deposit without revealing which one.
 */
export async function generateWithdrawalProof(
  inputs: WithdrawalInputs
): Promise<{ proof: unknown; publicSignals: string[] }> {
  const snarkjs = await import("snarkjs");

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    inputs as unknown as Record<string, unknown>,
    "/circuits/withdraw/withdraw.wasm",
    "/circuits/withdraw/groth16_pkey.zkey"
  );

  return { proof, publicSignals };
}

/**
 * Generate a commitment proof (for ragequit).
 */
export async function generateCommitmentProof(
  value: bigint,
  label: bigint,
  nullifier: bigint,
  secret: bigint
): Promise<{ proof: unknown; publicSignals: string[] }> {
  const snarkjs = await import("snarkjs");

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { value, label, nullifier, secret },
    "/circuits/commitment/commitment.wasm",
    "/circuits/commitment/groth16_pkey.zkey"
  );

  return { proof, publicSignals };
}

// ═══ FORMAT PROOF FOR SOLIDITY ═══

export function formatProofForSolidity(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}, publicSignals: string[]) {
  return {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])] as [bigint, bigint],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])] as [bigint, bigint],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
    pubSignals: publicSignals.map(s => BigInt(s)),
  };
}

// ═══ SERIALIZATION ═══

export function serializeDepositSecrets(secrets: DepositSecrets): string {
  return JSON.stringify({
    nullifier: secrets.nullifier.toString(),
    secret: secrets.secret.toString(),
    precommitment: secrets.precommitment.toString(),
    commitment: secrets.commitment.toString(),
    label: secrets.label.toString(),
    value: secrets.value.toString(),
  });
}

export function deserializeDepositSecrets(json: string): DepositSecrets {
  const parsed = JSON.parse(json);
  return {
    nullifier: BigInt(parsed.nullifier),
    secret: BigInt(parsed.secret),
    precommitment: BigInt(parsed.precommitment),
    commitment: BigInt(parsed.commitment),
    label: BigInt(parsed.label),
    value: BigInt(parsed.value),
  };
}
