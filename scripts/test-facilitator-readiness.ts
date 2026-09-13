/**
 * Regression tests for the facilitator readiness contract.
 *
 * Run: npx tsx scripts/test-facilitator-readiness.ts
 */

import {
  evaluateFacilitatorReadiness,
  type FacilitatorReadinessInput,
} from "../src/lib/facilitator-readiness.ts";

let failed = false;
const ok = (message: string) => console.log(`  PASS: ${message}`);
const bad = (message: string) => {
  console.log(`  FAIL: ${message}`);
  failed = true;
};
const expect = (condition: boolean, message: string) => (condition ? ok(message) : bad(message));

const base: FacilitatorReadinessInput = {
  network: "mainnet",
  stackIssues: [],
  postmanIssues: [],
  rpcConfigured: true,
  seedEncryptionConfigured: true,
  aspAuthConfigured: true,
  chainReachable: true,
  anonymitySet: 30,
  currentStateRoot: 11n,
  latestAspRoot: 22n,
  assetConfigPoolMatches: true,
  minimumDepositAmount: 1_000_000n,
  requiredMinimumDepositAmount: 1_000_000n,
  indexerConfigured: true,
  indexerLeafCount: 30,
  indexerStateRootMatches: true,
  indexerAspRootMatches: true,
  minimumAnonymitySet: 30,
  organicAnonymitySet: 30,
  pricingEnforced: true,
  mainnetE2EVerified: true,
  externalReviewApproved: true,
  legalClearanceApproved: true,
  customerPullConfirmed: true,
  anonymitySetProvenanceVerified: true,
};

const codes = (input: FacilitatorReadinessInput) =>
  evaluateFacilitatorReadiness(input).blockingReasons.map((reason) => reason.code);

console.log("facilitator readiness regression test\n");

{
  const empty = evaluateFacilitatorReadiness({
    ...base,
    anonymitySet: 0,
    currentStateRoot: 0n,
    latestAspRoot: null,
    indexerLeafCount: 0,
    indexerStateRootMatches: false,
    indexerAspRootMatches: false,
  });
  expect(!empty.verificationReady, "an empty pool is not verification-ready");
  expect(!empty.customerReady, "an empty pool is not customer-ready");
  expect(
    empty.blockingReasons.some((reason) => reason.code === "EMPTY_ANONYMITY_SET"),
    "empty-pool state is explicit instead of surfacing NoRootsAvailable",
  );
}

{
  const tooLow = evaluateFacilitatorReadiness({
    ...base,
    minimumDepositAmount: 999_999n,
  });
  expect(!tooLow.customerReady, "a sub-1-USDC floor cannot become customer-ready");
  expect(
    tooLow.blockingReasons.some(
      (reason) => reason.code === "MINIMUM_DEPOSIT_BELOW_REQUIRED",
    ),
    "the intended 1 USDC floor is enforced, not merely a nonzero value",
  );
}

{
  const oneDeposit = evaluateFacilitatorReadiness({
    ...base,
    anonymitySet: 1,
    indexerLeafCount: 1,
    organicAnonymitySet: 1,
  });
  expect(oneDeposit.verificationReady, "one approved deposit can make technical verification ready");
  expect(!oneDeposit.customerReady, "one approved deposit does not make mainnet customer-ready");
  expect(
    oneDeposit.blockingReasons.some((reason) => reason.code === "ANONYMITY_SET_BELOW_MINIMUM"),
    "meaningful anonymity threshold blocks customer claims",
  );
}

{
  const ready = evaluateFacilitatorReadiness(base);
  expect(ready.verificationReady, "root and indexer parity make verification ready");
  expect(ready.customerReady, "all technical, demand, review, legal, and pricing gates can open the route");
  expect(ready.blockingReasons.length === 0, "fully ready state has no blocking reasons");
}

{
  const closed = {
    ...base,
    pricingEnforced: false,
    mainnetE2EVerified: false,
    customerPullConfirmed: false,
    anonymitySetProvenanceVerified: false,
  };
  const result = evaluateFacilitatorReadiness(closed);
  const resultCodes = codes(closed);
  expect(result.verificationReady, "business launch gates do not prevent an internal verification canary");
  expect(!result.customerReady, "missing mainnet business gates keep customer discovery closed");
  expect(resultCodes.includes("PRICING_NOT_ENFORCED"), "pricing inconsistency is explicit");
  expect(resultCodes.includes("MAINNET_E2E_NOT_VERIFIED"), "unrelated mainnet E2E evidence is explicit");
  expect(resultCodes.includes("CUSTOMER_PULL_NOT_CONFIRMED"), "customer pull is an explicit launch gate");
  expect(
    resultCodes.includes("ANONYMITY_SET_PROVENANCE_NOT_VERIFIED"),
    "independent anonymity-set provenance is an explicit launch gate",
  );
}

{
  const zeroMinimum = evaluateFacilitatorReadiness({ ...base, minimumDepositAmount: 0n });
  expect(zeroMinimum.verificationReady, "a zero minimum does not block a controlled internal canary");
  expect(!zeroMinimum.customerReady, "a zero-value-deposit configuration cannot become customer-ready");
  expect(
    zeroMinimum.blockingReasons.some((reason) => reason.code === "ZERO_MINIMUM_DEPOSIT"),
    "zero-cost anonymity-set inflation is an explicit customer gate",
  );
}

{
  const unreachable = evaluateFacilitatorReadiness({
    ...base,
    chainReachable: false,
    anonymitySet: 0,
    currentStateRoot: 0n,
    latestAspRoot: null,
  });
  const unreachableCodes = unreachable.blockingReasons.map((reason) => reason.code);
  expect(unreachableCodes.includes("CHAIN_UNREACHABLE"), "RPC or contract read failure is explicit");
  expect(!unreachableCodes.includes("EMPTY_ANONYMITY_SET"), "an unreadable chain is not mislabeled as an empty pool");
}

{
  const sepolia = evaluateFacilitatorReadiness({
    ...base,
    network: "sepolia",
    anonymitySet: 1,
    indexerLeafCount: 1,
    minimumAnonymitySet: 1,
    pricingEnforced: false,
    mainnetE2EVerified: false,
    externalReviewApproved: false,
    legalClearanceApproved: false,
    customerPullConfirmed: false,
    anonymitySetProvenanceVerified: false,
  });
  expect(sepolia.customerReady, "Sepolia developer use is not blocked by mainnet commercial gates");
}

console.log("");
if (failed) {
  console.log("FACILITATOR READINESS: FAILED");
  process.exit(1);
}
console.log("FACILITATOR READINESS: all checks passed");
