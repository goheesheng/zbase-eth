/**
 * coordinator.ts — off-chain orchestration for the 3-of-5 ASP postman.
 *
 * Each of the 5 signers runs ONE instance of this script as a daemon. Together,
 * the daemons converge on a shared root proposal, collect signatures, and any
 * one of them submits the on-chain `updateRoot` transaction once quorum is met.
 *
 * Message bus:
 *   v0 ships a filesystem-based bus (one JSON file per proposal under
 *   `./bus/<chainId>/<nonce>.json`) so a quorum can be rehearsed on a single
 *   host with no infrastructure. The interface is bus-agnostic — Redis Streams,
 *   NATS, or libp2p PubSub all drop in by implementing `MessageBus`. Picking
 *   the production bus is intentionally deferred (see governance.md §3).
 *
 * Lifecycle (each signer):
 *   1. Poll for new `Deposited` events since the latest accepted root.
 *   2. Run `risk-pipeline.runRiskPipeline(events)` deterministically.
 *   3. Rebuild the Poseidon Merkle tree of APPROVED labels (mirrors what the
 *      existing `/api/asp-update/route.ts` does today; the LeanIMT construction
 *      is identical).
 *   4. Compare the computed root to the latest proposal on the bus:
 *       - no proposal yet → publish one with this signer's signature attached;
 *       - proposal matches → append my signature;
 *       - proposal differs → log + abstain (do NOT race to publish a competing
 *         proposal; the next polling tick reconciles).
 *   5. When the proposal carries ≥ THRESHOLD signatures, submit the on-chain tx
 *      iff this signer is the lexicographically-first signer that has not yet
 *      seen the proposal land on-chain. This is the simplest race-free leader
 *      election that doesn't require shared infra.
 *
 * v0 deferred (per the plan, "actual ceremony … is out of scope here"):
 *   - Real signer key management (HSM, Fireblocks, Safe). v0 reads keys from
 *     `SIGNER_PRIVATE_KEY` env. Production: each signer holds their own HSM-
 *     backed key and never exposes it to this process.
 *   - Production message bus (currently filesystem).
 *   - On-call rotation / alerting for stuck quorums.
 *   - Slashing / accountability for a signer that publishes a divergent
 *     proposal (governance.md §6 stub).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2 } from "poseidon-lite";
import {
  digestOfDecisions,
  runRiskPipeline,
  type DepositEvent,
  type ScreeningResult,
} from "./risk-pipeline";
import { STATIC_FALLBACK_VERSION } from "../../src/lib/ofac-screening";

// ── Configuration ────────────────────────────────────────────────────────────

const THRESHOLD = 3;

export interface CoordinatorConfig {
  rpcUrl: string;
  thresholdEntrypoint: `0x${string}`;
  /** Address of the deployed pool we're screening deposits from. */
  pool: `0x${string}`;
  /** This signer's index (0..4) and key. */
  signerIndex: number;
  signerPrivateKey: `0x${string}`;
  /** Path the JSON message bus writes proposals to. */
  busDir: string;
  /** OFAC snapshot version pinned for this ceremony. */
  ofacSnapshotVersion: string;
  /** Polling interval in ms. */
  pollIntervalMs: number;
}

// ── Bus ──────────────────────────────────────────────────────────────────────

export interface SignedAttestation {
  signerIndex: number;
  signerAddress: `0x${string}`;
  signature: `0x${string}`;
  decisionDigest: `0x${string}`;
}

export interface RootProposal {
  chainId: number;
  nonce: bigint;
  newRoot: `0x${string}`;
  decisionDigest: `0x${string}`;
  ipfsCID: string;
  signatures: SignedAttestation[];
}

export interface MessageBus {
  load(nonce: bigint): Promise<RootProposal | null>;
  save(proposal: RootProposal): Promise<void>;
}

export class FileBus implements MessageBus {
  constructor(private readonly dir: string, private readonly chainId: number) {}

  private pathFor(nonce: bigint): string {
    return join(this.dir, String(this.chainId), `${nonce.toString()}.json`);
  }

  async load(nonce: bigint): Promise<RootProposal | null> {
    const path = this.pathFor(nonce);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      ...raw,
      nonce: BigInt(raw.nonce),
    } as RootProposal;
  }

  async save(proposal: RootProposal): Promise<void> {
    const path = this.pathFor(proposal.nonce);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        { ...proposal, nonce: proposal.nonce.toString() },
        null,
        2
      )
    );
  }
}

// ── Coordinator ──────────────────────────────────────────────────────────────

const THRESHOLD_ENTRYPOINT_ABI = [
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "latestRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "rootDigest",
    stateMutability: "view",
    inputs: [{ name: "newRoot", type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "updateRoot",
    stateMutability: "nonpayable",
    inputs: [
      { name: "newRoot", type: "bytes32" },
      { name: "ipfsCID", type: "string" },
      { name: "signers", type: "address[]" },
      { name: "signatures", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

export class ThresholdCoordinator {
  // Viem client types are intentionally inferred — declaring `PublicClient` /
  // `WalletClient` directly fights the generic transport/chain inference and
  // produces opaque structural-mismatch errors. Inferred types compile cleanly.
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;
  private readonly bus: MessageBus;
  private readonly signerAddress: `0x${string}`;

  constructor(private readonly cfg: CoordinatorConfig) {
    this.publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(cfg.rpcUrl),
    });
    const account = privateKeyToAccount(cfg.signerPrivateKey);
    this.signerAddress = account.address;
    this.walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(cfg.rpcUrl),
    });
    this.bus = new FileBus(cfg.busDir, baseSepolia.id);
  }

  /**
   * Single tick: fetch state, screen, sign or submit if appropriate.
   * Designed to be called from a polling loop, a cron, or a one-shot CLI.
   */
  async tick(events: readonly DepositEvent[]): Promise<{
    proposalNonce: bigint;
    didSign: boolean;
    didSubmit: boolean;
    reason?: string;
  }> {
    // 1. Read on-chain state.
    const onChainNonce = (await this.publicClient.readContract({
      address: this.cfg.thresholdEntrypoint,
      abi: THRESHOLD_ENTRYPOINT_ABI,
      functionName: "nonce",
    })) as bigint;

    // 2. Screen events deterministically.
    const { results, decisionDigest } = await runRiskPipeline({
      events,
      ofacSnapshotVersion: this.cfg.ofacSnapshotVersion,
    });
    const approvedLabels = results
      .filter((r): r is ScreeningResult => r.decision === "approve")
      .map((r) => r.label);

    // 3. Compute the new Merkle root over approved labels.
    const tree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
    tree.insertMany(approvedLabels);
    const newRoot = toBytes32(tree.root);

    // 4. Load (or initialize) the proposal for this nonce.
    let proposal = await this.bus.load(onChainNonce);
    if (!proposal) {
      proposal = {
        chainId: baseSepolia.id,
        nonce: onChainNonce,
        newRoot,
        decisionDigest,
        ipfsCID: `zbase-asp-${onChainNonce.toString()}`,
        signatures: [],
      };
    }

    // 5. Detect divergence. If the proposal's decision digest disagrees with
    //    ours, refuse to sign — quorum determinism is the whole point.
    if (proposal.decisionDigest !== decisionDigest || proposal.newRoot !== newRoot) {
      return {
        proposalNonce: onChainNonce,
        didSign: false,
        didSubmit: false,
        reason: "diverged from existing proposal — refusing to sign",
      };
    }

    // 6. Sign if I haven't already.
    const alreadySigned = proposal.signatures.some(
      (s) => s.signerIndex === this.cfg.signerIndex
    );
    let didSign = false;
    if (!alreadySigned) {
      const digest = await this.publicClient.readContract({
        address: this.cfg.thresholdEntrypoint,
        abi: THRESHOLD_ENTRYPOINT_ABI,
        functionName: "rootDigest",
        args: [newRoot as Hex],
      }) as Hex;

      // viem's signMessage handles EIP-191 wrapping. We've already wrapped on-
      // chain, so sign the raw 32-byte digest here? — NO. The contract wraps
      // with personal_sign. We must sign the INNER payload (the keccak before
      // personal_sign) so that the contract's recovery matches.
      const innerPayload = keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "uint256" },
            { type: "address" },
            { type: "uint256" },
          ],
          [
            newRoot as Hex,
            onChainNonce,
            this.cfg.thresholdEntrypoint,
            BigInt(baseSepolia.id),
          ]
        )
      );
      const signature = await this.walletClient.signMessage({
        account: this.walletClient.account!,
        message: { raw: innerPayload },
      });
      proposal.signatures.push({
        signerIndex: this.cfg.signerIndex,
        signerAddress: this.signerAddress,
        signature,
        decisionDigest,
      });
      await this.bus.save(proposal);
      didSign = true;

      // Silence unused-var lint for `digest` while keeping the on-chain
      // round-trip readable (it documents the canonical digest contract).
      void digest;
    }

    // 7. Submit when quorum is reached. Leader election: lowest signerIndex.
    let didSubmit = false;
    if (proposal.signatures.length >= THRESHOLD) {
      const leaderIndex = Math.min(...proposal.signatures.map((s) => s.signerIndex));
      if (leaderIndex === this.cfg.signerIndex) {
        const signers = proposal.signatures.map((s) => s.signerAddress);
        const sigs = proposal.signatures.map((s) => s.signature);
        await this.walletClient.writeContract({
          address: this.cfg.thresholdEntrypoint,
          abi: THRESHOLD_ENTRYPOINT_ABI,
          functionName: "updateRoot",
          args: [newRoot as Hex, proposal.ipfsCID, signers, sigs],
          chain: baseSepolia,
          account: this.walletClient.account!,
          gas: 300_000n,
        });
        didSubmit = true;
      }
    }

    return {
      proposalNonce: onChainNonce,
      didSign,
      didSubmit,
    };
  }

  /**
   * Long-running daemon — repeats `tick()` on a polling interval.
   * Event-fetching is left to the caller so tests can inject fixtures.
   */
  async run(fetcher: () => Promise<readonly DepositEvent[]>): Promise<void> {
    // Deliberate `while (true)` — this is a daemon. SIGINT exits the process.
    for (;;) {
      try {
        const events = await fetcher();
        const out = await this.tick(events);
        console.log(`[postman ${this.cfg.signerIndex}] tick:`, out);
      } catch (err) {
        console.error(`[postman ${this.cfg.signerIndex}] tick error:`, err);
      }
      await sleep(this.cfg.pollIntervalMs);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toBytes32(value: bigint): `0x${string}` {
  const hex = value.toString(16).padStart(64, "0");
  return (`0x${hex}`) as `0x${string}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── CLI entry ────────────────────────────────────────────────────────────────

if (typeof require !== "undefined" && require.main === module) {
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) throw new Error(`Missing env: ${key}`);
    return v;
  };
  const cfg: CoordinatorConfig = {
    rpcUrl: required("BASE_SEPOLIA_RPC"),
    thresholdEntrypoint: required("THRESHOLD_ENTRYPOINT") as `0x${string}`,
    pool: required("USDC_POOL_ADDRESS") as `0x${string}`,
    signerIndex: parseInt(required("SIGNER_INDEX"), 10),
    signerPrivateKey: required("SIGNER_PRIVATE_KEY") as `0x${string}`,
    busDir: process.env.POSTMAN_BUS_DIR ?? join(process.cwd(), "scripts", "threshold-postman", "bus"),
    ofacSnapshotVersion: process.env.OFAC_SNAPSHOT_VERSION ?? STATIC_FALLBACK_VERSION,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? "15000", 10),
  };

  // Stubbed event fetcher — wire to the real Deposited-event reader before launch.
  // The signature is intentionally identical to what `src/app/api/asp-update/route.ts`
  // already implements, so the proven fetcher there can be lifted verbatim.
  const fetcher = async (): Promise<readonly DepositEvent[]> => {
    void cfg; // marker for the wiring task
    return [];
  };

  new ThresholdCoordinator(cfg).run(fetcher).catch((err) => {
    console.error("coordinator crashed:", err);
    process.exit(1);
  });

  // Re-export for the digest helper in case downstream tooling imports it.
  void digestOfDecisions;
}
