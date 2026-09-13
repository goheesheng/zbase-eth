/**
 * Shipment A.3 verification — metadata strip + privacy response headers.
 *
 * What this script checks (programmatically):
 *
 *   1. POST /api/facilitator/verify with two identifying headers
 *      (X-Forwarded-For and User-Agent).
 *   2. Assert the response carries the four privacy headers the A.3
 *      middleware sets:
 *        - Cache-Control: no-store, no-cache, must-revalidate
 *        - Referrer-Policy: no-referrer
 *        - X-Content-Type-Options: nosniff
 *        - Permissions-Policy: interest-cohort=()
 *
 * What you MUST verify manually (logs are out of band):
 *
 *   3. Tail the dev-server log (or `next dev` stdout) and confirm the
 *      string "1.2.3.4" never appears -- the IP from X-Forwarded-For
 *      must not have been received, logged, or echoed by the route.
 *   4. Same for "TestBot/1.0" -- the User-Agent must not appear.
 *
 * Usage:
 *
 *   # Terminal A
 *   npm run dev -- -p 3009
 *
 *   # Terminal B (after the dev server is up)
 *   npx tsx scripts/test-metadata-strip.ts [base-url]
 *
 *   # Then grep the dev-server output:
 *   #   grep -E '1\.2\.3\.4|TestBot' <(your dev log)
 *   # Expect: zero matches.
 *
 * Exit code: 0 on all assertions passing, 1 on any failure.
 */

const BASE_URL = process.argv[2] || process.env.ZBASE_BASE_URL || "http://localhost:3009";
const TARGET = `${BASE_URL.replace(/\/$/, "")}/api/facilitator/verify`;

// Sentinel values the spec calls out. Keep them recognizable so a manual
// `grep` over the dev-server log can spot leaks at a glance.
const SENTINEL_IP = "1.2.3.4";
const SENTINEL_UA = "TestBot/1.0";

const EXPECTED_HEADERS: Record<string, string> = {
  "cache-control": "no-store, no-cache, must-revalidate",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "permissions-policy": "interest-cohort=()",
};

async function main() {
  console.log(`[A.3 test] POST ${TARGET}`);
  console.log(`[A.3 test] Sending X-Forwarded-For: ${SENTINEL_IP}, User-Agent: ${SENTINEL_UA}`);

  let res: Response;
  try {
    res = await fetch(TARGET, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": SENTINEL_IP,
        "User-Agent": SENTINEL_UA,
        // A few other identifying headers the middleware also strips --
        // useful smoke coverage even though the spec only asserts on two.
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://example.test/from-here",
        "Cookie": "session=should-not-leak",
        "X-Real-IP": SENTINEL_IP,
        "CF-Connecting-IP": SENTINEL_IP,
        "True-Client-IP": SENTINEL_IP,
      },
      // Minimal body: /verify gracefully returns a 200 with valid:false
      // when paymentDetails is missing extra fields, which is fine for
      // checking response headers.
      body: JSON.stringify({
        paymentDetails: {
          scheme: "exact",
          networkId: "eip155:84532",
          payTo: "0x0000000000000000000000000000000000000000",
          maxAmountRequired: "1",
        },
      }),
    });
  } catch (err) {
    console.error(`[A.3 test] FAIL — could not reach ${TARGET}.`);
    console.error(`[A.3 test] Is the dev server running? (npm run dev -- -p 3009)`);
    console.error(`[A.3 test] Underlying error: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`[A.3 test] Response status: ${res.status}`);

  // The route may answer 200, 400, or 500 depending on env -- A.3 cares
  // about headers, not the body. Don't gate on status.
  const failures: string[] = [];
  for (const [name, expected] of Object.entries(EXPECTED_HEADERS)) {
    const actual = res.headers.get(name);
    if (actual !== expected) {
      failures.push(`  - ${name}: expected "${expected}", got ${actual === null ? "<missing>" : `"${actual}"`}`);
    } else {
      console.log(`[A.3 test] OK  ${name}: ${actual}`);
    }
  }

  // Defense-in-depth: scan the response body for the sentinels. The
  // route should never echo them back. If this trips, the strip is
  // either bypassed or the handler is reading raw headers from somewhere
  // we haven't covered.
  let body = "";
  try {
    body = await res.text();
  } catch {
    // Body read failed; ignore -- header check is the primary contract.
  }
  if (body.includes(SENTINEL_IP)) {
    failures.push(`  - response body leaked sentinel IP "${SENTINEL_IP}"`);
  }
  if (body.includes(SENTINEL_UA)) {
    failures.push(`  - response body leaked sentinel UA "${SENTINEL_UA}"`);
  }

  if (failures.length > 0) {
    console.error(`[A.3 test] FAIL — assertions did not pass:`);
    for (const line of failures) console.error(line);
    console.error(`[A.3 test] Manual log check still required for "${SENTINEL_IP}" and "${SENTINEL_UA}".`);
    process.exit(1);
  }

  console.log(`[A.3 test] PASS — all four privacy response headers present.`);
  console.log(`[A.3 test] Now manually verify the dev-server log:`);
  console.log(`[A.3 test]   grep -E '${SENTINEL_IP}|TestBot' <your-dev-log>`);
  console.log(`[A.3 test] Expect: zero matches.`);
}

main().catch((err) => {
  console.error(`[A.3 test] Unexpected error: ${(err as Error).stack || err}`);
  process.exit(1);
});
