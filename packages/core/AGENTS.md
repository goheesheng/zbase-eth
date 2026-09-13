# @zbase-protocol/core — agent guide (v0.5.0)

You (an AI agent) are integrating **private x402 payments**. Everything you need is bundled in this
package — read it locally, do not fetch the web.

- Quickstart: `./docs/quickstart.md`
- **Money-safety contract (READ THIS BEFORE WRITING ANY PAYMENT CODE):** `./docs/result-contract.md`
- API reference: `./docs/api.md`
- Runnable examples: `./examples/pay-and-fetch.ts`, `./examples/handle-tri-state.ts`

## The one rule that prevents double-paying

`payAndFetch(...)` returns a **discriminated union** on `result.outcome`, and it **throws** only when
the note is *provably unspent*. Handle all cases:

- `outcome: "delivered"` — paid, provider returned data. Use `result.response`; persist `result.nextDeposit`.
- `outcome: "free"` — resource wasn't 402; nothing paid.
- `outcome: "refused"` — incompatible seller; nothing paid, note untouched.
- `outcome: "uncertain"` — the note **may** be spent. `result.safeToRetry === true` because settlement
  is **idempotent on the note's nullifier**. **Retry the SAME call with the SAME deposit.**
- **throws** — provably unspent, note untouched, safe to retry with the same note.

**NEVER** treat "no clear success" as "unspent" and pay again from a **different** note — that is the
one mistake that double-pays. The safe reflex is always: retry the SAME note; never switch notes.

Copy `./examples/handle-tri-state.ts` — it is the correct pattern.
