# CDP sponsored postman — setup + verification (2026-07-02)

Moves the zBase **postman** (the operational hot signer for `updateRoot` + `relay`
+ UTXO `spend`/`transfer`) from a raw EOA private key to a **Coinbase Developer
Platform (CDP) ERC-4337 Smart Account with SPONSORED (gasless) gas**.

Why: (1) no more ETH top-ups on the postman wallet — CDP's Paymaster sponsors gas
on Base + Base Sepolia; (2) no raw private key sitting hot on the Vercel server —
the key is CDP-managed.

This is **opt-in and reversible** on Sepolia. For Base mainnet, CDP is the
recommended postman path; `POSTMAN_SIGNER=eoa` is blocked unless
`ZBASE_ALLOW_MAINNET_EOA_POSTMAN=true` is explicitly set as a break-glass
override.

---

## How it works (code)

All postman signing goes through one adapter: `src/lib/postman-signer.ts`
(`sendPostmanTx(...)`). The five call sites — `asp-update` (updateRoot),
`withdraw` (updateRoot + relay + UTXO spend), `transfer` (UTXO transfer) — all call
it. The backend is chosen by `POSTMAN_SIGNER`:

- `eoa` (default): `privateKeyToAccount(POSTMAN_PRIVATE_KEY)` + viem `writeContract`.
- `cdp`: encode calldata with viem, send via the CDP smart account's
  `sendUserOperation({ network, calls: [{ to, data }] })` (gas auto-sponsored),
  await `waitForUserOperation`, return the on-chain `transactionHash`.

Contract-side facts that make this safe (verified in the vendored 0xbow Entrypoint):
- `updateRoot` is `onlyRole(_ASP_POSTMAN)` → the CDP smart-account **address** must
  hold `ASP_POSTMAN`.
- `relay` is **permissionless** (the proof binds `processooor == the Entrypoint`,
  not the caller) → any sender, including a CDP smart account, can relay.

CDP SDK: `@coinbase/cdp-sdk` (installed, v1.51.2). Networks supported by this
adapter: Base (`8453` → `"base"`) and Base Sepolia (`84532` → `"base-sepolia"`).

---

## Setup

### 1. CDP credentials

Reuse the same CDP account as the mainnet x402 facilitator
(`mainnet-runbook-single-value.md` §CDP). From
[portal.cdp.coinbase.com](https://portal.cdp.coinbase.com):

- `CDP_API_KEY_ID`
- `CDP_API_KEY_SECRET`
- `CDP_WALLET_SECRET` (the wallet secret used to authorize account/user-op signing)

Set all three in the server env (Vercel for prod; `.env.local` locally). Never
commit them.

### 2. Create the smart account + learn its address

The adapter get-or-creates the accounts by name, but you need the **address** first
to grant it the role (step 3). Create it once and print the address:

```ts
// scripts/print-cdp-postman.ts — run once with the CDP env vars set.
import { CdpClient } from "@coinbase/cdp-sdk";

const cdp = new CdpClient();
const ownerName = process.env.CDP_POSTMAN_OWNER ?? "zbase-postman-owner";
const smartName = process.env.CDP_POSTMAN_SMART_ACCOUNT ?? "zbase-postman";

const owner = await cdp.evm.getOrCreateAccount({ name: ownerName });
const smart = await cdp.evm.getOrCreateSmartAccount({ name: smartName, owner });
console.log("CDP postman smart-account address:", smart.address);
```

```bash
CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… CDP_WALLET_SECRET=… \
  npx tsx scripts/print-cdp-postman.ts
```

The names default to `zbase-postman-owner` / `zbase-postman`; override with
`CDP_POSTMAN_OWNER` / `CDP_POSTMAN_SMART_ACCOUNT` if you want different labels.
Same names → same accounts across runs (idempotent).

### 3. Grant the smart account the ASP_POSTMAN role

The smart-account address from step 2 must hold `ASP_POSTMAN` on the Entrypoint:

- **At deploy (mainnet, cleanest):** pass it as `ENTRYPOINT_POSTMAN` to
  `DeployMainnetPool.s.sol` — the script grants ASP_POSTMAN to that address in the
  deploy broadcast. (Create the CDP smart account BEFORE deploying so you have the
  address.) See `mainnet-deploy-command.md`.
- **After deploy / on an existing pool (incl. Sepolia):** the owner calls
  `grantRole(_ASP_POSTMAN, <smart-account addr>)`.

`relay` needs no role (permissionless), so once ASP_POSTMAN is granted, all five
call sites work.

### 4. Configure the mainnet Paymaster policy

On **Base Sepolia**, gas is sponsored by default — nothing to configure. On
**Base mainnet**, set a Paymaster/sponsorship policy in the CDP Portal for the
smart account (e.g. allowlist the Entrypoint + pool addresses, set a spend cap).
Without a policy, mainnet user-ops won't be sponsored.

### 5. Flip the flag

```
POSTMAN_SIGNER=cdp
```

Set it in the server env alongside the CDP credentials. Redeploy (Vercel) or
restart (local). The EOA `POSTMAN_PRIVATE_KEY` is no longer read in this mode.

---

## Verification (do Sepolia FIRST)

1. **Sepolia gasless updateRoot** — with `POSTMAN_SIGNER=cdp` + ASP_POSTMAN granted
   to the smart account on a Sepolia pool, `POST /api/asp-update`. Confirm:
   - it returns a `txHash`,
   - the tx `from` is the CDP smart-account address,
   - **no ETH was spent by us** (sponsored),
   - the on-chain `latestRoot()` updated.
2. **Sepolia relay via CDP** ✅ PROVEN (2026-07-02, tx `0x69483d7b…`) — a full
   `test-full-flow.ts` deposit→withdraw with `POSTMAN_SIGNER=cdp` completed; the
   relay was sent gaslessly by the CDP smart account (relay is permissionless, so a
   CDP sender can't break it — the proof binds `processooor` to the Entrypoint).
3. **Revert to EOA on Sepolia** — unset `POSTMAN_SIGNER` (or set `eoa`); confirm
   behavior is identical to before (the EOA branch is the prior code, lifted
   verbatim). On mainnet, this requires `ZBASE_ALLOW_MAINNET_EOA_POSTMAN=true`.
4. **Only then mainnet** — repeat (1)–(2) on mainnet with the Paymaster policy live,
   using a small real amount.

## Helper scripts

- `scripts/print-cdp-postman.ts` — get-or-create the CDP postman accounts, print
  the smart-account address (needed for step 3's grant). Idempotent.
- `scripts/prove-cdp-postman.ts` — one-shot proof: forces cdp mode in-process and
  sends a real sponsored `updateRoot` on the live Sepolia Entrypoint (re-posts the
  current root, so it changes nothing), then confirms zero ETH spent.

## PROVEN on Sepolia (2026-07-02)

Smart account `0xd411f68a53F5698d05c840C52065a624F9CC5769` was granted `ASP_POSTMAN`
(role id `0xfc84ade0…`) on the live entrypoint `0x598ffaac…`. The old EOA
`0xcDB447c3…` kept its role (grant is additive). Both postman operations were then
proven sponsored (smart-account ETH stayed `0`, ERC-4337 sender = the smart account,
outer tx routed through the 4337 EntryPoint `0x5ff137d4…` via CDP's bundler):

- **updateRoot** — tx `0xceed1868…`, `status: success` (re-posted the current root).
- **relay (the money path)** — full `test-full-flow.ts` deposit→withdraw with
  `POSTMAN_SIGNER=cdp`: withdraw/relay tx `0x69483d7b…`, `status: success`; the pool
  Entrypoint + PrivacyPool + USDC all emitted (real withdrawal executed), smart
  account paid zero gas.

### Gotcha found: IPFS CID length

`Entrypoint.updateRoot(root, cid)` reverts `InvalidIPFSCIDLength()`
(selector `0xebc0ebeb`) if the CID string is **< 32 or > 64 bytes**. The
production routes already build long CIDs (`QmZbaseASPRoot…{Date.now()}pad`), so
the real path is fine; only ad-hoc test calls must remember the 32–64 byte bound.

## Rollback

On Sepolia, set `POSTMAN_SIGNER=eoa` (or unset it) and ensure
`POSTMAN_PRIVATE_KEY` is present + its address holds ASP_POSTMAN. On mainnet, also
set `ZBASE_ALLOW_MAINNET_EOA_POSTMAN=true`; otherwise launch readiness checks
reject EOA mode. If you had swapped the role to the CDP address only,
`grantRole(_ASP_POSTMAN, <eoa addr>)` first.

---

## Deploy is NOT affected

The one-time contract deploy stays a standard forge key (`--private-key` /
keystore) — forge can't broadcast through the CDP REST API, and rewriting the
deploy in TS was explicitly rejected as too much risk on the critical path. Only
the *ongoing* postman signer moves to CDP. Separately, the OWNER role can also be
moved to a CDP wallet post-deploy via `grantRole(_OWNER_ROLE, …)` — see the
"OPTIONAL — owner role via a CDP wallet" section in `mainnet-deploy-command.md`.
