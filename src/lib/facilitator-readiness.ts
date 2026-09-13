import { createPublicClient, http, parseAbiItem, getAddress } from "viem";
import { countAnonymitySet, countableFloorAtomic } from "./anonymity-count";
import {
  contractStackLaunchIssues,
  getActiveChain,
  getActiveStack,
  ZERO_ADDRESS,
} from "@/lib/contracts";
import {
  cacheLabelsMatch,
  cacheRootMatches,
  indexerAvailable,
  readIndexer,
} from "@/lib/indexer";
import { postmanSignerConfigIssues } from "@/lib/postman-signer";

/**
 * The scopes a blocker can shut. Each tier is one `.some()` over `blocks`, so a tier is
 * defined entirely by which blockers name it — there is no tier arithmetic anywhere.
 *
 * "pilot" is NOT "customer minus the anonymity gate", and deriving it that way would be
 * the bug. It is its own question — "is this sound enough to move real money, given an
 * honest disclosure that it is not private yet?" — and every blocker answers it
 * explicitly below. The dividing line is whether a DISCLOSURE can honestly cover it:
 *
 *   - A thin set, no E2E yet, no pull data, not monetised, no legal clearance: these do
 *     NOT block pilot. Each is disclosed or is the operator's own risk to carry.
 *   - Unprotected keys, an unverifiable set, a broken stack: these DO. You can tell a
 *     client "this is not private yet"; you cannot tell them "the secrets that spend your
 *     money are unencrypted" and call that a disclosed product.
 *
 * Despite the name there is no pilot MODE — no switch, no key, no allowlist. If pilotReady
 * is true, zBase settles. See src/lib/pilot.ts for why every gate we tried was answering
 * the wrong question.
 */
export type ReadinessScope = "verification" | "pilot" | "customer";

export interface FacilitatorReadinessIssue {
  code: string;
  message: string;
  blocks: ReadinessScope[];
}

export interface FacilitatorReadinessInput {
  network: "sepolia" | "mainnet" | "eth-sepolia";
  stackIssues: string[];
  postmanIssues: string[];
  rpcConfigured: boolean;
  seedEncryptionConfigured: boolean;
  aspAuthConfigured: boolean;
  chainReachable: boolean;
  anonymitySet: number;
  currentStateRoot: bigint;
  latestAspRoot: bigint | null;
  assetConfigPoolMatches: boolean;
  minimumDepositAmount: bigint;
  requiredMinimumDepositAmount: bigint;
  anonymitySetProvenanceVerified: boolean;
  indexerConfigured: boolean;
  indexerLeafCount: number;
  indexerStateRootMatches: boolean;
  indexerAspRootMatches: boolean;
  minimumAnonymitySet: number;
  /**
   * INDEPENDENT depositors — the actual anonymity set. NOT `anonymitySet` above, which
   * is currentTreeSize and is the right measure for pool liveness and indexer parity
   * (leaves vs leaves) but the WRONG one for privacy: it counts treasury seeds and your
   * own change notes. See src/lib/anonymity-count.ts.
   *
   * null = could not be determined (RPC/scan failure). Fails CLOSED: we cannot assert a
   * crowd we could not count.
   */
  organicAnonymitySet: number | null;
  pricingEnforced: boolean;
  mainnetE2EVerified: boolean;
  externalReviewApproved: boolean;
  legalClearanceApproved: boolean;
  customerPullConfirmed: boolean;
}

export interface FacilitatorReadiness {
  network: "sepolia" | "mainnet" | "eth-sepolia";
  verificationReady: boolean;
  /**
   * The stack is sound enough to move real money, PROVIDED every response discloses that
   * the payment is not private yet. True => zBase settles; there is no separate switch.
   * Never a synonym for customerReady and never implies a privacy claim — see
   * ReadinessScope and src/lib/pilot.ts.
   */
  pilotReady: boolean;
  customerReady: boolean;
  blockingReasons: FacilitatorReadinessIssue[];
  /** Pool commitments (currentTreeSize) — liveness + indexer parity, NOT privacy. */
  anonymitySet: number;
  /** Independent depositors — the real anonymity set. null = could not be counted. */
  organicAnonymitySet: number | null;
  minimumAnonymitySet: number;
  currentStateRoot: `0x${string}`;
  latestAspRoot: `0x${string}` | "0x";
  assetConfig: {
    poolMatches: boolean;
    minimumDepositAmount: string;
    requiredMinimumDepositAmount: string;
  };
  blockNumber: string;
  indexer: {
    configured: boolean;
    leafCount: number;
    stateRootMatches: boolean;
    aspRootMatches: boolean;
  };
  gates: {
    chainReachable: boolean;
    rpcConfigured: boolean;
    seedEncryptionConfigured: boolean;
    postmanConfigured: boolean;
    aspAuthConfigured: boolean;
    pricingEnforced: boolean;
    mainnetE2EVerified: boolean;
    externalReviewApproved: boolean;
    legalClearanceApproved: boolean;
    customerPullConfirmed: boolean;
    anonymitySetProvenanceVerified: boolean;
  };
}

const TREE_SIZE_ABI = [
  {
    name: "currentTreeSize",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const CURRENT_ROOT_ABI = [
  {
    name: "currentRoot",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const LATEST_ROOT_ABI = [
  {
    name: "latestRoot",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ASSET_CONFIG_ABI = [
  {
    name: "assetConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
  },
] as const;

function enabled(name: string): boolean {
  return String(process.env[name] ?? "false").toLowerCase() === "true";
}

function configuredRpc(network: "sepolia" | "mainnet" | "eth-sepolia"): boolean {
  if (network === "mainnet") {
    return Boolean(process.env.BASE_MAINNET_RPC || process.env.NEXT_PUBLIC_BASE_MAINNET_RPC);
  }
  if (network === "eth-sepolia") {
    return Boolean(process.env.ETH_SEPOLIA_RPC || process.env.NEXT_PUBLIC_ETH_SEPOLIA_RPC);
  }
  return Boolean(process.env.BASE_SEPOLIA_RPC || process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC);
}

/**
 * k=30 — the conventional anonymity-set lower bound (Tornado Cash research), and the
 * same threshold /api/anonymity-set uses to leave bootstrap disclosure.
 */
export const MAINNET_ANONYMITY_FLOOR = 30;

/**
 * The minimum anonymity set for customer use.
 *
 * ZBASE_MIN_CUSTOMER_ANONYMITY_SET may RAISE the bar but never lower it below 30 on
 * mainnet. Before this clamp, `ZBASE_MIN_CUSTOMER_ANONYMITY_SET=1` was a one-line path
 * to `customerReady:true` — which flips /supported to "Privacy-preserving x402
 * settlement" with an anonymity set of one and no disclosure anywhere. That is the
 * exact false claim every other gate in this file exists to prevent, reachable by
 * typing a number into an env var.
 *
 * You do not need this dial to transact before the set is real — zBase already settles
 * and DISCLOSES that the payment is not private. Turning this down would settle and claim
 * it IS private. That difference is the whole product.
 *
 * Sepolia is unclamped — it is a testnet and privacy claims there are not sold.
 */
function minimumAnonymitySet(network: "sepolia" | "mainnet" | "eth-sepolia"): number {
  const configured = Number(process.env.ZBASE_MIN_CUSTOMER_ANONYMITY_SET);
  const hasConfigured = Number.isSafeInteger(configured) && configured > 0;

  if (network !== "mainnet") return hasConfigured ? configured : 1;

  // Mainnet: the env var is a floor-raiser only.
  return hasConfigured ? Math.max(configured, MAINNET_ANONYMITY_FLOOR) : MAINNET_ANONYMITY_FLOOR;
}

function requiredMinimumDepositAmount(): bigint {
  const configured = process.env.ZBASE_REQUIRED_MIN_DEPOSIT_ATOMIC;
  if (configured) {
    try {
      const value = BigInt(configured);
      if (value > 0n) return value;
    } catch {
      // Fall through to the production-safe USDC default.
    }
  }
  return 1_000_000n;
}

function rootHex(root: bigint): `0x${string}` {
  return `0x${root.toString(16).padStart(64, "0")}`;
}

export function evaluateFacilitatorReadiness(
  input: FacilitatorReadinessInput,
): Pick<
  FacilitatorReadiness,
  "verificationReady" | "pilotReady" | "customerReady" | "blockingReasons"
> {
  const blockingReasons: FacilitatorReadinessIssue[] = [];
  const add = (code: string, message: string, blocks: ReadinessScope[]) => {
    blockingReasons.push({ code, message, blocks });
  };
  /** The stack is broken. Nothing works, for anyone, at any tier. */
  const all: ReadinessScope[] = ["verification", "pilot", "customer"];
  /**
   * Safety, not a privacy claim — so a disclosure cannot buy its way past. Blocks pilot
   * AND customer, but not verification: sellers verifying a payment header are not
   * exposed to these.
   */
  const unsafe: ReadinessScope[] = ["pilot", "customer"];
  /**
   * The privacy claim itself, or evidence the pilot exists to GATHER. A pilot that ran
   * only once these cleared could never start — the pilot is how they clear.
   */
  const claimOnly: ReadinessScope[] = ["customer"];

  if (input.stackIssues.length > 0) {
    add("STACK_CONFIG", `Contract stack is incomplete: ${input.stackIssues.join("; ")}.`, all);
  }
  if (!input.rpcConfigured) {
    // Blocks pilot: a public RPC is rate-limited, and every settle builds a proof against
    // freshly-read chain state. Real client money on a best-effort endpoint is a
    // reliability problem, and no disclosure makes a dropped settle acceptable.
    add("RPC_NOT_CONFIGURED", "A production RPC endpoint is not configured.", unsafe);
  }
  if (!input.chainReachable) {
    add("CHAIN_UNREACHABLE", "The active chain or privacy-pool contracts could not be read.", all);
  }
  if (input.chainReachable) {
    if (!input.assetConfigPoolMatches) {
      add("ASSET_CONFIG_POOL_MISMATCH", "The entrypoint asset configuration does not point to the active privacy pool.", all);
    }
    if (input.anonymitySet === 0) {
      add("EMPTY_ANONYMITY_SET", "The privacy pool has no deposits.", all);
    } else {
      if (input.currentStateRoot === 0n) {
        add("STATE_ROOT_UNAVAILABLE", "The privacy pool has no usable state root.", all);
      }
      if (!input.latestAspRoot || input.latestAspRoot === 0n) {
        add("ASP_ROOT_UNAVAILABLE", "No Association Set Provider root has been posted.", all);
      }
    }
  }
  if (!input.indexerConfigured) {
    add("INDEXER_NOT_CONFIGURED", "The root-verified shared indexer is not configured.", all);
  } else if (input.anonymitySet > 0) {
    if (!input.indexerStateRootMatches || input.indexerLeafCount !== input.anonymitySet) {
      add("INDEXER_STATE_ROOT_MISMATCH", "The indexer state tree is cold or does not match the pool.", all);
    }
    if (!input.indexerAspRootMatches) {
      add("INDEXER_ASP_ROOT_MISMATCH", "The indexer association set is cold or does not match the ASP root.", all);
    }
  }
  if (input.postmanIssues.length > 0) {
    // Blocks pilot: the postman relays and sponsors the withdrawal. If it is not
    // launch-ready, client funds enter the pool and cannot come out.
    add("POSTMAN_CONFIG", `The postman signer is not launch-ready: ${input.postmanIssues.join("; ")}.`, unsafe);
  }
  if (!input.seedEncryptionConfigured) {
    // Blocks pilot, and this is the clearest case in the file: a disclosure can say "your
    // payment is not anonymous yet". It cannot say "the secrets that spend your money sit
    // unencrypted on our disk" and have the client meaningfully accept that. Disclosure
    // covers a WEAKER claim; it does not cover custody of the keys to real funds.
    add("SEED_ENCRYPTION_NOT_CONFIGURED", "Server-side deposit secrets are not protected by a configured encryption key.", unsafe);
  }
  if (!input.aspAuthConfigured) {
    // Blocks pilot: an unauthenticated ASP root writer lets anyone post an association
    // root, which is a withdrawal-authorising input. That is a fund-safety hole.
    add("ASP_AUTH_NOT_CONFIGURED", "The ASP root writer is not protected by production authentication.", unsafe);
  }
  // PRIVACY gate — independent depositors only. `anonymitySet` (treeSize) would count
  // treasury seeds and the payer's own change notes, so 30 self-deposits would satisfy
  // it while the real crowd was one person. That is the exact failure this gate exists
  // to prevent.
  // `typeof !== "number"`, NOT `=== null`. undefined is neither null nor a number, and
  // `undefined < 30` evaluates FALSE — so an omitted field would skip the blocker and
  // silently OPEN the gate. Fail-open is the one outcome this whole file exists to
  // prevent, and scripts/ is excluded from tsc so a stale caller would not be caught at
  // compile time. Treat anything that is not a real count as "could not determine".
  if (typeof input.organicAnonymitySet !== "number" || !Number.isFinite(input.organicAnonymitySet)) {
    add(
      "ANONYMITY_SET_BELOW_MINIMUM",
      "The independent-depositor count could not be read, so the anonymity set cannot be asserted.",
      claimOnly,
    );
  } else if (input.anonymitySet > 0 && input.organicAnonymitySet < input.minimumAnonymitySet) {
    // Does NOT block pilot. This is the one blocker the pilot exists to RESOLVE: the set
    // only grows when independent people deposit, and they only deposit if they can
    // transact. Blocking the pilot on it would be a deadlock — the set can never reach 30
    // if nobody may pay until it does. Pilot mode permits the payment and DISCLOSES that
    // it is not private; that is the honest form of this trade, and the reason
    // ZBASE_MIN_CUSTOMER_ANONYMITY_SET is clamped rather than left as an easier path.
    add(
      "ANONYMITY_SET_BELOW_MINIMUM",
      `The anonymity set is ${input.organicAnonymitySet} independent depositor(s); customer use requires at least ${input.minimumAnonymitySet}. ` +
        `(The pool holds ${input.anonymitySet} commitment(s) — treasury deposits and change notes are not anonymity.)`,
      claimOnly,
    );
  }
  if (
    input.chainReachable &&
    input.minimumDepositAmount < input.requiredMinimumDepositAmount
  ) {
    const isZero = input.minimumDepositAmount === 0n;
    // ZERO blocks pilot; merely-below-required does not. The distinction is not pedantry:
    // at a minimum of 0, commitments are free and unlimited, so the disclosed number
    // ("the set is N") is not evidence of anything and an attacker can inflate it at
    // will. Pilot mode's entire product is an honest count, so a meaningless count
    // defeats it. At ANY nonzero minimum, spam costs real money per commitment — the
    // count means something, it is just below our policy bar, which is exactly what the
    // disclosure states.
    add(
      isZero ? "ZERO_MINIMUM_DEPOSIT" : "MINIMUM_DEPOSIT_BELOW_REQUIRED",
      isZero
        ? `The entrypoint accepts zero-value deposits; customer use requires a minimum of ${input.requiredMinimumDepositAmount} atomic units.`
        : `The deployed minimum is ${input.minimumDepositAmount} atomic units; customer use requires at least ${input.requiredMinimumDepositAmount}.`,
      isZero ? unsafe : claimOnly,
    );
  }

  if (input.network === "mainnet") {
    if (!input.pricingEnforced) {
      // Does not block pilot: a pilot need not monetise. Charging inconsistently is a
      // commercial defect, not a fund-safety or privacy one.
      add("PRICING_NOT_ENFORCED", "Hosted mainnet pricing is not enforced consistently.", claimOnly);
    }
    if (!input.mainnetE2EVerified) {
      // Does not block pilot: the pilot IS the end-to-end. Requiring a verified E2E before
      // permitting the payments that would produce one is the same deadlock as the
      // anonymity gate.
      add("MAINNET_E2E_NOT_VERIFIED", "An unrelated end-to-end mainnet private settlement has not been approved.", claimOnly);
    }
    if (!input.externalReviewApproved) {
      // Blocks pilot. Real client funds sit in contracts nobody outside has reviewed; a
      // disclosure about ANONYMITY says nothing about whether the money can be lost. The
      // operator clears this by asserting the review exists (see
      // ZBASE_EXTERNAL_REVIEW_APPROVED in deploy/mainnet.app.env.example, which records
      // what the vendor audit does and does not cover) — not by pilot mode routing around
      // it.
      add("EXTERNAL_REVIEW_NOT_APPROVED", "External contract and operations review is not approved.", unsafe);
    }
    if (!input.legalClearanceApproved) {
      // Blocks the CLAIM, not early access — an operator decision (2026-07-17), recorded
      // here because the reasoning is not self-evident from the flag.
      //
      // The argument: the ASP is live and enforcing. Deposits are OFAC-screened and a
      // sanctioned depositor's label is excluded from the association set, so they can
      // never privately withdraw; screening fails CLOSED. That is the Privacy Pools
      // compliance design doing its job, and it addresses the laundering vector directly.
      //
      // What it does NOT address is licensing — the ASP governs who is in the pool, not
      // whether operating the pool as a business needs a payment-services registration.
      // Those are separate regimes, and server-side proving (withdraw/route.ts receives
      // the note's full spend authority) makes the "we are only non-custodial
      // infrastructure" position weaker than it would be for a pure protocol.
      //
      // So this stays a REPORTED blocker, visible on /supported and /health, rather than
      // being cleared by ZBASE_LEGAL_CLEARANCE_APPROVED. The flag asserts that clearance
      // EXISTS; the operator's position is that it is not required. Setting it would
      // record a fact that is not true and lose the distinction the next person needs.
      add("LEGAL_CLEARANCE_NOT_APPROVED", "Jurisdiction-specific legal clearance is not approved.", claimOnly);
    }
    if (!input.customerPullConfirmed) {
      // Does not block pilot: the pilot IS the demand test.
      add("CUSTOMER_PULL_NOT_CONFIRMED", "Signed customer pull for private routing is not confirmed.", claimOnly);
    }
    if (!input.anonymitySetProvenanceVerified) {
      // Does not block pilot — same reason as ANONYMITY_SET_BELOW_MINIMUM. It is a human
      // judgement about whether the set is independent (sybils make the count alone
      // insufficient), and there is no set to judge until the pilot produces one.
      add(
        "ANONYMITY_SET_PROVENANCE_NOT_VERIFIED",
        "The mainnet anonymity set has not been approved as independent enough for customer privacy claims.",
        claimOnly,
      );
    }
  }

  return {
    verificationReady: !blockingReasons.some((reason) => reason.blocks.includes("verification")),
    pilotReady: !blockingReasons.some((reason) => reason.blocks.includes("pilot")),
    customerReady: !blockingReasons.some((reason) => reason.blocks.includes("customer")),
    blockingReasons,
  };
}

const CACHE_TTL_MS = 10_000;
let cache: { key: string; expiresAt: number; value: FacilitatorReadiness } | null = null;
let inFlight: { key: string; value: Promise<FacilitatorReadiness> } | null = null;

/**
 * The independent-depositor count is cached FAR longer than the rest of readiness.
 *
 * Counting it means scanning every Deposited event from the pool's deploy block — ~16s
 * on mainnet. Readiness itself caches for only 10s and is called by /health (which
 * Docker health-checks every 30s) and /supported, so folding a 16s scan into that path
 * would time the health check out and make every cache expiry cost 16 seconds.
 *
 * A 10-minute TTL is safe because the number moves in deposits, not seconds: a new
 * depositor is visible within 10 minutes, and being stale can only ever UNDER-report —
 * the gate stays shut slightly longer. It can never over-report, which is the only
 * direction that would matter.
 */
const DEPOSITOR_COUNT_TTL_MS = 10 * 60 * 1000;
let depositorCache: { key: string; expiresAt: number; value: number | null } | null = null;
let depositorInFlight: { key: string; value: Promise<number | null> } | null = null;

/** Deposited(…) — we need the depositor AND the value; neither is in the tree size. */
const DEPOSITED_EVENT_FOR_COUNT = parseAbiItem(
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
);

/**
 * Count INDEPENDENT depositors from Deposited events.
 *
 * Returns null when it cannot be determined. The caller fails CLOSED on null, because
 * "we could not count the crowd" must never be read as "the crowd is big enough".
 */
async function countOrganicDepositors(
  client: ReturnType<typeof createPublicClient>,
  stack: ReturnType<typeof getActiveStack>,
  cacheKey: string,
): Promise<number | null> {
  if (depositorCache && depositorCache.key === cacheKey && Date.now() < depositorCache.expiresAt) {
    return depositorCache.value;
  }
  if (depositorInFlight && depositorInFlight.key === cacheKey) return depositorInFlight.value;

  const pending = (async (): Promise<number | null> => {
    try {
      const [logs, assetConfig] = await Promise.all([
        client.getLogs({
          address: stack.usdcPool as `0x${string}`,
          event: DEPOSITED_EVENT_FOR_COUNT,
          fromBlock: BigInt(stack.poolDeployBlock),
          toBlock: "latest",
        }),
        client.readContract({
          address: stack.entrypoint as `0x${string}`,
          abi: ASSET_CONFIG_ABI,
          functionName: "assetConfig",
          args: [stack.usdc as `0x${string}`],
        }) as Promise<readonly [string, bigint, bigint, bigint]>,
      ]);

      // Derive the dust floor from the LIVE config. The entrypoint checks its minimum
      // PRE-fee while the event carries POST-fee, so comparing against assetConfig[1]
      // directly would reject every legitimate minimum deposit as dust.
      const floor = countableFloorAtomic(BigInt(assetConfig[1]), BigInt(assetConfig[2]));

      const treasury = process.env.ZBASE_TREASURY_ADDRESS
        ? (getAddress(process.env.ZBASE_TREASURY_ADDRESS) as `0x${string}`)
        : null;

      const deposits = logs.flatMap((l) => {
        const a = l.args as { _depositor?: `0x${string}`; _value?: bigint };
        if (!a._depositor || a._value === undefined) return [];
        return [{ depositor: getAddress(a._depositor) as `0x${string}`, value: a._value }];
      });

      // distinctDepositors, NOT organic. `organic` counts DEPOSITS; this gate asserts how
      // many independent PARTIES a withdrawal could have come from, and those diverge the
      // moment anyone deposits twice.
      //
      // Wiring `.organic` here (as this did until 2026-07-17) meant one client depositing
      // $1 thirty times read as 30, flipped customerReady:true, and made /supported
      // announce "Privacy-preserving x402 settlement" with a single real participant —
      // the exact false claim Phase B exists to prevent, reopened one level down. The
      // blocker message said "N independent depositor(s)", which was simply not what N
      // was. anonymity-count.ts already spelled it out: "one party making 30 deposits is
      // 30 organic deposits and ONE participant".
      //
      // Why parties and not notes: if Alice deposits 30 times and Bob once, a withdrawal
      // has 31 candidate notes but only TWO candidate people. An observer asking WHO paid
      // is choosing between 2. Extra notes buy Alice no anonymity — only Bob does.
      //
      // Sybils can still split across addresses, so this number cannot be the whole
      // answer; ANONYMITY_SET_PROVENANCE_NOT_VERIFIED keeps that a human judgement. This
      // makes the automatic number honest, not sufficient.
      return countAnonymitySet(deposits, treasury, floor).distinctDepositors;
    } catch {
      return null; // unknown → the caller blocks customer use
    }
  })();

  depositorInFlight = { key: cacheKey, value: pending };
  try {
    const value = await pending;
    depositorCache = { key: cacheKey, expiresAt: Date.now() + DEPOSITOR_COUNT_TTL_MS, value };
    return value;
  } finally {
    if (depositorInFlight?.value === pending) depositorInFlight = null;
  }
}

export async function getFacilitatorReadiness(): Promise<FacilitatorReadiness> {
  const stack = getActiveStack();
  const activeChain = getActiveChain();
  const cacheKey = `${activeChain.network}:${stack.entrypoint}:${stack.usdcPool}`;
  if (cache && cache.key === cacheKey && Date.now() < cache.expiresAt) return cache.value;
  if (inFlight && inFlight.key === cacheKey) return inFlight.value;

  const pending = computeFacilitatorReadiness(stack, activeChain, cacheKey);
  inFlight = { key: cacheKey, value: pending };
  try {
    return await pending;
  } finally {
    if (inFlight?.value === pending) inFlight = null;
  }
}

async function computeFacilitatorReadiness(
  stack: ReturnType<typeof getActiveStack>,
  activeChain: ReturnType<typeof getActiveChain>,
  cacheKey: string,
): Promise<FacilitatorReadiness> {
  const stackIssues = contractStackLaunchIssues(stack);
  const postmanIssues = postmanSignerConfigIssues();
  let blockNumber = "0";
  let chainReachable = false;
  let anonymitySet = 0;
  let currentStateRoot = 0n;
  let latestAspRoot: bigint | null = null;
  let assetConfigPoolMatches = false;
  let minimumDepositAmount = 0n;
  // null until counted. Stays null on any failure — the gate then blocks customer use
  // rather than assume a crowd it could not see.
  let organicAnonymitySet: number | null = null;

  if (stack.entrypoint !== ZERO_ADDRESS && stack.usdcPool !== ZERO_ADDRESS) {
    const client = createPublicClient({
      chain: activeChain.chain,
      transport: http(activeChain.readRpcUrl),
    });
    try {
      const [latestBlock, treeSize, stateRoot, assetConfig] = await Promise.all([
        client.getBlockNumber(),
        client.readContract({ address: stack.usdcPool, abi: TREE_SIZE_ABI, functionName: "currentTreeSize" }),
        client.readContract({ address: stack.usdcPool, abi: CURRENT_ROOT_ABI, functionName: "currentRoot" }),
        client.readContract({
          address: stack.entrypoint,
          abi: ASSET_CONFIG_ABI,
          functionName: "assetConfig",
          args: [stack.usdc],
        }),
      ]);
      blockNumber = latestBlock.toString();
      anonymitySet = Number(treeSize);
      currentStateRoot = BigInt(stateRoot);
      assetConfigPoolMatches = assetConfig[0].toLowerCase() === stack.usdcPool.toLowerCase();
      minimumDepositAmount = BigInt(assetConfig[1]);
      chainReachable = true;

      // The PRIVACY number, cached separately (10 min) — it needs a full Deposited scan
      // and must never be in the 10s readiness path that /health hits.
      organicAnonymitySet = await countOrganicDepositors(client, stack, cacheKey);

      // Entrypoint.latestRoot() deliberately reverts with NoRootsAvailable()
      // before the first approved deposit. Never call it for an empty pool.
      if (anonymitySet > 0) {
        try {
          latestAspRoot = BigInt(await client.readContract({
            address: stack.entrypoint,
            abi: LATEST_ROOT_ABI,
            functionName: "latestRoot",
          }));
        } catch {
          latestAspRoot = null;
        }
      }
    } catch {
      chainReachable = false;
    }
  }

  const indexerConfigured = indexerAvailable();
  let indexerLeafCount = 0;
  let indexerStateRootMatches = false;
  let indexerAspRootMatches = false;
  if (indexerConfigured && chainReachable && anonymitySet > 0) {
    try {
      const indexed = await readIndexer({
        network: stack.facilitatorNetwork,
        pool: stack.usdcPool,
        deployBlock: stack.poolDeployBlock,
      });
      indexerLeafCount = indexed.leafCount;
      indexerStateRootMatches = cacheRootMatches(indexed, currentStateRoot);
      indexerAspRootMatches = latestAspRoot !== null && cacheLabelsMatch(indexed, latestAspRoot);
    } catch {
      // A cold or unavailable shared cache remains explicitly not ready.
    }
  }

  const input: FacilitatorReadinessInput = {
    network: activeChain.network,
    stackIssues,
    postmanIssues,
    rpcConfigured: configuredRpc(activeChain.network),
    seedEncryptionConfigured: Boolean(process.env.ZBASE_SEED_ENCRYPTION_KEY),
    aspAuthConfigured:
      process.env.NODE_ENV !== "production" || Boolean(process.env.ASP_UPDATE_SECRET || process.env.CRON_SECRET),
    chainReachable,
    anonymitySet,
    currentStateRoot,
    latestAspRoot,
    assetConfigPoolMatches,
    minimumDepositAmount,
    requiredMinimumDepositAmount: requiredMinimumDepositAmount(),
    indexerConfigured,
    indexerLeafCount,
    indexerStateRootMatches,
    indexerAspRootMatches,
    minimumAnonymitySet: minimumAnonymitySet(activeChain.network),
    organicAnonymitySet,
    pricingEnforced: enabled("ZBASE_FEE_REQUIRED"),
    mainnetE2EVerified: enabled("ZBASE_MAINNET_E2E_VERIFIED"),
    externalReviewApproved: enabled("ZBASE_EXTERNAL_REVIEW_APPROVED"),
    legalClearanceApproved: enabled("ZBASE_LEGAL_CLEARANCE_APPROVED"),
    customerPullConfirmed: enabled("ZBASE_PRIVATE_ROUTE_CUSTOMER_PULL_CONFIRMED"),
    anonymitySetProvenanceVerified: enabled("ZBASE_ANONYMITY_SET_PROVENANCE_VERIFIED"),
  };
  const evaluated = evaluateFacilitatorReadiness(input);
  const value: FacilitatorReadiness = {
    network: input.network,
    ...evaluated,
    anonymitySet,
    organicAnonymitySet,
    minimumAnonymitySet: input.minimumAnonymitySet,
    currentStateRoot: rootHex(currentStateRoot),
    latestAspRoot: latestAspRoot === null ? "0x" : rootHex(latestAspRoot),
    assetConfig: {
      poolMatches: input.assetConfigPoolMatches,
      minimumDepositAmount: input.minimumDepositAmount.toString(),
      requiredMinimumDepositAmount: input.requiredMinimumDepositAmount.toString(),
    },
    blockNumber,
    indexer: {
      configured: indexerConfigured,
      leafCount: indexerLeafCount,
      stateRootMatches: indexerStateRootMatches,
      aspRootMatches: indexerAspRootMatches,
    },
    gates: {
      chainReachable: input.chainReachable,
      rpcConfigured: input.rpcConfigured,
      seedEncryptionConfigured: input.seedEncryptionConfigured,
      postmanConfigured: postmanIssues.length === 0,
      aspAuthConfigured: input.aspAuthConfigured,
      pricingEnforced: input.pricingEnforced,
      mainnetE2EVerified: input.mainnetE2EVerified,
      externalReviewApproved: input.externalReviewApproved,
      legalClearanceApproved: input.legalClearanceApproved,
      customerPullConfirmed: input.customerPullConfirmed,
      anonymitySetProvenanceVerified: input.anonymitySetProvenanceVerified,
    },
  };
  cache = { key: cacheKey, expiresAt: Date.now() + CACHE_TTL_MS, value };
  return value;
}
