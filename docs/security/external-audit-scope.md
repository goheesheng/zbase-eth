# External Audit Scope — ExecutorProcessooor (C1)

**Prepared:** 2026-07-09 · **For:** a third-party smart-contract audit firm ·
**Contact:** DM @zbase__ (brand channel)

This is the scope package to hand an audit firm for the **C1 gate**
(`MAINNET_READINESS.md`): an external audit of the deployed fund-holding contract
before real money on mainnet. It exists to get an accurate quote fast — the
contract is small, self-contained, and already internally reviewed, so an external
firm starts from a clean, findings-fixed baseline.

## 1. What needs auditing (and what does NOT)

**IN SCOPE — the one custom, fund-holding contract:**

| File | LOC | Role |
|------|-----|------|
| `zbase-protocol/pkg/contracts/src/contracts/ExecutorProcessooor.sol` | 309 | Withdraws from the 0xbow pool (naming itself processooor), spends the funds into a whitelisted call, sweeps output to a bound recipient. Immutable, no owner, frozen whitelist. |
| `zbase-protocol/pkg/contracts/script/DeployExecutorProcessooor.s.sol` | 120 | Deploy script (frozen whitelist construction) — review the constructor args / whitelist discipline. |

**OUT OF SCOPE — inherits upstream audits, do not re-audit:**
- The **0xbow PrivacyPool / Entrypoint / verifiers** (`vendor/0xbow/*`) — audited
  upstream (ChainSecurity, Trail of Bits). The executor treats the pool as a
  trusted, audited dependency and only calls its public `withdraw()`/`ASSET()`/`SCOPE()`.
- Off-chain code (relayer, API routes) — not fund-custody contracts.
- UTXO / ThresholdEntrypoint / Morpho — not deployed on the mainnet single-value path.

**Total custom on-chain surface to audit: ~309 LOC + a 120-LOC deploy script.**
This is deliberately tiny — the whole design goal was to add private-funded DeFi
access WITHOUT a new pool or circuit.

## 2. The security model to verify (the core claim)

The executor's entire safety rests on **one invariant**: a malicious relayer
cannot alter the call plan, because the plan is bound into the ZK proof's context.

```
context = keccak256(abi.encode(Withdrawal{processooor, data}, scope)) % SNARK_FIELD
data    = abi.encode(ExecPlan{callTarget, inputToken, outputToken, minOut,
                              finalRecipient, feeRecipient, relayFeeBPS, callData})
```

The contract re-derives this and requires it equals `proof.pubSignals[7]`; the pool
independently re-checks against its own immutable `SCOPE`. **The auditor should
confirm every fund-directing field is inside that preimage** (our internal review
found all 8 are, including `feeRecipient`), and that the Groth16 verifier binds
`pubSignals[7]` so it can't be swapped.

## 3. Deployed instance to audit

- **ExecutorProcessooor (FIXED):** `0x58a27688A086f8E429Dbf294B0d12FC12623aC25` (Base Sepolia)
- Source is in-repo (path above); **the live Sepolia pool is not BaseScan-verified**,
  so source-of-truth is this repo, not the explorer.
- The mainnet instance does not exist yet — the deploy is gated on this audit
  (D1 hard-blocks chainid 8453 in the deploy script until the block is removed).

## 4. Internal review already done (start from here)

Two internal adversarial passes have run; the external firm inherits a clean base:

- **3-angle adversarial review (2026-07-09):** fund-theft (12 executable PoCs),
  ERC-20/accounting, proof-binding. **No CRITICAL/HIGH fund-theft.** Findings fixed:
  - **Residual-input DoS (Medium):** a target consuming < the full approval used to
    revert valid withdrawals; now refunds the residual to the bound recipient.
  - **Fail-fast scope check (Low)** + **struct-sync comment (Info).**
- Proof-binding confirmed **sound** (all fund-directing fields bound).
- Reproducible via `docs/security/adversarial-audit-harness.md`.

**Known residual items for the auditor to weigh (design choices, not bugs):**
- No `msg.sender` gate — a front-runner can submit a bound bundle, but funds still
  go to the context-bound recipient (griefs the relayer's gas, no theft). Confirm.
- Immutable / no rescue — accidentally-sent tokens are unrecoverable (deliberate
  honeypot defense). Confirm this is acceptable.
- **Whitelist trust:** the executor trusts whitelisted targets to be well-behaved
  standard tokens (non-rebasing, non-fee-on-transfer). The audit should stress the
  whitelist-discipline requirement, and we should whitelist only audited targets.

## 5. What we're asking the firm for

1. Confirm (or refute) the context-binding invariant and the no-fund-theft finding.
2. Independently exercise the ERC-20 edge cases (fee-on-transfer, rebasing,
   USDC-blocklist atomicity, partial-consume) against the refund fix.
3. Review the deploy script's whitelist construction + constructor safety.
4. A written report we can cite for the C1 gate.

## 6. Build + test to reproduce

```
FOUNDRY_PROFILE=vendor forge build
forge test --match-contract ExecutorProcessooor -vv    # 21 tests
bash scripts/audit-regression.sh                        # full 62-test fund-safety suite
```

## 7. Suggested firms (from prior research)

Firms already in the zBase competitive/ecosystem notes as credible for this class:
ChainSecurity or Trail of Bits (audited 0xbow upstream — continuity), Zellic,
Spearbit/Cantina, or OtterSec (Solana-adjacent if the SVM side is later added).
The tiny surface (~309 LOC) should make this a low-cost, fast engagement.
