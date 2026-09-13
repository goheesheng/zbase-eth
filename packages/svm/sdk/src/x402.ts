/** x402 v2 client/resource-server adapters for the private SVM scheme. */

import type {
  AssetAmount,
  Network,
  PaymentPayloadResult,
  PaymentRequirements,
  Price,
  SchemeNetworkClient,
  SchemeNetworkServer,
  SettleResponse,
} from "@x402/core/types";
import type { PaymentResponseContext } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import type { AccountSecrets } from "@zbase-protocol/core";
import {
  PRIVATE_SVM_SCHEME,
  SvmPool,
  type PreparedSvmWithdrawal,
} from "./pool.js";

/**
 * Resource-server adapter. Pricing and USDC selection reuse the official SVM
 * exact scheme, while the scheme name prevents ordinary direct-transfer
 * clients from accidentally selecting the private pool path.
 */
export class PrivateExactSvmServerScheme implements SchemeNetworkServer {
  readonly scheme = PRIVATE_SVM_SCHEME;
  readonly defaultAssetTransferMethod = "zbase-groth16-pool";
  readonly paymentFlows = {
    [this.defaultAssetTransferMethod]: {
      supported: ["authorization"],
      default: "authorization",
    },
  } as const;
  private readonly exact = new ExactSvmScheme();

  parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    return this.exact.parsePrice(price, network);
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    if (supportedKind.scheme !== this.scheme) {
      throw new Error(`facilitator must advertise ${this.scheme}`);
    }
    const enhanced = await this.exact.enhancePaymentRequirements(
      paymentRequirements,
      supportedKind,
      facilitatorExtensions,
    );
    return {
      ...enhanced,
      scheme: this.scheme,
      extra: {
        ...enhanced.extra,
        ...supportedKind.extra,
        assetTransferMethod: this.defaultAssetTransferMethod,
        paymentFlow: "authorization",
        proofGeneration: "client",
      },
    };
  }
}

export interface PrivateExactSvmClientConfig {
  pool: SvmPool;
  /** Return the currently spendable note. Never send this result over HTTP. */
  getNote: () => AccountSecrets | Promise<AccountSecrets>;
  /**
   * Persist the prepared change note as PENDING. Promote it only after the
   * resource response carries a successful PAYMENT-RESPONSE. Lock the original
   * note while this state is pending; only reconciliation can unlock it.
   */
  onPrepared?: (prepared: PreparedSvmWithdrawal) => void | Promise<void>;
  /** Promote the pending change note only after a successful settle response. */
  onSettled?: (
    prepared: PreparedSvmWithdrawal,
    response: SettleResponse,
  ) => void | Promise<void>;
  /** Discard the pending change note after a definitive pre-settlement rejection. */
  onRejected?: (
    prepared: PreparedSvmWithdrawal,
    context: PaymentResponseContext,
  ) => void | Promise<void>;
  /** Reconcile on-chain before choosing either note after any ambiguous settle outcome. */
  onIndeterminate?: (
    prepared: PreparedSvmWithdrawal,
    context: PaymentResponseContext,
  ) => void | Promise<void>;
  /** Persist the result of an explicit on-chain nullifier reconciliation. */
  onReconciled?: (
    prepared: PreparedSvmWithdrawal,
    result: { spent: true },
  ) => void | Promise<void>;
}

export class PrivateExactSvmClientScheme implements SchemeNetworkClient {
  readonly scheme = PRIVATE_SVM_SCHEME;
  readonly schemeHooks = {
    onPaymentResponse: async (context: PaymentResponseContext) => {
      const pending = this.takePrepared(context);
      if (!pending) return;
      const { prepared } = pending;

      if (context.settleResponse?.success) {
        // Treat the note as indeterminate until durable promotion succeeds.
        // If onSettled throws (disk/database failure), a later 402 response
        // must never unlock the already-spent original note.
        pending.status = "indeterminate";
        await this.config.onSettled?.(prepared, context.settleResponse);
        this.preparedByNullifier.delete(prepared.payment.nullifierHash);
        return;
      }
      // State transitions are monotonic. Once a request may have reached the
      // relayer, only an eventual successful settlement or explicit on-chain
      // reconciliation may choose between the old and change notes.
      if (pending.status === "indeterminate") {
        await this.config.onIndeterminate?.(prepared, context);
        return;
      }
      // Any settle failure is ambiguous: the relayer may have broadcast the
      // transaction and lost confirmation/RPC response. Never reactivate the
      // old note until its nullifier has been reconciled on chain.
      if (context.error || context.settleResponse) {
        pending.status = "indeterminate";
        await this.config.onIndeterminate?.(prepared, context);
        return;
      }
      if (context.paymentRequired) {
        await this.config.onRejected?.(prepared, context);
        this.preparedByNullifier.delete(prepared.payment.nullifierHash);
        return;
      }
      pending.status = "indeterminate";
      await this.config.onIndeterminate?.(prepared, context);
    },
  } satisfies NonNullable<SchemeNetworkClient["schemeHooks"]>;
  private readonly config: PrivateExactSvmClientConfig;
  private readonly preparedByNullifier = new Map<
    string,
    { prepared: PreparedSvmWithdrawal; status: "prepared" | "indeterminate" }
  >();

  constructor(config: PrivateExactSvmClientConfig) {
    this.config = config;
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (x402Version !== 2) throw new Error("private SVM payments require x402 v2");
    if (paymentRequirements.scheme !== this.scheme) {
      throw new Error(`payment requirements must use ${this.scheme}`);
    }
    if (paymentRequirements.network !== this.config.pool.networkId) {
      throw new Error("payment requirements network does not match the configured pool");
    }
    if (paymentRequirements.asset !== this.config.pool.tokenMintAddress) {
      throw new Error("payment requirements asset does not match the configured pool mint");
    }
    const routeExtra = {
      program: this.config.pool.programAddress,
      pool: this.config.pool.poolAddress,
      assetTransferMethod: "zbase-groth16-pool",
      paymentFlow: "authorization",
      proofGeneration: "client",
    } as const;
    for (const [field, wanted] of Object.entries(routeExtra)) {
      if (paymentRequirements.extra?.[field] !== wanted) {
        throw new Error(`payment requirements extra.${field} must be ${wanted}`);
      }
    }
    const relayer =
      paymentRequirements.extra?.relayer ?? paymentRequirements.extra?.feePayer;
    if (typeof relayer !== "string") {
      throw new Error("private SVM payment requirements must advertise a relayer");
    }
    if (
      relayer !== this.config.pool.relayerAddress ||
      paymentRequirements.extra?.relayer !== this.config.pool.relayerAddress ||
      paymentRequirements.extra?.feePayer !== this.config.pool.relayerAddress
    ) {
      throw new Error("payment requirements relayer/feePayer do not match the configured pool");
    }
    const prepared = await this.config.pool.prepareWithdrawal(
      await this.config.getNote(),
      paymentRequirements.payTo,
      paymentRequirements.amount,
      relayer,
    );
    const nullifierHash = prepared.payment.nullifierHash;
    if (this.preparedByNullifier.has(nullifierHash)) {
      throw new Error(
        "a payment for this note is already pending or indeterminate; reconcile its nullifier before preparing another payment",
      );
    }
    this.preparedByNullifier.set(nullifierHash, {
      prepared,
      status: "prepared",
    });
    try {
      await this.config.onPrepared?.(prepared);
    } catch (error) {
      this.preparedByNullifier.delete(nullifierHash);
      throw error;
    }
    return {
      x402Version,
      payload: { payment: prepared.payment },
    };
  }

  /**
   * Resolve an ambiguous response by reading the nullifier PDA on Solana.
   * A finalized spent PDA promotes the change-note path through the durable
   * `onReconciled` hook. A missing PDA leaves the lock intact: absence alone
   * does not prove an ambiguously broadcast Solana transaction has expired.
   */
  async reconcilePayment(
    nullifierHash: string,
  ): Promise<{ spent: true; prepared: PreparedSvmWithdrawal }> {
    const pending = this.preparedByNullifier.get(nullifierHash);
    if (!pending) throw new Error("payment is not pending in this client instance");
    if (pending.status !== "indeterminate") {
      throw new Error("only an indeterminate payment may be reconciled on chain");
    }
    const spent = await this.config.pool.isPreparedWithdrawalSpent(
      pending.prepared.payment,
    );
    if (!spent) {
      throw new Error(
        "nullifier is not finalized as spent; lock retained because account absence does not prove the relay transaction expired",
      );
    }
    await this.config.onReconciled?.(pending.prepared, { spent: true });
    this.preparedByNullifier.delete(nullifierHash);
    return { spent: true, prepared: pending.prepared };
  }

  private takePrepared(context: PaymentResponseContext):
    | {
        prepared: PreparedSvmWithdrawal;
        status: "prepared" | "indeterminate";
      }
    | undefined {
    const payload = context.paymentPayload.payload as {
      payment?: { nullifierHash?: unknown };
    };
    const nullifierHash = payload.payment?.nullifierHash;
    if (typeof nullifierHash !== "string") return undefined;
    return this.preparedByNullifier.get(nullifierHash);
  }
}
