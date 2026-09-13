/**
 * wallet.test.ts — the seed IS the money. These are the fund-safety invariants.
 *
 * Run: npx tsx packages/mcp/src/wallet.test.ts
 */
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidMnemonic } from "@zbase-protocol/core";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zbase-wallet-"));
process.env.ZBASE_HOME = path.join(tmp, "home");
delete process.env.ZBASE_SEED;

const { getOrCreateSeed, seedExists, importSeed, walletHome } = await import("./wallet.js");
const { deriveFundingKey } = await import("./account.js");

console.log("mcp wallet — seed custody\n");

// 1. First use creates a seed; second use returns the SAME one. A regenerating seed
//    would orphan every note derived from the first.
{
  seedExists() === false ? ok("fresh home => no seed") : bad("seed already exists");
  const a = getOrCreateSeed();
  isValidMnemonic(a) ? ok("creates a valid BIP39 mnemonic") : bad("invalid mnemonic");
  const b = getOrCreateSeed();
  a === b ? ok("second call returns the SAME seed (never regenerates)") : bad("seed changed between calls");
  seedExists() ? ok("seedExists() true after creation") : bad("seedExists false");
}

// 2. Permissions. Anyone who can read the file owns the funds.
{
  const file = path.join(walletHome(), "seed");
  const mode = fs.statSync(file).mode & 0o777;
  mode === 0o600 ? ok("seed file is 0600 (owner-only)") : bad(`seed file mode is ${mode.toString(8)}`);
  const dirMode = fs.statSync(walletHome()).mode & 0o777;
  dirMode === 0o700 ? ok("wallet dir is 0700") : bad(`wallet dir mode is ${dirMode.toString(8)}`);
}

// 3. THE BIG ONE: importSeed must refuse to overwrite. Restoring over a live seed
//    orphans every note derived from the old one — silent, irreversible, and an easy
//    mistake to make in a chat window.
{
  const before = getOrCreateSeed();
  const other = "test test test test test test test test test test test junk";
  assert.throws(() => importSeed(other), /already exists|Refusing to overwrite/i);
  ok("importSeed REFUSES to overwrite an existing seed");
  getOrCreateSeed() === before ? ok("the existing seed is untouched after a refused import") : bad("seed was modified");
}

// 4. A corrupt seed file must not be silently replaced — it may be a damaged seed
//    holding real funds.
{
  const home2 = path.join(tmp, "corrupt");
  process.env.ZBASE_HOME = home2;
  fs.mkdirSync(home2, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home2, "seed"), "not a mnemonic\n", { mode: 0o600 });
  assert.throws(() => getOrCreateSeed(), /valid BIP39|Refusing to overwrite/i);
  ok("a corrupt seed file throws rather than being regenerated over");
}

// 5. ZBASE_SEED env wins, and is validated (a typo'd env seed would derive a whole
//    different wallet and silently report a zero balance).
{
  process.env.ZBASE_HOME = path.join(tmp, "envtest");
  const known = "test test test test test test test test test test test junk";
  process.env.ZBASE_SEED = known;
  getOrCreateSeed() === known ? ok("ZBASE_SEED overrides the file") : bad("env seed ignored");
  process.env.ZBASE_SEED = "clearly not valid";
  assert.throws(() => getOrCreateSeed(), /valid BIP39/i);
  ok("an invalid ZBASE_SEED throws (never silently derives a different wallet)");
  delete process.env.ZBASE_SEED;
}

// 6. The funding key is deterministic and domain-separated from note keys.
{
  const seed = "test test test test test test test test test test test junk";
  const k1 = deriveFundingKey(seed);
  const k2 = deriveFundingKey(seed);
  k1 === k2 ? ok("funding key is deterministic (same seed => same address)") : bad("funding key not stable");
  /^0x[0-9a-f]{64}$/.test(k1) ? ok("funding key is well-formed") : bad("bad key format");

  const other = deriveFundingKey("legal winner thank year wave sausage worth useful legal winner thank yellow");
  k1 !== other ? ok("different seeds => different funding addresses") : bad("funding key collision");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? "\nFAILED" : "\nMCP WALLET: seed custody invariants hold");
process.exit(failed ? 1 : 0);
