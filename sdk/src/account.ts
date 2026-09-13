import { poseidon2 } from "poseidon-lite";
import type { AccountSecrets } from "./types.js";

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result % SNARK_FIELD;
}

/**
 * A zBase private account.
 *
 * Holds the cryptographic secrets needed to deposit and withdraw
 * from the privacy pool. These secrets must be saved securely —
 * losing them means losing access to your funds.
 */
export class ZX402Account {
  readonly nullifier: bigint;
  readonly secret: bigint;
  readonly precommitment: bigint;

  // Set after deposit (from on-chain event)
  label: bigint = 0n;
  commitment: bigint = 0n;
  value: bigint = 0n;
  deposited: boolean = false;
  withdrawn: boolean = false;

  constructor(nullifier?: bigint, secret?: bigint) {
    this.nullifier = nullifier ?? randomFieldElement();
    this.secret = secret ?? randomFieldElement();
    this.precommitment = poseidon2([this.nullifier, this.secret]);
  }

  /** Create from saved secrets (e.g., from localStorage or database) */
  static fromSecrets(secrets: AccountSecrets): ZX402Account {
    const account = new ZX402Account(
      BigInt(secrets.nullifier),
      BigInt(secrets.secret)
    );
    account.label = BigInt(secrets.label);
    account.commitment = BigInt(secrets.commitment);
    account.value = BigInt(secrets.value);
    account.deposited = true;
    return account;
  }

  /** Export secrets for saving */
  toSecrets(): AccountSecrets {
    return {
      nullifier: this.nullifier.toString(),
      secret: this.secret.toString(),
      precommitment: this.precommitment.toString(),
      label: this.label.toString(),
      commitment: this.commitment.toString(),
      value: this.value.toString(),
    };
  }

  /** Serialize to JSON string */
  serialize(): string {
    return JSON.stringify(this.toSecrets());
  }

  /** Deserialize from JSON string */
  static deserialize(json: string): ZX402Account {
    return ZX402Account.fromSecrets(JSON.parse(json));
  }
}
