# Enterprise Data Product — Self-Sovereign Compliance Export (Design)

**Date:** 2026-07-11
**Status:** 🟡 DESIGNED — gated on the UTXO/notes rail being live. Build when UTXO ships.
**Supersedes:** the fake "compliance tier" (removed 2026-07-10 — it was a 3× price label
with no deliverable; see `[[project_facilitator_fee_structure]]` and the single-5%-tier
commit).

## 1. Summary

The enterprise tier's REAL product is **data, not a settle surcharge**: an enterprise opts
in and gets a **self-sovereign, viewing-key-gated export of THEIR OWN agents' transactions**
— for their AML screening, reporting, and analytics. The enterprise holds a viewing key;
they can decrypt/see only the notes that belong to their key, and nothing else. zBase never
builds a cross-user surveillance database.

This is a feature **only a privacy-native facilitator can offer**: a *transparent*
facilitator can't sell it (everything's already public), and a *surveillance* facilitator
can't offer it honestly (they own the data, not you). zBase sits in the sweet spot — private
by default, disclosable by the owner's choice. The tagline: **"self-custody your compliance
data."**

## 2. The non-negotiable design guardrail

**SELF-SOVEREIGN, NOT SURVEILLANCE.** This is the line that makes the feature enhance the
privacy product instead of poisoning it:

- The enterprise sees ONLY notes that decrypt to THEIR viewing key. The crypto enforces this
  — a note encrypted to key A cannot be decrypted by key B.
- zBase does NOT persist a queryable transaction ledger of all users. The dataset is
  **reconstructed from chain** via the viewing-key scan, on demand, per enterprise.
- The enterprise HOLDS the viewing key (or zBase holds a per-enterprise derived sub-key that
  only decrypts that enterprise's notes). Either way, no key sees another enterprise's data.

If this guardrail is ever violated (a shared DB, cross-tenant visibility, zBase decrypting
everyone), the feature becomes a honeypot and contradicts the entire product. It is the
constraint every design decision below serves.

## 3. What's REUSABLE (the crypto core already exists)

The viewing-key stack is ~90% of this feature. Verified in the codebase:

- **`packages/core/src/viewingKeyHD.ts`** — `deriveViewingKeyFromMnemonic(mnemonic, index)`
  (deterministic BIP32/BIP39, path `m/44'/60'/0'/0'/<index>`). The doc already anticipates
  "per-app sub-keys later" → **assign each enterprise its own derivation index.**
- **`packages/core/src/notes.ts`** — `scanNotes(entries, viewingPrivateKey)` returns ONLY
  the notes that decrypt to a viewing key. This IS "give me my own transaction set."
  Also `decryptNote` / `decryptNoteWithAAD`.
- **`packages/core/src/noteScanner.ts`** — `scanTransferredLogs(logs, viewingPrivateKey)`
  (batch/historical replay over `eth_getLogs` output) → the natural building block for a
  compliance export. `createScanner(...)` is the live WS variant.
- **`packages/core/src/npk.ts`** — per-note unlinkability + owner-side recovery: two notes to
  the same recipient are unlinkable on-chain, but the viewing-key holder can cluster their
  own. Exactly the self-sovereign property.
- **`/api/anonymity-set`** (`src/app/api/anonymity-set/route.ts`) — the disclosure-ladder +
  explicit no-PII pattern is the DESIGN TEMPLATE to mirror for privacy-preserving reporting.

## 4. What's NET-NEW

1. **Enterprise ↔ viewing-key association + opt-in flag.** Persist (Upstash, mirroring the
   fail-closed `facilitator-authz` pattern) an `enterpriseId` → derivation-index (or
   registered viewing pubkey) mapping. Set ONLY via out-of-band enterprise onboarding (not
   self-serve — this is a sales-gated product). `agentId`/`owner`
   (`src/app/api/agent/register/route.ts`) is the conceptual grouping key.
2. **Viewing-key-gated export endpoint** — `POST /api/enterprise/report`. Authenticates the
   enterprise, runs `scanTransferredLogs`/`scanNotes` over historical UTXO-pool logs with
   THEIR viewing key, and formats an AML/reporting dataset: tx list, amounts, timestamps,
   per-provider breakdown — for THEIR OWN agents only. No existing endpoint self-reports;
   this is the deliverable that justifies the enterprise price.
3. **Auth boundary.** The crypto already scopes (only their notes decrypt), but the API must
   require proof the caller controls the enterprise's key — a signature over a challenge,
   same pattern as the vault bearer (`vault-messages.ts`) and forwarding-register signature.
4. **(Optional) agent-registry persistence.** The registry
   (`agent/register/route.ts:43`) is in-memory/per-instance ("demo only"). IF grouping by
   `agentId`/`owner`, persist it (Upstash, fail-closed). PREFERRED: skip persistence and
   reconstruct purely from chain via the viewing-key scan — aligns with "no surveillance DB."

## 5. The hard dependency (why this is gated, not buildable-now)

**This feature needs encrypted per-note transfers to scan** — and those only exist on the
**UTXO/notes path**, which is `/experimental`, pre-ceremony, NOT deployed. The current
single-value pool has no per-note encrypted transfers to viewing-key-scan (`npk.ts:38-45`
also notes the spending-key scheme isn't shipped; the export needs only the *viewing* key /
read-only decrypt, so that part is fine — but the notes must exist).

**So the sequencing is hard-gated:**
1. Part 1 (5% rate) — SHIPPED (2026-07-10, live on zbase.app).
2. UTXO/notes rail goes live (ceremony + `UTXOPool.sol` deploy) — a separate track,
   demand-gated (`[[project_utxo_moat_verdict]]`, `[[project_utxo_testnet_state]]`).
3. THEN this enterprise-data feature is buildable (~1-2 weeks, mostly the endpoint + auth +
   report formatting, since the scan crypto is reusable).

Do NOT build this before the UTXO rail — there'd be nothing to scan.

## 6. Verification (when built)

- **Scoping proof (the guardrail test):** an enterprise viewing key scans a set of logs and
  recovers EXACTLY its own agents' notes, and recovers NONE of a different enterprise's notes.
  This is the test that proves "self-sovereign, not surveillance." Reuse the
  `scanNotes`/`scanTransferredLogs` patterns in `notes.test.ts`.
- The export endpoint REJECTS a caller who can't prove control of the enterprise key.
- The report format matches what an AML/compliance team needs (tx list, amounts, timestamps,
  provider breakdown) — validate with the first enterprise customer, not in a vacuum.

## 7. Honest caveats

- **Demand-gated, like everything.** This is the enterprise upsell — build it when you have a
  named enterprise customer who wants it, not speculatively. It's the deliverable that makes
  the flat enterprise fee ($2.5–25K/mo) honest, but only if a customer exists to pay it.
- **Regulatory framing matters.** "We give enterprises their own transaction data for AML" is
  a defensible, compliance-positive story. Get the framing reviewed (the same legal/MSB read
  the mainnet gate needs) so "we log agent transactions" is never mis-heard as surveillance.
- **This does NOT change the base product.** Base = compliant privacy at 5%, universal
  screening, no per-tenant logging. The enterprise data product is an OPT-IN, viewing-key-
  scoped add-on that touches only that enterprise's own notes.

Related: `[[project_facilitator_fee_structure]]`, `[[project_utxo_moat_verdict]]`,
`[[project_utxo_testnet_state]]`, `[[project_differentiation_verdict]]`.
