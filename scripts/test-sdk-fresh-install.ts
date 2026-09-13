/**
 * Regression test: the published SDK must import cleanly on a FRESH install
 * OUTSIDE the monorepo. This is the check that would have caught 0.1.0's missing
 * `viem` dependency — inside the repo viem is hoisted so a broken dep "works";
 * only a clean install in a temp dir reveals an undeclared dependency.
 *
 * It packs @zbase-protocol/core, installs the tarball into a throwaway dir with
 * NO access to the monorepo's node_modules, and imports both the main entry and
 * the /experimental subpath. Any undeclared dep → ERR_MODULE_NOT_FOUND → fail.
 *
 * Run: npx tsx scripts/test-sdk-fresh-install.ts
 * (slower — does an npm pack + install; ~30-60s)
 */

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CORE_DIR = join(import.meta.dirname, "..", "packages", "core");

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

console.log("sdk fresh-install — imports clean outside the monorepo\n");
let passed = 0;

// 1. Pack the SDK to a tarball.
sh("npm", ["run", "build"], CORE_DIR);
sh("npm", ["pack"], CORE_DIR);
const tarball = readdirSync(CORE_DIR).find((f) => f.startsWith("zbase-protocol-core-") && f.endsWith(".tgz"));
assert.ok(tarball, "npm pack must produce a tarball");
console.log(`  ✓ packed ${tarball}`);
passed += 1;

// 2. Install into a throwaway dir (no monorepo node_modules in scope).
const dir = mkdtempSync(join(tmpdir(), "zbase-sdk-freshinstall-"));
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", private: true, type: "module" }));
sh("npm", ["install", join(CORE_DIR, tarball!)], dir);
console.log("  ✓ installed the tarball in a clean dir");
passed += 1;

// 3. Import the MAIN entry — any undeclared dep (e.g. the viem bug) throws here.
const mainCheck = sh(
  "node",
  ["--input-type=module", "-e", "import * as z from '@zbase-protocol/core'; if (typeof z.createFacilitatorClient!=='function') throw new Error('missing createFacilitatorClient'); if (z.createNote!==undefined) throw new Error('UTXO leaked to main entry'); console.log('MAIN_OK');"],
  dir,
);
assert.match(mainCheck, /MAIN_OK/, "main entry must import with all deps resolved + no UTXO leak");
console.log("  ✓ main entry imports clean (deps resolve, no UTXO footgun leaked)");
passed += 1;

// 4. Import the /experimental subpath.
const expCheck = sh(
  "node",
  ["--input-type=module", "-e", "import * as x from '@zbase-protocol/core/experimental'; if (typeof x.createNote!=='function') throw new Error('experimental createNote missing'); console.log('EXP_OK');"],
  dir,
);
assert.match(expCheck, /EXP_OK/, "/experimental subpath must resolve");
console.log("  ✓ /experimental subpath resolves");
passed += 1;

// 5. The agent-ready bundle (docs/, examples/, AGENTS.md) must ship in the tarball.
const pkgDir = join(dir, "node_modules", "@zbase-protocol", "core");
for (const rel of [
  "AGENTS.md",
  "docs/quickstart.md",
  "docs/result-contract.md",
  "docs/api.md",
  "examples/handle-tri-state.ts",
  "examples/pay-and-fetch.ts",
]) {
  assert.ok(existsSync(join(pkgDir, rel)), `agent-ready bundle missing from tarball: ${rel}`);
}
console.log("  ✓ docs/, examples/, AGENTS.md shipped in the tarball");
passed += 1;

// 6. Bundled examples must COMPILE against the INSTALLED package (stale examples are worse than
//    none — an agent would confidently run a broken payment sequence). Copy them out of
//    node_modules and typecheck, resolving "@zbase-protocol/core" from the fresh install.
cpSync(join(pkgDir, "examples"), join(dir, "examples"), { recursive: true });
sh("npm", ["install", "--no-save", "typescript@^5", "@types/node@^20"], dir);
writeFileSync(
  join(dir, "tsconfig.examples.json"),
  JSON.stringify({
    compilerOptions: {
      module: "esnext",
      target: "es2022",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["examples/*.ts"],
  }),
);
sh(join(dir, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.examples.json"], dir);
console.log("  ✓ bundled examples type-check against the installed package");
passed += 1;

// Cleanup the tarball so it isn't left in the package dir.
try {
  execFileSync("rm", ["-f", join(CORE_DIR, tarball!)]);
} catch {
  /* best effort */
}

console.log(`\n${passed} passed\n`);
