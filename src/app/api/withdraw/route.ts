import { NextResponse } from "next/server";
import {
  createPublicClient,
  http,
  encodeAbiParameters,
  keccak256,
  toHex,
  isAddress,
} from "viem";
import { poseidon2, poseidon3 } from "poseidon-lite";
import { LeanIMT } from "@zk-kit/lean-imt";
import * as snarkjs from "snarkjs";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getActiveStack, getActiveChain, type ContractStack } from "@/lib/contracts";
import { sendPostmanTx, postmanSignerKind } from "@/lib/postman-signer";
import {
  getAuthorizedTier,
  treasuryAddress,
  takeBpsFor,
  resolveEffectiveFeeTier,
  userIsPremium,
  type FacilitatorNetwork,
  type PricingTier,
} from "@/lib/facilitator-authz";
import { findProviderByPayTo } from "@/app/api/providers/register/route";
import { readIndexer, indexerAvailable, cacheRootMatches, cacheLabelsMatch, hexBlock } from "@/lib/indexer";
// CRITICAL C1 fix (2026-07-09): screen ASP labels here too, so /api/withdraw can
// never build/write an UNSCREENED ASP root (sanctions bypass). Same helpers as
// /api/asp-update.
import { createConfiguredScreeningProvider } from "@/lib/ofac-screening";
import { screenDeposits } from "@/lib/asp-screening";
import { SNARK_SCALAR_FIELD } from "@zbase-protocol/core";
// UTXO primitives live on the /experimental subpath (SDK audit 2026-07-09) —
// this is the 501-gated UTXO route; not part of the deployed public SDK surface.
import {
  commitmentOf,
  createDummyNote,
  createNote,
  deriveRecipientNPK,
  nullifierHashOf,
  planSpend,
  type Note,
} from "@zbase-protocol/core/experimental";
import { randomBytes } from "@noble/hashes/utils";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { executorGateForStack } from "@/lib/executor-gate";
import { hypersyncUrlFor, hypersyncToken } from "@/lib/hypersync";
// HyperRPC: standard JSON-RPC powered by HyperSync (no block range limits, no rate limits)

const _stack = getActiveStack();
const ENTRYPOINT_ADDRESS = _stack.entrypoint;
const USDC_POOL_ADDRESS = _stack.usdcPool;
const POOL_DEPLOY_BLOCK = Number(_stack.poolDeployBlock);
const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const DEPOSITED_TOPIC = keccak256(toHex("Deposited(address,uint256,uint256,uint256,uint256)"));
const LEAF_TOPIC = keccak256(toHex("LeafInserted(uint256,uint256,uint256)"));
// Historical PrivacyPoolMorpho yield-distribution event. The active plain 0xbow
// pool does not emit this; keep the parser only for backwards-compatible clients
// and old receipts.
// Signature must match contracts/PrivacyPoolMorpho.sol exactly:
//   event YieldDistributed(address indexed recipient, uint256 principal, uint256 yieldAmount, uint256 fee);
const YIELD_DISTRIBUTED_TOPIC = keccak256(
  toHex("YieldDistributed(address,uint256,uint256,uint256)"),
);

// Old RPC event definitions removed — now using HyperSync with topic hashes directly

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
 * Optional caller-supplied secrets for the CHANGE note (`nextNullifier` /
 * `nextSecret`, decimal strings). When present they replace the server's random
 * ones, which makes the change note re-derivable from the caller's seed — see the
 * long comment at the newNullifier assignment for why that matters.
 *
 * Validation is strict on purpose. A silently-truncated or out-of-field value
 * would produce a commitment whose secrets nobody holds — i.e. exactly the
 * permanent-loss bug this feature exists to remove. Reject loudly instead:
 * the note is still unspent at this point, so the caller can simply retry.
 *
 * Both-or-neither: a half-supplied pair means the caller's derivation is broken,
 * and silently randomising the other half would hand back an unrecoverable note.
 */
function parseClientNextNote(
  body: Record<string, unknown>,
): { nullifier: bigint; secret: bigint } | null {
  const rawNullifier = body.nextNullifier;
  const rawSecret = body.nextSecret;
  if (rawNullifier === undefined && rawSecret === undefined) return null;
  if (rawNullifier === undefined || rawSecret === undefined) {
    throw new Error(
      "nextNullifier and nextSecret must be supplied together (a half-derived change note would be unspendable).",
    );
  }

  const toField = (v: unknown, name: string): bigint => {
    if (typeof v !== "string" || !/^[0-9]+$/.test(v)) {
      throw new Error(`${name} must be a decimal field-element string.`);
    }
    const n = BigInt(v);
    // 0 is a valid field element but a degenerate secret; reject it rather than
    // mint a note whose precommitment is guessable.
    if (n <= 0n || n >= SNARK_FIELD) {
      throw new Error(`${name} must be in [1, SNARK_FIELD-1]; got a value outside the field.`);
    }
    return n;
  };

  const nullifier = toField(rawNullifier, "nextNullifier");
  const secret = toField(rawSecret, "nextSecret");
  if (nullifier === secret) {
    throw new Error("nextNullifier and nextSecret must differ.");
  }
  return { nullifier, secret };
}

/**
 * POST /api/withdraw
 *
 * Server-side private withdrawal with ZK proof generation.
 *
 * Body: { nullifier, secret, value, label, commitment, recipient, amountAtomic? }
 *
 * Flow:
 * 1. Fetch all deposits → build state tree + ASP tree
 * 2. Generate Merkle proofs
 * 3. Compute context
 * 4. Generate Groth16 withdrawal proof (snarkjs)
 * 5. Verify proof locally
 * 6. Submit relay tx on-chain
 */
export async function POST(request: Request) {
  try {
    // ── Phase 1A: UTXO branch ────────────────────────────────────────────────
    // The UTXO note-spend path is a SIBLING of the single-value flow below,
    // not an extension. Opted into via `?pool=utxo`; default behaviour is
    // unchanged. If the caller passes `?pool=utxo` we hand off to a dedicated
    // handler in ./utxo (no shared state, no shared mutation). See
    // packages/svm/zx402-privacy-pool ... err, zbase-protocol/.../UTXOPool.sol
    // for the contract surface and packages/core/src/notes.ts for the SDK.
    const url = new URL(request.url);
    const poolParam = url.searchParams.get("pool");
    if (poolParam === "utxo") {
      const unsafeTestMode = url.searchParams.get("unsafeTestMode") === "true";
      return handleUtxoSpend(request, { unsafeTestMode });
    }
    if (poolParam && poolParam !== "single-value") {
      return NextResponse.json(
        { error: `Unknown pool param: "${poolParam}". Supported: "single-value" (default), "utxo".` },
        { status: 400 },
      );
    }
    // ── End UTXO branch — single-value flow continues unchanged below ────────

    // External-ASP guard (fail loud, never touch the chain): on stacks where
    // zBase is not the ASP_POSTMAN (e.g. Ethereum Sepolia, where 0xbow's own
    // postman posts the ASP root), a withdrawal proof would have to match a
    // root we don't build and can't predict — refuse before any RPC/proof work.
    if (_stack.externalAsp) {
      return NextResponse.json(
        {
          error: "withdraw_unsupported_on_stack",
          message:
            "This stack's ASP root is posted by a third-party postman (0xbow); zBase is not the ASP_POSTMAN on this pool, so withdrawals cannot be proven/relayed here yet. Deposit, indexing and anonymity-set reads are supported.",
        },
        { status: 501 },
      );
    }

    const ZERO = "0x0000000000000000000000000000000000000000";
    if (
      USDC_POOL_ADDRESS.toLowerCase() === ZERO ||
      ENTRYPOINT_ADDRESS.toLowerCase() === ZERO ||
      POOL_DEPLOY_BLOCK === 0
    ) {
      return NextResponse.json(
        {
          error:
            "Active Base stack is not fully configured. Deploy and wire entrypoint, pool, and poolDeployBlock before enabling withdrawals.",
        },
        { status: 503 },
      );
    }

    const body = await request.json();
    const {
      nullifier: nullifierStr,
      secret: secretStr,
      value: valueStr,
      label: labelStr,
      commitment: commitmentStr,
      recipient,
      amountAtomic,
    } = body;

    // Validate the optional caller-supplied change-note secrets UP FRONT: a typo'd
    // derivation should cost a 400, not a full HyperSync scan and a proof. Used far
    // below at the newNullifier assignment; parsed here so we fail fast and cheap.
    let clientNext: { nullifier: bigint; secret: bigint } | null;
    try {
      clientNext = parseClientNextNote(body);
    } catch (e) {
      // Caller error, not server error — and the note is still unspent, so they can
      // fix the derivation and retry with nothing lost.
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    // B2 ExecutorProcessooor path (private-funded DeFi access). When present, the
    // withdrawal's processooor becomes the executor and `data` carries an ABI-encoded
    // ExecPlan (bound into `context`), submitted via executeFromPool instead of relay.
    // Absent → the single-value money path below is byte-for-byte unchanged.
    // NOTE: /withdraw is public. The shared executor gate below is mandatory;
    // /facilitator/call validation alone is not an authorization boundary.
    const callPlan = body.callPlan as
      | {
          target: string;
          inputToken: string;
          outputToken: string;
          minOut: string;
          recipient: string;
          callData: string;
        }
      | undefined;
    const isCallPlan = !!callPlan;
    // Do not trust the public /facilitator/call route as the only launch gate:
    // /withdraw is itself public. Enforce the same mainnet audit approval here
    // before any proof generation, RPC scan, or postman gas can be consumed.
    const executorGate = isCallPlan ? executorGateForStack(_stack) : null;
    if (executorGate && !executorGate.enabled) {
      return NextResponse.json(
        { error: executorGate.error, code: executorGate.code },
        { status: 501 },
      );
    }
    const EXECUTOR_ADDRESS =
      executorGate?.enabled ? executorGate.executor : _stack.executorProcessooor;
    // 2026-06-08 (FIND-301 fix): fee parameters are NEVER taken from the
    // request body. They are SERVER-RESOLVED from the nullifier's tier in
    // Upstash. If a buyer authorized at standard tier, every withdraw of
    // their nullifier pays 30 bps to treasury — regardless of what they
    // POST. Demo route + reclaim scripts work because their nullifiers
    // aren't in Upstash → tier resolves to null → no-op (recipient gets
    // full amount, no fee skim). This closes the bypass where a buyer
    // could call /api/withdraw directly with relayFeeBPS=0 to escape the
    // per-settle take advertised on /supported.
    const startTime = Date.now();

    // On the executor (callPlan) path the pool pushes funds to the EXECUTOR, which then
    // spends them into the whitelisted call and sweeps to ExecPlan.finalRecipient. So the
    // withdrawal-level "recipient" IS the executor here; the human recipient lives inside
    // the ExecPlan (validated by /api/facilitator/call before forwarding). For the default
    // path, recipient must be a real address as before.
    const effectiveRecipient = isCallPlan ? EXECUTOR_ADDRESS : recipient;
    if (isCallPlan && (!EXECUTOR_ADDRESS || /^0x0{40}$/i.test(EXECUTOR_ADDRESS))) {
      return NextResponse.json(
        { error: "callPlan supplied but no ExecutorProcessooor is configured for the active stack." },
        { status: 501 },
      );
    }
    if (!effectiveRecipient || !isAddress(effectiveRecipient)) {
      return NextResponse.json({ error: `Invalid recipient address: "${effectiveRecipient}"` }, { status: 400 });
    }

    // Rate limit (security-sweep-2026-06-25): the single-value path runs
    // body→ZK proof→POSTMAN-signed relay() with no caller auth. Without a limit,
    // a caller (or a replayed settle body) can drive unbounded POSTMAN gas + proof
    // CPU. Nullifier-keyed, mirroring the UTXO branch (handleUtxoSpend) so a
    // double-spend attempt is also throttled. Fee-bypass is separately closed
    // server-side (FIND-301 above); this closes the DoS/gas-drain surface.
    const rateLimitKey = nullifierStr
      ? `${_stack.facilitatorNetwork}:single-value:${String(nullifierStr).toLowerCase()}`
      : undefined;
    const rl = await checkRateLimit(request, "settle", rateLimitKey);
    if (!rl.success) return rateLimitResponse(rl);

    // B6 fix (audit-sweep-2026-06-17): resolve chain + RPCs by the active
    // network instead of hardcoding Base Sepolia. On a mainnet flip this signs
    // for the right chainId and broadcasts to the right RPC. `_stack` (module
    // scope) is already network-aware, so addresses + chain now agree.
    const activeChain = getActiveChain();
    const rpcUrl = activeChain.readRpcUrl;
    // HyperSync endpoint for THIS chain, or null when our token isn't entitled
    // here (Ethereum — see @/lib/hypersync). The externalAsp guard above already
    // refuses Ethereum Sepolia before this point, so in the path that reaches
    // here `hs` is Base/Base Sepolia and never null today — resolved per-chain
    // anyway rather than hardcoded, for whenever that stops being true.
    const hs = hypersyncUrlFor(activeChain.chain.id);
    // EOA postman needs POSTMAN_PRIVATE_KEY; CDP postman (POSTMAN_SIGNER=cdp) uses
    // CDP-managed keys instead (validated inside sendPostmanTx). A HyperSync
    // endpoint is required regardless (log scan; no chunked RPC fallback here yet
    // — see the hackathon report for the known gap).
    const postmanIsEoa = postmanSignerKind() === "eoa";
    if ((postmanIsEoa && !process.env.POSTMAN_PRIVATE_KEY) || !hs) {
      return NextResponse.json({ error: "Missing server config (POSTMAN_PRIVATE_KEY or HyperSync endpoint)" }, { status: 500 });
    }

    // Validate all BigInt inputs before conversion
    for (const [name, val] of Object.entries({ nullifier: nullifierStr, secret: secretStr, value: valueStr, label: labelStr, commitment: commitmentStr })) {
      if (!val || val === "0x" || val === "undefined" || val === "null") {
        return NextResponse.json({ error: `Invalid ${name}: "${val}"` }, { status: 400 });
      }
    }

    let existingNullifier: bigint, existingSecret: bigint, existingValue: bigint, label: bigint, commitment: bigint;
    try {
      existingNullifier = BigInt(nullifierStr);
      existingSecret = BigInt(secretStr);
      existingValue = BigInt(valueStr);
      label = BigInt(labelStr);
      commitment = BigInt(commitmentStr);
    } catch (e) {
      return NextResponse.json({ error: `Invalid BigInt input: ${(e as Error).message}` }, { status: 400 });
    }
    let withdrawnValue: bigint;
    try {
      withdrawnValue = amountAtomic === undefined || amountAtomic === null || amountAtomic === ""
        ? existingValue
        : BigInt(amountAtomic);
    } catch (e) {
      return NextResponse.json({ error: `Invalid amountAtomic: ${(e as Error).message}` }, { status: 400 });
    }
    if (withdrawnValue <= 0n) {
      return NextResponse.json({ error: "amountAtomic must be > 0" }, { status: 400 });
    }
    if (withdrawnValue > existingValue) {
      return NextResponse.json({
        error: `amountAtomic exceeds note value: ${withdrawnValue.toString()} > ${existingValue.toString()}`,
      }, { status: 400 });
    }
    const remainingValue = existingValue - withdrawnValue;

    // CSO-P1-2 fix: previously this block logged value + label + commitment
    // + recipient to stdout. Those flow to Vercel logs where anyone with
    // log access (insider, breach, subpoena) could reconstruct every settle
    // by joining log lines against the on-chain Deposited event → defeats
    // the unlinkable-settle property the product sells. Now: structural
    // marker only. Do not add per-payment identifiers back without a
    // structured logger that redacts privacy-sensitive fields in prod.
    console.log("[Withdraw] Starting private withdrawal");

    // Two clients: HyperRPC for log queries (no limits), regular RPC for eth_call/writes.
    const writeRpcUrl = activeChain.writeRpcUrl;
    const publicClient = createPublicClient({
      chain: activeChain.chain,
      transport: http(rpcUrl), // Infura for eth_call, readContract
    });
    const hyperClient = createPublicClient({
      chain: activeChain.chain,
      transport: http(hs, {
        fetchOptions: {
          headers: { "Authorization": `Bearer ${hypersyncToken()}` },
        },
      }),
    });

    // ── Build the state + ASP trees ──────────────────────────────────────────
    // Infra upgrade #1 (facilitator-infra-architecture-2026-06-24): try the
    // Redis-backed indexer cache FIRST (O(1) read, no chain scan). Verify the
    // cache-built state root against the pool's on-chain `currentRoot`; if it
    // matches, trust the cache. On ANY miss (cache cold/stale/unavailable, root
    // mismatch, or error) fall back to the original full HyperSync scan — identical
    // behavior to before, just slower. The cache is an optimization, never the
    // source of truth.
    const DEPOSITED_EVENT = {
      type: "event" as const, name: "Deposited" as const,
      inputs: [
        { name: "_depositor", type: "address" as const, indexed: true as const },
        { name: "_commitment", type: "uint256" as const, indexed: false as const },
        { name: "_label", type: "uint256" as const, indexed: false as const },
        { name: "_value", type: "uint256" as const, indexed: false as const },
        { name: "_precommitmentHash", type: "uint256" as const, indexed: false as const },
      ],
    };
    const LEAF_INSERTED_EVENT = {
      type: "event" as const, name: "LeafInserted" as const,
      inputs: [
        { name: "_index", type: "uint256" as const, indexed: false as const },
        { name: "_leaf", type: "uint256" as const, indexed: false as const },
        { name: "_root", type: "uint256" as const, indexed: false as const },
      ],
    };

    // The original full-scan path, factored out so both the cache-miss fallback
    // and the no-cache case use the exact same logic as before.
    const fetchFromChain = async (): Promise<{
      leaves: bigint[];
      labels: bigint[];
      depositLogs: { depositor: `0x${string}`; label: bigint; txHash: `0x${string}`; blockNumber: bigint }[];
    }> => {
      // Pre-hex fromBlock for HyperSync — it rejects decimal block numbers and the
      // production bundle was emitting decimal, 500ing the scan. See indexer.hexBlock.
      const fromHex = hexBlock(BigInt(POOL_DEPLOY_BLOCK)) as unknown as bigint;
      const depLogs = await hyperClient.getLogs({
        address: USDC_POOL_ADDRESS as `0x${string}`,
        event: DEPOSITED_EVENT,
        fromBlock: fromHex,
        toBlock: "latest",
      });
      const leafLogs = await hyperClient.getLogs({
        address: USDC_POOL_ADDRESS as `0x${string}`,
        event: LEAF_INSERTED_EVENT,
        fromBlock: fromHex,
        toBlock: "latest",
      });
      return {
        leaves: leafLogs.map((l) => (l.args as { _leaf: bigint })._leaf),
        labels: depLogs.map((l) => (l.args as { _label: bigint })._label),
        // CRITICAL C1 fix (2026-07-09): keep the DEPOSITOR too, so the ASP tree
        // here can be SCREENED identically to /api/asp-update. Previously we kept
        // only labels and built (and could WRITE) an UNSCREENED root — a flagged
        // depositor calling /api/withdraw would overwrite the on-chain screened
        // root with one re-including their label = sanctions bypass.
        depositLogs: depLogs.map((l) => {
          const a = l.args as { _depositor: `0x${string}`; _label: bigint };
          return {
            depositor: a._depositor,
            label: a._label,
            txHash: l.transactionHash as `0x${string}`,
            blockNumber: l.blockNumber as bigint,
          };
        }),
      };
    };

    let allLeaves: bigint[];
    let labels: bigint[];
    // C1 fix: populated only on the full-chain-scan path; drives OFAC screening
    // below. Null on the indexer-cache path (already root-verified against chain).
    let chainDepositLogs:
      | { depositor: `0x${string}`; label: bigint; txHash: `0x${string}`; blockNumber: bigint }[]
      | null = null;
    let cacheHit = false;

    if (indexerAvailable() && USDC_POOL_ADDRESS !== "0x0000000000000000000000000000000000000000") {
      try {
        const idxCfg = {
          network: _stack.facilitatorNetwork,
          pool: USDC_POOL_ADDRESS as `0x${string}`,
          deployBlock: BigInt(POOL_DEPLOY_BLOCK),
        };
        const cached = await readIndexer(idxCfg);
        // Verify the cache against chain truth on BOTH trees before trusting it:
        //  (a) leaves: cache-built state root must equal the pool's live currentRoot.
        //  (b) labels: cache-built ASP root must equal the entrypoint's latestRoot
        //      (security audit 2026-06-24, Finding 4 — labels lack an index event
        //      and a concurrent sync can duplicate them; the leaf check does NOT
        //      cover that). If EITHER diverges → stale/corrupt cache → full chain
        //      scan fallback (slower, always correct).
        const onchainStateRoot = (await publicClient.readContract({
          address: USDC_POOL_ADDRESS as `0x${string}`,
          abi: [{ name: "currentRoot", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
          functionName: "currentRoot",
        }).catch(() => null)) as bigint | null;
        const onchainAspRootForCache = (await publicClient.readContract({
          address: ENTRYPOINT_ADDRESS,
          abi: [{ name: "latestRoot", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
          functionName: "latestRoot",
        }).catch(() => null)) as bigint | null;

        const leavesOk = onchainStateRoot !== null && cached.leafCount > 0 && cacheRootMatches(cached, onchainStateRoot);
        const labelsOk = onchainAspRootForCache !== null && cacheLabelsMatch(cached, onchainAspRootForCache);

        if (leavesOk && labelsOk) {
          allLeaves = cached.leaves;
          labels = cached.labels;
          cacheHit = true;
          console.log("[Withdraw] indexer cache HIT:", cached.leafCount, "leaves (state+ASP roots verified, no chain scan)");
        } else {
          console.log(`[Withdraw] indexer cache miss/stale (leavesOk=${leavesOk} labelsOk=${labelsOk}) — full scan fallback`);
          const fresh = await fetchFromChain();
          allLeaves = fresh.leaves;
          labels = fresh.labels;
          chainDepositLogs = fresh.depositLogs;
        }
      } catch (e) {
        console.log("[Withdraw] indexer cache error, full scan fallback:", String(e).slice(0, 120));
        const fresh = await fetchFromChain();
        allLeaves = fresh.leaves;
        labels = fresh.labels;
        chainDepositLogs = fresh.depositLogs;
      }
    } else {
      const fresh = await fetchFromChain();
      allLeaves = fresh.leaves;
      labels = fresh.labels;
      chainDepositLogs = fresh.depositLogs;
    }

    // ── CRITICAL C1 fix (2026-07-09): SCREEN the ASP labels before building the
    //    tree, identically to /api/asp-update. When the labels came from a full
    //    chain scan (chainDepositLogs populated), run OFAC/risk screening and keep
    //    ONLY approved labels — so a flagged depositor can neither satisfy the
    //    association proof NOR cause this route to overwrite the on-chain screened
    //    root with an unscreened one. The indexer-cache path is already implicitly
    //    screened: its labels are trusted only after `labelsOk` verified the
    //    cache-built ASP root equals the on-chain screened `latestRoot`.
    if (chainDepositLogs) {
      const configuredScreening = await createConfiguredScreeningProvider();
      const provider = configuredScreening.provider;
      const screen = await screenDeposits(chainDepositLogs, provider, {
        version: provider.snapshotVersion,
        source: configuredScreening.source,
      });
      if (screen.rejected.length > 0) {
        console.log(
          `[Withdraw] ASP screening excluded ${screen.rejected.length}/${screen.screened} flagged deposit(s) ` +
            `(snapshot=${screen.snapshotVersion})`,
        );
      }
      labels = screen.approvedLabels;
    }

    console.log("[Withdraw] Total leaves (deposits+changes):", allLeaves.length, cacheHit ? "(cache)" : "(chain)");

    // Build state tree from ALL leaves (deposits + withdrawal change commitments).
    // `let` — the commitment-not-found retry loop below may rebuild from a fresh scan.
    let stateTree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
    stateTree.insertMany(allLeaves);
    let stateRoot = stateTree.root;
    let stateDepth = BigInt(stateTree.depth);

    console.log("[Withdraw] State depth:", stateDepth.toString());

    // Build ASP tree
    const aspTree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
    aspTree.insertMany(labels);
    const aspRoot = aspTree.root;
    const aspDepth = BigInt(aspTree.depth);

    // Verify ASP root matches on-chain
    const onChainASPRoot = (await publicClient.readContract({
      address: ENTRYPOINT_ADDRESS,
      abi: [{ name: "latestRoot", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: "latestRoot",
    })) as bigint;

    if (aspRoot !== onChainASPRoot) {
      // Auto-update ASP root and WAIT for confirmation before generating proof.
      // Signed via the postman-signer adapter (EOA default / CDP sponsored).
      console.log("[Withdraw] ASP root stale, updating...");
      const ipfsCID = `QmZbaseASPRoot${labels.length}deposits${Date.now()}pad`;
      try {
        const updateTxHash = await sendPostmanTx({
          address: ENTRYPOINT_ADDRESS,
          abi: [{ name: "updateRoot", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_root", type: "uint256" }, { name: "_ipfsCID", type: "string" }], outputs: [{ name: "_index", type: "uint256" }] }],
          functionName: "updateRoot",
          args: [aspRoot, ipfsCID],
          gas: 200_000n,
          chain: activeChain.chain,
          writeRpcUrl,
          readRpcUrl: activeChain.readRpcUrl,
        });
        console.log("[Withdraw] ASP root update confirmed:", updateTxHash);
      } catch (aspErr) {
        // Nonce collision — /api/asp-update likely updating the root concurrently
        // Wait for the other tx to be mined, then re-check
        console.log("[Withdraw] ASP update tx failed, waiting for concurrent update...", String(aspErr).slice(0, 100));
        for (let attempt = 0; attempt < 6; attempt++) {
          await new Promise(r => setTimeout(r, 3000));
          const retriedRoot = (await publicClient.readContract({
            address: ENTRYPOINT_ADDRESS,
            abi: [{ name: "latestRoot", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
            functionName: "latestRoot",
          })) as bigint;
          if (retriedRoot === aspRoot) {
            console.log("[Withdraw] ASP root confirmed by concurrent tx after", (attempt + 1) * 3, "s");
            break;
          }
          if (attempt === 5) {
            return NextResponse.json({
              error: "ASP root update failed after 18s. The concurrent update may not have gone through. Try again.",
              debug: { expected: aspRoot.toString(), onChain: retriedRoot.toString(), cause: String(aspErr).slice(0, 200) },
            }, { status: 500 });
          }
        }
      }
    }

    // 4. Generate Merkle proofs
    let stateIdx = stateTree.indexOf(commitment);
    for (let attempt = 0; stateIdx === -1 && attempt < 5; attempt++) {
      console.log(`[Withdraw] Commitment not found yet; retrying leaf sync (${attempt + 1}/5)...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      // Bypass the cache on retry — a missing commitment means the cache (or a
      // stale chain read) didn't have it yet; go straight to a fresh full scan.
      const fresh = await fetchFromChain();
      allLeaves = fresh.leaves;
      stateTree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
      stateTree.insertMany(allLeaves);
      stateRoot = stateTree.root;
      stateDepth = BigInt(stateTree.depth);
      stateIdx = stateTree.indexOf(commitment);
    }
    if (stateIdx === -1) {
      // CSO-P1-2: do not log full commitment or leaf list — they correlate
      // the failed withdraw to the on-chain Deposited event. The HTTP 400
      // response body already includes a slice-redacted lookup hint for
      // legitimate debugging.
      console.log("[Withdraw] Commitment not found in state tree (idx=-1, leaves:", allLeaves.length, ")");
      return NextResponse.json({
        error: "Commitment not found in state tree. Your saved deposit data may be stale. Clear localStorage (F12 → Console → localStorage.clear()) and make a fresh deposit.",
        debug: {
          lookingFor: commitment.toString().slice(0, 20) + "...",
          treeLeaves: allLeaves.length,
          firstLeaf: allLeaves.length > 0 ? allLeaves[0].toString().slice(0, 20) + "..." : "none",
        }
      }, { status: 400 });
    }
    const stateProof = stateTree.generateProof(stateIdx);

    const aspIdx = aspTree.indexOf(label);
    if (aspIdx === -1) {
      return NextResponse.json({ error: "Label not found in ASP tree" }, { status: 400 });
    }
    const aspProof = aspTree.generateProof(aspIdx);

    // Pad siblings to 32
    const padSiblings = (s: bigint[]) => [...s, ...Array(32 - s.length).fill(0n)];

    console.log("[Withdraw] State proof index:", stateProof.index, "siblings:", stateProof.siblings.length);
    console.log("[Withdraw] ASP proof index:", aspProof.index, "siblings:", aspProof.siblings.length);

    // 5. Compute context
    //
    // The change note's secrets. The circuit takes newNullifier/newSecret as
    // PRIVATE inputs and does not care where they came from — random was a choice,
    // not a constraint, and it was the wrong one:
    //
    //   Server-random change secrets are returned exactly ONCE, are never persisted
    //   server-side and never logged (correctly — they are spend authority). So a
    //   caller that dies between the response and its own write loses the remaining
    //   balance FOREVER: ragequit needs those same secrets and nothing re-derives
    //   them. That is not hypothetical — it cost 0.985 USDC on 2026-07-16.
    //
    // So: let the caller supply them, derived from its own seed
    // (deriveForwardingNote(seed, i+1) — packages/core/src/forwardingNotes.ts).
    // Then the change note is re-derivable from the seed alone, and a lost response
    // is a retry instead of a loss.
    //
    // Falls back to random when absent, so existing callers are unaffected.
    // Post-client-side-proving this server stops seeing them at all.
    // (`clientNext` was validated up front, right after the body parse.)
    const newNullifier = clientNext?.nullifier ?? randomFieldElement();
    const newSecret = clientNext?.secret ?? randomFieldElement();
    const newPrecommitment = poseidon2([newNullifier, newSecret]);
    const expectedNewCommitment = poseidon3([remainingValue, label, newPrecommitment]);

    const scope = (await publicClient.readContract({
      address: USDC_POOL_ADDRESS,
      abi: [{ name: "SCOPE", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: "SCOPE",
    })) as bigint;

    // === Server-resolved fee parameters (FIND-301 mitigation) ============
    // Look up the nullifier's tier in Upstash. If a tier is recorded, that
    // determines the on-chain fee — caller cannot override. If no tier is
    // recorded (demo route, reclaim scripts), no fee is taken (legacy
    // no-op behavior).
    //
    // Network is derived from the active contract stack (_stack.facilitatorNetwork)
    // so the Upstash key namespace matches what /authorize wrote. When mainnet
    // is added in contracts.ts, the facilitatorNetwork field on the mainnet
    // stack will route automatically — closes the latent cross-network bypass
    // the pentest flagged as B2 / BUG-1 (would have silently zeroed mainnet
    // fees if /api/withdraw stayed hardcoded to Sepolia).
    const FACILITATOR_NETWORK: FacilitatorNetwork = _stack.facilitatorNetwork;
    // Step D (2026-06-23): the SELLER's tier wins when `recipient` is a registered
    // provider ("providers pay to get paid privately"); the payer's nullifier tier
    // is the fallback. BOTH are resolved SERVER-SIDE (provider from `recipient`,
    // nullifier from Upstash) — never from the request body — so FIND-301 stays
    // closed (a caller still cannot POST a cheaper tier). The bps come from
    // takeBpsFor() (single source of truth) — previously hardcoded 30/100, which
    // would have ignored the 2026-06-23 rate change on-chain.
    const registeredProvider = await findProviderByPayTo(effectiveRecipient);
    const providerTier: PricingTier | null =
      registeredProvider?.tier === "standard" || registeredProvider?.tier === "compliance"
        ? registeredProvider.tier
        : null;
    const nullifierTier = await getAuthorizedTier(FACILITATOR_NETWORK, nullifierStr);
    // AUDIT HIGH #3: charge the HIGHER take (compliance can't be downgraded to
    // standard by a self-registered provider record). See resolveEffectiveFeeTier.
    const resolvedTier: PricingTier | null = resolveEffectiveFeeTier(providerTier, nullifierTier);
    const resolvedFeeBPS: bigint =
      resolvedTier && resolvedTier !== "enterprise"
        ? BigInt(takeBpsFor(resolvedTier))
        : 0n; // enterprise + null both → 0 bps (no skim)
    const resolvedFeeRecipient: `0x${string}` =
      resolvedFeeBPS > 0n
        ? (treasuryAddress() as `0x${string}`)
        : (effectiveRecipient as `0x${string}`);

    // Step G (2026-06-23): user-wallet freemium. Read whether the withdrawing
    // user holds a premium upgrade (the human revenue line — free to transact,
    // pay for opt-in value-adds). The flag is wired + chargeable now and surfaced
    // in the response; the BEHAVIORAL expedite (skip the relayer queue / decoy
    // window) activates once that free-tier baseline ships (decoy scheduler is in
    // scripts/ but not in prod, so standard withdraw is already immediate today —
    // we don't fake a free-tier delay, which would be user-hostile). Keyed on the
    // recipient address; inert (best-effort, defaults false) while FEE_REQUIRED=false.
    const isPremiumUser = await userIsPremium(
      FACILITATOR_NETWORK,
      effectiveRecipient as string,
    ).catch(() => false);

    // B2 executor path: `data` is an ABI-encoded ExecPlan (struct order MUST match
    // ExecutorProcessooor.ExecPlan exactly), processooor = the executor. Otherwise the
    // classic 0xbow RelayData → Entrypoint path (unchanged).
    let data: `0x${string}`;
    let withdrawalProcessooor: `0x${string}`;
    if (isCallPlan) {
      if (!EXECUTOR_ADDRESS || /^0x0{40}$/i.test(EXECUTOR_ADDRESS)) {
        return NextResponse.json(
          { error: "callPlan supplied but no ExecutorProcessooor is configured for the active stack." },
          { status: 501 },
        );
      }
      data = encodeAbiParameters(
        [{
          type: "tuple",
          components: [
            { name: "callTarget", type: "address" },
            { name: "inputToken", type: "address" },
            { name: "outputToken", type: "address" },
            { name: "minOut", type: "uint256" },
            { name: "finalRecipient", type: "address" },
            { name: "feeRecipient", type: "address" },
            { name: "relayFeeBPS", type: "uint256" },
            { name: "callData", type: "bytes" },
          ],
        }],
        [{
          callTarget: callPlan!.target as `0x${string}`,
          inputToken: callPlan!.inputToken as `0x${string}`,
          outputToken: callPlan!.outputToken as `0x${string}`,
          minOut: BigInt(callPlan!.minOut),
          finalRecipient: callPlan!.recipient as `0x${string}`,
          feeRecipient: resolvedFeeRecipient,
          relayFeeBPS: resolvedFeeBPS,
          callData: callPlan!.callData as `0x${string}`,
        }]
      );
      withdrawalProcessooor = EXECUTOR_ADDRESS;
    } else {
      data = encodeAbiParameters(
        [{ type: "tuple", components: [{ name: "recipient", type: "address" }, { name: "feeRecipient", type: "address" }, { name: "relayFeeBPS", type: "uint256" }] }],
        [{ recipient: recipient as `0x${string}`, feeRecipient: resolvedFeeRecipient, relayFeeBPS: resolvedFeeBPS }]
      );
      withdrawalProcessooor = ENTRYPOINT_ADDRESS;
    }

    const withdrawal = {
      processooor: withdrawalProcessooor,
      data,
    };

    const context = BigInt(keccak256(
      encodeAbiParameters(
        [
          { type: "tuple", components: [{ name: "processooor", type: "address" }, { name: "data", type: "bytes" }] },
          { name: "scope", type: "uint256" },
        ],
        [withdrawal, scope]
      )
    )) % SNARK_FIELD;

    // CSO-P1-2: context + scope hash both deterministically derive from
    // (recipient, scope) → logging them is equivalent to logging the
    // recipient address. Suppress in prod logs.

    // 6. Generate ZK withdrawal proof
    const circuitInputs = {
      withdrawnValue: withdrawnValue,
      stateRoot: stateRoot,
      stateTreeDepth: stateDepth,
      ASPRoot: aspRoot,
      ASPTreeDepth: aspDepth,
      context: context,
      label: label,
      existingValue: existingValue,
      existingNullifier: existingNullifier,
      existingSecret: existingSecret,
      newNullifier: newNullifier,
      newSecret: newSecret,
      stateSiblings: padSiblings(stateProof.siblings),
      stateIndex: BigInt(stateProof.index),
      ASPSiblings: padSiblings(aspProof.siblings),
      ASPIndex: BigInt(aspProof.index),
    };

    console.log("[Withdraw] Generating proof...");

    const wasmPath = join(process.cwd(), "public/circuits/withdraw/withdraw.wasm");
    const zkeyPath = join(process.cwd(), "public/circuits/withdraw/groth16_pkey.zkey");

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInputs as unknown as Record<string, unknown>,
      wasmPath,
      zkeyPath
    );

    console.log("[Withdraw] Proof generated! pubSignals:", publicSignals.length);

    // Validate pubSignals length (circuit outputs 2 + 6 public inputs = 8)
    if (publicSignals.length !== 8) {
      return NextResponse.json({ error: `Invalid proof: expected 8 public signals, got ${publicSignals.length}` }, { status: 500 });
    }
    if (BigInt(publicSignals[0]) !== expectedNewCommitment) {
      return NextResponse.json({
        error: "Proof new commitment mismatch",
        debug: {
          expectedNewCommitment: expectedNewCommitment.toString(),
          proofNewCommitment: publicSignals[0].toString(),
        },
      }, { status: 500 });
    }

    // 7. Verify locally
    const vkey = JSON.parse(readFileSync(join(process.cwd(), "public/circuits/withdraw/groth16_vkey.json"), "utf-8"));
    const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    console.log("[Withdraw] Local verification:", isValid);

    if (!isValid) {
      // CSO-P2 fix: do not echo publicSignals on failure. The Groth16 public
      // signals include nullifier hashes + state/ASP roots which, while
      // on-chain-public, become a stable correlation surface when returned
      // in an HTTP body alongside the failure timestamp.
      return NextResponse.json({ error: "Proof failed local verification" }, { status: 500 });
    }

    // 8. Format proof for Solidity
    // Note: pi_b coordinates are swapped [0][1],[0][0] and [1][1],[1][0]
    // This is required by the EVM Groth16 verifier which uses a different
    // point representation than snarkjs. All Groth16 EVM verifiers do this.
    const p = proof as { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    if (!p.pi_a || !p.pi_b || !p.pi_c || p.pi_a.length < 2 || p.pi_b.length < 2 || p.pi_c.length < 2) {
      return NextResponse.json({ error: "Malformed proof structure" }, { status: 500 });
    }
    const pi_a = p.pi_a;
    const pi_b = p.pi_b;
    const pi_c = p.pi_c;

    const formattedProof = {
      pA: [BigInt(pi_a[0]), BigInt(pi_a[1])],
      pB: [
        [BigInt(pi_b[0][1]), BigInt(pi_b[0][0])],
        [BigInt(pi_b[1][1]), BigInt(pi_b[1][0])],
      ],
      pC: [BigInt(pi_c[0]), BigInt(pi_c[1])],
      pubSignals: publicSignals.map((s: string) => BigInt(s)),
    };

    // 9. Submit via relay — through the postman-signer adapter (EOA default / CDP
    // sponsored). relay is PERMISSIONLESS (proof binds processooor==Entrypoint,
    // not the caller), so any sender — EOA or CDP smart account — can relay.
    // waitForReceipt:false so this route keeps its own receipt-wait + on-chain
    // revert-decode below (unchanged); the adapter only submits + returns the hash.
    // B2 executor path submits executeFromPool on the ExecutorProcessooor (which calls
    // pool.withdraw itself, being the named processooor); the default path submits relay
    // on the Entrypoint. Both are proof-bound to `context` — the postman is trustless.
    const withdrawalTuple = { name: "_withdrawal", type: "tuple" as const, components: [
      { name: "processooor", type: "address" as const },
      { name: "data", type: "bytes" as const },
    ]};
    const proofTuple = { name: "_proof", type: "tuple" as const, components: [
      { name: "pA", type: "uint256[2]" as const },
      { name: "pB", type: "uint256[2][2]" as const },
      { name: "pC", type: "uint256[2]" as const },
      { name: "pubSignals", type: "uint256[8]" as const },
    ]};
    console.log(isCallPlan ? "[Withdraw] Submitting executeFromPool tx..." : "[Withdraw] Submitting relay tx...");
    const txHash = isCallPlan
      ? await sendPostmanTx({
          address: EXECUTOR_ADDRESS as `0x${string}`,
          abi: [{
            name: "executeFromPool",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "pool", type: "address" },
              withdrawalTuple,
              proofTuple,
              { name: "scope", type: "uint256" },
            ],
            outputs: [],
          }],
          functionName: "executeFromPool",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: [USDC_POOL_ADDRESS, withdrawal, formattedProof, scope] as any,
          // audit F4: the executor path does MORE than a plain relay (pool withdraw =
          // Groth16 verify + Merkle insert ~600-800k, PLUS the whitelisted vault call
          // ~100-250k, PLUS approve+sweep). 1.5M can OOG on a real ERC-4626 vault. Raised
          // to 3M for headroom. TODO(operator): benchmark the ACTUAL cost against the
          // deployed pool + the specific whitelisted vault and set this per-target.
          gas: 3_000_000n,
          chain: activeChain.chain,
          writeRpcUrl,
          readRpcUrl: activeChain.readRpcUrl,
          waitForReceipt: false,
        })
      : await sendPostmanTx({
          address: ENTRYPOINT_ADDRESS,
          abi: [{
            name: "relay",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [withdrawalTuple, proofTuple, { name: "_scope", type: "uint256" }],
            outputs: [],
          }],
          functionName: "relay",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: [withdrawal, formattedProof, scope] as any,
          gas: 1_500_000n, // Groth16 verify + USDC transfer; generous for pool variants
          chain: activeChain.chain,
          writeRpcUrl,
          readRpcUrl: activeChain.readRpcUrl,
          waitForReceipt: false,
        });

    console.log("[Withdraw] Relay tx submitted:", txHash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === "reverted") {
      // Decode the revert reason from the receipt
      const errorMap: Record<string, string> = {
        "09bde339": "InvalidProof — ZK proof failed on-chain verification",
        "ef6daeb0": "ContextMismatch — withdrawal context hash doesn't match",
        "fd3d3c4c": "UnknownStateRoot — state root not recognized by pool",
        "a6a78244": "IncorrectASPRoot — ASP root doesn't match latest on-chain",
        "1a7c48e5": "InvalidProcessooor — caller is not the processooor",
        "9abc7491": "InvalidWithdrawalAmount — withdrawn amount is zero",
        "c21cc8e2": "InvalidTreeDepth — tree depth exceeds maximum",
        "0fb8e278": "OnlyOriginalDepositor — only the depositor can ragequit",
        "b115d857": "NullifierAlreadySpent — this deposit was already withdrawn",
      };

      // Try to get revert data by replaying the call
      let revertReason = "unknown (check server logs for debug info)";
      try {
        // Replay the reverted call to recover its revert reason. `from` is
        // cosmetic here (relay is permissionless), so we read it back off the
        // reverted tx rather than depending on a local signer object.
        const tx = await publicClient.getTransaction({ hash: txHash });
        await publicClient.call({
          data: tx.input,
          to: tx.to!,
          account: tx.from,
        });
      } catch (callErr: unknown) {
        const errStr = String(callErr);
        for (const [sel, msg] of Object.entries(errorMap)) {
          if (errStr.includes(sel)) {
            revertReason = msg;
            break;
          }
        }
        if (revertReason === "unknown (check server logs for debug info)") {
          revertReason = errStr.slice(0, 300);
        }
      }

      // CSO-P1-2: original error path dumped pubSignals + state root +
      // ASP root + commitment + label on revert. pubSignals[1] is the
      // nullifier hash — logging it on the same line as the revert tx
      // hash is the worst correlation surface in the whole codebase
      // (every reverted settle reveals which deposit attempted to spend).
      // Now: keep the revert REASON + tx hash (publicly visible on-chain
      // anyway) + structural shape. Suppress all privacy-sensitive values.
      console.error("[Withdraw] RELAY REVERTED:", revertReason);
      console.error("[Withdraw] Tx:", txHash);
      console.error("[Withdraw] State depth:", stateTree.depth, "ASP depth:", aspTree.depth, "pubSignals count:", publicSignals.length);

      return NextResponse.json({
        error: `Relay reverted: ${revertReason}`,
        txHash,
        debug: {
          stateRoot: stateTree.root.toString(),
          aspRoot: aspRoot.toString(),
          stateDepth: stateTree.depth,
          aspDepth: aspTree.depth,
          stateLeaves: allLeaves.length,
          depositCount: labels.length,
          localVerification: isValid,
        }
      }, { status: 500 });
    }

    let changeLeafInserted = remainingValue === 0n;
    let yieldEarned: bigint = 0n;
    let protocolFee: bigint = 0n;
    let yieldEventFound = false;
    for (const eventLog of receipt.logs) {
      if (eventLog.address.toLowerCase() !== USDC_POOL_ADDRESS.toLowerCase()) continue;

      const topic = eventLog.topics[0];
      if (topic === LEAF_TOPIC && remainingValue > 0n && !changeLeafInserted) {
        const data = eventLog.data as string;
        if (data.length >= 194) {
          const leaf = BigInt("0x" + data.slice(66, 130));
          if (leaf === expectedNewCommitment) {
            changeLeafInserted = true;
          }
        }
      } else if (topic === YIELD_DISTRIBUTED_TOPIC) {
        // data layout: principal (32) | yieldAmount (32) | fee (32). recipient is indexed.
        const data = eventLog.data as string;
        if (data.length >= 2 + 64 * 3) {
          // skip leading 0x + first 32 bytes (principal); we already know it.
          yieldEarned = BigInt("0x" + data.slice(66, 130));
          protocolFee = BigInt("0x" + data.slice(130, 194));
          yieldEventFound = true;
        }
      }
    }

    console.log("[Withdraw] SUCCESS! Tx:", txHash);
    if (remainingValue > 0n && !changeLeafInserted) {
      console.warn(
        "[Withdraw] Exact-amount payment succeeded, but deployed Base pool did not insert the change commitment. nextDeposit is not spendable on this deployment.",
      );
    }

    // CSO-P2 fix (Codex + Claim 2):
    //   - `amount` stripped. The caller sent `amountAtomic` in the request,
    //     so they already know the withdrawn value. Echoing it back leaks
    //     the settle size in the HTTP response (browser network tab,
    //     unauthenticated read before on-chain confirmation, stable
    //     timing-correlation surface). On-chain the value is public, but
    //     the API should not be a faster correlation oracle than RPC.
    //   - `publicSignals` stripped. Raw Groth16 public signals (nullifier
    //     hash, state root, ASP root, etc.) are deterministically derivable
    //     by any caller that has the inputs — echoing them in a stable
    //     order is gratuitous correlation help. Callers that need them can
    //     compute them client-side.
    // Internal consumers in src/app/api/{facilitator/settle,x402-pay}/route.ts
    // were updated to forward their input amount (paymentAmount / amount)
    // instead of reading withdrawData.amount.
    return NextResponse.json({
      success: true,
      txHash,
      // Step G freemium: surfaces the user's premium status. Expedited path is a
      // no-op behavioral difference today (standard withdraw is already immediate);
      // becomes a real skip-queue once the free-tier decoy/queue baseline ships.
      premium: isPremiumUser,
      expedited: isPremiumUser,
      remainingValue: changeLeafInserted ? remainingValue.toString() : "0",
      expectedRemainingValue: remainingValue.toString(),
      changeNoteSupported: changeLeafInserted,
      ...(remainingValue > 0n && changeLeafInserted
        ? {
            nextDeposit: {
              nullifier: newNullifier.toString(),
              secret: newSecret.toString(),
              value: remainingValue.toString(),
              label: label.toString(),
              commitment: expectedNewCommitment.toString(),
            },
          }
        : {}),
      // Yield distribution telemetry, populated when the pool contract emits
      // Backwards-compatible yield payload. Active plain 0xbow pool has no
      // yield leg, so this is normally present:false and zero-valued.
      yield: {
        earned: yieldEarned.toString(),
        protocolFee: protocolFee.toString(),
        feeBps: 100,
        present: yieldEventFound,
      },
      proofTimeMs: Date.now() - startTime,
      proofValid: isValid,
    });
  } catch (error) {
    const errMsg = (error as Error).message || "Unknown error";
    const errStack = (error as Error).stack || "";
    // F15: log the message always; only emit the full stack outside production,
    // so persistent prod logs (readable by anyone with Vercel log access) don't
    // retain potentially-sensitive internals. The HTTP response is already
    // generic in prod (see below).
    console.error("[Withdraw] UNCAUGHT ERROR:", errMsg);
    if (process.env.NODE_ENV !== "production") {
      console.error("[Withdraw] Stack:", errStack.slice(0, 500));
    }

    // Identify the error source (used to pick a generic hint; never leaks raw
    // strings to the response in production).
    let errorSource = "unknown";
    if (errMsg.includes("snarkjs") || errMsg.includes("circuit") || errMsg.includes("wasm") || errMsg.includes("zkey")) {
      errorSource = "proof_generation";
    } else if (errMsg.includes("relay") || errMsg.includes("writeContract") || errMsg.includes("sendRawTransaction")) {
      errorSource = "relay_submission";
    } else if (errMsg.includes("getLogs") || errMsg.includes("readContract") || errMsg.includes("getBlockNumber")) {
      errorSource = "rpc_read";
    } else if (errMsg.includes("BigInt") || errMsg.includes("parse") || errMsg.includes("JSON")) {
      errorSource = "data_parsing";
    } else if (errMsg.includes("ENOENT") || errMsg.includes("file")) {
      errorSource = "file_not_found";
    }

    // Codex P1 fix: do NOT echo raw error messages or stack traces in
    // production. They leak internal library versions, file paths, and
    // occasionally env-var values that appear inside underlying errors
    // (e.g. RPC URLs with embedded API keys, file paths revealing project
    // layout). In dev keep the raw message for productivity.
    const isProd = process.env.NODE_ENV === "production";
    const safeError = isProd
      ? "Internal error during withdrawal. Check server logs for details."
      : errMsg.slice(0, 500);

    return NextResponse.json(
      {
        error: safeError,
        source: errorSource,
        hint: errorSource === "proof_generation" ? "ZK circuit or key file issue" :
              errorSource === "relay_submission" ? "Transaction submission failed — check RPC or gas" :
              errorSource === "rpc_read" ? "RPC read failed — rate limit or connection issue" :
              errorSource === "data_parsing" ? "Invalid data format" :
              errorSource === "file_not_found" ? "Circuit WASM or zkey file missing from public/" :
              "Check server terminal for full stack trace"
      },
      { status: 500 }
    );
  }
}

// ─── Phase 1A: UTXO spend handler ──────────────────────────────────────────────
//
// Sibling to the single-value POST flow above. Routed from the top of POST
// when `?pool=utxo` is present. Intentionally shares NOTHING with the
// single-value path — different stack, different contract ABI, different
// proof format (10 public signals vs 8), different commitment recipe
// (variable-amount UTXO notes).
//
// Two modes:
//
//   * normal (default):
//       Loads UTXO stack from getActiveStack({ stack: "utxo" }), generates a
//       real Groth16 note_spend proof via snarkjs, submits to UTXOPool.spend().
//       BLOCKED on the trusted-setup ceremony for note_spend.circom — without
//       the deployed Verifier_NoteSpend the contract write would revert on
//       InvalidProof regardless. Returns 501 until ceremony.
//
//   * unsafeTestMode=true:
//       Skips proof generation and submits a hardcoded zero-proof bytestring.
//       Only usable against a UTXOPool deployed with an UnsafeMockVerifier
//       (see scripts/deploy-utxo-pool.sh). The mock verifier accepts any
//       inputs, so this exercises every codepath EXCEPT the cryptography:
//       calldata encoding, gas, event emission, state-root bookkeeping.
//       Refused entirely unless ALLOW_UNSAFE_UTXO_TEST_MODE === "true" in
//       the runtime env (fail-closed default). Production Vercel deploys
//       MUST NEVER set this var — there is no safe production use of a
//       path that bypasses Groth16 verification.

interface UtxoNoteShape {
  amount: string | number | bigint;
  label: string | number | bigint;
  // C3: optional NPK inputs (v1 commitment recipe); default 0 when absent.
  spendingPK?: string | number | bigint;
  viewingPKBlind?: string | number | bigint;
  nullifier: string | number | bigint;
  secret: string | number | bigint;
}

function parseUtxoNote(raw: UtxoNoteShape, position: string): Note {
  const toBig = (v: string | number | bigint, fieldName: string): bigint => {
    if (v === undefined || v === null || v === "") {
      throw new Error(`UTXO note ${position}.${fieldName} is empty`);
    }
    return BigInt(v);
  };
  const toBigOptional = (v: string | number | bigint | undefined): bigint =>
    v === undefined || v === null || v === "" ? 0n : BigInt(v);
  return {
    amount: toBig(raw.amount, "amount"),
    label: toBig(raw.label, "label"),
    spendingPK: toBigOptional(raw.spendingPK),
    viewingPKBlind: toBigOptional(raw.viewingPKBlind),
    nullifier: toBig(raw.nullifier, "nullifier"),
    secret: toBig(raw.secret, "secret"),
  };
}

async function handleUtxoSpend(
  request: Request,
  opts: { unsafeTestMode: boolean },
): Promise<Response> {
  const startTime = Date.now();
  const { unsafeTestMode } = opts;

  // ── Production safety gate (SECURITY: 2026-06-09 review fix) ──────────────
  // unsafeTestMode submits a mock proof. We gate it on an EXPLICIT env opt-in
  // (ALLOW_UNSAFE_UTXO_TEST_MODE === "true") that defaults to OFF —
  // fail-closed even if NODE_ENV is misdetected on a dev/staging deploy. The
  // prior NODE_ENV-only check would fall open on any deploy where the var was
  // unset. Production Vercel deploys must NEVER set this var.
  if (unsafeTestMode && process.env.ALLOW_UNSAFE_UTXO_TEST_MODE !== "true") {
    return NextResponse.json(
      {
        error:
          "unsafeTestMode is disabled. Set ALLOW_UNSAFE_UTXO_TEST_MODE=true " +
          "(dev/test env only — NEVER in prod) to enable the mock-proof path.",
      },
      { status: 400 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch (e) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${(e as Error).message}` },
      { status: 400 },
    );
  }

  // ── Rate limit + caller-authz gate (SECURITY: 2026-06-09 review fix) ──────
  // The first input note's nullifier is the privacy-preserving per-buyer
  // identifier (revealed on-chain at settle, so reusing here leaks nothing).
  // Bind the rate-limit key to it so unauthenticated callers cannot hammer
  // the POSTMAN_PRIVATE_KEY-signed write path.
  //
  // PHASE 3 TODO: when the real-proof path lands post-ceremony, this MUST
  // also enforce nullifier-was-authorized via getAuthorizedTier (matching
  // /api/facilitator/settle Path D + the UTXO branch in settle/route.ts).
  // The facilitator path already does this check before forwarding here, but
  // direct callers of /api/withdraw?pool=utxo bypass that — close the gap
  // before any non-test deploy.
  const utxoNotes = body.notes as Array<{ nullifier?: string }> | undefined;
  const rateLimitNullifier =
    Array.isArray(utxoNotes) && utxoNotes.length > 0
      ? String(utxoNotes[0]?.nullifier ?? "")
      : "";
  const rateLimitKey = rateLimitNullifier
    ? `eip155:84532:utxo:${rateLimitNullifier.toLowerCase()}`
    : undefined;
  const rl = await checkRateLimit(request, "settle", rateLimitKey);
  if (!rl.success) return rateLimitResponse(rl);

  const recipient = body.recipient as string | undefined;
  if (!recipient || !isAddress(recipient)) {
    return NextResponse.json(
      { error: `Invalid recipient address: "${recipient}"` },
      { status: 400 },
    );
  }

  // The wallet/facilitator passes its available notes; we plan a 2-in / 2-out
  // spend that pays out `withdrawAmount` and conserves the rest as change.
  const rawNotes = body.notes as UtxoNoteShape[] | undefined;
  const withdrawAmountStr = body.withdrawAmount as string | undefined;
  if (!Array.isArray(rawNotes) || rawNotes.length === 0) {
    return NextResponse.json(
      { error: "UTXO spend requires `notes: Note[]` in body (≥1 spendable note)" },
      { status: 400 },
    );
  }
  if (!withdrawAmountStr) {
    return NextResponse.json(
      { error: "UTXO spend requires `withdrawAmount` (atomic USDC) in body" },
      { status: 400 },
    );
  }
  let withdrawAmount: bigint;
  try {
    withdrawAmount = BigInt(withdrawAmountStr);
  } catch (e) {
    return NextResponse.json(
      { error: `Invalid withdrawAmount: ${(e as Error).message}` },
      { status: 400 },
    );
  }
  if (withdrawAmount <= 0n) {
    return NextResponse.json(
      { error: "withdrawAmount must be > 0" },
      { status: 400 },
    );
  }

  let available: Note[];
  try {
    available = rawNotes.map((n, i) => parseUtxoNote(n, `notes[${i}]`));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Plan the spend via SDK heuristic. Throws NoteValueError on insufficient.
  let plan: ReturnType<typeof planSpend>;
  try {
    plan = planSpend(available, withdrawAmount);
  } catch (e) {
    return NextResponse.json(
      { error: `planSpend failed: ${(e as Error).message}` },
      { status: 400 },
    );
  }
  const [inputA, inputB] = plan.inputs;
  const [outAmount0, outAmount1] = plan.outputAmounts;
  // The output notes inherit the ASP label of the originating real input.
  const inheritedLabel = inputA.amount > 0n ? inputA.label : inputB.label;
  // The SDK's `planSpend` returns input notes + output amounts only; we mint
  // fresh nullifier+secret pairs for the outputs ourselves so the recipient
  // (and any change-back-to-self note) can later re-spend. In a wallet flow
  // these would be stashed in encrypted form alongside the NoteCommitted log;
  // here we return them in the response for the smoke test to capture.
  // C3 NPK derivation: in a withdraw the USDC exits the pool to the EVM
  // `recipient`; the output commitments are change-back-TO-SELF notes the
  // spender keeps and must be able to re-spend. So they should carry the
  // SPENDER's own NPK, not a third party's. When the caller supplies their own
  // viewing+spending pubkey we derive a self-NPK and apply it to both change
  // outputs; absent that we keep NPK=0 (scaffold-safe — the real-proof path is
  // 501-blocked until the ceremony regardless).
  let changeNpk: { spendingPK: bigint; viewingPKBlind: bigint } | undefined;
  const changeViewRaw = body.changeViewingPubKey;
  const changeSpendRaw = body.changeSpendingPubKey;
  if (changeViewRaw !== undefined && changeViewRaw !== null && changeViewRaw !== "") {
    try {
      const changeViewPub = parseUtxoViewingPubKey(changeViewRaw);
      let changeSpendPK: bigint;
      if (changeSpendRaw !== undefined && changeSpendRaw !== null && changeSpendRaw !== "") {
        changeSpendPK = BigInt(changeSpendRaw as string | number) % SNARK_SCALAR_FIELD;
      } else {
        let v = 0n;
        for (const byte of changeViewPub) v = (v << 8n) | BigInt(byte);
        changeSpendPK = v % SNARK_SCALAR_FIELD;
      }
      const d = deriveRecipientNPK({
        recipientViewingPubKey: changeViewPub,
        recipientSpendingPubKey: changeSpendPK,
        ephemeralPrivateKey: randomBytes(32),
      });
      changeNpk = { spendingPK: d.spendingPK, viewingPKBlind: d.viewingPKBlind };
    } catch (e) {
      return NextResponse.json(
        { error: `changeViewingPubKey/changeSpendingPubKey: ${(e as Error).message}` },
        { status: 400 },
      );
    }
  }
  const output0: Note = createUtxoOutput(outAmount0, inheritedLabel, changeNpk);
  const output1: Note =
    outAmount1 === 0n ? createDummyNote() : createUtxoOutput(outAmount1, inheritedLabel, changeNpk);

  const stack: ContractStack = getActiveStack({ stack: "utxo" });
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  if (stack.usdcPool === ZERO_ADDR) {
    return NextResponse.json(
      {
        error:
          "UTXO pool is not deployed yet. Run `scripts/deploy-utxo-pool.sh` and update src/lib/contracts.ts UTXO_STACK.usdcPool.",
      },
      { status: 503 },
    );
  }

  // UTXO is Sepolia-only by design (getStackByName throws on mainnet UTXO until
  // the ceremony + C4 fix — Road B). Pin the chain to sepolia explicitly rather
  // than hardcoding baseSepolia/the public RPC (B6, audit-sweep-2026-06-17).
  const utxoChain = getActiveChain("sepolia");
  const rpcUrl = utxoChain.readRpcUrl;
  // EOA postman needs POSTMAN_PRIVATE_KEY; CDP postman (POSTMAN_SIGNER=cdp) uses
  // CDP-managed keys instead (validated inside sendPostmanTx).
  if (postmanSignerKind() === "eoa" && !process.env.POSTMAN_PRIVATE_KEY) {
    return NextResponse.json(
      { error: "Missing server config (POSTMAN_PRIVATE_KEY)" },
      { status: 500 },
    );
  }

  // ── Compute the public signals expected by UTXOPool.spend ────────────────
  // v1 8-signal layout (matches note_spend.circom `component main` + UTXOPool.sol
  // Proof.pubSignals uint256[8]):
  //   [0..1] nullifierHashes[0..1]
  //   [2..3] outputCommitments[0..1]
  //   [4]    stateRoot       (from the live LeanIMT — supplied by the smoke harness)
  //   [5]    stateTreeDepth
  //   [6]    aspRoot
  //   [7]    context
  // v1 dropped `withdrawnAmount` + `aspTreeDepth` from the public set (now private
  // witnesses; withdrawnAmount binds to the calldata unshield amount via context).
  const nullHash0 = nullifierHashOf(inputA);
  const nullHash1 = nullifierHashOf(inputB);
  const outCom0 = commitmentOf(output0);
  const outCom1 = commitmentOf(output1);

  // Context binding — must match UTXOPool's expectedContext recipe verbatim:
  //   uint256(keccak256(abi.encode(withdrawal, SCOPE))) % SNARK_FIELD
  const relayData = encodeAbiParameters(
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
    [
      {
        recipient: recipient as `0x${string}`,
        feeRecipient: recipient as `0x${string}`,
        relayFeeBPS: 0n,
      },
    ],
  );
  const withdrawal = {
    processooor: stack.entrypoint,
    data: relayData,
  };

  const publicClient = createPublicClient({
    chain: utxoChain.chain,
    transport: http(rpcUrl),
  });

  // Read SCOPE from the deployed pool so context is deterministic against
  // whatever the constructor was wired with.
  let scope: bigint;
  try {
    scope = (await publicClient.readContract({
      address: stack.usdcPool,
      abi: [
        {
          name: "SCOPE",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "SCOPE",
    })) as bigint;
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read SCOPE from UTXOPool: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const context = BigInt(
    keccak256(
      encodeAbiParameters(
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
        [withdrawal, scope],
      ),
    ),
  ) % SNARK_FIELD;

  // v1 8-signal layout (matches note_spend.circom `component main` + UTXOPool.sol
  // Proof.pubSignals uint256[8]):
  //   [0..1] nullifierHashes  [2..3] outputCommitments  [4] stateRoot
  //   [5] stateTreeDepth  [6] aspRoot  [7] context
  // v1 removed `withdrawnAmount` and `aspTreeDepth` from the public set (both are
  // now private witnesses — withdrawnAmount binds to the calldata unshield amount
  // through `context`). The Phase-1 contract remap requires this wire format.
  type PubSignals = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  let pubSignals: PubSignals;
  let proof: {
    pA: readonly [bigint, bigint];
    pB: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
    pC: readonly [bigint, bigint];
  };

  if (unsafeTestMode) {
    // ── Mock-proof path ──────────────────────────────────────────────────
    // We still must populate pubSignals correctly because UTXOPool unpacks
    // them BEFORE calling the verifier (nullifier double-spend check,
    // context match, etc. all read from pubSignals). The mock verifier
    // only short-circuits the cryptographic check itself.
    //
    // stateRoot / treeDepth / aspRoot are sentinels — UTXOPool's _isKnownRoot
    // will reject zero unless the deploy script seeds a known root (e.g. by
    // submitting a no-op spend or by exposing a test helper). This handler is
    // responsible for the wire format only; the mock contract is responsible
    // for permissive verification + state.
    pubSignals = [
      nullHash0,
      nullHash1,
      outCom0,
      outCom1,
      0n, // stateRoot — see note above
      0n, // stateTreeDepth (unverified in mock)
      0n, // aspRoot — IEntrypoint(ENTRYPOINT).latestRoot() must equal this
      context,
    ];
    proof = {
      pA: [0n, 0n],
      pB: [
        [0n, 0n],
        [0n, 0n],
      ],
      pC: [0n, 0n],
    };
    console.log(
      "[Withdraw UTXO] unsafeTestMode: submitting zero-proof. Pool MUST be deployed with UnsafeMockVerifier — see scripts/deploy-utxo-pool.sh.",
    );
  } else {
    // ── Real proof path (note_spend.circom) ───────────────────────────────
    // Guarded: we prove against public/circuits/note_spend/{wasm,zkey} which
    // the trusted-setup ceremony drops in. Until those artifacts exist we
    // return the same 501 as before (NO behavior change shippable now). The
    // instant the ceremony files land, this path activates with zero further
    // code change. Mirrors the single-value fullProve pattern (~line 430).
    const wasmPath = join(process.cwd(), "public/circuits/note_spend/note_spend.wasm");
    const zkeyPath = join(process.cwd(), "public/circuits/note_spend/groth16_pkey.zkey");
    if (!existsSync(wasmPath) || !existsSync(zkeyPath)) {
      return NextResponse.json(
        {
          error:
            "UTXO note-spend proof generation is blocked on the trusted-setup " +
            "ceremony for note_spend.circom (artifacts not yet present in " +
            "public/circuits/note_spend/). Pass `?unsafeTestMode=true` against a " +
            "UTXOPool deployed with UnsafeMockVerifier to exercise the codepath.",
          source: "ceremony_pending",
          hint:
            "Drop the ceremony wasm + groth16_pkey.zkey into " +
            "public/circuits/note_spend/ to activate this path. See " +
            "docs/mainnet-deploy-checklist (proving-key workstream).",
        },
        { status: 501 },
      );
    }

    // Build the full NoteSpend(32,2,2) witness input from the planned spend.
    // The Merkle/ASP membership proofs come from the on-chain state — the
    // ceremony-smoke caller is responsible for supplying state/asp siblings via
    // the body (see scripts/build-note-spend-witness.ts for the input shape);
    // here we assemble what the route already has and defer the membership
    // witnesses to the smoke harness, which knows the live tree.
    const circuitInput = buildNoteSpendInput({
      inputA,
      inputB,
      output0,
      output1,
      withdrawnAmount: withdrawAmount,
      context,
      body,
    });
    try {
      const { proof: rawProof, publicSignals } = await snarkjs.groth16.fullProve(
        circuitInput as unknown as Record<string, unknown>,
        wasmPath,
        zkeyPath,
      );
      const snarkProof = rawProof as {
        pi_a: string[];
        pi_b: string[][];
        pi_c: string[];
      };
      // snarkjs returns decimal strings; map to bigint in the v1 8-signal order.
      const ps = (publicSignals as string[]).map((s) => BigInt(s));
      if (ps.length !== 8) {
        throw new Error(`note_spend produced ${ps.length} public signals, expected 8`);
      }
      pubSignals = ps as unknown as PubSignals;
      proof = {
        pA: [BigInt(snarkProof.pi_a[0]), BigInt(snarkProof.pi_a[1])],
        // Groth16 pi_b is column-major for the EVM verifier: swap inner pairs.
        pB: [
          [BigInt(snarkProof.pi_b[0][1]), BigInt(snarkProof.pi_b[0][0])],
          [BigInt(snarkProof.pi_b[1][1]), BigInt(snarkProof.pi_b[1][0])],
        ],
        pC: [BigInt(snarkProof.pi_c[0]), BigInt(snarkProof.pi_c[1])],
      };
    } catch (e) {
      const msg = (e as Error).message || "unknown proving error";
      console.error("[Withdraw UTXO] note_spend fullProve failed:", msg.slice(0, 300));
      return NextResponse.json(
        { error: `note_spend proof generation failed: ${msg.slice(0, 200)}` },
        { status: 500 },
      );
    }
  }

  // ── Submit on-chain ──────────────────────────────────────────────────────
  // Through the postman-signer adapter (EOA default / CDP sponsored).
  // waitForReceipt:false so this handler keeps its own receipt-wait below (it
  // reads gasUsed + blockNumber off the receipt); the adapter only submits.
  const writeRpcUrl = utxoChain.writeRpcUrl;

  try {
    const txHash = await sendPostmanTx({
      address: stack.usdcPool,
      abi: [
        {
          name: "spend",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            {
              name: "withdrawal",
              type: "tuple",
              components: [
                { name: "processooor", type: "address" },
                { name: "data", type: "bytes" },
              ],
            },
            {
              name: "proof",
              type: "tuple",
              components: [
                { name: "pA", type: "uint256[2]" },
                { name: "pB", type: "uint256[2][2]" },
                { name: "pC", type: "uint256[2]" },
                { name: "pubSignals", type: "uint256[8]" },
              ],
            },
            { name: "encryptedOutputNotes", type: "bytes[2]" },
          ],
          outputs: [],
        },
      ],
      functionName: "spend",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: [withdrawal, { ...proof, pubSignals }, ["0x", "0x"]] as any,
      gas: 1_500_000n,
      chain: utxoChain.chain,
      writeRpcUrl,
      readRpcUrl: utxoChain.readRpcUrl,
      waitForReceipt: false,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const gasUsed = receipt.gasUsed.toString();

    // CSO-P2 parity: no echo of inputs/publicSignals — matches single-value
    // strip from PR #30 5a5f27c. The caller already has `withdrawAmount`.
    return NextResponse.json({
      success: true,
      pool: "utxo",
      txHash,
      status: receipt.status,
      gasUsed,
      blockNumber: receipt.blockNumber.toString(),
      unsafeTestMode,
      proofTimeMs: Date.now() - startTime,
    });
  } catch (e) {
    const msg = (e as Error).message || "Unknown spend error";
    console.error("[Withdraw UTXO] spend reverted/failed:", msg.slice(0, 300));
    return NextResponse.json(
      {
        error: `UTXO spend failed: ${msg.slice(0, 300)}`,
        unsafeTestMode,
      },
      { status: 500 },
    );
  }
}

// Local alias for `createNote` to make the "mints fresh randomness — do not
// reuse outputs across spends" invariant readable at the call-site. `npk`
// (C3) self-addresses the change note to the spender; omit for the NPK=0
// scaffold case.
function createUtxoOutput(
  amount: bigint,
  label: bigint,
  npk?: { spendingPK: bigint; viewingPKBlind: bigint },
): Note {
  return createNote(amount, label, npk);
}

const NOTE_SPEND_TREE_DEPTH = 32; // == circuit maxTreeDepth

/**
 * Assemble a NoteSpend(32,2,2) circuit input from the planned spend (two input
 * notes, two output notes, withdrawn amount, context).
 *
 * The state-tree + ASP membership WITNESSES (siblings, indices, depths) are not
 * reconstructable from the route alone — they require the live on-chain LeanIMT.
 * The ceremony-smoke harness supplies them in the body under
 * `stateProofs`/`aspProofs` (same shape scripts/build-note-spend-witness.ts
 * produces). If absent, we throw a clear error rather than proving against a
 * bogus tree (which would yield a proof the contract rejects with InvalidProof).
 *
 * All values serialize to decimal strings (snarkjs input convention).
 */
function buildNoteSpendInput(args: {
  inputA: Note;
  inputB: Note;
  output0: Note;
  output1: Note;
  withdrawnAmount: bigint;
  context: bigint;
  body: Record<string, unknown>;
}): Record<string, string | string[] | string[][]> {
  const { inputA, inputB, output0, output1, withdrawnAmount, context, body } = args;
  const S = (x: bigint): string => x.toString();

  // Membership witnesses from the body (smoke harness supplies these).
  const sp = body.stateProofs as
    | {
        root: string;
        treeDepth: number | string;
        indices: [number, number] | [string, string];
        siblings: [string[], string[]];
      }
    | undefined;
  const ap = body.aspProofs as
    | {
        root: string;
        treeDepth: number | string;
        indices: [number, number] | [string, string];
        siblings: [string[], string[]];
      }
    | undefined;
  if (!sp || !ap) {
    throw new Error(
      "real-proof path requires `stateProofs` + `aspProofs` membership witnesses " +
        "in the body (state/asp roots, treeDepth, per-input indices + " +
        `${NOTE_SPEND_TREE_DEPTH}-padded siblings). See scripts/build-note-spend-witness.ts.`,
    );
  }
  const padSibs = (s: string[]): string[] => {
    if (s.length > NOTE_SPEND_TREE_DEPTH) {
      throw new Error(`siblings length ${s.length} exceeds tree depth ${NOTE_SPEND_TREE_DEPTH}`);
    }
    const out = s.slice();
    while (out.length < NOTE_SPEND_TREE_DEPTH) out.push("0");
    return out;
  };

  return {
    // public
    stateRoot: String(sp.root),
    stateTreeDepth: String(sp.treeDepth),
    aspRoot: String(ap.root),
    context: S(context),
    // private per-input
    inAmount: [S(inputA.amount), S(inputB.amount)],
    inLabel: [S(inputA.label), S(inputB.label)],
    inSpendingPK: [S(inputA.spendingPK), S(inputB.spendingPK)],
    inViewingPKBlind: [S(inputA.viewingPKBlind), S(inputB.viewingPKBlind)],
    inNullifier: [S(inputA.nullifier), S(inputB.nullifier)],
    inSecret: [S(inputA.secret), S(inputB.secret)],
    inIsDummy: [inputA.amount > 0n ? "0" : "1", inputB.amount > 0n ? "0" : "1"],
    inStateIndex: [String(sp.indices[0]), String(sp.indices[1])],
    inStateSiblings: [padSibs(sp.siblings[0]), padSibs(sp.siblings[1])],
    inAspIndex: [String(ap.indices[0]), String(ap.indices[1])],
    inAspSiblings: [padSibs(ap.siblings[0]), padSibs(ap.siblings[1])],
    aspTreeDepth: String(ap.treeDepth),
    // private per-output
    outAmount: [S(output0.amount), S(output1.amount)],
    outLabel: [S(output0.label), S(output1.label)],
    outSpendingPK: [S(output0.spendingPK), S(output1.spendingPK)],
    outViewingPKBlind: [S(output0.viewingPKBlind), S(output1.viewingPKBlind)],
    outNullifier: [S(output0.nullifier), S(output1.nullifier)],
    outSecret: [S(output0.secret), S(output1.secret)],
    // private unshield amount
    withdrawnAmount: S(withdrawnAmount),
  };
}

// Parse a 32-byte X25519 viewing pubkey from a JSON body field. Accepts a
// number[] (JSON array) or a 0x-prefixed / bare 64-char hex string. Mirrors the
// transfer route's parseViewingPubKey.
function parseUtxoViewingPubKey(raw: unknown): Uint8Array {
  if (Array.isArray(raw)) {
    if (raw.length !== 32) {
      throw new Error(`viewing pubkey array must be 32 bytes, got ${raw.length}`);
    }
    return Uint8Array.from(raw.map((n) => Number(n) & 0xff));
  }
  if (typeof raw === "string") {
    const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
    if (hex.length !== 64 || /[^0-9a-fA-F]/.test(hex)) {
      throw new Error("viewing pubkey hex must be 64 hex chars (32 bytes)");
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  throw new Error("viewing pubkey must be a 32-byte number[] or hex string");
}
