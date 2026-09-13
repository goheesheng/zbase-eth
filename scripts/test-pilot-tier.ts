/**
 * test-pilot-tier.ts — the pilot must unblock the PAYMENT without unblocking the CLAIM.
 *
 * Pilot mode exists to break a deadlock: the anonymity set only grows when independent
 * people deposit, and they only deposit if they can transact — so "no payments until the
 * set reaches 30" blocks the only thing that clears it. The dangerous way to break that
 * deadlock is to make `customerReady` true. This suite exists to prove pilot mode is not
 * that, by asserting the two things that would make it that:
 *
 *   1. Pilot never sets customerReady, never fills `supported[]`, never claims privacy.
 *   2. Pilot is NOT "customer minus the anonymity gate" — the safety blockers that a
 *      disclosure cannot cover still shut it.
 *
 * Run: npx tsx scripts/test-pilot-tier.ts
 */
import {
  evaluateFacilitatorReadiness,
  type FacilitatorReadinessInput,
} from "../src/lib/facilitator-readiness";
import { pilotDisclosure } from "../src/lib/pilot";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

/**
 * A mainnet facilitator that is sound but NOT private: the stack works, the keys are
 * protected, legal is cleared — and the anonymity set is 1. This is exactly the live box
 * after Phase A + B, and exactly the state the pilot is for.
 */
const soundButThin = (over: Partial<FacilitatorReadinessInput> = {}): FacilitatorReadinessInput => ({
  network: "mainnet",
  stackIssues: [],
  postmanIssues: [],
  rpcConfigured: true,
  seedEncryptionConfigured: true,
  aspAuthConfigured: true,
  chainReachable: true,
  anonymitySet: 2,
  currentStateRoot: 1n,
  latestAspRoot: 1n,
  assetConfigPoolMatches: true,
  minimumDepositAmount: 1_000_000n, // Phase A: armed on-chain
  requiredMinimumDepositAmount: 1_000_000n,
  anonymitySetProvenanceVerified: false, // no set to judge yet
  indexerConfigured: true,
  indexerLeafCount: 2,
  indexerStateRootMatches: true,
  indexerAspRootMatches: true,
  minimumAnonymitySet: 30,
  organicAnonymitySet: 1, // the live truth
  pricingEnforced: false, // a pilot need not monetise
  mainnetE2EVerified: false, // the pilot IS the E2E
  externalReviewApproved: true,
  legalClearanceApproved: true,
  customerPullConfirmed: false, // the pilot IS the demand test
  ...over,
});

console.log("pilot tier — permits the payment, withholds the claim\n");

// 1. THE POINT. A thin set must not block the pilot, or the deadlock is unbroken.
{
  const r = evaluateFacilitatorReadiness(soundButThin());
  r.pilotReady ? ok("sound stack + set of 1 => pilotReady (the deadlock breaks)") : bad("pilot blocked: " + JSON.stringify(r.blockingReasons.filter((x) => x.blocks.includes("pilot")).map((x) => x.code)));
  r.customerReady === false ? ok("...and customerReady STAYS false (the claim is withheld)") : bad("pilot flipped customerReady — the exact false claim this exists to prevent");
  r.blockingReasons.some((x) => x.code === "ANONYMITY_SET_BELOW_MINIMUM")
    ? ok("...and the anonymity blocker is still REPORTED, not suppressed")
    : bad("pilot mode silenced the anonymity blocker");
}

// 2. Pilot is NOT customer-minus-anonymity. Each of these is a thing a disclosure cannot
//    cover, and each must shut the pilot on its own. If any of these passes, pilot has
//    become "ignore the gates" rather than "disclose the gap".
{
  const mustBlockPilot: Array<[string, Partial<FacilitatorReadinessInput>]> = [
    ["SEED_ENCRYPTION_NOT_CONFIGURED", { seedEncryptionConfigured: false }],
    ["EXTERNAL_REVIEW_NOT_APPROVED", { externalReviewApproved: false }],
    ["ZERO_MINIMUM_DEPOSIT", { minimumDepositAmount: 0n }],
    ["ASP_AUTH_NOT_CONFIGURED", { aspAuthConfigured: false }],
    ["POSTMAN_CONFIG", { postmanIssues: ["signer is an unfunded EOA"] }],
    ["RPC_NOT_CONFIGURED", { rpcConfigured: false }],
    ["STACK_CONFIG", { stackIssues: ["pool address unset"] }],
    ["CHAIN_UNREACHABLE", { chainReachable: false }],
    ["INDEXER_NOT_CONFIGURED", { indexerConfigured: false }],
  ];
  for (const [code, over] of mustBlockPilot) {
    const r = evaluateFacilitatorReadiness(soundButThin(over));
    const shuts = r.blockingReasons.some((x) => x.code === code && x.blocks.includes("pilot"));
    if (shuts && !r.pilotReady) ok(`${code} blocks pilot (a disclosure cannot cover it)`);
    else bad(`${code} did NOT block pilot — pilot has become "ignore the gates"`);
  }
}

// 3. The ones a disclosure CAN cover must not block pilot — otherwise the pilot can never
//    start and the tier is decorative.
{
  const mustNotBlockPilot = [
    "ANONYMITY_SET_BELOW_MINIMUM",
    "ANONYMITY_SET_PROVENANCE_NOT_VERIFIED",
    "MAINNET_E2E_NOT_VERIFIED",
    "CUSTOMER_PULL_NOT_CONFIRMED",
    "PRICING_NOT_ENFORCED",
    // Operator decision, 2026-07-17: the ASP is live and enforcing (OFAC-screened,
    // sanctioned depositors excluded from the association set, fails closed), and the
    // operator's position is that clearance is not required rather than that it has been
    // obtained. So this blocks the CLAIM, not early access. It stays a reported blocker —
    // ZBASE_LEGAL_CLEARANCE_APPROVED is deliberately NOT set, because that flag asserts
    // clearance exists and asserting it would record something untrue.
    "LEGAL_CLEARANCE_NOT_APPROVED",
  ];
  const r = evaluateFacilitatorReadiness(soundButThin({ legalClearanceApproved: false }));
  for (const code of mustNotBlockPilot) {
    const reason = r.blockingReasons.find((x) => x.code === code);
    if (!reason) { bad(`${code} not raised at all — fixture drift, the test is asserting nothing`); continue; }
    reason.blocks.includes("pilot")
      ? bad(`${code} blocks pilot — the pilot could never start; it exists to resolve this`)
      : ok(`${code} does not block pilot (resolving it IS the pilot)`);
    reason.blocks.includes("customer")
      ? ok(`   ...but still blocks customer`)
      : bad(`${code} stopped blocking customer — the claim leaked open`);
  }
}

// 4. A THIN SET IS NOT A BROKEN FACILITATOR. Sellers must keep verifying.
{
  const r = evaluateFacilitatorReadiness(soundButThin());
  r.verificationReady ? ok("verification unaffected by pilot state (sellers keep working)") : bad("verification blocked");
}

// 5. The escalation is monotone: anything that shuts verification shuts pilot and
//    customer too. A tier that stayed open while the stack was broken would be absurd.
{
  const r = evaluateFacilitatorReadiness(soundButThin({ stackIssues: ["broken"] }));
  !r.verificationReady && !r.pilotReady && !r.customerReady
    ? ok("a broken stack shuts every tier (no tier survives its own foundation)")
    : bad("a broken stack left a tier open");
}

// 6. Full launch: pilot must also be ready. A facilitator that is customer-ready but not
//    pilot-ready would be incoherent — it would mean the claim holds while the safety
//    checks under it do not.
{
  const r = evaluateFacilitatorReadiness(
    soundButThin({
      organicAnonymitySet: 40, anonymitySet: 40, indexerLeafCount: 40,
      anonymitySetProvenanceVerified: true, pricingEnforced: true,
      mainnetE2EVerified: true, customerPullConfirmed: true,
    }),
  );
  r.customerReady && r.pilotReady ? ok("a fully-launched facilitator is both customerReady and pilotReady") : bad(`incoherent tiers: customer=${r.customerReady} pilot=${r.pilotReady}`);
}

// 7. THERE IS NO SWITCH, and nothing may reintroduce one. If any env var could gate
//    early access, we would be back to withholding a capability zBase has in order to
//    manage a claim it cannot back — see src/lib/pilot.ts. The only dial anywhere near
//    this is the anonymity MINIMUM, and that only tightens (test-anonymity-gate.ts).
{
  const withNoEnv = evaluateFacilitatorReadiness(soundButThin());
  for (const v of ["ZBASE_PILOT_ENABLED", "ZBASE_PILOT_KEY"]) {
    const prev = process.env[v];
    process.env[v] = "false";
    const off = evaluateFacilitatorReadiness(soundButThin());
    off.pilotReady === withNoEnv.pilotReady
      ? ok(`${v} has no effect — early access is not a mode`)
      : bad(`${v} still gates early access; the switch came back`);
    if (prev === undefined) delete process.env[v];
    else process.env[v] = prev;
  }
}

// 8. THE DISCLOSURE IS THE PRODUCT. A pilot success that reads as private is the whole
//    failure mode, so `private` is asserted false unconditionally.
{
  const d = pilotDisclosure(1, 30);
  d.private === false ? ok("pilot disclosure says private:false") : bad("pilot disclosure claims privacy");
  d.anonymitySet === 1 && d.minimumForPrivacy === 30 ? ok("...carries the live set and the bar") : bad("disclosure numbers wrong");
  /NOT PRIVATE/.test(d.disclosure) ? ok("...and says NOT PRIVATE in words, not just a boolean") : bad("disclosure text is not plain");
  /link/i.test(d.disclosure) ? ok("...and names the actual consequence (linkability)") : bad("disclosure omits the consequence");

  // Unknown count must not render as a confident small number.
  const u = pilotDisclosure(null, 30);
  u.private === false && /unknown/i.test(u.disclosure) ? ok("an uncountable set discloses honestly, still private:false") : bad("null set mishandled");
}

console.log(failed ? "\nFAILED" : "\nPILOT TIER: payment permitted, claim withheld, disclosure mandatory");
process.exit(failed ? 1 : 0);
