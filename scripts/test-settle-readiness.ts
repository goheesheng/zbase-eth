/**
 * test-settle-readiness.ts — the server-side half of the launch gate.
 *
 * getFacilitatorReadiness() was consumed by /health, /supported and
 * /facilitator/verify only. settle-x402 was NOT gated, so the facilitator could
 * publish customerReady:false with its reasons and settle anyway. The SDK gate
 * (FacilitatorNotReadyError) helps, but a direct HTTP caller bypasses it — a gate
 * only the honest client honours is not a gate.
 *
 * Run: npx tsx scripts/test-settle-readiness.ts
 */
import * as assert from "node:assert/strict";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

console.log("settle readiness — the gate the server enforces\n");

// 1. The escape hatch is ENV-driven, never caller-driven. A request field would let a
//    caller talk the facilitator out of its own launch gate.
{
  delete process.env.ZBASE_ALLOW_UNREADY_SETTLE;
  const { unreadySettleAllowed } = await import("../src/lib/settle-readiness");
  unreadySettleAllowed() === false ? ok("default: unready settles are REFUSED") : bad("default allows unready settle");
}
{
  process.env.ZBASE_ALLOW_UNREADY_SETTLE = "true";
  const mod = await import("../src/lib/settle-readiness?2" as string).catch(() => null);
  // Re-read through the live function rather than a cached module value.
  const { unreadySettleAllowed } = mod ?? (await import("../src/lib/settle-readiness"));
  unreadySettleAllowed() === true ? ok("ZBASE_ALLOW_UNREADY_SETTLE=true opts the operator in") : bad("env opt-in ignored");
  delete process.env.ZBASE_ALLOW_UNREADY_SETTLE;
}
{
  process.env.ZBASE_ALLOW_UNREADY_SETTLE = "TRUE";
  const { unreadySettleAllowed } = await import("../src/lib/settle-readiness");
  unreadySettleAllowed() === true ? ok("case-insensitive") : bad("TRUE not honoured");
  delete process.env.ZBASE_ALLOW_UNREADY_SETTLE;
}
{
  process.env.ZBASE_ALLOW_UNREADY_SETTLE = "yes";
  const { unreadySettleAllowed } = await import("../src/lib/settle-readiness");
  // Fail CLOSED on anything that isn't exactly "true": a typo in an env var must
  // never silently open a launch gate.
  unreadySettleAllowed() === false ? ok('"yes" does NOT open the gate (fails closed on a typo)') : bad('"yes" opened the gate');
  delete process.env.ZBASE_ALLOW_UNREADY_SETTLE;
}



// 2. The operator's bypass lets the plumbing be tested — but must NOT manufacture a
//    privacy claim. Bypassing a gate does not create the property the gate was checking.
{
  process.env.ZBASE_ALLOW_UNREADY_SETTLE = "true";
  const { settleReadinessVerdict } = await import("../src/lib/settle-readiness");
  const v = await settleReadinessVerdict();
  v.allow ? ok("opted in => allowed (operator can test the plumbing)") : bad("refused despite opt-in");
  if (v.allow) {
    v.privacy.private === false
      ? ok("...but privacy.private:false — the bypass discloses instead of claiming")
      : bad("the bypass claimed privacy it cannot back");
  }
  delete process.env.ZBASE_ALLOW_UNREADY_SETTLE;
}

// 3. Against the REAL readiness of this stack. zbase.app is closed today, so a
//    default-config run must refuse. If this ever starts passing silently, the gate
//    has stopped gating.
{
  delete process.env.ZBASE_PILOT_ENABLED; // pilot closed: assert the plain gate
  const { settleReadinessVerdict } = await import("../src/lib/settle-readiness");
  const { getFacilitatorReadiness } = await import("../src/lib/facilitator-readiness");
  const readiness = await getFacilitatorReadiness();
  const v = await settleReadinessVerdict();

  if (readiness.customerReady) {
    v.allow ? ok("customerReady:true => settle proceeds") : bad("refused a ready facilitator");
  } else {
    if (v.allow) { bad("customerReady:false but settle was NOT refused — the gate is not enforcing"); }
    else {
      const r = v.refusal;
      r.status === 503 ? ok("customerReady:false => 503 refusal") : bad("status " + r.status);
      const body = await r.json();
      body.code === "FACILITATOR_NOT_READY" ? ok("code=FACILITATOR_NOT_READY (mirrors /facilitator/verify)") : bad("code: " + body.code);
      body.settled === false ? ok("settled:false") : bad("settled not false");
      /unspent/i.test(body.details ?? "") ? ok("tells the caller their note is UNSPENT (safe to retry)") : bad("does not say the note is unspent");
      // A refusal now means something a disclosure CANNOT cover is broken — a thin
      // anonymity set settles (with a disclosure) rather than refusing. So the message
      // must not send the caller looking at the anonymity set, which is the one thing
      // that is NOT the problem when they see this.
      /NOT the anonymity set/i.test(body.details ?? "")
        ? ok("explains this is NOT the thin-set case (that would settle + disclose)")
        : bad("refusal message still blames the anonymity set: " + body.details);
      Array.isArray(body.blockingReasons) && body.blockingReasons.length > 0
        ? ok(`carries ${body.blockingReasons.length} blockingReasons`)
        : bad("no blockingReasons");
      body.blockingReasons?.every((x: { blocks?: string[] }) => x.blocks?.includes("customer"))
        ? ok("only CUSTOMER-blocking reasons (not verification-only noise)")
        : bad("leaked non-customer reasons");
    }
  }
}

// 4. EARLY ACCESS. A sound stack with a thin set SETTLES, and discloses — no switch, no
//    key, nothing to turn on. Deploying is the whole act. See src/lib/pilot.ts.
{
  const { getFacilitatorReadiness } = await import("../src/lib/facilitator-readiness");
  const readiness = await getFacilitatorReadiness();
  const { settleReadinessVerdict } = await import("../src/lib/settle-readiness");
  const v = await settleReadinessVerdict();

  if (readiness.pilotReady) {
    v.allow ? ok("pilotReady + thin set => SETTLES (no switch needed)") : bad("refused a sound stack");
    if (v.allow) {
      v.privacy.private === false
        ? ok("...and privacy.private is FALSE — payment permitted, claim withheld")
        : bad("CLAIMED PRIVACY at a thin set — the exact failure this exists to prevent");
      /NOT PRIVATE/i.test(v.privacy.disclosure ?? "")
        ? ok("...with a plain-language disclosure, not just a boolean")
        : bad("no plain disclosure");
      v.privacy.anonymitySet === readiness.organicAnonymitySet
        ? ok("...carrying the LIVE independent-depositor count")
        : bad("disclosure set does not match readiness");
    }
  } else {
    // !pilotReady means something a disclosure CANNOT cover is wrong. That must still
    // refuse — early access is not "ignore the gates".
    v.allow === false
      ? ok("stack not pilotReady => still REFUSES (safety is not disclosable)")
      : bad("settled on a stack that is not safe to settle on");
    if (!v.allow) {
      const body = await v.refusal.json();
      body.blockingReasons?.length > 0 && body.blockingReasons.every((x: { blocks?: string[] }) => x.blocks?.includes("pilot"))
        ? ok("...and reports only what actually blocks settling")
        : bad("refusal reasons do not match what blocks it");
    }
  }
}

// 5. No env var may reintroduce a gate on early access.
{
  const { settleReadinessVerdict } = await import("../src/lib/settle-readiness");
  const baseline = await settleReadinessVerdict();
  for (const v of ["ZBASE_PILOT_ENABLED", "ZBASE_PILOT_KEY"]) {
    const prev = process.env[v];
    process.env[v] = "false";
    const got = await settleReadinessVerdict();
    got.allow === baseline.allow ? ok(`${v}=false does not close early access`) : bad(`${v} still gates settling`);
    if (prev === undefined) delete process.env[v];
    else process.env[v] = prev;
  }
}

console.log(failed ? "\nFAILED" : "\nSETTLE READINESS: the server enforces its own gate");
process.exit(failed ? 1 : 0);
