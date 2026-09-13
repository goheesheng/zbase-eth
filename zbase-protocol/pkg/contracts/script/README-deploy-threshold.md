# ThresholdEntrypoint Deploy Runbook

**Date:** 2026-05-31
**Owner:** Eesheng Goh (founder, signer slot 5)
**Target:** `ThresholdEntrypoint.sol` (B.2 — 3-of-5 ASP root quorum gateway)
**Script:** `script/DeployThresholdEntrypoint.s.sol`
**Companion docs:**
- `docs/governance/signer-candidates-2026-05-31.md` (recruitment plan)
- `docs/governance/signer-memo-of-understanding-2026-05-31.md` (MoU)
- `docs/governance.md` (live address goes here after deploy)

---

## Recommended invocation

Use the wrapper — it inspects argv and auto-sets the right `FOUNDRY_PROFILE`,
so you can't forget the `threshold` profile when running anything that targets
the deploy test in `zbase-protocol/pkg/contracts/test/`.

```bash
# Easier: auto-picks the right profile
./scripts/forge-wrap.sh test --match-contract DeployThresholdEntrypoint -vv

# Manual equivalent
FOUNDRY_PROFILE=threshold forge test --match-contract DeployThresholdEntrypoint -vv
```

First-time setup: `chmod +x scripts/forge-wrap.sh` (one-time). The wrapper
echoes the chosen profile to stderr so you can confirm routing at a glance.

---

## Foundry profile note (read first)

The repo's `foundry.toml` lives at the **repo root** and uses:

```toml
src = "contracts"
test = "contracts/test"
remappings = ["@zbase-protocol/=zbase-protocol/pkg/contracts/src/", ...]
```

The script + test files in `zbase-protocol/pkg/contracts/script` and
`zbase-protocol/pkg/contracts/test` are **not** auto-discovered by `forge build`
under the default profile. Two options to run them:

**Option A — symlink (recommended for first deploy):**
```bash
ln -s zbase-protocol/pkg/contracts/script script-threshold
ln -s zbase-protocol/pkg/contracts/test/DeployThresholdEntrypoint.t.sol \
      contracts/test/DeployThresholdEntrypoint.t.sol
forge script script-threshold/DeployThresholdEntrypoint.s.sol:DeployThresholdEntrypoint ...
```

**Option B — extend foundry.toml `script`/`test` paths:**
```toml
script = ["zbase-protocol/pkg/contracts/script"]
test   = ["contracts/test", "zbase-protocol/pkg/contracts/test"]
```

Pick whichever you prefer; both work. The Solidity imports use the existing
`@zbase-protocol/contracts/` remapping so the files compile without further
config changes.

---

## Pre-flight checklist

Tick every box before running `--broadcast`. This contract is **immutable** —
you cannot fix a typo by re-keying. Mistakes mean redeploy + role migration.

### Signer recruitment (gating)
- [ ] All 5 signers identified per `docs/governance/signer-candidates-2026-05-31.md`
      (recommended order: Soleimani → Kassandra → Wong → Cutler → Eesheng)
- [ ] Each signer has returned a counter-signed MoU
      (`docs/governance/signer-memo-of-understanding-2026-05-31.md`)
- [ ] Each signer has confirmed control of the EOA they want bound in (test
      signature over an out-of-band challenge string — see MoU §3)
- [ ] Each EOA is **distinct** (5 unique addresses, no shared HD seed)
- [ ] Each signer has agreed to the operational SLA (response window for root
      attestations) documented in `docs/governance.md §4`
- [ ] No signer is the deployer address (separation of concerns: deployer has
      no on-chain power post-deploy, but cultural hygiene matters)

### Environment
- [ ] `BASE_SEPOLIA_RPC` env set (or `BASE_RPC` for mainnet later)
- [ ] `DEPLOYER_PRIVATE_KEY` set to a **freshly funded** key — never reuse a
      key that has signed anything else; this key has no role after deploy but
      its tx appears in the deployment trail forever
- [ ] Deployer has >= 0.01 ETH on the target chain
- [ ] `BASESCAN_API_KEY` exported (for `--verify`)
- [ ] All 5 `THRESHOLD_SIGNER_N` env vars set:

```bash
export THRESHOLD_SIGNER_1=0x...  # signer 1 (e.g. Soleimani)
export THRESHOLD_SIGNER_2=0x...  # signer 2 (e.g. Kassandra)
export THRESHOLD_SIGNER_3=0x...  # signer 3 (e.g. Wong)
export THRESHOLD_SIGNER_4=0x...  # signer 4 (e.g. Cutler)
export THRESHOLD_SIGNER_5=0x...  # signer 5 (Eesheng)
```

- [ ] (Optional) `DOWNSTREAM_ENTRYPOINT` set if forwarding to the live 0xbow
      Entrypoint. For v0 stand-alone mode (per the B.2 plan note), leave unset.

---

## Dry run (no broadcast)

Always do this first. Confirms env vars resolve and constructor checks pass:

```bash
forge script script/DeployThresholdEntrypoint.s.sol:DeployThresholdEntrypoint \
    --rpc-url $BASE_SEPOLIA_RPC
```

Expected log:

```
=== DeployThresholdEntrypoint :: preflight ===
Deployer:         0x...
Chain ID:         84532
Threshold:        3
Signer count:     5
Signer 1:         0x...
...
Signer 5:         0x...
Downstream:       0x0000000000000000000000000000000000000000
  (stand-alone mode: no forwarding to a live Entrypoint)
================================================
```

If any signer logs as `0x0000...0000` or two log the same address, **STOP**
and re-export the missing/duplicated env var.

---

## Broadcast

```bash
forge script script/DeployThresholdEntrypoint.s.sol:DeployThresholdEntrypoint \
    --rpc-url $BASE_SEPOLIA_RPC \
    --broadcast \
    --verify
```

### Expected gas

Constructor cost is dominated by:
- 5 × `address` SSTORE into `THRESHOLD_SIGNERS[0..4]` (~22k each, ~110k total)
- 1 × `address` SSTORE into `downstream` immutable (folded into bytecode — ~0)
- Contract bytecode deploy (~200 LOC of solc 0.8.20 output, ~200k gas)
- Constructor input-validation loops over 5 signers (negligible, <20k)

**Estimate: 350k–450k gas.** At Base Sepolia base fee ~0.01 gwei this is
< $0.0001. At Base mainnet ~0.05 gwei base fee this is still < $0.01.

If forge estimates significantly higher (>1M gas), abort — something has been
changed in the contract since this runbook was written.

---

## Post-flight

### Immediate (< 5 minutes)
- [ ] BaseScan shows the contract verified (`--verify` should auto-handle this;
      if it fails, run `forge verify-contract --watch --chain base-sepolia
      <address> ThresholdEntrypoint`)
- [ ] On BaseScan, read `getSigners()` — confirm all 5 addresses match the
      env vars you exported
- [ ] On BaseScan, read `THRESHOLD()` → 3, `SIGNER_COUNT()` → 5, `nonce()` → 0
- [ ] Copy the deployed address into `.env.local` (script prints the exact line)

### Same day
- [ ] Post the deploy tx hash + deployed address in `STATUS.md` under
      "Threshold Entrypoint live"
- [ ] Update `docs/governance.md` — replace `TBD` for the live address; list
      the 5 signer addresses + the BaseScan link
- [ ] Update `src/app/api/asp-update/route.ts` — switch the root update call
      from the legacy single-key Entrypoint
      (`0x598ffaac79ae29b1aae571fd91899d4492183688`) to the new
      `ThresholdEntrypoint` address (or wire as additional listener if running
      both during cutover)
- [ ] Update `CLAUDE.md` "Deployed Contracts (Base Sepolia)" section to include
      the new ThresholdEntrypoint address
- [ ] Each signer pings their bonded key once via the off-chain coordinator
      (`scripts/threshold-postman/`) to confirm signing path works end-to-end

### Within the week
- [ ] Schedule the first live root submission (3-of-5) as a dress rehearsal
      with a known/intended root, not real ASP data
- [ ] If a downstream Entrypoint is wired in, separately grant the
      `POSTMAN_ROLE` on the live 0xbow Entrypoint to the new contract
      (`AccessControl.grantRole(POSTMAN_ROLE, <ThresholdEntrypoint address>)`)
      and then revoke from the EOA postman once a successful forward is
      observed

---

## Rollback

**There is no in-place rollback.** The contract is immutable: the 5 signer
addresses are baked into storage at deploy time and cannot be rotated, added
to, or removed. If you need to change the signer set or the threshold (e.g.
a signer leaks a key), the only path is:

1. Deploy a **new** `ThresholdEntrypoint` with the corrected signer set.
2. Pause root publishing on the old contract by off-chain agreement among the
   signers (they simply stop signing).
3. Migrate ASP root authority:
   - If `downstream` is set on the old contract and points at the live
     0xbow Entrypoint, **revoke** `POSTMAN_ROLE` from the old contract and
     **grant** it to the new one (single tx from the role admin).
   - If running stand-alone, update `src/app/api/asp-update/route.ts` to read
     `latestRoot` from the new address.
4. Re-issue the most recent good root on the new contract (signed by the
     new quorum).
5. Update `docs/governance.md` with the new live address, BaseScan link, and
   the post-mortem note explaining why the old one was retired.

The old contract continues to exist on-chain forever but becomes inert (no
signer ever submits to it again).

---

## Test (offline)

Before any mainnet deploy, the bundled test simulates the script with mock
signer env vars and asserts the deployed contract has the correct 5 signers
+ threshold of 3:

```bash
forge test --match-contract DeployThresholdEntrypointTest -vv
```

(After symlinking per the Foundry profile note above, or with the extended
`test` paths config.)

This test is what gives you confidence the script wires env vars into the
constructor correctly. It does NOT test the recruited signers' keys — that
is the signer's responsibility, validated via the MoU §3 challenge signature.
