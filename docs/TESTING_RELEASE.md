# zBase Testing Release Runbook

Last updated: 2026-05-29

This is a testnet release checklist for validating the Paperclip changes and
the public docs before inviting testers. It is not a mainnet release checklist.

## What Changed

- Base Sepolia x402 agent settle now includes
  `paymentDetails.maxAmountRequired`, so policy checks use the invoice amount.
- SVM devnet facilitator/SDK can settle an exact payment amount from a larger
  note and return a reusable `nextDeposit` for the remaining private balance.
- SVM x402 server validates payment amount, token mint, active pool, ASP root,
  and deposit value before settlement.

## Required Environment

Base Sepolia:

```bash
BASE_SEPOLIA_RPC=...
POSTMAN_PRIVATE_KEY=...
HYPERSYNC_TOKEN=...
```

SVM devnet:

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com
ZX402_SVM_READY=true
```

`ZX402_SVM_READY` remains the compatibility env name in code during testnet;
the public product name is zBase.

The Solana wallet at `~/.config/solana/id.json` must have devnet SOL. The Base
test wallet must have Base Sepolia USDC.

## Local Gates

Run these before any on-chain test:

```bash
npm test
npm run build:core
npm run build:svm-sdk
npm run build
```

If `npm run build` fails on `next/font` Google Fonts in a sandboxed
environment, rerun with network access. A real release environment must be able
to fetch or self-host those fonts.

## Base Sepolia x402 E2E

Terminal 1:

```bash
npm run dev -- -p 3009
```

Terminal 2:

```bash
npm run test:x402-server
```

Terminal 3:

```bash
set -a; source .env.local; set +a
npm run test:x402-agent
```

Success markers:

- `Got 402 Payment Required`
- `Verification: VALID`
- `Payment settled ... txHash`
- `Payment #2 settled ... txHash`
- `Service returned premium data!`

Base Sepolia now supports exact-amount payments with spendable `nextDeposit`
change notes. A short leaf-sync retry handles HyperRPC lag when the next payment
starts immediately after the change commitment is inserted.

Latest verified run, 2026-05-29:

- Deposit: `0x3a44d0bccc8b714118faec6c392ad1bee63de541a77a884dff7b9a8c5ca1febf`
- Payment #1: `0xfd0816d67a20c3a1f9fc4b64c3eca95ac9d3c870ba098f09daeb3a78541ca217`
- Payment #2: `0xcadb0fc0da682a675e1d1787854c17fb82a745a9c71b28c607d3d041d3e39a4c`
- Anonymity set reported by facilitator: `72`
- Proof/settle times: `6212ms`, `6144ms`
- Remaining note value after payment #2: `89000`

## SVM Devnet Partial-Note E2E

Terminal 1:

```bash
npm run demo:server
```

Terminal 2:

```bash
npm run test:svm-x402-agent
```

Success markers:

- Payment #1 verifies and settles.
- Response includes `remainingValue` and `nextDeposit`.
- Payment #2 verifies and settles using the returned `nextDeposit`.
- Both paid endpoint retries return `200`.

If the shared demo pool has stale mixed deposit/change ordering, reset it and
rerun:

```bash
npm run demo:bootstrap -- --reset
npm run test:svm-x402-agent
```

Latest verified run after reset, 2026-05-29:

- Demo pool: `3tdjgufA8V8LoL6TBY6RwM2za2jix11Zt3omowRDxRPE`
- Deposit: `5GBMes9nZVkrB3DYt8bpeaj6CTqwids6kadhWnCdnNqU4LwoAxzWa7wxHzSdhvyrAgNTpggdyUCb61H42iAVB7By`
- Settlement #1: `6D1GUwwoZs9hAgD31ZDtQEBi81KuoDtaTEC2fN6rvW7aUtrmAzuJBppp4inYXqAAJ5HSy1nSjME3JvDwDn1FoAp`
- Settlement #2: `3XxhEUCANKu88tV8VJFurSx7pQBmbcBi8LMZNFuRUQoTyq56PRfZaUStyygpanBeTk1XgPociMmjZEPMcaeEV3pG`
- Remaining note values: `990000` after payment #1, `985000` after payment #2

## Docs Release Checklist

- README examples use `zbaseDeposit` for Base Sepolia API routes.
- README settle examples include `paymentDetails.maxAmountRequired`.
- GitBook folder is `docs/gitbook/` with `SUMMARY.md`, landing page, Base
  Sepolia guide, quickstart, architecture problems/solutions page, trust model,
  API reference, troubleshooting, and testing release page.
- No docs claim Solana mainnet private routing is live.
- No docs claim complete anonymity.
- No docs claim production decentralization of the ASP/postman.

## Testing Release Wording

Use:

> zBase is ready for Base Sepolia and Solana devnet testing. Base Sepolia
> validates exact-amount private x402 settlement and reports current pool
> change-note compatibility. Solana devnet validates reusable `nextDeposit`
> partial-note flow and the V1 on-chain Groth16 path.

Avoid:

> Production mainnet readiness.
> Complete anonymity.
> No trust assumptions.
> Private Solana production settlement is live.
