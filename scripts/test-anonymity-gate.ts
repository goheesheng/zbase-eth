/**
 * test-anonymity-gate.ts — the privacy gate must not be satisfiable by yourself.
 *
 * Two live holes this closes:
 *
 *  1. `anonymitySet = Number(currentTreeSize)` counted tree LEAVES — treasury seeds and
 *     the payer's own change notes. 30 self-deposits would have flipped
 *     customerReady:true and made /supported announce "Privacy-preserving x402
 *     settlement" with a real crowd of one.
 *  2. `ZBASE_MIN_CUSTOMER_ANONYMITY_SET=1` was a one-line path to the same false claim.
 *
 * Run: npx tsx scripts/test-anonymity-gate.ts
 */
import {
  evaluateFacilitatorReadiness,
  MAINNET_ANONYMITY_FLOOR,
  type FacilitatorReadinessInput,
} from "../src/lib/facilitator-readiness";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

/** A fully-healthy mainnet input; each test perturbs one field. */
const base = (over: Partial<FacilitatorReadinessInput> = {}): FacilitatorReadinessInput => ({
  network: "mainnet",
  stackIssues: [],
  postmanIssues: [],
  rpcConfigured: true,
  seedEncryptionConfigured: true,
  aspAuthConfigured: true,
  chainReachable: true,
  anonymitySet: 40,
  currentStateRoot: 1n,
  latestAspRoot: 1n,
  assetConfigPoolMatches: true,
  minimumDepositAmount: 1_000_000n,
  requiredMinimumDepositAmount: 1_000_000n,
  anonymitySetProvenanceVerified: true,
  indexerConfigured: true,
  indexerLeafCount: 40,
  indexerStateRootMatches: true,
  indexerAspRootMatches: true,
  minimumAnonymitySet: 30,
  organicAnonymitySet: 40,
  pricingEnforced: true,
  mainnetE2EVerified: true,
  externalReviewApproved: true,
  legalClearanceApproved: true,
  customerPullConfirmed: true,
  ...over,
});

const blocked = (i: FacilitatorReadinessInput) =>
  evaluateFacilitatorReadiness(i).blockingReasons.some((r) => r.code === "ANONYMITY_SET_BELOW_MINIMUM");

console.log("anonymity gate — you cannot satisfy it with your own money\n");

// 1. Sanity: a real crowd passes.
{
  const r = evaluateFacilitatorReadiness(base());
  r.customerReady ? ok("40 independent depositors + all gates => customerReady") : bad("healthy input blocked: " + JSON.stringify(r.blockingReasons.map((x) => x.code)));
}

// 2. THE HOLE: a big TREE with a tiny crowd must NOT pass. This is 30 treasury seeds, or
//    one user's 30 change notes — the old gate counted both as anonymity.
{
  const i = base({ anonymitySet: 40, indexerLeafCount: 40, organicAnonymitySet: 1 });
  blocked(i) ? ok("40 leaves but 1 real depositor => BLOCKED (the old gate passed this)") : bad("a crowd of one satisfied the gate");
  evaluateFacilitatorReadiness(i).customerReady === false ? ok("...customerReady stays false") : bad("customerReady true with 1 depositor");
}

// 3. Fail CLOSED when the count is unknown. "We couldn't count the crowd" must never read
//    as "the crowd is big enough".
{
  const i = base({ organicAnonymitySet: null });
  blocked(i) ? ok("unknown count => BLOCKED (fails closed)") : bad("unknown count passed the gate");
  const msg = evaluateFacilitatorReadiness(i).blockingReasons.find((r) => r.code === "ANONYMITY_SET_BELOW_MINIMUM")?.message ?? "";
  /could not be read/i.test(msg) ? ok("...and says WHY, rather than implying the set is small") : bad("message: " + msg);
}

// 3b. FAIL-OPEN REGRESSION. `undefined` is neither null nor a number, and
//     `undefined < 30` is FALSE — so an omitted field skipped the blocker and OPENED the
//     gate. scripts/ is excluded from tsc, so no compile error would have caught it. The
//     existing readiness suite did.
{
  const i = { ...base(), organicAnonymitySet: undefined as unknown as number | null };
  blocked(i) ? ok("UNDEFINED count => BLOCKED (was fail-open: undefined < 30 is false)") : bad("undefined count OPENED the gate — fail-open");
  const j = { ...base(), organicAnonymitySet: NaN as unknown as number | null };
  blocked(j) ? ok("NaN count => BLOCKED (NaN comparisons are always false)") : bad("NaN count opened the gate");
}

// 4. It blocks CUSTOMER only — a thin crowd is not a broken facilitator, and verification
//    must keep working for sellers.
{
  const i = base({ organicAnonymitySet: 1 });
  const r = evaluateFacilitatorReadiness(i);
  r.verificationReady ? ok("a thin crowd does NOT break verification (sellers unaffected)") : bad("verification blocked by a privacy gate");
}

// 5. An empty POOL is still a both-scope failure — that is liveness, measured on leaves,
//    and must keep using the tree size.
{
  const r = evaluateFacilitatorReadiness(base({ anonymitySet: 0, organicAnonymitySet: 0 }));
  r.blockingReasons.some((x) => x.code === "EMPTY_ANONYMITY_SET")
    ? ok("empty pool => EMPTY_ANONYMITY_SET (liveness still uses tree size)")
    : bad("empty pool not caught");
}

// 6. THE DIAL. `ZBASE_MIN_CUSTOMER_ANONYMITY_SET=1` used to be a one-line path to
//    customerReady:true at k=1 — a false privacy claim from an env var.
//
//    minimumAnonymitySet() is module-private, so this asserts the clamp through the
//    exported floor and through getFacilitatorReadiness (which applies it), rather than
//    faking a module reload.
{
  MAINNET_ANONYMITY_FLOOR === 30 ? ok("mainnet floor is 30 (k=30, Tornado Cash convention)") : bad("floor: " + MAINNET_ANONYMITY_FLOOR);

  // Even at the clamped floor, a crowd of one is blocked — the dial cannot buy a claim.
  const i = base({ minimumAnonymitySet: MAINNET_ANONYMITY_FLOOR, organicAnonymitySet: 1 });
  blocked(i) ? ok("at the clamped floor, k=1 is still blocked") : bad("the dial still opens the gate");
}

// 6b. The clamp itself, end-to-end: set the dial to 1 on mainnet and read back what
//     readiness actually uses. This is the test that would have caught the hole.
{
  const prev = process.env.ZBASE_MIN_CUSTOMER_ANONYMITY_SET;
  const prevNet = process.env.NEXT_PUBLIC_NETWORK;
  process.env.ZBASE_MIN_CUSTOMER_ANONYMITY_SET = "1";
  process.env.NEXT_PUBLIC_NETWORK = "mainnet";

  const { getFacilitatorReadiness } = await import("../src/lib/facilitator-readiness");
  const r = await getFacilitatorReadiness();
  r.minimumAnonymitySet >= MAINNET_ANONYMITY_FLOOR
    ? ok(`dial=1 on mainnet clamps to ${r.minimumAnonymitySet} (not 1)`)
    : bad(`dial=1 produced minimumAnonymitySet=${r.minimumAnonymitySet} — the clamp is not applied`);

  if (prev === undefined) delete process.env.ZBASE_MIN_CUSTOMER_ANONYMITY_SET;
  else process.env.ZBASE_MIN_CUSTOMER_ANONYMITY_SET = prev;
  if (prevNet === undefined) delete process.env.NEXT_PUBLIC_NETWORK;
  else process.env.NEXT_PUBLIC_NETWORK = prevNet;
}

// 7. Raising the bar IS allowed — an operator who wants k=100 should get k=100.
{
  const i = base({ minimumAnonymitySet: 100, organicAnonymitySet: 40 });
  blocked(i) ? ok("a raised bar (100) blocks a set of 40 — the dial still tightens") : bad("raised bar ignored");
}

console.log(failed ? "\nFAILED" : "\nANONYMITY GATE: satisfiable only by independent depositors");
process.exit(failed ? 1 : 0);
