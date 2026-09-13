# Pay any x402 service privately — buyer quickstart (Base mainnet)

**Goal:** in ~10 minutes, pay any standard x402 API privately from your agent, using
`@zbase-protocol/core`. You deposit USDC once into a privacy pool, then every payment is
funded from that pool through a fresh single-use wallet — so there is no on-chain link
between your wallet and what you pay for.

**The seller does nothing.** zBase produces a spec-standard x402 payment header, so any
x402 seller whose facilitator settles a standard `exact` EIP-3009 payment accepts it with
zero integration on their side. They never learn zBase exists. This is the large majority —
anyone on **Coinbase CDP** (the dominant x402 facilitator). Proven on mainnet against
**BlockRun** and **Nansen**. A seller running a *bespoke* facilitator that ignores the
standard header (e.g. Otto AI's signed-offer/SIWX flow) is the exception — and the SDK's
**free-probe refuses those before spending**, so you never waste a note on one.

> **Read this first — zBase is an early product.** Privacy comes from a crowd: your
> withdrawal hides among other people's deposits. Right now the pool is still filling
> toward the launch threshold of **30 independent depositors**, so **payments are not
> private yet** — the withdrawal is currently linkable back to your deposit. Every payment
> tells you this in `result.privacy`. It flips to private **automatically** once the pool
> reaches 30, and every depositor (including you) moves it there. You are not just an early
> user; you are what makes it private.

---

## 1. Install

```bash
npm install @zbase-protocol/core
```

## 2. Deposit once — get a note

A "note" is your claim on funds in the pool: `{ nullifier, secret, value, label, commitment }`.

**Easiest:** deposit at **https://zbase.app/app#deposit** with a browser wallet holding
USDC on Base (min $1). The app runs the on-chain deposit and saves your note to an
encrypted, seed-recoverable vault — nothing to hand-manage. Use that note below.

**Programmatic** (if you'd rather not touch the app): use `prepareDeposit(amountAtomic)`
to get the deposit calldata + secrets, submit the deposit on-chain yourself, then fill in
`value`/`label`/`commitment` from the `Deposited` event. See `getDepositConfig()` for the
mainnet entrypoint/asset addresses.

## 3. Pay — pick the path that matches your stack

All three do the same thing: fund the payment from your pool note and hand the seller a
standard header. Pick by what you already use.

### A. Greenfield / simplest — `createPrivateFetch`

```ts
import { createFacilitatorClient } from "@zbase-protocol/core";

const zbase = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453" });

const buy = zbase.createPrivateFetch({
  deposit: myNote,
  onNoteRotate: (next) => db.save(next), // persist the change note (see "Two rules")
  acceptNotPrivate: true,                // early product — you accept it isn't private yet
});

const res = await buy("https://api.seller.ai/data", {
  method: "POST",
  body: JSON.stringify({ q: "top RWA tokens" }),
});

console.log(res.response);          // the seller's data
console.log(res.privacy.private);   // false until the pool reaches 30 depositors
```

### B. Already on `@x402/core@2` — one line, no call sites change

```ts
import { createZBaseExactClient } from "@zbase-protocol/core";

client.register("eip155:8453", createZBaseExactClient({
  deposit: myNote,
  onNoteRotate: db.save,
  acceptNotPrivate: true,
}));
// every existing payment now flows privately from the pool
```

### C. Already on `x402-fetch` / `x402-axios` — zBase acts as your wallet

```ts
import { createZBasePrivateAccount } from "@zbase-protocol/core";
import { wrapFetchWithPayment } from "x402-fetch";

const account = createZBasePrivateAccount({ deposit: myNote, onNoteRotate: db.save });
const fetchWithPay = wrapFetchWithPayment(fetch, account);

await fetchWithPay("https://api.seller.ai/data"); // paid from the pool
```

### Free-probe is automatic (v0.4.0)

`payAndFetch`/`createPrivateFetch` **free-probe the seller before spending**: they read the
402 and send an invalid-signature dummy (which never settles, so it costs nothing) to check
the seller actually honors a standard payload. If not, they return `{ paid: false,
compatible: false, probeReason }` **without touching your note** — no stranded funds on a
bespoke seller. To vet a seller yourself without paying:

```ts
const p = await zbase.probe("https://api.seller.ai/data", { method: "POST", body });
// { compatible: true|false, status, reason, priceAtomic }
```

Pass `skipProbe: true` to skip it for a seller you have already proven.

## 4. Two rules that matter

**1. Keep your note recoverable — the SDK enforces this.** After a partial payment you get
a *change note* for the remainder. The SDK **refuses to spend** unless that change can
survive a crash, so it won't let you lose funds by accident. You satisfy it either way:

- Deposit from the app (the note is seed-recoverable — a full restore rebuilds the whole
  chain from your seed words), **or**
- Pass `onNoteRotate` to persist each change note the instant it exists.

If you do neither, the SDK throws a clear error before spending. (This is the guarantee:
in v0.4.0 you cannot silently lose a change note.)

**2. Check `result.privacy.private` before you rely on privacy.** A not-private payment
succeeds identically to a private one — same proof, same fresh payer, same 200. The only
place the difference shows is here:

```ts
if (!res.privacy.private) {
  // res.privacy.disclosure  → plain-language reason
  // res.privacy.anonymitySet, res.privacy.minimumForPrivacy → "N of 30"
}
```

## 5. What "not private yet" means, concretely

- **The payment works.** The seller is paid, you get your data. Nothing is blocked.
- **It is not anonymous yet.** With the pool below 30 depositors, an observer can link the
  withdrawal back to your deposit. `res.privacy.private` is `false` and says so.
- **It turns private on its own.** At 30 independent depositors the facilitator flips to
  private with no action from anyone, and `res.privacy.private` starts returning `true` for
  everyone — including payments you make after that point.
- **The amount is always visible on-chain** regardless of set size (see the threat model).

`acceptNotPrivate: true` is your explicit acknowledgement of the above. Without it, the SDK
refuses to pay through a not-yet-private facilitator — so nobody wires zBase in expecting
privacy and silently gets none.

## 6. The seller side

Nothing, for a standard seller. The header zBase produces is a spec EIP-3009 `exact`-scheme
payment that the seller's own facilitator verifies like any other. It works with sellers who
read the standard header — `X-PAYMENT` (x402 v1) or `Payment-Signature` (x402 v2); zBase
sends both — and settle via CDP. Proven against **BlockRun** and **Nansen**. The one class
it can't pay is a **bespoke** facilitator that requires its own flow (e.g. Otto AI's
signed-offer + SIWX); the free-probe detects and refuses those before you spend.

## 7. No-code option — the MCP / CLI

If your agent runs the zBase MCP (or you just want to try it), the same flow is a few
commands, no SDK wiring (from `packages/mcp`):

```bash
npx tsx run.ts address                       # send $1 USDC (Base) here — no ETH
npx tsx run.ts sweep                          # gasless deposit into the pool
npx tsx run.ts probe  <url> [--body '<json>'] # free-probe a seller ($0)
npx tsx run.ts pay    <url> <maxUSDC> --pilot [--body '<json>']   # private pay (probes first)
```

`--pilot` acknowledges the not-private disclosure; `--body` switches to POST. `pay`
free-probes by default (`--no-probe` to skip for a proven seller).

---

**Live status:** `GET https://zbase.app/api/facilitator/supported` returns the current
independent-depositor count and whether privacy is live. **Support:** you cannot lose
funds (v0.4.0) and every payment discloses its own privacy — if `res.privacy` ever
disagrees with what you expect, that block is the source of truth.
