/**
 * @zbase-protocol/core — Chain-agnostic ZK proof generation
 *
 * Uses snarkjs for Groth16 proof generation. The circuits are universal:
 * same WASM + zkey files work regardless of which chain the proof is verified on.
 *
 * snarkjs is an OPTIONAL dependency (SDK audit 2026-07-09): it is ~9 MB and only
 * needed by consumers who actually GENERATE a proof. It is loaded LAZILY inside
 * the two functions below, so a consumer using only the Poseidon/Merkle/stealth/
 * facilitator primitives never pulls it in. If snarkjs isn't installed, the lazy
 * import throws a clear message pointing the consumer to add it.
 */

import { createRequire } from "node:module";

async function loadSnarkjs(): Promise<{
  groth16: {
    fullProve: (input: unknown, wasm: string, zkey: string) => Promise<{ proof: unknown; publicSignals: unknown }>;
    verify: (vkey: unknown, pubSignals: unknown, proof: unknown) => Promise<boolean>;
  };
}> {
  try {
    const requireCjs = createRequire(import.meta.url);
    return requireCjs("snarkjs");
  } catch {
    throw new Error(
      "snarkjs is required for proof generation but is not installed. " +
        "It is an optional dependency of @zbase-protocol/core — run `npm i snarkjs` to enable generateWithdrawalProof/verifyProofLocally.",
    );
  }
}

/**
 * Inputs to the upstream withdraw.circom (template `Withdraw(maxTreeDepth=32)`).
 * Order and names mirror the circuit's signal declarations exactly. Padding:
 * `stateSiblings` and `ASPSiblings` MUST be padded with zeros to length 32.
 *
 * Public signals returned by snarkjs (in order):
 *   [0] newCommitmentHash       (output)
 *   [1] existingNullifierHash   (output)
 *   [2] withdrawnValue
 *   [3] stateRoot
 *   [4] stateTreeDepth
 *   [5] ASPRoot
 *   [6] ASPTreeDepth
 *   [7] context
 */
export interface ProofInput {
  // Public inputs
  withdrawnValue: string;
  stateRoot: string;
  stateTreeDepth: string;
  ASPRoot: string;
  ASPTreeDepth: string;
  context: string;

  // Private inputs
  label: string;
  existingValue: string;
  existingNullifier: string;
  existingSecret: string;
  newNullifier: string;
  newSecret: string;
  stateSiblings: string[]; // length 32
  stateIndex: string;
  ASPSiblings: string[]; // length 32
  ASPIndex: string;
}

export interface Groth16Proof {
  pi_a: [string, string];
  pi_b: [[string, string], [string, string]];
  pi_c: [string, string];
  protocol: "groth16";
  curve: "bn128";
}

export interface ProofResult {
  proof: Groth16Proof;
  publicSignals: string[];
  proofTimeMs: number;
}

/**
 * Generate a Groth16 withdrawal proof.
 * Chain-agnostic: works for both EVM and Solana verifiers.
 */
export async function generateWithdrawalProof(
  input: ProofInput,
  wasmPath: string,
  zkeyPath: string
): Promise<ProofResult> {
  const startTime = Date.now();

  const snarkjs = await loadSnarkjs();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );

  return {
    proof: proof as Groth16Proof,
    publicSignals: publicSignals as string[],
    proofTimeMs: Date.now() - startTime,
  };
}

/**
 * Verify a Groth16 proof locally (for testing, not on-chain verification).
 */
export async function verifyProofLocally(
  proof: Groth16Proof,
  publicSignals: string[],
  vkeyPath: string
): Promise<boolean> {
  const snarkjs = await loadSnarkjs();
  const vkey = await fetch(vkeyPath).then((r) => r.json());
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}
