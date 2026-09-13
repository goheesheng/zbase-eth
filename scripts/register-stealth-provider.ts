/**
 * scripts/register-stealth-provider.ts — one-command B.1 stealth onboarding.
 *
 * Mints a fresh ERC-5564 meta-address (scheme 1, secp256k1) and registers it
 * against a running zBase facilitator's POST /api/providers/register, then
 * round-trips by:
 *   1. Deriving ONE test stealth address from the meta-address to prove the
 *      facilitator-side derivation will succeed.
 *   2. Re-reading the registry over GET to confirm the new provider lands in
 *      the public listing.
 *
 * This is the operator entry point for the Base Sepolia push:
 *   - Real providers run it once to mint + register their first meta-address.
 *   - The founder runs it as a sales demo ("integration is one command").
 *
 * Distinct from scripts/test-stealth.ts (pure offline SDK invariants) and
 * scripts/test-providers-route.ts (in-process route handler smoke). This one
 * speaks HTTP to a live dev server or deployment.
 *
 * --- Environment ---
 *
 *   PROVIDER_NAME       optional; default "test-provider-<ms timestamp>"
 *   PROVIDER_EMAIL      optional; default "ops+<ms timestamp>@example.test"
 *   FALLBACK_PAYTO      optional; 0x-prefixed; included in POST if set
 *   STEALTH_SEED        optional; 64-byte hex (with or without 0x). If set,
 *                       key generation is deterministic — same seed always
 *                       produces the same meta-address. If unset, fresh OS
 *                       randomness is used and the script prints a loud
 *                       warning that the keys are unrecoverable without it.
 *   ZBASE_API           optional; default "http://localhost:3009"
 *
 * --- Flags ---
 *
 *   --reveal-private-keys   print spending+viewing private keys to stdout.
 *                           Off by default. Always pair with a password
 *                           manager workflow; never paste into chat/logs.
 *
 * --- Exit codes ---
 *
 *   0   registration accepted, derivation worked, GET listing contains the
 *       new provider.
 *   1   any of the above failed (network, validation, listing miss, etc).
 *
 * --- Usage ---
 *
 *   # Local dev server (port 3009)
 *   PROVIDER_NAME="Nansen API" PROVIDER_EMAIL="ops@nansen.ai" \
 *     npx tsx scripts/register-stealth-provider.ts
 *
 *   # Reproducible run (same seed -> same meta-address)
 *   STEALTH_SEED=$(openssl rand -hex 64) \
 *   PROVIDER_NAME="my-provider" PROVIDER_EMAIL="ops@my-provider.com" \
 *     npx tsx scripts/register-stealth-provider.ts --reveal-private-keys
 *
 *   # Against a deployed facilitator
 *   ZBASE_API="https://zbase.app" PROVIDER_NAME="prod-provider" \
 *     npx tsx scripts/register-stealth-provider.ts
 */

import {
  generateMetaAddress,
  deriveStealthAddress,
} from "../packages/core/src/stealth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const REVEAL_PRIVATE_KEYS = process.argv.includes("--reveal-private-keys");

const TS = Date.now();
const PROVIDER_NAME = (process.env.PROVIDER_NAME || `test-provider-${TS}`).trim();
const PROVIDER_EMAIL = (process.env.PROVIDER_EMAIL || `ops+${TS}@example.test`).trim();
const FALLBACK_PAYTO = (process.env.FALLBACK_PAYTO || "").trim();
const ZBASE_API = (process.env.ZBASE_API || "http://localhost:3009").replace(/\/$/, "");
const STEALTH_SEED_HEX = (process.env.STEALTH_SEED || "").trim();

const REGISTER_URL = `${ZBASE_API}/api/providers/register`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error("seed: odd-length hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function rule(): void {
  console.log("─".repeat(72));
}

function fail(msg: string, extra?: unknown): never {
  console.error(`\n[register-stealth-provider] FAIL — ${msg}`);
  if (extra !== undefined) console.error(extra);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  rule();
  console.log("zBase B.1 stealth provider onboarding");
  console.log(`facilitator : ${ZBASE_API}`);
  console.log(`provider    : ${PROVIDER_NAME}`);
  console.log(`email       : ${PROVIDER_EMAIL}`);
  if (FALLBACK_PAYTO) console.log(`fallbackPay : ${FALLBACK_PAYTO}`);
  rule();

  // 1. Generate the meta-address (deterministic if seed provided)
  let seed: Uint8Array | undefined;
  if (STEALTH_SEED_HEX) {
    try {
      seed = hexToBytes(STEALTH_SEED_HEX);
    } catch (e) {
      fail(`STEALTH_SEED is not valid hex: ${(e as Error).message}`);
    }
    if (seed!.length !== 64) {
      fail(`STEALTH_SEED must decode to exactly 64 bytes, got ${seed!.length}`);
    }
    console.log("[1/4] Generating meta-address from STEALTH_SEED (deterministic).");
  } else {
    console.log("[1/4] Generating meta-address from fresh OS randomness.");
    console.log("");
    console.log("      !!! WARNING !!!");
    console.log("      No STEALTH_SEED was provided. The spending and viewing");
    console.log("      private keys printed below (with --reveal-private-keys)");
    console.log("      are the ONLY copies. If you lose them, all stealth");
    console.log("      payments to this meta-address are permanently unspendable.");
    console.log("      Re-running this script will mint a NEW unrelated identity.");
    console.log("");
    console.log("      To make this run reproducible:");
    console.log("        STEALTH_SEED=$(openssl rand -hex 64) <re-run>");
    console.log("      Store STEALTH_SEED in a password manager.");
    console.log("");
  }

  const meta = generateMetaAddress(seed);
  console.log(`      meta-address      : ${meta.metaAddress}`);
  console.log(`      spending pubkey   : ${meta.spendingPublicKey}`);
  console.log(`      viewing  pubkey   : ${meta.viewingPublicKey}`);
  if (REVEAL_PRIVATE_KEYS) {
    console.log("");
    console.log("      --- PRIVATE KEYS (store in a password manager) ---");
    console.log(`      spending privkey  : ${meta.spendingPrivateKey}`);
    console.log(`      viewing  privkey  : ${meta.viewingPrivateKey}`);
    console.log("      ---------------------------------------------------");
  } else {
    console.log("");
    console.log("      Private keys hidden. Re-run with --reveal-private-keys to print them.");
  }
  rule();

  // 2. POST registration
  console.log(`[2/4] POST ${REGISTER_URL}`);
  const body: Record<string, unknown> = {
    providerName: PROVIDER_NAME,
    metaAddress: meta.metaAddress,
    contactEmail: PROVIDER_EMAIL,
    // schemeId is hard-coded server-side, but include for forward-compat.
    scheme: 1,
  };
  if (FALLBACK_PAYTO) body.fallbackPayTo = FALLBACK_PAYTO;

  let regRes: Response;
  try {
    regRes = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    fail(
      `could not reach ${REGISTER_URL}. Is the facilitator running?\n` +
        `      try: npm run dev -- -p 3009`,
      (e as Error).message,
    );
  }

  const regBody = await regRes!.json().catch(() => ({}));
  if (regRes!.status !== 200) {
    fail(`POST returned ${regRes!.status}`, regBody);
  }
  if (!regBody.registered || !regBody.provider?.id) {
    fail("POST returned 200 but payload did not include {registered:true, provider.id}", regBody);
  }
  const providerId: string = regBody.provider.id;
  console.log(`      OK — provider registered`);
  console.log(`      id          : ${providerId}`);
  console.log(`      schemeId    : ${regBody.provider.schemeId}`);
  console.log(`      registeredAt: ${regBody.provider.registeredAt}`);
  rule();

  // 3. Derive one stealth address to prove the round trip works
  console.log("[3/4] Deriving one test stealth address (round-trip proof).");
  const derived = deriveStealthAddress(meta.metaAddress);
  console.log(`      stealth address    : ${derived.stealthAddress}`);
  console.log(`      ephemeral pubkey   : ${derived.ephemeralPublicKey}`);
  console.log(`      view tag (1 byte)  : ${derived.viewTag}`);
  console.log("      (this is what a real settlement would send funds to.)");
  rule();

  // 4. GET listing and verify the provider is there
  console.log(`[4/4] GET ${REGISTER_URL} — verifying listing.`);
  let listRes: Response;
  try {
    listRes = await fetch(REGISTER_URL, { method: "GET" });
  } catch (e) {
    fail(`GET failed`, (e as Error).message);
  }
  const listBody = await listRes!.json().catch(() => ({}));
  if (listRes!.status !== 200) {
    fail(`GET returned ${listRes!.status}`, listBody);
  }
  const providers: Array<{ id: string; metaAddress: string; providerName: string }> =
    Array.isArray(listBody.providers) ? listBody.providers : [];
  const match = providers.find(
    (p) => p.id === providerId && p.metaAddress === meta.metaAddress,
  );
  if (!match) {
    fail(
      `provider ${providerId} not found in GET listing of ${providers.length} entries`,
      listBody,
    );
  }
  console.log(`      OK — provider is in listing (count=${providers.length})`);
  rule();

  console.log("\nPASS — stealth provider registered + round-trip verified.");
  console.log("\nNext steps:");
  console.log(`  • Run scanForPayments(viewingPrivateKey, ephemeralPubkeys, spendingPublicKey)`);
  console.log(`    on settle logs to detect inbound payments.`);
  console.log(`  • Use computeStealthPrivateKey(...) to derive the spend key for sweep.`);
  console.log(`  • Docs: docs/operations/stealth-provider-onboarding-2026-05-31.md`);
}

main().catch((err) => {
  console.error(`\n[register-stealth-provider] unexpected error:`);
  console.error((err as Error).stack || err);
  process.exit(1);
});
