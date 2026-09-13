# The result contract (money-safety) — v0.5.0

`payAndFetch()` moves real USDC. Get this wrong and you double-pay. This is the whole contract.

## The result is a discriminated union + a throw

```ts
const res = await zbase.payAndFetch(url, init, opts); // may THROW (see below)
```

| `res.outcome` | Meaning | What you do |
|---|---|---|
| `"delivered"` | Paid; provider returned data. | Use `res.response`; persist `res.nextDeposit`. |
| `"free"` | Resource was not 402; nothing paid. | Use `res.response`. |
| `"refused"` | Free-probe found a bespoke/incompatible seller; nothing paid, note untouched. | Pick another seller. |
| `"uncertain"` | Settlement unconfirmed; the note **may** be spent. `res.safeToRetry === true`. | **Retry the SAME call with the SAME `deposit`.** |
| *(throws)* | Provably unspent — the withdrawal did NOT happen. Note untouched. | Safe to retry with the same note. |

`res.paid` (`=== outcome "delivered"`) and `res.uncertain` are **deprecated** aliases; switch on
`res.outcome`.

## Why retrying is safe (and switching notes is not)

Settlement is **idempotent on the note's nullifier** (server-side lease + on-chain nullifier
backstop). Retrying the exact same `payAndFetch` with the same `deposit` cannot charge twice — the
second attempt replays the same settlement. The ONLY way to double-pay is to react to an
`"uncertain"` or a throw by paying again **from a different note**. Do not do that.

## The correct handler

```ts
try {
  const res = await zbase.payAndFetch(url, { method: "GET" }, {
    deposit,
    onNoteRotate: (n) => db.save(n),   // persist the change note the instant it exists
    maxAmountAtomic: "50000",          // hard ceiling vs a hostile 402
  });
  switch (res.outcome) {
    case "delivered": return res.response;
    case "free":      return res.response;
    case "refused":   throw new Error("incompatible seller");
    case "uncertain": /* safeToRetry === true */ return retrySameNote();
  }
} catch (err) {
  // provably unspent — same note, safe to retry
  throw err;
}
```

See `../examples/handle-tri-state.ts` for the runnable version.
