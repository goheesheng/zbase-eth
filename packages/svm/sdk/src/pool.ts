/**
 * @zbase-protocol/svm — Solana implementation of the ZX402 privacy pool.
 *
 * V1 changes vs the V0 skeleton:
 *   * Field elements are 32-byte big-endian arrays everywhere on the wire to
 *     match the on-chain program (which dropped the toy u128 representation).
 *   * Withdraw generates a real Groth16 proof against the universal circuit
 *     and submits it through `relay_withdrawal`, which now verifies it
 *     on-chain via groth16-solana.
 *   * `compute_context` (recipient binding) and `compute_label` are mirrored
 *     here exactly the way the on-chain program computes them; if either
 *     drifts, proofs stop verifying.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
// @ts-expect-error bn.js has no shipped types but anchor depends on it
import BN from "bn.js";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  computePrecommitment,
  computeCommitment,
  computeNullifierHash,
  computeLabel,
  feToBE32,
  generateDepositSecrets,
  buildMerkleTree,
  generateMerkleProof,
  generateWithdrawalProof,
  SNARK_SCALAR_FIELD,
} from "@zbase-protocol/core";
import type {
  ZX402Pool,
  AccountSecrets,
  DepositResult,
  WithdrawResult,
  PayResult,
  PoolStats,
  ChainType,
  Groth16Proof,
} from "@zbase-protocol/core";
import idl from "./idl.json" with { type: "json" };
// @ts-expect-error snarkjs has no bundled TS types in this workspace
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as snarkjs from "snarkjs";

const PROGRAM_ID = new PublicKey("7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM");
const USDC_MINT_MAINNET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_MINT_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_TESTNET_CAIP2 = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
export const PRIVATE_SVM_SCHEME = "private-exact";

/**
 * Derive the canonical token account for a private-payment recipient.
 *
 * Native Solana programs receive funds through PDA authorities, which are
 * deliberately off the Ed25519 curve. SPL Token's ATA helper rejects those
 * owners unless `allowOwnerOffCurve` is enabled, so all recipient derivation
 * goes through this helper. Relayer and depositor accounts remain ordinary
 * signer-owned ATAs.
 */
export function deriveSvmRecipientTokenAccount(
  tokenMint: PublicKey,
  recipient: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(
    tokenMint,
    recipient,
    true,
    TOKEN_PROGRAM_ID,
  );
}

/// Circuit `maxTreeDepth` parameter — must match `Withdraw(32)` in
/// packages/circuits/src/index.ts of the upstream 0xbow repo.
const MAX_TREE_DEPTH = 32;
/// BN254 field-modulus minus 1 (used to compute the "negation" of proof_a).
const BN254_PRIME =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export interface SvmPoolConfig {
  connection: Connection;
  wallet: Keypair;
  /**
   * Public key that will relay a prepared withdrawal. Clients should set this
   * to the facilitator-advertised relayer without possessing its secret key.
   * Direct/self-relayed withdrawals default to `wallet.publicKey`.
   */
  relayer?: PublicKey;
  usdcMint?: PublicKey;
  programId?: PublicKey;
  /// Path or URL containing `withdraw/withdraw.wasm` and `withdraw/groth16_pkey.zkey`.
  /// In the browser this is typically `/circuits`; in a Node test it's a
  /// filesystem path (e.g. the repo's `public/circuits` directory).
  circuitsUrl?: string;
  network?: "mainnet-beta" | "devnet" | "testnet";
  /**
   * Create a missing recipient ATA at the relayer's expense. Direct SDK
   * withdrawals default to true. Public facilitators should set this false so
   * a valid note cannot drain relayer SOL by naming fresh recipient wallets.
   */
  createRecipientTokenAccount?: boolean;
}

/**
 * Proof-bearing x402 payload. This object is safe to send to a facilitator:
 * it deliberately contains no note nullifier, note secret, or change-note
 * secret. The Groth16 proof is already bound to recipient, amount, pool, and
 * relayer.
 */
export interface PreparedSvmPayment {
  version: 1;
  scheme: typeof PRIVATE_SVM_SCHEME;
  network: string;
  programId: string;
  pool: string;
  tokenMint: string;
  recipient: string;
  relayer: string;
  amount: string;
  relayFeeBps: string;
  withdrawalData: string;
  nullifierHash: string;
  proofA: string;
  proofB: string;
  proofC: string;
  publicInputs: string[];
}

export interface PreparedSvmWithdrawal {
  payment: PreparedSvmPayment;
  remainingValue: string;
  nextDeposit?: AccountSecrets;
  proofTimeMs: number;
}

export interface PreparedSvmPaymentExpectations {
  network: string;
  programId: string;
  pool: string;
  tokenMint: string;
  relayer: string;
  recipient?: string;
  amount?: string;
  maxRelayFeeBps?: bigint;
}

export interface ValidatedPreparedSvmPayment {
  recipient: PublicKey;
  relayer: PublicKey;
  amount: bigint;
  relayFeeBps: bigint;
  withdrawalData: Uint8Array;
  nullifierHash: Uint8Array;
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  publicInputs: number[][];
}

export class SvmPool implements ZX402Pool {
  readonly chain: ChainType = "svm";

  private connection: Connection;
  private wallet: Keypair;
  private relayer: PublicKey;
  private usdcMint: PublicKey;
  private programId: PublicKey;
  private circuitsUrl: string;
  private network: string;
  private createRecipientTokenAccount: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private program: any;

  constructor(config: SvmPoolConfig) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.relayer = config.relayer || config.wallet.publicKey;
    this.programId = config.programId || PROGRAM_ID;
    this.circuitsUrl = config.circuitsUrl || "/circuits";
    this.network =
      config.network === "devnet"
        ? SOLANA_DEVNET_CAIP2
        : config.network === "testnet"
          ? SOLANA_TESTNET_CAIP2
          : SOLANA_MAINNET_CAIP2;
    this.createRecipientTokenAccount = config.createRecipientTokenAccount ?? true;

    if (config.usdcMint) {
      this.usdcMint = config.usdcMint;
    } else if (config.network === "devnet" || config.network === "testnet") {
      this.usdcMint = USDC_MINT_DEVNET;
    } else {
      this.usdcMint = USDC_MINT_MAINNET;
    }

    const provider = new AnchorProvider(
      this.connection,
      new Wallet(this.wallet),
      { commitment: "confirmed" },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.program = new Program(idl as any, provider);
  }

  get relayerAddress(): string {
    return this.relayer.toBase58();
  }

  get networkId(): string {
    return this.network;
  }

  get tokenMintAddress(): string {
    return this.usdcMint.toBase58();
  }

  get programAddress(): string {
    return this.programId.toBase58();
  }

  get poolAddress(): string {
    return this.getPoolPda()[0].toBase58();
  }

  // --- PDA derivations ---

  private getPoolPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), this.usdcMint.toBuffer()],
      this.programId,
    );
  }

  private getVaultPda(poolPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      this.programId,
    );
  }

  private getDepositRecordPda(poolPda: PublicKey, index: number): [PublicKey, number] {
    const indexBuffer = Buffer.alloc(8);
    indexBuffer.writeBigUInt64LE(BigInt(index));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("deposit"), poolPda.toBuffer(), indexBuffer],
      this.programId,
    );
  }

  /// Nullifier-hash PDA: seed = "nullifier" || pool_pda || nullifier_hash_be32.
  /// Must match the program's `seeds = [b"nullifier", pool_state.key().as_ref(), &nullifier_hash]`.
  private getNullifierPda(poolPda: PublicKey, nullifierHashBE: Uint8Array): [PublicKey, number] {
    if (nullifierHashBE.length !== 32) throw new Error("nullifier hash must be 32 bytes");
    return PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), poolPda.toBuffer(), Buffer.from(nullifierHashBE)],
      this.programId,
    );
  }

  private getAgentPda(owner: PublicKey, hotKey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), owner.toBuffer(), hotKey.toBuffer()],
      this.programId,
    );
  }

  // --- Init ---

  async initializePool(postman: PublicKey): Promise<string> {
    const [poolPda] = this.getPoolPda();
    const [vaultPda] = this.getVaultPda(poolPda);

    return await this.program.methods
      .initialize(new BN(50), new BN(100), new BN(1_000_000))
      .accounts({
        poolState: poolPda,
        vault: vaultPda,
        tokenMint: this.usdcMint,
        owner: this.wallet.publicKey,
        postman,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }

  // --- Deposit ---

  async deposit(amount: string): Promise<DepositResult> {
    const amountLamports = Math.floor(parseFloat(amount) * 1e6);
    const vettingFee = Math.floor((amountLamports * 50) / 10_000); // 0.5%
    const netValue = amountLamports - vettingFee;

    const { nullifier, secret } = generateDepositSecrets();
    const precommitment = computePrecommitment(nullifier, secret);
    const precommitmentBytes = Array.from(feToBE32(precommitment));

    const [poolPda] = this.getPoolPda();
    const [vaultPda] = this.getVaultPda(poolPda);

    const poolState = await this.program.account.poolState.fetch(poolPda);
    const depositIndex = (poolState as { depositCount: BN }).depositCount.toNumber();
    const [depositRecordPda] = this.getDepositRecordPda(poolPda, depositIndex);

    const depositorAta = await getAssociatedTokenAddress(this.usdcMint, this.wallet.publicKey);
    try {
      await getAccount(this.connection, depositorAta);
    } catch {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          this.wallet.publicKey,
          depositorAta,
          this.wallet.publicKey,
          this.usdcMint,
        ),
      );
      await sendAndConfirmTransaction(this.connection, tx, [this.wallet]);
    }

    const tx = await this.program.methods
      .deposit(precommitmentBytes, new BN(amountLamports))
      .accounts({
        poolState: poolPda,
        depositRecord: depositRecordPda,
        vault: vaultPda,
        depositorTokenAccount: depositorAta,
        depositor: this.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Re-derive the on-chain values so the caller has a complete `AccountSecrets`.
    const scopeBE = (poolState as { scope: number[] }).scope;
    const scopeBig = beBytesToBigInt(scopeBE);
    const label = computeLabel(scopeBig, depositIndex);
    const commitment = computeCommitment(BigInt(netValue), label, precommitment);

    const fullSecrets: AccountSecrets = {
      nullifier,
      secret,
      commitment,
      label,
      value: netValue.toString(),
    };

    return {
      txHash: tx,
      commitment,
      label,
      value: netValue.toString(),
      secrets: fullSecrets,
      chain: "svm",
    };
  }

  // --- Withdraw ---

  async prepareWithdrawal(
    secrets: AccountSecrets,
    recipient: string,
    amountAtomic?: string,
    relayer = this.relayerAddress,
  ): Promise<PreparedSvmWithdrawal> {
    const startTime = Date.now();

    const [poolPda] = this.getPoolPda();
    const recipientPubkey = new PublicKey(recipient);
    const relayerPubkey = new PublicKey(relayer);
    if (recipientPubkey.equals(relayerPubkey)) {
      throw new Error(
        "prepareWithdrawal: recipient must differ from relayer; the Anchor instruction requires distinct writable token accounts",
      );
    }

    // 1. Fetch on-chain state we need for the proof.
    const poolState = await this.program.account.poolState.fetch(poolPda);
    const ps = poolState as {
      scope: number[];
      aspRoot: number[];
      depositCount: BN;
    };
    const scopeBig = beBytesToBigInt(ps.scope);
    const aspRootBig = beBytesToBigInt(ps.aspRoot);

    // 2. Rebuild the state Merkle tree from DepositEvent and WithdrawalEvent
    //    logs in transaction order. Both instructions insert leaves, so
    //    DepositRecord.index alone cannot recover an interleaved history.
    const depositAccounts = await this.program.account.depositRecord.all([
      { memcmp: { offset: 8, bytes: poolPda.toBase58() } },
    ]);
    const sortedDeposits = [...depositAccounts].sort(
      (a, b) =>
        (a.account as { index: BN }).index.toNumber() -
        (b.account as { index: BN }).index.toNumber(),
    );
    const depositLeaves = sortedDeposits.map((acc) =>
      beBytesToBigInt(
        (acc.account as { commitment: number[] }).commitment,
      ),
    );

    const eventLeaves: bigint[] = [];
    const changeLeaves: bigint[] = [];
    let depositEventCount = 0;
    try {
      const sigs: Awaited<ReturnType<Connection["getSignaturesForAddress"]>> = [];
      let before: string | undefined;
      do {
        const batch = await this.connection.getSignaturesForAddress(poolPda, {
          limit: 1000,
          ...(before ? { before } : {}),
        });
        sigs.push(...batch);
        if (batch.length < 1000) break;
        before = batch[batch.length - 1]?.signature;
      } while (before);

      // Newest-first; reverse so we process oldest-to-newest.
      const ordered = sigs.reverse();
      type PoolEventData = {
        pool?: PublicKey;
        commitment?: number[];
        newCommitment?: number[];
        new_commitment?: number[];
      };
      const eventParser = (this.program as {
        coder: {
          events: {
            decode: (value: string) => { name: string; data: PoolEventData } | null;
          };
        };
      }).coder.events;
      for (const sigMeta of ordered) {
        const tx = await this.connection.getTransaction(sigMeta.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (!tx?.meta?.logMessages) continue;
        for (const log of tx.meta.logMessages) {
          // Anchor program logs events as `Program data: <base64>`.
          const m = log.match(/^Program data: (.+)$/);
          if (!m) continue;
          try {
            const ev = eventParser.decode(m[1]);
            if (!ev) continue;
            if (ev.data.pool && !ev.data.pool.equals(poolPda)) continue;
            if (ev.name === "depositEvent" || ev.name === "DepositEvent") {
              if (ev.data.commitment) {
                eventLeaves.push(beBytesToBigInt(ev.data.commitment));
                depositEventCount += 1;
              }
              continue;
            }
            if (ev.name === "withdrawalEvent" || ev.name === "WithdrawalEvent") {
              const nc = ev.data.newCommitment ?? ev.data.new_commitment;
              if (nc) {
                const changeCommitment = beBytesToBigInt(nc);
                eventLeaves.push(changeCommitment);
                changeLeaves.push(changeCommitment);
              }
            }
          } catch {
            // Not our event; skip.
          }
        }
      }
    } catch (err) {
      // A historical provider may prune logs. The root checks below decide
      // whether the account-only fallbacks are actually safe to use.
      // eslint-disable-next-line no-console
      console.warn("[zx402-svm] failed to scan pool events:", (err as Error).message);
    }

    const onchainRootBig = beBytesToBigInt(
      (poolState as { treeRoot: number[] }).treeRoot,
    );
    if (eventLeaves.length > 0 && depositEventCount !== depositLeaves.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[zx402-svm] event history contains ${depositEventCount} deposits, ` +
          `but ${depositLeaves.length} DepositRecord accounts exist`,
      );
    }
    const candidates = [
      { name: "chronological events", leaves: eventLeaves },
      { name: "deposits-then-changes fallback", leaves: [...depositLeaves, ...changeLeaves] },
      { name: "deposit records only", leaves: depositLeaves },
    ].filter((candidate) => candidate.leaves.length > 0);
    const attempted = candidates.map((candidate) => ({
      ...candidate,
      tree: buildMerkleTree(candidate.leaves),
    }));
    const matched = attempted.find((candidate) => candidate.tree.root === onchainRootBig);
    if (!matched) {
      throw new Error(
        `withdraw: cannot reconstruct on-chain state root ${onchainRootBig.toString()}; ` +
          attempted
            .map((candidate) => `${candidate.name}=${candidate.tree.root.toString()}`)
            .join(", ") +
          `. Scanned ${depositLeaves.length} deposits and ${changeLeaves.length} change commitments.`,
      );
    }
    const leaves = matched.leaves;
    const stateTree = matched.tree;
    // eslint-disable-next-line no-console
    console.log(
      `[zx402-svm] state tree: ${leaves.length} leaves, ` +
        `source=${matched.name}, root=${stateTree.root.toString().slice(0, 16)}…, match=true`,
    );

    // Find OUR commitment in the tree. The SDK saved `commitment` at deposit
    // time (`secrets.commitment`); if it isn't there, the deposit hasn't
    // landed yet (or this account targets a different pool).
    const ours = BigInt(secrets.commitment);
    const leafIndex = leaves.findIndex((l) => l === ours);
    if (leafIndex === -1) {
      throw new Error(
        `withdraw: commitment ${ours.toString()} not found among ${leaves.length} on-chain deposits`,
      );
    }
    const stateProof = generateMerkleProof(stateTree, leafIndex);

    // 3. Build the ASP tree from the labels the postman has approved.
    //    For V1 we use a single-element ASP tree containing our own label —
    //    this only proves "compliant" if the postman has set asp_root to that
    //    same single-leaf tree's root. The production setup feeds the full
    //    label set off-chain (typically via IPFS, then `update_asp_root`).
    const ourLabel = BigInt(secrets.label);
    const aspTree = buildMerkleTree([ourLabel]);
    const aspProof = generateMerkleProof(aspTree, 0);

    // The pool's current asp_root MUST equal the ASP tree's root, otherwise
    // the on-chain `IncorrectAspRoot` check rejects us. If they don't match,
    // tell the caller — most likely the postman hasn't published this label.
    if (aspTree.root !== aspRootBig) {
      throw new Error(
        `withdraw: ASP root mismatch — pool=${aspRootBig.toString()}, our=${aspTree.root.toString()}. ` +
          `The postman has not yet approved this label.`,
      );
    }

    // 4. Withdraw only what is needed for this payment. The circuit emits a
    //    new commitment for the remaining balance, so one funded note can
    //    settle multiple payments in sequence.
    const existingValue = BigInt(secrets.value);
    const withdrawnValue = amountAtomic ? BigInt(amountAtomic) : existingValue;
    if (withdrawnValue <= 0n) {
      throw new Error(`withdraw: amount must be > 0, got ${withdrawnValue.toString()}`);
    }
    if (withdrawnValue > existingValue) {
      throw new Error(
        `withdraw: amount ${withdrawnValue.toString()} exceeds note value ${existingValue.toString()}`,
      );
    }
    const remainingValue = existingValue - withdrawnValue;
    const { nullifier: newNullifier, secret: newSecret } = generateDepositSecrets();
    const newPrecommitment = computePrecommitment(newNullifier, newSecret);
    const expectedNewCommitment = computeCommitment(
      remainingValue,
      ourLabel,
      newPrecommitment,
    );

    // 5. Compute the binding context for this exact withdrawal. Mirrors the
    //    Solana program's `compute_context(pool_pda, withdrawal_data, scope)`.
    //    `withdrawal_data` for SVM = recipient_pubkey || relay_fee_bps_be8 ||
    //    relayer_pubkey. The relayer_fee is 0 in V1 (self-relay).
    const withdrawalData = svmEncodeWithdrawalData(
      recipientPubkey,
      0n,
      relayerPubkey,
    );
    const context = computeSvmContext(poolPda, withdrawalData, scopeBig);

    // 6. Generate the proof.
    const stateSiblings = padSiblings(stateProof.pathElements);
    const ASPSiblings = padSiblings(aspProof.pathElements);

    // B3 (audit-sweep-2026-06-17): the circuit's `stateIndex`/`ASPIndex` must be
    // zk-kit's COMPACTED `proof.index` (NOT the raw leafIndex), and the depth
    // must be the compacted `actualDepth` (NOT the full `tree.depth`), to match
    // the compacted `pathElements`/siblings. Pre-fix this passed the raw
    // leafIndex + full tree depth alongside compacted siblings — they misaligned
    // for any leaf whose path crosses a "no right sibling" level, producing a
    // wrong root and an unsatisfiable witness (it only worked on the left spine).
    // Same shared-depth caveat as the EVM circuit applies (see merkle.ts + the
    // audit doc): a single shared depth requires the relevant subtree be
    // perfect at the leaf's index. Solana's `withdraw.circom` shares this design.
    const proofResult = await generateWithdrawalProof(
      {
        withdrawnValue: withdrawnValue.toString(),
        stateRoot: stateTree.root.toString(),
        stateTreeDepth: stateProof.actualDepth.toString(),
        ASPRoot: aspTree.root.toString(),
        ASPTreeDepth: aspProof.actualDepth.toString(),
        context: context.toString(),

        label: ourLabel.toString(),
        existingValue: existingValue.toString(),
        existingNullifier: secrets.nullifier,
        existingSecret: secrets.secret,
        newNullifier,
        newSecret,
        stateSiblings,
        stateIndex: stateProof.index.toString(),
        ASPSiblings,
        ASPIndex: aspProof.index.toString(),
      },
      `${this.circuitsUrl}/withdraw/withdraw.wasm`,
      `${this.circuitsUrl}/withdraw/groth16_pkey.zkey`,
    );

    if (proofResult.publicSignals.length !== 8) {
      throw new Error(
        `withdraw: expected 8 public signals, got ${proofResult.publicSignals.length}`,
      );
    }
    if (BigInt(proofResult.publicSignals[0]) !== BigInt(expectedNewCommitment)) {
      throw new Error(
        `withdraw: proof newCommitment mismatch (expected ${expectedNewCommitment}, got ${proofResult.publicSignals[0]})`,
      );
    }

    // Local verify: catch witness/circuit input bugs before paying for
    // an on-chain tx. If this fails the SDK's circuit inputs are wrong,
    // not the on-chain VK or the encoder.
    try {
      const fs = await import("fs");
      const path = await import("path");
      const vkeyPath = path.join(this.circuitsUrl, "withdraw", "groth16_vkey.json");
      const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
      const okLocal = await snarkjs.groth16.verify(
        vkey,
        proofResult.publicSignals,
        proofResult.proof,
      );
      // eslint-disable-next-line no-console
      console.log("[zx402-svm] local Groth16 verify:", okLocal ? "OK" : "FAILED");
      if (!okLocal) {
        throw new Error("withdraw: local proof verification failed; circuit inputs are wrong");
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[zx402-svm] local verify error:", (err as Error).message);
      throw err;
    }

    // 7. Encode proof bytes for groth16-solana. proof_a is negated and
    //    written in big-endian (no swap on B). The negation is the
    //    multiplicative inverse modulo BN254_PRIME — equivalently: y -> p-y
    //    on the y-coordinate.
    const { proofA, proofB, proofC } = encodeProofForSolana(proofResult.proof);

    // Public-input array: 8 × [u8; 32] big-endian.
    const publicInputs: number[][] = proofResult.publicSignals.map(
      (s: string) => Array.from(feToBE32(s)),
    );

    // 8. Package a proof-bearing payment for the facilitator. The original
    // note secrets and the change-note secrets never enter `payment`.
    const nullifierHash = computeNullifierHash(secrets.nullifier);
    const nullifierHashBE = feToBE32(nullifierHash);

    return {
      payment: {
        version: 1,
        scheme: PRIVATE_SVM_SCHEME,
        network: this.network,
        programId: this.programId.toBase58(),
        pool: poolPda.toBase58(),
        tokenMint: this.usdcMint.toBase58(),
        recipient: recipientPubkey.toBase58(),
        relayer: relayerPubkey.toBase58(),
        amount: withdrawnValue.toString(),
        relayFeeBps: "0",
        withdrawalData: bytesToHex(withdrawalData),
        nullifierHash: bytesToHex(nullifierHashBE),
        proofA: bytesToHex(proofA),
        proofB: bytesToHex(proofB),
        proofC: bytesToHex(proofC),
        publicInputs: publicInputs.map((input) => bytesToHex(Uint8Array.from(input))),
      },
      remainingValue: remainingValue.toString(),
      ...(remainingValue > 0n
        ? {
            nextDeposit: {
              nullifier: newNullifier,
              secret: newSecret,
              label: secrets.label,
              value: remainingValue.toString(),
              commitment: expectedNewCommitment,
            },
          }
        : {}),
      proofTimeMs: Date.now() - startTime,
    };
  }

  async verifyPreparedWithdrawal(
    payment: PreparedSvmPayment,
    expected?: Pick<PreparedSvmPaymentExpectations, "recipient" | "amount">,
  ): Promise<{ isValid: boolean; invalidReason?: string }> {
    try {
      const builder = await this.preparedWithdrawalBuilder(payment, expected);
      await builder.simulate();
      return { isValid: true };
    } catch (err) {
      return {
        isValid: false,
        invalidReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async relayPreparedWithdrawal(
    payment: PreparedSvmPayment,
    expected?: Pick<PreparedSvmPaymentExpectations, "recipient" | "amount">,
  ): Promise<string> {
    const builder = await this.preparedWithdrawalBuilder(payment, expected);
    return await builder.rpc();
  }

  /**
   * Build the proof-bearing pool instruction without submitting it. Native
   * programs can forward the returned instruction data through CPI and apply
   * their own state transition atomically after the pool transfer succeeds.
   * Callers remain responsible for the compute-budget instruction and for
   * provisioning recipient/relayer token accounts.
   */
  async buildPreparedWithdrawalInstruction(
    payment: PreparedSvmPayment,
    expected?: Pick<PreparedSvmPaymentExpectations, "recipient" | "amount">,
  ): Promise<TransactionInstruction> {
    const builder = await this.preparedWithdrawalBuilder(payment, expected);
    return await builder.instruction();
  }

  /**
   * Resolve an ambiguous relay outcome from the nullifier PDA. Account creation
   * and the `spent=true` write are atomic with withdrawal settlement. A found
   * finalized PDA proves the note was spent. Absence does NOT prove it is safe
   * to reuse the note while an ambiguously broadcast transaction may still
   * land.
   */
  async isPreparedWithdrawalSpent(payment: PreparedSvmPayment): Promise<boolean> {
    const [poolPda] = this.getPoolPda();
    const validated = validatePreparedSvmPayment(payment, {
      network: this.network,
      programId: this.programId.toBase58(),
      pool: poolPda.toBase58(),
      tokenMint: this.usdcMint.toBase58(),
      relayer: this.relayerAddress,
      maxRelayFeeBps: 0n,
    });
    const [nullifierPda] = this.getNullifierPda(poolPda, validated.nullifierHash);
    const account = await this.connection.getAccountInfo(nullifierPda, "finalized");
    if (!account) return false;
    if (!account.owner.equals(this.programId)) {
      throw new Error("nullifier PDA exists but is not owned by the configured program");
    }
    // Anchor discriminator (8 bytes), then NullifierRecord.spent (bool).
    if (account.data.length < 9 || account.data[8] !== 1) {
      throw new Error("nullifier PDA exists but is not a valid spent record");
    }
    return true;
  }

  async withdraw(
    secrets: AccountSecrets,
    recipient: string,
    amountAtomic?: string,
  ): Promise<WithdrawResult> {
    const prepared = await this.prepareWithdrawal(
      secrets,
      recipient,
      amountAtomic,
      this.relayerAddress,
    );
    const txHash = await this.relayPreparedWithdrawal(prepared.payment, {
      recipient,
      amount: prepared.payment.amount,
    });
    return {
      txHash,
      recipient,
      amount: prepared.payment.amount,
      remainingValue: prepared.remainingValue,
      nextDeposit: prepared.nextDeposit,
      proofTimeMs: prepared.proofTimeMs,
      chain: "svm",
    };
  }

  private async preparedWithdrawalBuilder(
    payment: PreparedSvmPayment,
    expected?: Pick<PreparedSvmPaymentExpectations, "recipient" | "amount">,
  // Anchor's generated method builder type is not exported in a stable path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const [poolPda] = this.getPoolPda();
    const [vaultPda] = this.getVaultPda(poolPda);
    const validated = validatePreparedSvmPayment(payment, {
      network: this.network,
      programId: this.programId.toBase58(),
      pool: poolPda.toBase58(),
      tokenMint: this.usdcMint.toBase58(),
      relayer: this.relayerAddress,
      recipient: expected?.recipient,
      amount: expected?.amount,
      maxRelayFeeBps: 0n,
    });
    const [nullifierPda] = this.getNullifierPda(
      poolPda,
      validated.nullifierHash,
    );
    const recipientAta = deriveSvmRecipientTokenAccount(
      this.usdcMint,
      validated.recipient,
    );
    const relayerAta = await getAssociatedTokenAddress(
      this.usdcMint,
      validated.relayer,
    );

    const preInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ...(this.createRecipientTokenAccount
        ? [
            createAssociatedTokenAccountIdempotentInstruction(
              this.wallet.publicKey,
              recipientAta,
              validated.recipient,
              this.usdcMint,
            ),
          ]
        : []),
      createAssociatedTokenAccountIdempotentInstruction(
        this.wallet.publicKey,
        relayerAta,
        validated.relayer,
        this.usdcMint,
      ),
    ];

    return this.program.methods
      .relayWithdrawal(
        Array.from(validated.nullifierHash),
        validated.recipient,
        new BN(validated.amount.toString()),
        new BN(validated.relayFeeBps.toString()),
        Buffer.from(validated.withdrawalData),
        Array.from(validated.proofA),
        Array.from(validated.proofB),
        Array.from(validated.proofC),
        validated.publicInputs,
      )
      .accounts({
        poolState: poolPda,
        nullifierRecord: nullifierPda,
        vault: vaultPda,
        recipientTokenAccount: recipientAta,
        relayerTokenAccount: relayerAta,
        relayer: this.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(preInstructions);
  }

  async pay(secrets: AccountSecrets, provider: string, amount?: string): Promise<PayResult> {
    const result = await this.withdraw(secrets, provider, amount);
    return { ...result, provider };
  }

  // --- Stats ---

  async getPoolStats(): Promise<PoolStats> {
    const [poolPda] = this.getPoolPda();
    try {
      const ps = (await this.program.account.poolState.fetch(poolPda)) as {
        depositCount: BN;
      };
      return {
        depositsCount: ps.depositCount.toNumber(),
        totalCommittedValue: "0",
        yieldEarned: "0",
        anonymitySetSize: ps.depositCount.toNumber(),
        chain: "svm",
      };
    } catch {
      return {
        depositsCount: 0,
        totalCommittedValue: "0",
        yieldEarned: "0",
        anonymitySetSize: 0,
        chain: "svm",
      };
    }
  }

  // --- Agents ---

  async registerAgent(
    name: string,
    hotKey: PublicKey,
    maxSpendPerTx: number,
    maxSpendPerDay: number,
  ): Promise<string> {
    const [agentPda] = this.getAgentPda(this.wallet.publicKey, hotKey);
    return await this.program.methods
      .registerAgent(name, new BN(maxSpendPerTx), new BN(maxSpendPerDay))
      .accounts({
        agentRecord: agentPda,
        owner: this.wallet.publicKey,
        hotKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
}

// ---------- helpers ----------

function beBytesToBigInt(bytes: number[] | Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function padSiblings(siblings: bigint[]): string[] {
  if (siblings.length > MAX_TREE_DEPTH) {
    throw new Error(`siblings length ${siblings.length} > MAX_TREE_DEPTH ${MAX_TREE_DEPTH}`);
  }
  return [
    ...siblings.map((s) => s.toString()),
    ...Array(MAX_TREE_DEPTH - siblings.length).fill("0"),
  ];
}

/**
 * Encode `withdrawal_data` exactly the way the on-chain Solana program reads
 * it for context binding: `recipient || relay_fee_bps_be8 || relayer`.
 * We deliberately use a fixed layout (not abi-encoded) — the on-chain side
 * just hashes the bytes verbatim, so any deterministic encoding works.
 */
function svmEncodeWithdrawalData(
  recipient: PublicKey,
  relayFeeBps: bigint,
  relayer: PublicKey,
): Uint8Array {
  const out = new Uint8Array(32 + 8 + 32);
  out.set(recipient.toBytes(), 0);
  for (let i = 7; i >= 0; i--) {
    out[32 + i] = Number(relayFeeBps & 0xffn);
    relayFeeBps >>= 8n;
  }
  out.set(relayer.toBytes(), 40);
  return out;
}

/// Mirrors `crypto::compute_context(pool_pda, withdrawal_data, scope)`.
function computeSvmContext(
  poolPda: PublicKey,
  withdrawalData: Uint8Array,
  scope: bigint,
): bigint {
  const scopeBE = feToBE32(scope);
  const buf = new Uint8Array(32 + withdrawalData.length + 32);
  buf.set(poolPda.toBytes(), 0);
  buf.set(withdrawalData, 32);
  buf.set(scopeBE, 32 + withdrawalData.length);
  const h = keccak_256(buf);
  let x = 0n;
  for (const b of h) x = (x << 8n) | BigInt(b);
  return x % SNARK_SCALAR_FIELD;
}

/**
 * Format a snarkjs Groth16 proof for groth16-solana's `Groth16Verifier::new`.
 *   proof_a: 64 bytes BE, NEGATED on the y-coordinate
 *   proof_b: 128 bytes BE (no coord swap on Solana — that's an EVM-only quirk)
 *   proof_c: 64 bytes BE
 */
function encodeProofForSolana(proof: Groth16Proof): {
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
} {
  const ax = BigInt(proof.pi_a[0]);
  const ay = BigInt(proof.pi_a[1]);
  const ayNeg = (BN254_PRIME - (ay % BN254_PRIME)) % BN254_PRIME;
  const proofA = new Uint8Array(64);
  proofA.set(feToBE32(ax), 0);
  proofA.set(feToBE32(ayNeg), 32);

  // pi_b is [ [bx_c0, bx_c1], [by_c0, by_c1] ]. groth16-solana wants the
  // Fp2 coords in (c1, c0) order, big-endian: x.c1 || x.c0 || y.c1 || y.c0.
  // Verified empirically on devnet 2026-05-10: snarkjs-native order rejected
  // with InvalidProof; swapped order verifies.
  const proofB = new Uint8Array(128);
  proofB.set(feToBE32(BigInt(proof.pi_b[0][1])), 0);
  proofB.set(feToBE32(BigInt(proof.pi_b[0][0])), 32);
  proofB.set(feToBE32(BigInt(proof.pi_b[1][1])), 64);
  proofB.set(feToBE32(BigInt(proof.pi_b[1][0])), 96);

  const proofC = new Uint8Array(64);
  proofC.set(feToBE32(BigInt(proof.pi_c[0])), 0);
  proofC.set(feToBE32(BigInt(proof.pi_c[1])), 32);

  return { proofA, proofB, proofC };
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function hexToFixedBytes(value: string, length: number, field: string): Uint8Array {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${field} must be a 0x-prefixed hex string`);
  }
  const bytes = Uint8Array.from(Buffer.from(value.slice(2), "hex"));
  if (bytes.length !== length) {
    throw new Error(`${field} must be ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function assertNoSpendSecrets(value: unknown, path = "payment"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "secret" || key === "nullifier" || key === "nextDeposit") {
      throw new Error(`${path}.${key} must never be sent to the facilitator`);
    }
    assertNoSpendSecrets(child, `${path}.${key}`);
  }
}

const PREPARED_PAYMENT_FIELDS = new Set<keyof PreparedSvmPayment>([
  "version",
  "scheme",
  "network",
  "programId",
  "pool",
  "tokenMint",
  "recipient",
  "relayer",
  "amount",
  "relayFeeBps",
  "withdrawalData",
  "nullifierHash",
  "proofA",
  "proofB",
  "proofC",
  "publicInputs",
]);

function assertAddress(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${field} must be a valid Solana address`);
  }
}

function assertPositiveU64(value: string, field: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${field} must be a base-10 integer string`);
  }
  if (!/^[0-9]+$/.test(value) || parsed <= 0n || parsed > 18_446_744_073_709_551_615n) {
    throw new Error(`${field} must be an integer in [1, 2^64-1]`);
  }
  return parsed;
}

export function validatePreparedSvmPayment(
  payment: PreparedSvmPayment,
  expected: PreparedSvmPaymentExpectations,
): ValidatedPreparedSvmPayment {
  assertNoSpendSecrets(payment);
  for (const field of Object.keys(payment)) {
    if (!PREPARED_PAYMENT_FIELDS.has(field as keyof PreparedSvmPayment)) {
      throw new Error(`unexpected private SVM payment field: ${field}`);
    }
  }
  if (payment.version !== 1) throw new Error("unsupported private SVM payment version");
  if (payment.scheme !== PRIVATE_SVM_SCHEME) {
    throw new Error(`scheme must be ${PRIVATE_SVM_SCHEME}`);
  }
  const exact = [
    ["network", payment.network, expected.network],
    ["programId", payment.programId, expected.programId],
    ["pool", payment.pool, expected.pool],
    ["tokenMint", payment.tokenMint, expected.tokenMint],
    ["relayer", payment.relayer, expected.relayer],
  ] as const;
  for (const [field, actual, wanted] of exact) {
    if (actual !== wanted) {
      throw new Error(`${field} mismatch: expected ${wanted}, got ${actual}`);
    }
  }
  if (expected.recipient && payment.recipient !== expected.recipient) {
    throw new Error(
      `recipient mismatch: expected ${expected.recipient}, got ${payment.recipient}`,
    );
  }
  if (expected.amount && payment.amount !== expected.amount) {
    throw new Error(`amount mismatch: expected ${expected.amount}, got ${payment.amount}`);
  }

  // Validate every address even when string equality already matched. This
  // prevents malformed values from reaching PDA/ATA derivation.
  assertAddress(payment.programId, "programId");
  assertAddress(payment.pool, "pool");
  assertAddress(payment.tokenMint, "tokenMint");
  const recipient = assertAddress(payment.recipient, "recipient");
  const relayer = assertAddress(payment.relayer, "relayer");
  if (recipient.equals(relayer)) {
    throw new Error("recipient must differ from relayer");
  }

  const amount = assertPositiveU64(payment.amount, "amount");
  let relayFeeBps: bigint;
  try {
    relayFeeBps = BigInt(payment.relayFeeBps);
  } catch {
    throw new Error("relayFeeBps must be a base-10 integer string");
  }
  const maxRelayFeeBps = expected.maxRelayFeeBps ?? 0n;
  if (!/^[0-9]+$/.test(payment.relayFeeBps) || relayFeeBps > maxRelayFeeBps) {
    throw new Error(`relayFeeBps exceeds facilitator maximum ${maxRelayFeeBps}`);
  }

  const withdrawalData = hexToFixedBytes(payment.withdrawalData, 72, "withdrawalData");
  const canonicalWithdrawalData = svmEncodeWithdrawalData(recipient, relayFeeBps, relayer);
  if (!Buffer.from(withdrawalData).equals(Buffer.from(canonicalWithdrawalData))) {
    throw new Error("withdrawalData is not the canonical recipient/fee/relayer encoding");
  }

  const nullifierHash = hexToFixedBytes(payment.nullifierHash, 32, "nullifierHash");
  const proofA = hexToFixedBytes(payment.proofA, 64, "proofA");
  const proofB = hexToFixedBytes(payment.proofB, 128, "proofB");
  const proofC = hexToFixedBytes(payment.proofC, 64, "proofC");
  if (!Array.isArray(payment.publicInputs) || payment.publicInputs.length !== 8) {
    throw new Error("publicInputs must contain exactly 8 field elements");
  }
  const publicInputBytes = payment.publicInputs.map((input, index) =>
    hexToFixedBytes(input, 32, `publicInputs[${index}]`),
  );
  if (!Buffer.from(publicInputBytes[1]).equals(Buffer.from(nullifierHash))) {
    throw new Error("publicInputs[1] does not match nullifierHash");
  }
  if (!Buffer.from(publicInputBytes[2]).equals(Buffer.from(feToBE32(amount)))) {
    throw new Error("publicInputs[2] does not match amount");
  }

  return {
    recipient,
    relayer,
    amount,
    relayFeeBps,
    withdrawalData,
    nullifierHash,
    proofA,
    proofB,
    proofC,
    publicInputs: publicInputBytes.map((input) => Array.from(input)),
  };
}
