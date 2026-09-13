/**
 * x402 v2 facilitator mechanism for private Solana payments.
 *
 * The buyer generates the Groth16 proof locally. The facilitator receives only
 * a proof-bearing payment bound to the merchant, amount, pool, and relayer; it
 * never receives the buyer's note nullifier/secret or the change-note secret.
 */

import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  PRIVATE_SVM_SCHEME,
  SvmPool,
  type PreparedSvmPayment,
  type SvmPoolConfig,
} from "./pool.js";

type SvmFacilitatorPool = Pick<
  SvmPool,
  | "networkId"
  | "relayerAddress"
  | "tokenMintAddress"
  | "programAddress"
  | "poolAddress"
  | "verifyPreparedWithdrawal"
  | "relayPreparedWithdrawal"
>;

export interface SvmFacilitatorConfig extends SvmPoolConfig {
  /** Test-only dependency injection; production callers pass the pool config. */
  pool?: SvmFacilitatorPool;
  /** Smallest atomic-token payment this relayer will subsidize. Defaults to 1. */
  minimumSettlementAmount?: string | bigint;
}

export class SvmFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = PRIVATE_SVM_SCHEME;
  readonly caipFamily = "solana:*";
  private readonly pool: SvmFacilitatorPool;
  private readonly minimumSettlementAmount: bigint;
  private readonly settlementsInFlight = new Set<string>();

  constructor(config: SvmFacilitatorConfig) {
    this.pool =
      config.pool ??
      new SvmPool({
        ...config,
        // A public facilitator must not let a note owner force it to fund an
        // unbounded number of fresh recipient token accounts.
        createRecipientTokenAccount: config.createRecipientTokenAccount ?? false,
      });
    const minimum = config.minimumSettlementAmount ?? 1n;
    try {
      this.minimumSettlementAmount = BigInt(minimum);
    } catch {
      throw new Error("minimumSettlementAmount must be a positive integer");
    }
    if (this.minimumSettlementAmount <= 0n) {
      throw new Error("minimumSettlementAmount must be a positive integer");
    }
  }

  getExtra(network: string): Record<string, unknown> | undefined {
    if (network !== this.pool.networkId) return undefined;
    return {
      feePayer: this.pool.relayerAddress,
      relayer: this.pool.relayerAddress,
      program: this.pool.programAddress,
      pool: this.pool.poolAddress,
      assetTransferMethod: "zbase-groth16-pool",
      paymentFlow: "authorization",
      proofGeneration: "client",
      facilitatorReceivesNoteSecrets: false,
      amountHiding: false,
      minimumSettlementAmount: this.minimumSettlementAmount.toString(),
      recipientTokenAccountCreation: "merchant",
    };
  }

  getSigners(network: string): string[] {
    return network === this.pool.networkId ? [this.pool.relayerAddress] : [];
  }

  getSupported() {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: this.scheme,
          network: this.pool.networkId,
          extra: this.getExtra(this.pool.networkId),
        },
      ],
      extensions: [],
      signers: { [this.caipFamily]: [this.pool.relayerAddress] },
    };
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    try {
      const payment = this.bindPayment(payload, requirements);
      const result = await this.pool.verifyPreparedWithdrawal(payment, {
        recipient: requirements.payTo,
        amount: requirements.amount,
      });
      if (!result.isValid) {
        return {
          isValid: false,
          invalidReason: "invalid_private_svm_payment",
          invalidMessage: result.invalidReason,
        };
      }
      return {
        isValid: true,
        // The pool is the on-chain payer. Returning a depositor identity would
        // defeat the privacy property and the facilitator does not know it.
        payer: this.pool.poolAddress,
      };
    } catch (err) {
      return {
        isValid: false,
        invalidReason: "invalid_private_svm_payment",
        invalidMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    try {
      const payment = this.bindPayment(payload, requirements);
      if (this.settlementsInFlight.has(payment.nullifierHash)) {
        return {
          success: false,
          errorReason: "private_svm_settlement_in_flight",
          errorMessage: "a settlement for this nullifier is already in progress",
          transaction: "",
          network: requirements.network,
        };
      }
      this.settlementsInFlight.add(payment.nullifierHash);
      try {
        const verified = await this.pool.verifyPreparedWithdrawal(payment, {
          recipient: requirements.payTo,
          amount: requirements.amount,
        });
        if (!verified.isValid) {
          return {
            success: false,
            errorReason: "invalid_private_svm_payment",
            errorMessage: verified.invalidReason,
            transaction: "",
            network: requirements.network,
          };
        }
        const transaction = await this.pool.relayPreparedWithdrawal(payment, {
          recipient: requirements.payTo,
          amount: requirements.amount,
        });
        return {
          success: true,
          payer: this.pool.poolAddress,
          transaction,
          network: requirements.network,
          amount: requirements.amount,
          extensions: {
            "zbase-private-svm": {
              privacy: "sender-recipient unlinkability only",
              amountHiding: false,
              facilitatorReceivedNoteSecrets: false,
            },
          },
        };
      } finally {
        this.settlementsInFlight.delete(payment.nullifierHash);
      }
    } catch (err) {
      return {
        success: false,
        errorReason: "private_svm_settlement_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        transaction: "",
        network: requirements.network,
      };
    }
  }

  private bindPayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): PreparedSvmPayment {
    if (payload.x402Version !== 2) throw new Error("x402Version must be 2");
    if (requirements.scheme !== this.scheme) {
      throw new Error(`requirements.scheme must be ${this.scheme}`);
    }
    if (requirements.network !== this.pool.networkId) {
      throw new Error(
        `requirements.network mismatch: expected ${this.pool.networkId}, got ${requirements.network}`,
      );
    }
    if (requirements.asset !== this.pool.tokenMintAddress) {
      throw new Error(
        `requirements.asset mismatch: expected ${this.pool.tokenMintAddress}, got ${requirements.asset}`,
      );
    }
    const requiredExtra = {
      relayer: this.pool.relayerAddress,
      feePayer: this.pool.relayerAddress,
      program: this.pool.programAddress,
      pool: this.pool.poolAddress,
      assetTransferMethod: "zbase-groth16-pool",
      paymentFlow: "authorization",
      proofGeneration: "client",
    } as const;
    for (const [field, wanted] of Object.entries(requiredExtra)) {
      if (requirements.extra?.[field] !== wanted) {
        throw new Error(`requirements.extra.${field} must be ${wanted}`);
      }
    }
    let requiredAmount: bigint;
    try {
      requiredAmount = BigInt(requirements.amount);
    } catch {
      throw new Error("requirements.amount must be a base-10 integer string");
    }
    if (!/^[0-9]+$/.test(requirements.amount) || requiredAmount <= 0n) {
      throw new Error("requirements.amount must be a positive base-10 integer string");
    }
    if (requiredAmount < this.minimumSettlementAmount) {
      throw new Error(
        `requirements.amount is below facilitator minimum ${this.minimumSettlementAmount}`,
      );
    }
    const accepted = payload.accepted;
    for (const field of ["scheme", "network", "asset", "amount", "payTo"] as const) {
      if (accepted[field] !== requirements[field]) {
        throw new Error(`payload.accepted.${field} does not match payment requirements`);
      }
    }
    const candidate = payload.payload.payment ?? payload.payload;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("payment payload must contain a prepared private SVM payment");
    }
    return candidate as unknown as PreparedSvmPayment;
  }
}
