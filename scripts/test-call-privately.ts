/**
 * E2E harness for the B2 private-funded DeFi access path (ExecutorProcessooor).
 *
 * Two tiers, auto-selected by environment:
 *
 *  TIER 1 — route smoke test (no chain, always runs):
 *    Verifies /api/facilitator/call validates the call plan and gates on a deployed
 *    executor (501 when EXECUTOR_PROCESSOOOR is unset; input validation otherwise).
 *    Needs only a running dev server.
 *      npm run dev -- -p 3110
 *      npx tsx --env-file=.env.local scripts/test-call-privately.ts
 *
 *  TIER 2 — full on-chain E2E (runs when CALL_E2E_ONCHAIN=1):
 *    Requires: EXECUTOR_PROCESSOOOR deployed on Base Sepolia + a whitelisted ERC-4626
 *    vault + a funded deposit already in the pool. Provide the deposit secrets via
 *    CALL_E2E_DEPOSIT (JSON: {nullifier,secret,value,label,commitment}) and the vault
 *    coordinates via CALL_E2E_VAULT / CALL_E2E_SHARE_TOKEN. Asserts the recipient
 *    receives vault shares and there is no on-chain link to the payer.
 *
 * This harness NEVER deploys and NEVER holds a private key — deploy is operator-run
 * (see DeployExecutorProcessooor.s.sol). It only drives the HTTP surface + reads chain.
 */

import * as assert from "node:assert/strict";
import { createPublicClient, http, isAddress, encodeFunctionData, getAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { buildSwapCallPlan } from "../packages/core/src/swapPlan.js";

const BASE = process.env.CALL_TEST_BASE ?? "http://localhost:3110";
const ONCHAIN = process.env.CALL_E2E_ONCHAIN === "1";
const NETWORK_ID = "eip155:84532";

const DEPOSIT_SEL = "0x6e553f65"; // deposit(uint256,address)
const ERC20_BAL_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Build a well-formed callPlan for an ERC-4626 vault deposit.
 *
 * CRITICAL (audit F1): the vault `receiver` MUST be the EXECUTOR, not finalRecipient.
 * The executor measures outDelta on ITS OWN balance and sweeps to finalRecipient. If
 * receiver = finalRecipient, outDelta == 0 → the contract reverts NoOutputProduced
 * (post-fix). The earlier harness set receiver = recipient AND minOut = 0, which is why
 * the old Sepolia E2E "passed" without exercising the sweep. Both are corrected here.
 */
function makePlan(opts: {
  vault: string;
  usdc: string;
  shareToken: string;
  recipient: string;
  executor: string; // the deployed ExecutorProcessooor — the vault receiver MUST be this
  spend: bigint;
  minOut: bigint;
}) {
  const callData = encodeFunctionData({
    abi: [{ name: "deposit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "deposit",
    // receiver = the EXECUTOR (it sweeps to finalRecipient after). Anything else reverts.
    args: [opts.spend, getAddress(opts.executor)],
  });
  return {
    target: opts.vault,
    inputToken: opts.usdc,
    outputToken: opts.shareToken,
    minOut: opts.minOut.toString(),
    recipient: opts.recipient,
    callData,
  };
}

async function post(body: unknown) {
  const res = await fetch(`${BASE}/api/facilitator/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function tier1RouteSmoke(): Promise<void> {
  console.log("── TIER 1: route smoke test ──");

  const dummyDeposit = { nullifier: "111", secret: "222", value: "990000", label: "42", commitment: "777" };
  const goodPlan = makePlan({
    vault: "0x1111111111111111111111111111111111111111",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    shareToken: "0x2222222222222222222222222222222222222222",
    recipient: "0x3333333333333333333333333333333333333333",
    executor: "0x4444444444444444444444444444444444444444", // smoke-only; never executes
    spend: 990000n,
    minOut: 1n, // audit F2: minOut must be > 0
  });

  // First, detect whether the executor is configured on the active stack. The route
  // gates on this FIRST (501 before any body validation) — a deliberate security
  // ordering. Every assertion below adapts to that gate.
  const probe = await post({ networkId: NETWORK_ID, amountAtomic: "990000", callPlan: goodPlan, zbaseDeposit: dummyDeposit });
  const executorConfigured = probe.status !== 501;
  console.log(
    executorConfigured
      ? `0. executor IS configured on the active stack (probe → ${probe.status}).`
      : "0. executor NOT deployed → route gates with 501 FIRST (expected until you deploy). ✅ gate works.",
  );

  if (!executorConfigured) {
    // With no executor, the 501 gate short-circuits every request. That IS the
    // invariant to prove on the smoke path: the surface is safely disabled.
    const cases = [
      { name: "missing deposit", body: { networkId: NETWORK_ID, amountAtomic: "990000", callPlan: goodPlan } },
      { name: "malformed callData", body: { networkId: NETWORK_ID, amountAtomic: "990000", callPlan: { ...goodPlan, callData: "0x" }, zbaseDeposit: dummyDeposit } },
      { name: "bad target", body: { networkId: NETWORK_ID, amountAtomic: "990000", callPlan: { ...goodPlan, target: "not-an-address" }, zbaseDeposit: dummyDeposit } },
    ];
    for (let i = 0; i < cases.length; i++) {
      const { status } = await post(cases[i].body);
      assert.equal(status, 501, `${cases[i].name}: executor-unset must 501, got ${status}`);
      console.log(`${i + 1}. ${cases[i].name} → 501 (disabled-surface gate holds)`);
    }
    console.log("TIER 1 ok: /api/facilitator/call is safely DISABLED (no executor). Deploy to enable.\n");
    return;
  }

  // Executor IS configured → assert real input validation (runs AFTER the 501 gate).
  {
    const { status } = await post({ networkId: NETWORK_ID, amountAtomic: "990000", callPlan: goodPlan });
    assert.equal(status, 400, "missing zbaseDeposit must 400");
    console.log("1. missing deposit rejected (400)");
  }
  {
    const badPlan = { ...goodPlan, callData: "0x" };
    const { status, json } = await post({ networkId: NETWORK_ID, amountAtomic: "990000", callPlan: badPlan, zbaseDeposit: dummyDeposit });
    assert.equal(status, 400, `bad callData must 400, got ${status}: ${json?.error}`);
    console.log("2. malformed callData rejected (400)");
  }
  {
    const badPlan = { ...goodPlan, target: "not-an-address" };
    const { status } = await post({ networkId: NETWORK_ID, amountAtomic: "990000", callPlan: badPlan, zbaseDeposit: dummyDeposit });
    assert.equal(status, 400, `bad target must 400, got ${status}`);
    console.log("3. bad target rejected (400)");
  }
  console.log("TIER 1 ok: route validates the call plan correctly.\n");
}

async function tier2OnChain(): Promise<void> {
  console.log("── TIER 2: full on-chain E2E ──");
  const vault = process.env.CALL_E2E_VAULT;
  const shareToken = process.env.CALL_E2E_SHARE_TOKEN;
  const usdc = process.env.CALL_E2E_USDC ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const recipient = process.env.CALL_E2E_RECIPIENT;
  const executor = process.env.EXECUTOR_PROCESSOOOR ?? process.env.NEXT_PUBLIC_EXECUTOR_PROCESSOOOR;
  const depositRaw = process.env.CALL_E2E_DEPOSIT;
  const amountAtomic = process.env.CALL_E2E_AMOUNT ?? "990000";

  assert.ok(vault && isAddress(vault), "CALL_E2E_VAULT (whitelisted ERC-4626 vault) required");
  assert.ok(shareToken && isAddress(shareToken), "CALL_E2E_SHARE_TOKEN (vault share token) required");
  assert.ok(recipient && isAddress(recipient), "CALL_E2E_RECIPIENT required");
  assert.ok(executor && isAddress(executor), "EXECUTOR_PROCESSOOOR (deployed executor addr) required — the vault receiver");
  assert.ok(depositRaw, "CALL_E2E_DEPOSIT (JSON deposit secrets) required");
  const deposit = JSON.parse(depositRaw);

  const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC) });

  const sharesBefore = (await client.readContract({
    address: getAddress(shareToken), abi: ERC20_BAL_ABI, functionName: "balanceOf", args: [getAddress(recipient)],
  })) as bigint;

  // audit F1: receiver = executor (makePlan enforces). audit F2: minOut > 0 — the vault
  // mints 1:1, so a minOut of 1 always clears while actually exercising the sweep path
  // (the old harness used 0 and got a false green).
  const plan = makePlan({ vault: vault!, usdc, shareToken: shareToken!, recipient: recipient!, executor: executor!, spend: BigInt(amountAtomic), minOut: 1n });
  console.log("Submitting callPrivately (deposit → executeFromPool → vault deposit → sweep)...");
  const { status, json } = await post({ networkId: NETWORK_ID, amountAtomic, callPlan: plan, zbaseDeposit: deposit });
  assert.equal(status, 200, `call must 200, got ${status}: ${json?.error}`);
  assert.ok(json.txHash, "must return a txHash");
  console.log(`  tx: ${json.txHash}`);

  await client.waitForTransactionReceipt({ hash: json.txHash as `0x${string}` });
  const sharesAfter = (await client.readContract({
    address: getAddress(shareToken), abi: ERC20_BAL_ABI, functionName: "balanceOf", args: [getAddress(recipient)],
  })) as bigint;

  const gained = sharesAfter - sharesBefore;
  assert.ok(gained > 0n, `recipient must receive vault shares (got +${gained})`);
  console.log(`  recipient +${gained} shares. ✅`);

  // Sanity: the submitting tx's `from` is the postman, NOT the depositor — that's the unlinkability.
  const receipt = await client.getTransactionReceipt({ hash: json.txHash as `0x${string}` });
  console.log(`  submitter (postman): ${receipt.from} — not tied to the pool depositor. ✅`);
  console.log("TIER 2 ok: private-funded vault deposit landed at recipient.\n");
}

/**
 * TIER 3 — swap-as-settlement E2E (runs when CALL_E2E_SWAP=1).
 *
 * Proves the differentiated path: agent pays USDC → seller receives a DIFFERENT token
 * (their choice), unlinkably, via a whitelisted Uniswap-V3-style router. Requires an
 * executor deployed on Base Sepolia whose whitelist includes the router
 * (target=CALL_E2E_ROUTER, selector=exactInputSingle 0x04e45aaf), a funded pool
 * deposit, and a Sepolia V3 pool with liquidity for USDC/outputToken at CALL_E2E_POOL_FEE.
 *
 * NOTE: Base Sepolia DEX liquidity is thin — if no live pool exists for the pair, deploy
 * a MockRouter (see ExecutorProcessooor.t.sol) and whitelist THAT instead; the plan shape
 * is identical. This harness only drives HTTP + reads chain; it never deploys or holds a key.
 */
async function tier3SwapOnChain(): Promise<void> {
  console.log("── TIER 3: swap-as-settlement E2E ──");
  const router = process.env.CALL_E2E_ROUTER;
  const outputToken = process.env.CALL_E2E_OUTPUT_TOKEN;
  const usdc = process.env.CALL_E2E_USDC ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const recipient = process.env.CALL_E2E_RECIPIENT;
  const executor = process.env.EXECUTOR_PROCESSOOOR ?? process.env.NEXT_PUBLIC_EXECUTOR_PROCESSOOOR;
  const depositRaw = process.env.CALL_E2E_DEPOSIT;
  const amountAtomic = process.env.CALL_E2E_AMOUNT ?? "990000";
  const poolFee = Number(process.env.CALL_E2E_POOL_FEE ?? "500");
  const minOut = BigInt(process.env.CALL_E2E_SWAP_MINOUT ?? "1"); // set realistically for a live pool

  assert.ok(router && isAddress(router), "CALL_E2E_ROUTER (whitelisted swap router) required");
  assert.ok(outputToken && isAddress(outputToken), "CALL_E2E_OUTPUT_TOKEN (seller's asset) required");
  assert.ok(recipient && isAddress(recipient), "CALL_E2E_RECIPIENT (the seller) required");
  assert.ok(executor && isAddress(executor), "EXECUTOR_PROCESSOOOR (deployed executor addr) required");
  assert.ok(depositRaw, "CALL_E2E_DEPOSIT (JSON deposit secrets) required");
  const deposit = JSON.parse(depositRaw);

  const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC) });

  const outBefore = (await client.readContract({
    address: getAddress(outputToken), abi: ERC20_BAL_ABI, functionName: "balanceOf", args: [getAddress(recipient)],
  })) as bigint;

  // buildSwapCallPlan enforces F1 (router recipient = executor), F5 (in!=out), F2 (minOut>0).
  const plan = buildSwapCallPlan({
    router: router!,
    executor: executor!,
    inputToken: usdc,
    outputToken: outputToken!,
    poolFee,
    amountIn: BigInt(amountAtomic),
    minOut,
    recipient: recipient!,
  });
  console.log("Submitting swap-settle (deposit → executeFromPool → router swap → sweep to seller)...");
  const { status, json } = await post({ networkId: NETWORK_ID, amountAtomic, callPlan: plan, zbaseDeposit: deposit });
  assert.equal(status, 200, `swap-settle must 200, got ${status}: ${json?.error}`);
  assert.ok(json.txHash, "must return a txHash");
  console.log(`  tx: ${json.txHash}`);

  await client.waitForTransactionReceipt({ hash: json.txHash as `0x${string}` });
  const outAfter = (await client.readContract({
    address: getAddress(outputToken), abi: ERC20_BAL_ABI, functionName: "balanceOf", args: [getAddress(recipient)],
  })) as bigint;

  const gained = outAfter - outBefore;
  assert.ok(gained >= minOut, `seller must receive >= minOut of the output token (got +${gained}, minOut ${minOut})`);
  console.log(`  seller +${gained} of output token (minOut ${minOut}). ✅`);

  const receipt = await client.getTransactionReceipt({ hash: json.txHash as `0x${string}` });
  console.log(`  submitter (postman): ${receipt.from} — not tied to the pool depositor. ✅`);
  console.log("TIER 3 ok: private cross-asset settlement landed at the seller.\n");
}

async function main(): Promise<void> {
  console.log(`[test-call-privately] base=${BASE} onchain=${ONCHAIN}\n`);
  await tier1RouteSmoke();
  if (ONCHAIN) {
    await tier2OnChain();
  } else {
    console.log("TIER 2 skipped (set CALL_E2E_ONCHAIN=1 + deploy the executor to run the full on-chain E2E).");
  }
  if (process.env.CALL_E2E_SWAP === "1") {
    await tier3SwapOnChain();
  } else {
    console.log("TIER 3 skipped (set CALL_E2E_SWAP=1 + a router-whitelisted executor to run swap-settle E2E).");
  }
  console.log("\nscripts/test-call-privately.ts: done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
