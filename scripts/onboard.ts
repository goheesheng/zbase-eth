#!/usr/bin/env -S npx tsx
/**
 * scripts/onboard.ts — one-command provider onboarding.
 *
 * Usage:
 *   ./scripts/onboard.sh <provider-name>
 *
 * Or directly:
 *   npx tsx scripts/onboard.ts <provider-name>
 *
 * Bundles meta-address generation → register with facilitator → derive a
 * test stealth address → verify scan → print summary. Designed to be the
 * single command a founder can paste into a Coinbase / OpenAI / Anthropic
 * DM as "here's how easy it is to integrate stealth payments with zBase."
 *
 * Lower-level building block: scripts/register-stealth-provider.ts
 * Sales artifact: docs/operations/stealth-provider-onboarding-2026-05-31.md
 */

import {
  generateMetaAddress,
  deriveStealthAddress,
  scanForPayments,
} from "@zbase-protocol/core";
import { writeFileSync, chmodSync } from "node:fs";
import { argv, env, exit, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

interface Args {
  name: string;
  api: string;
  email?: string;
  fallback?: string;
  seed?: string;
  revealPrivateKeys: boolean;
  nonInteractive: boolean;
}

function parseArgs(): Args {
  const raw = argv.slice(2);
  let name: string | undefined;
  let api = env.ZBASE_API ?? "http://localhost:3009";
  let email: string | undefined;
  let fallback: string | undefined;
  let seed: string | undefined;
  let revealPrivateKeys = false;
  let nonInteractive = false;

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--reveal-private-keys") revealPrivateKeys = true;
    else if (a === "--non-interactive") nonInteractive = true;
    else if (a === "--api") api = raw[++i];
    else if (a.startsWith("--api=")) api = a.slice(6);
    else if (a === "--email") email = raw[++i];
    else if (a.startsWith("--email=")) email = a.slice(8);
    else if (a === "--fallback") fallback = raw[++i];
    else if (a.startsWith("--fallback=")) fallback = a.slice(11);
    else if (a === "--seed") seed = raw[++i];
    else if (a.startsWith("--seed=")) seed = a.slice(7);
    else if (a === "--help" || a === "-h") {
      printHelp();
      exit(0);
    } else if (!a.startsWith("-") && !name) {
      name = a;
    }
  }

  if (!name) {
    console.error("error: missing provider name\n");
    printHelp();
    exit(2);
  }

  return { name, api, email, fallback, seed, revealPrivateKeys, nonInteractive };
}

function printHelp() {
  console.log(`zBase provider onboarding — one command

Usage:
  ./scripts/onboard.sh <provider-name> [flags]

Flags:
  --api=URL                  Facilitator endpoint (default: $ZBASE_API or http://localhost:3009)
  --email=EMAIL              Contact email (non-interactive)
  --fallback=0x...           Optional fallback payTo address
  --seed=HEX                 Deterministic key generation (for re-runs)
  --reveal-private-keys      Print spending/viewing private keys to stdout
  --non-interactive          Skip confirmation prompt
  -h, --help                 Show this help

Example:
  ./scripts/onboard.sh coinbase-test --email=eng@example.com`);
}

function box(lines: string[]): string {
  const w = Math.max(...lines.map((l) => l.length));
  const top = "╭" + "─".repeat(w + 2) + "╮";
  const bot = "╰" + "─".repeat(w + 2) + "╯";
  const sep = "├" + "─".repeat(w + 2) + "┤";
  const body = lines
    .map((l) =>
      l === "---" ? sep : "│ " + l + " ".repeat(w - l.length) + " │",
    )
    .join("\n");
  return [top, body, bot].join("\n");
}

function trunc(s: string, n = 24): string {
  return s.length > n ? s.slice(0, n - 4) + "..." + s.slice(-4) : s;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = await rl.question(question);
  rl.close();
  return ans.trim();
}

async function healthCheck(api: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) return { ok: true };
    return { ok: false, reason: `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function main() {
  const args = parseArgs();

  console.log("\nzBase provider onboarding — one command");
  console.log("─".repeat(48));
  console.log(`Provider name:   ${args.name}`);
  console.log(`Facilitator API: ${args.api}`);

  // === Pre-flight ===========================================================
  const health = await healthCheck(args.api);
  if (!health.ok) {
    console.warn(
      `\n⚠️  Facilitator health check failed: ${health.reason}\n` +
        `   Continuing anyway — registration may fail.`,
    );
  } else {
    console.log("Facilitator:     ✓ reachable");
  }

  let email = args.email;
  let fallback = args.fallback;

  if (!email && !args.nonInteractive) {
    email = await prompt("Contact email (for compliance notifications): ");
  }
  if (!email) email = `ops+${Date.now()}@example.test`;

  if (!fallback && !args.nonInteractive) {
    const f = await prompt(
      "Fallback payTo address (optional, ENTER to skip): ",
    );
    if (f) fallback = f;
  }

  if (!args.nonInteractive) {
    console.log(
      "\nI'll generate a stealth meta-address, register it with the\n" +
        "facilitator, derive one test stealth address, and verify the\n" +
        "scan flow works. Takes ~10 seconds.",
    );
    const yn = await prompt("Continue? [Y/n] ");
    if (yn && yn.toLowerCase().startsWith("n")) {
      console.log("Aborted.");
      exit(0);
    }
  }

  // === Generate ============================================================
  console.log("\n[1/5] Generating meta-address...");
  const seedBuf = args.seed ? Buffer.from(args.seed, "hex") : undefined;
  if (args.seed && seedBuf!.length !== 64) {
    console.error(
      "error: --seed must be 64 bytes (128 hex chars) for deterministic generation",
    );
    exit(2);
  }
  const meta = generateMetaAddress(seedBuf);

  console.log(`      meta-address:  ${trunc(meta.metaAddress, 40)}`);
  console.log(`      spending pubkey: ${trunc(meta.spendingPublicKey, 40)}`);
  console.log(`      viewing pubkey:  ${trunc(meta.viewingPublicKey, 40)}`);

  if (args.revealPrivateKeys) {
    console.log(`      spending PRIV:   ${meta.spendingPrivateKey}`);
    console.log(`      viewing PRIV:    ${meta.viewingPrivateKey}`);
    console.log("      ⚠️  PRIVATE KEYS PRINTED — store in password manager NOW");
  } else {
    console.log("      (private keys hidden — pass --reveal-private-keys to show)");
  }

  // Persist keypair locally so the operator can move it to a password manager.
  const ts = Math.floor(Date.now() / 1000);
  const keypairPath = `./zbase-provider-${args.name}-${ts}.json`;
  const keypairData = {
    providerName: args.name,
    metaAddress: meta.metaAddress,
    spendingPublicKey: meta.spendingPublicKey,
    viewingPublicKey: meta.viewingPublicKey,
    spendingPrivateKey: meta.spendingPrivateKey,
    viewingPrivateKey: meta.viewingPrivateKey,
    schemeId: 1,
    createdAt: new Date().toISOString(),
    warning:
      "MOVE TO PASSWORD MANAGER IMMEDIATELY. DELETE THIS FILE AFTER. The viewing private key never needs to leave the provider's machine; the spending private key is what authorizes sweeps to treasury.",
  };
  writeFileSync(keypairPath, JSON.stringify(keypairData, null, 2), "utf8");
  try {
    chmodSync(keypairPath, 0o600);
  } catch {
    // Windows fallback — no chmod
  }
  console.log(`      keypair saved:   ${keypairPath} (chmod 600)`);

  // === Register ============================================================
  console.log("\n[2/5] Registering with facilitator...");
  let providerId: string;
  try {
    const body: Record<string, unknown> = {
      providerName: args.name,
      metaAddress: meta.metaAddress,
      contactEmail: email,
    };
    if (fallback) body.fallbackPayTo = fallback;

    const res = await fetch(`${args.api}/api/providers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`      ✗ HTTP ${res.status}: ${errText.slice(0, 300)}`);
      console.error(
        "\nCommon causes:\n" +
          "  • Provider name already registered → pick a different name\n" +
          "  • Malformed meta-address → re-run onboard.sh\n" +
          "  • Facilitator not running → check ZBASE_API and try again",
      );
      exit(1);
    }
    const json = (await res.json()) as { id?: string; error?: string };
    if (!json.id) {
      console.error(`      ✗ Registration returned no id: ${JSON.stringify(json)}`);
      exit(1);
    }
    providerId = json.id;
    console.log(`      ✓ registered as ${providerId}`);
  } catch (err) {
    console.error(`      ✗ network error: ${(err as Error).message}`);
    exit(1);
  }

  // === Derive ==============================================================
  console.log("\n[3/5] Deriving a test stealth address...");
  const derived = deriveStealthAddress(meta.metaAddress);
  console.log(`      stealth address: ${derived.stealthAddress}`);
  console.log(`      ephemeral pubkey: ${trunc(derived.ephemeralPublicKey, 40)}`);
  console.log(`      view tag:         ${derived.viewTag}`);
  console.log("      (this is what a payer computes when sending to you)");

  // === Verify scan =========================================================
  console.log("\n[4/5] Verifying provider can recognize incoming payments...");
  const matches = scanForPayments(
    meta.viewingPrivateKey,
    [derived.ephemeralPublicKey],
    meta.spendingPublicKey,
    [derived.viewTag],
  );
  if (matches.length === 1 && matches[0].stealthAddress === derived.stealthAddress) {
    console.log("      ✓ scan recovered the stealth address");
  } else {
    console.error(
      `      ✗ scan did NOT recover the stealth address (got ${matches.length} matches)`,
    );
    exit(1);
  }

  // === Summary =============================================================
  console.log("\n[5/5] Summary\n");
  console.log(
    box([
      `zBase provider onboarding — ${args.name}`,
      "---",
      `Meta-address:    ${trunc(meta.metaAddress, 36)}`,
      `Facilitator:     ${args.api}`,
      `Provider ID:     ${providerId}`,
      `Test stealth:    ${trunc(derived.stealthAddress, 36)}`,
      `Scan check:      ✓`,
      `Keypair file:    ${keypairPath}`,
      `Backup now:      ⚠️  move to 1Password!`,
      "---",
      "Next steps:",
      "1. Move keypair to password manager",
      `2. Delete local file: rm ${keypairPath}`,
      "3. Run scanForPayments on your endpoint",
      "   to receive incoming stealth payments",
      "4. See onboarding doc:",
      "   docs/operations/stealth-provider-",
      "   onboarding-2026-05-31.md",
    ]),
  );
  console.log("");
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  if (err.stack) console.error(err.stack.split("\n").slice(0, 5).join("\n"));
  exit(1);
});
