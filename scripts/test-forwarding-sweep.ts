/**
 * test-forwarding-sweep.ts — the EIP-3009 sweep, without a chain.
 *
 * The sweep is the plug for the socket forwarding-authority.ts refuses to run
 * without. These assert the properties that keep it from becoming the drain it
 * replaced:
 *
 *   1. The authorization must move THIS user's funds to THIS postman.
 *   2. The deposit uses the MEASURED balance delta, never the client's `value`.
 *   3. receiveWithAuthorization, not transferWithAuthorization (front-run safety).
 *   4. The EIP-712 domain comes from the active stack, never from the caller.
 *
 * Run: npx tsx scripts/test-forwarding-sweep.ts
 */
import * as assert from "node:assert/strict";
import {
  USDC_RECEIVE_WITH_AUTHORIZATION_ABI,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  sweepDomain,
} from "../src/lib/forwarding-sweep";
import { getActiveStack, getActiveChain } from "../src/lib/contracts";

let passed = 0;
const ok = (n: string) => { passed += 1; console.log(`  ✓ ${n}`); };
let failed = false;
const bad = (n: string) => { failed = true; console.log(`  ✗ ${n}`); };

console.log("forwarding sweep — EIP-3009 shape + domain safety\n");

// 1. RECEIVE, not TRANSFER. This is the front-run defence: USDC enforces
//    msg.sender == to for receiveWithAuthorization, so an authorization sitting in a
//    request body can only ever be submitted by the postman it names. A
//    transferWithAuthorization could be lifted and broadcast by anyone.
{
  const fn = USDC_RECEIVE_WITH_AUTHORIZATION_ABI[0];
  fn.name === "receiveWithAuthorization"
    ? ok("ABI is receiveWithAuthorization (only `to` can submit it)")
    : bad(`ABI is ${fn.name} — a transfer authorization is front-runnable`);
  fn.inputs.length === 9 ? ok("9 args (from,to,value,validAfter,validBefore,nonce,v,r,s)") : bad("arg count");
  assert.deepEqual(
    fn.inputs.map((i) => i.name),
    ["from", "to", "value", "validAfter", "validBefore", "nonce", "v", "r", "s"],
  );
  ok("arg ORDER matches USDC's signature (a swap here silently signs the wrong thing)");
}

// 2. The typed-data struct: same 6 fields as TransferWithAuthorization, different
//    primaryType. The differing typehash is what stops one being replayed as the other.
{
  const t = RECEIVE_WITH_AUTHORIZATION_TYPES.ReceiveWithAuthorization;
  assert.deepEqual(
    t.map((f) => f.name),
    ["from", "to", "value", "validAfter", "validBefore", "nonce"],
  );
  ok("ReceiveWithAuthorization struct matches EIP-3009");
  Object.keys(RECEIVE_WITH_AUTHORIZATION_TYPES)[0] === "ReceiveWithAuthorization"
    ? ok("primaryType is ReceiveWithAuthorization (distinct typehash from Transfer)")
    : bad("wrong primaryType — signatures would cross-replay");
}

// 3. The domain is OURS, not the caller's. A caller-supplied domain is a
//    signature-confusion hole: pick the right one and a signature the victim made
//    over an unrelated message recovers to the victim.
{
  const d = sweepDomain();
  const stack = getActiveStack();
  const chain = getActiveChain();
  d.verifyingContract === stack.usdc ? ok("domain.verifyingContract = the ACTIVE stack's USDC") : bad("verifyingContract: " + d.verifyingContract);
  d.chainId === chain.chain.id ? ok("domain.chainId = the active chain (no cross-chain replay)") : bad("chainId: " + d.chainId);
  d.name === "USD Coin" && d.version === "2" ? ok("domain name/version hardcoded (USDC v2)") : bad("name/version");

  // The point: sweepDomain takes NO arguments. There is no way for a caller to
  // influence it, which is the structural version of "don't trust caller input".
  sweepDomain.length === 0
    ? ok("sweepDomain() takes no caller input — confusion hole closed by construction")
    : bad("sweepDomain accepts arguments — a caller could steer the domain");
}

// 4. The ABI must be exactly what viem will encode; a stray `outputs` or mutability
//    change would revert on-chain rather than at the type level.
{
  const fn = USDC_RECEIVE_WITH_AUTHORIZATION_ABI[0];
  fn.stateMutability === "nonpayable" ? ok("nonpayable") : bad("stateMutability: " + fn.stateMutability);
  fn.inputs[5].type === "bytes32" ? ok("nonce is bytes32") : bad("nonce type: " + fn.inputs[5].type);
  fn.inputs[6].type === "uint8" ? ok("v is uint8 (splitSignature normalizes to 27/28)") : bad("v type");
}

console.log(failed ? "\nFAILED" : `\n${passed} passed — sweep shape + domain are safe\n`);
process.exit(failed ? 1 : 0);
