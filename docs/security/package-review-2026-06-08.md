# Package surface security review — 2026-06-08

**Scope:** `@zbase-protocol/core`, `@zbase-protocol/svm`, `@zbase-protocol/mcp` — what would land in an npm tarball if these packages were published. Repo currently private; nothing published.

**Reviewer:** feature-dev:code-reviewer subagent, confidence ≥7/10 filter.

**Severity count:** 1 P0, 4 P1, 3 P2, 0 P3.

---

## P0 — Must fix before any public-facing distribution

### P0-1: `require()` inside a pure-ESM package breaks `nullifierHashOf` at runtime

**File:** `packages/core/src/notes.ts:154` (also compiled into `packages/core/dist/notes.js:104`)

**Confidence:** 95/100

**What is wrong:** `packages/core/package.json` declares `"type": "module"`, making every `.js` file in the package an ES module. ES modules do not have a `require` global — it is undefined. The function `nullifierHashOf()` (publicly exported in `index.ts`) contains:

```js
const { poseidon1 } = require("poseidon-lite");
```

This is a synchronous CJS `require()` call inside an exported function of a `"type": "module"` package. Any consumer that calls `nullifierHashOf()` — a first-class exported symbol — will get `ReferenceError: require is not defined` at the call site. Not a Node.js version issue; structural. The package is `"type": "module"` and the dist is compiled `.js` with `export` statements throughout, so there is no CJS fallback.

**Impact:** `nullifierHashOf` is the on-chain spend marker computation for UTXO notes. A caller using it to prepare a spend transaction hits an uncaught `ReferenceError`. The function is exported from the package's public `index.ts` barrel — every downstream consumer of `@zbase-protocol/core` that touches notes.ts is affected the first time they call `nullifierHashOf`.

**Fix:** Replace the inline `require` with a top-level static import at the top of `notes.ts`:

```ts
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
```

Then `nullifierHashOf` becomes `return poseidon1([note.nullifier]);` with no `require` needed.

---

## P1 — Must fix before npm publish

### P1-1: `@zbase-protocol/svm` depends on an npm-unresolvable workspace package

**File:** `packages/svm/sdk/package.json:20`

**Confidence:** 100/100

**What is wrong:**

```json
"@zbase-protocol/core": "*"
```

`@zbase-protocol/core` does not exist on the npm registry. The `"*"` range, which resolves fine within a workspace, becomes a hard failure for any external consumer running `npm install @zbase-protocol/svm`. npm resolves `*` against the public registry, finds nothing, aborts with `npm ERR! 404 Not Found - GET https://registry.npmjs.org/@zbase-protocol%2Fcore`.

**Impact:** Entire `@zbase-protocol/svm` package un-installable by any third party until core is published first. Because svm transitively depends on core for every useful function, this is a complete install-time blocker.

**Fix:** Publish `@zbase-protocol/core` to npm first, then pin a concrete version: `"@zbase-protocol/core": "^0.2.0"` before publishing svm.

---

### P1-2: Missing `publishConfig.access: "public"` on all three packages

**Files:**
- `packages/core/package.json`
- `packages/svm/sdk/package.json`
- `packages/mcp/package.json`

**Confidence:** 98/100

**What is wrong:** All three packages are scoped (`@zbase-protocol/...`). npm's default for scoped packages is `restricted` access (private — requires paid Teams/Org subscription). Without `"publishConfig": { "access": "public" }`, `npm publish` either fails with `npm ERR! 402 Payment Required` or silently publishes as private (invisible to `npm install @zbase-protocol/mcp` by a new user).

**Impact:** Users following the README's `npm install -g @zbase-protocol/mcp` get 404 or access-denied. Claude Desktop users copying the MCP config JSON see the npx invocation fail silently. The README's quickstart breaks.

**Fix:** Add to each `package.json`:

```json
"publishConfig": {
  "access": "public"
}
```

---

### P1-3: `@noble/curves` duplicate key causes version downgrade

**File:** `packages/core/package.json:22,25`

**Confidence:** 90/100

**What is wrong:**

```json
"@noble/curves": "^1.9.0",
...
"@noble/curves": "^1.6.0"
```

JSON duplicate keys: every real-world parser takes the last value. Last entry is `^1.6.0`, so npm resolves to a version ≥1.6.0 and <2.0.0 — potentially 1.6.x — rather than the intended ≥1.9.0.

The `stealth.ts` code accesses `secp256k1` via the internal `ProjectivePoint` API (`secp256k1.ProjectivePoint.BASE.multiply(...)`, `secp256k1.CURVE.n`) — semi-private APIs that have changed between minor versions. Version 1.6.x and 1.9.x differ in internal API surface; the code was developed against 1.9.x. Resolving to 1.6.x could result in `TypeError: secp256k1.ProjectivePoint is not a constructor` for any ERC-5564 stealth operation.

**Impact:** Every call to `generateMetaAddress`, `deriveStealthAddress`, `scanForPayments`, `computeStealthPrivateKey` could silently throw on fresh installs. Runtime cryptographic failure, not a build failure — TypeScript compiles fine either way.

**Fix:** Remove the duplicate key. Keep only `"@noble/curves": "^1.9.0"`.

---

### P1-4: Proof byte diagnostic dumps ship to stdout in `@zbase-protocol/svm`

**File:** `packages/svm/sdk/src/pool.ts:548-560` (also in compiled `packages/svm/sdk/dist/pool.js`)

**Confidence:** 85/100

**What is wrong:** Every call to `SvmPool.withdraw()` unconditionally logs all 256+ bytes of the Groth16 proof and all 8 public input signals to stdout:

```ts
console.log("[zx402-svm] proof_a=", hex(proofA));
console.log("[zx402-svm] proof_b=", hex(proofB));
console.log("[zx402-svm] proof_c=", hex(proofC));
proofResult.publicSignals.forEach((s, i) => {
  console.log(`[zx402-svm] pi[${i}] dec=${s} hex=${hex(feToBE32(s))}`);
});
```

Public signals include `existingNullifierHash` (index 1) and `stateRoot` / `ASPRoot`. The nullifier hash is the on-chain spend marker — logging it alongside a withdrawal indexes which pool deposit was spent at which time, in plain text in process stdout. In a server-side SDK deployment, this goes into log aggregators (Datadog, CloudWatch, Vercel logs) where it becomes queryable, linkable to IP/timestamp, visible to anyone with log access.

This is development debugging that was not stripped before the dist build.

**Impact:** Directly degrades privacy guarantees by logging the nullifier hash to the operator's log pipeline. Undermines the core product claim.

**Fix:** Remove lines 548-560 (the `const hex = ...` helper and all `console.log` calls for proofA/B/C and `pi[i]`). The `console.log` on lines 381/393 (state-root matching) and 526 (local verify) are lower-severity debug aids that can optionally be gated behind a `DEBUG` env var, but the proof-byte dumps are the acute issue.

---

## P2 — Defense-in-depth / polish

### P2-1: Non-constant-time view-tag comparison in `decryptNote`

**File:** `packages/core/src/notes.ts:380`

**Confidence:** 80/100 (real issue; low exploitability in this specific context)

**What is wrong:**

```ts
if (expectedTag[0] !== viewTag[0] || expectedTag[1] !== viewTag[1]) {
  return null;
}
```

Variable-time comparison of two bytes derived from a shared secret. In ERC-5564 context, a timing-capable attacker observing per-note scan latency could narrow down view-tag values. However, scanner runs locally (not over a network), the 2-byte tag is a coarse 1/65536 filter, and JS JIT timing side-channels are largely neutralized by OS scheduling jitter. Practical exploitability very low.

Standard defense (per ERC-5564 spec, Umbra implementation): constant-time comparison or hash-compare, eliminating the branch. The AEAD step that follows (`xchacha20poly1305.decrypt`) is already properly authenticated.

**Fix:**

```ts
const tagMatch = (expectedTag[0] ^ viewTag[0]) | (expectedTag[1] ^ viewTag[1]);
if (tagMatch !== 0) return null;
```

---

### P2-2: Test file ships in tarball via `files: ["src"]`

**File:** `packages/core/src/account.test.ts`

**Confidence:** 85/100

**What is wrong:** `@zbase-protocol/core`'s `files` array includes `"src"`, including `src/account.test.ts` in the published tarball. No secrets in the test, but signals to consumers that this is a dev artifact not intended as a public API. Could lead users to write code coupling to implementation details.

The tsconfig already excludes `*.test.ts` from compilation (does not appear in `dist/`), but the `files` array does not exclude it from `src/`.

**Fix:** Either add `"!src/**/*.test.ts"` to the `files` array, or move test files to a top-level `tests/` directory outside `src/`.

---

### P2-3: `@zbase-protocol/core` and `@zbase-protocol/svm` missing `repository` field

**Files:** Both `package.json` files

**Confidence:** 82/100

**What is wrong:** Neither has a `repository` field. Missing means: (a) `npm audit` cannot link CVEs to source; (b) npm package page shows no source link; (c) security researchers cannot find code to report issues; (d) `npm fund` and `npm docs` don't work.

**Fix:** Add the same `repository` block as mcp (with the correct `directory` path) to both files.

---

## Non-findings (checked, clean)

- **Hardcoded private keys:** None found. The large hex constant in `account.ts` is the BN128 scalar field modulus, a well-known public number.
- **`Math.random()` in keygen:** Not present. All randomness uses `crypto.getRandomValues` or `secp256k1.utils.randomPrivateKey()`.
- **Shell-exec in MCP:** No `child_process`, `spawn`, `exec`, or `execSync` in `packages/mcp/src/**`. The server is purely an HTTP client over stdio.
- **Env-var leakage via MCP tool responses:** `config.ts` reads `ZBASE_FACILITATOR_URL`, `ZBASE_NETWORK`, `ZBASE_FETCH_TIMEOUT_MS`. None returned in tool responses. `config.ts` comment notes "No secrets in this file."
- **Source maps with absolute paths:** All 10 `.map` files in `packages/mcp/dist/` use relative `sources` paths. No `/Users/eesheng_eth/...` paths anywhere.
- **Prompt injection in MCP tool descriptions:** Tool descriptions are static strings; no interpolated external data. Server instructions interpolate `ZBASE_FACILITATOR_URL` and `ZBASE_NETWORK` (operator-controlled env vars), acceptable.
- **IDL private data leakage (`dist/idl.json`):** Clean. Contains only instruction names, account layout, discriminators, program ID — all public, on-chain information.
- **MCP `node_modules` in tarball:** `files: ["dist", "README.md"]`. `node_modules/` not listed; excluded by npm default behavior.
