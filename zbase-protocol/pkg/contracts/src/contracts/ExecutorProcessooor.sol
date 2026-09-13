// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/*//////////////////////////////////////////////////////////////
                    0xbow ABI-EXACT TYPES (top-level)
//////////////////////////////////////////////////////////////*/

/// @dev Mirrors 0xbow IPrivacyPool.Withdrawal EXACTLY (ABI-critical). Declared locally
///      (not imported) so the executor is self-contained and free of the vendored 0xbow
///      dependency tree / solc-0.8.28 coupling. Struct layout must equal the deployed ABI.
struct Withdrawal {
    address processooor;
    bytes data;
}

/// @dev Mirrors 0xbow ProofLib.WithdrawProof EXACTLY. context = pubSignals[7],
///      withdrawnValue = pubSignals[2], existingNullifierHash = pubSignals[1].
struct WithdrawProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[8] pubSignals;
}

/// @notice The call plan encoded into `Withdrawal.data` and thus bound by `context`.
/// @dev AUDIT-D (2026-07-09): FIELD ORDER IS ABI-CRITICAL AND CROSS-LANGUAGE. The server
///      re-encodes this exact tuple in the SAME order in
///      `src/app/api/withdraw/route.ts` (the `data`/callPlan encode). Reordering these
///      fields here WITHOUT updating that route (or vice-versa) makes every honest
///      withdrawal fail `ContextMismatch` (fail-closed — no fund loss, but a total
///      liveness break). Keep the two in lock-step; treat as a shared ABI.
struct ExecPlan {
    address callTarget; // whitelisted contract to call (e.g. an ERC-4626 vault)
    address inputToken; // the pool asset (USDC) pushed to this executor
    address outputToken; // token the call yields (vault shares / swap out)
    uint256 minOut; // slippage floor on outputToken delta
    address finalRecipient; // who receives the outputToken
    address feeRecipient; // zBase treasury
    uint256 relayFeeBPS; // take on the withdrawn input
    bytes callData; // exact calldata for callTarget
}

/// @notice Minimal ABI-exact interface for 0xbow PrivacyPool. Self-contained.
///         ASSET()/SCOPE() are 0xbow IState getters (view) used to validate the plan
///         against the pool's real immutable asset + scope (audit F3/F4).
interface IPrivacyPoolLike {
    function withdraw(Withdrawal memory w, WithdrawProof memory p) external;
    function ASSET() external view returns (address);
    function SCOPE() external view returns (uint256);
}

/**
 * @title ExecutorProcessooor
 * @notice Layer-2 "private-funded DeFi access" executor for zBase.
 *
 * WHAT THIS SOLVES
 * ----------------
 * 0xbow's PrivacyPool `withdraw(Withdrawal{processooor, data}, proof)` pushes the
 * withdrawn funds to `withdrawal.processooor` and binds the ENTIRE `withdrawal`
 * (processooor + data) into the proof's `context` public signal:
 *     context = keccak256(abi.encode(withdrawal, scope)) % SNARK_SCALAR_FIELD
 * The pool's `withdraw()` is guarded ONLY by `validWithdrawal` — it checks
 * `msg.sender == withdrawal.processooor` and the context match; it is NOT
 * `onlyEntrypoint`. So a contract can name ITSELF as processooor, call
 * `pool.withdraw()` directly, receive the `_push`ed funds, and spend them into a
 * whitelisted call — all while the ZK proof cryptographically binds the call plan.
 * No circuit recompile, no ceremony: the frozen 8-signal circuit only proves
 * knowledge of `context`, and `context` already commits to `data`.
 *
 * This is Railgun's `RelayAdapt`/`adaptParams` pattern, applied to 0xbow.
 *
 * NAME NOTE: the triple-`o` echoes 0xbow's on-chain `processooor` struct field
 * (immutable ABI). This contract *sets itself as* that processooor.
 *
 * SECURITY MODEL (enforced as require()s / custom errors in executeFromPool):
 *  1. withdrawal.processooor == address(this)
 *  2. RE-DERIVE keccak256(abi.encode(withdrawal, scope)) % FIELD == proof.context
 *     — makes the relayer trustless: it cannot alter target/calldata/minOut/recipient.
 *  3. callData >= 4 bytes; callTarget + selector whitelisted (frozen at construction).
 *  4. inputToken == pool.ASSET() (F3) and inputToken != outputToken (F5) and minOut > 0 (F1/F2).
 *  5. pool.withdraw spends the nullifier BEFORE pushing funds (reentrant double-spend dead);
 *     withdrawn > 0.
 *  6. nonReentrant on the whole call. approve-exact -> call -> zero-approve, atomically.
 *  7. outDelta > 0 (F1/F2: the call MUST produce measurable output on the executor's
 *     balance — a call routing value elsewhere reverts) AND outDelta >= minOut (slippage).
 *     Together these force value back through the finalRecipient sweep: the whitelisted
 *     call's beneficiary must be THIS executor, else outDelta == 0 and it reverts.
 *  8. sweep outDelta to finalRecipient.
 *  9. NO residual token balance AND NO residual approval left behind (honeypot defense).
 * 10. Immutable: no owner, no upgrade, no admin fund-move. Whitelist frozen in constructor.
 *
 * SCOPE OF THE GUARANTEE: this hides WHO funded the call (unlinkable), not WHAT the call
 * does (public). It does NOT vet the whitelisted target's own logic — a whitelisted target
 * is TRUSTED to be a well-behaved standard-token protocol (non-rebasing, non-fee-on-transfer;
 * F5-adjacent). Whitelist only audited, standard targets. See the zBase threat model.
 */
contract ExecutorProcessooor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice bn254 scalar field — the pool reduces context mod this. Must match 0xbow.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice Max relay fee, mirrors the pool's guard. 10% hard cap.
    uint256 public constant MAX_RELAY_FEE_BPS = 1000;

    /// @notice Whitelisted (callTarget => allowed) — frozen at construction.
    mapping(address => bool) public isWhitelistedTarget;

    /// @notice Whitelisted (callTarget => selector => allowed) — frozen at construction.
    mapping(address => mapping(bytes4 => bool)) public isWhitelistedSelector;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event PrivateCallExecuted(
        address indexed callTarget,
        address indexed finalRecipient,
        address inputToken,
        address outputToken,
        uint256 inputSpent,
        uint256 outputSwept,
        uint256 fee
    );

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotSelfProcessooor();
    error ContextMismatch();
    error TargetNotWhitelisted();
    error SelectorNotWhitelisted();
    error RelayFeeTooHigh();
    error CallReverted();
    error SlippageTooHigh(); // outputDelta < minOut
    error ResidualInput(); // executor kept input tokens (must be 0)
    error ResidualOutput(); // executor kept output tokens (must be 0)
    error ResidualApproval(); // executor left a standing approval (must be 0)
    error EmptyWhitelist();
    error ZeroAddress();
    error LengthMismatch();
    error ZeroSelector(); // F6: selector 0x00000000 must not be whitelisted
    error CalldataTooShort(); // F6: callData must carry a full 4-byte selector
    error WrongInputToken(); // F3: inputToken must equal the pool's real ASSET
    error SameInOutToken(); // F5: inputToken == outputToken not supported (accounting)
    error ZeroMinOut(); // F1/F2: minOut must be > 0 so slippage/output is actually enforced
    error NoOutputProduced(); // F1/F2: a value-spending call must produce output
    error ZeroWithdrawn(); // withdrawn must be > 0 (fail-fast; base pool doesn't guard it)

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param targets    parallel array of whitelisted call targets
    /// @param selectors  parallel array of allowed 4-byte selectors (targets[i] => selectors[i])
    /// @dev Immutable after construction. To add a target, deploy a NEW executor.
    constructor(address[] memory targets, bytes4[] memory selectors) {
        if (targets.length == 0) revert EmptyWhitelist();
        if (targets.length != selectors.length) revert LengthMismatch();
        for (uint256 i; i < targets.length; ++i) {
            if (targets[i] == address(0)) revert ZeroAddress();
            if (selectors[i] == bytes4(0)) revert ZeroSelector(); // F6: no fallback/empty-calldata surface
            isWhitelistedTarget[targets[i]] = true;
            isWhitelistedSelector[targets[i]][selectors[i]] = true;
        }
    }

    /*//////////////////////////////////////////////////////////////
                           CORE ENTRYPOINT
    //////////////////////////////////////////////////////////////*/

    /// @notice Pull funds out of the pool (to this contract) and execute the bound call.
    /// @param pool  the 0xbow PrivacyPool (called directly; this contract is the processooor)
    /// @param w     the withdrawal naming THIS contract as processooor, carrying an ExecPlan in data
    /// @param proof the Groth16 withdrawal proof (context binds `w`)
    /// @param scope the pool scope (part of the context preimage)
    function executeFromPool(IPrivacyPoolLike pool, Withdrawal calldata w, WithdrawProof calldata proof, uint256 scope)
        external
        nonReentrant
    {
        // (1) this contract must be the named processooor.
        if (w.processooor != address(this)) revert NotSelfProcessooor();

        // (1b) AUDIT-B (2026-07-09): fail-fast scope check. The pool independently
        //      re-derives context against its OWN immutable SCOPE (validWithdrawal), so a
        //      wrong `scope` is already a safe no-op (pool reverts, nullifier not spent).
        //      But asserting it here removes the reliance on the pool as the SOLE backstop
        //      and turns a silent pool-side ContextMismatch into a clear executor-side one.
        if (scope != pool.SCOPE()) revert ContextMismatch();

        // (2) ★ trustless-relayer invariant: re-derive context and require it matches
        //     the proof. A relayer cannot alter the ExecPlan (target/calldata/minOut/
        //     recipient) without breaking this. This is the whole security story.
        uint256 derived = uint256(keccak256(abi.encode(w, scope))) % SNARK_SCALAR_FIELD;
        if (derived != proof.pubSignals[7]) revert ContextMismatch();

        ExecPlan memory p = abi.decode(w.data, (ExecPlan));

        // (3) target + selector must be whitelisted (frozen at construction).
        //     F6: reject sub-selector calldata so a whitelisted target can't be hit
        //     with empty/fallback data.
        if (p.callData.length < 4) revert CalldataTooShort();
        if (!isWhitelistedTarget[p.callTarget]) revert TargetNotWhitelisted();
        if (!isWhitelistedSelector[p.callTarget][_selectorOf(p.callData)]) {
            revert SelectorNotWhitelisted();
        }

        // (3b) F3: inputToken MUST equal the pool's real immutable asset. Otherwise the
        //      pool pushes USDC while accounting reads a different token → withdrawn=0 and
        //      the real USDC is permanently stranded (nullifier already spent). Fail fast.
        if (p.inputToken != pool.ASSET()) revert WrongInputToken();
        // (3c) F5: same-token in/out breaks the two-snapshot residual accounting. Unsupported.
        if (p.inputToken == p.outputToken) revert SameInOutToken();
        // (3d) F1/F2: a zero slippage floor lets a value-consuming call that produces no
        //      measurable output "succeed" silently (funds gone, recipient gets nothing).
        //      Require a real floor; outDelta >= minOut > 0 is then enforced below.
        if (p.minOut == 0) revert ZeroMinOut();

        // (6a) fee guard.
        if (p.relayFeeBPS > MAX_RELAY_FEE_BPS) revert RelayFeeTooHigh();

        IERC20 inToken = IERC20(p.inputToken);
        IERC20 outToken = IERC20(p.outputToken);

        // Snapshot balances BEFORE the pool push so accounting is exact regardless of dust.
        uint256 inBefore = inToken.balanceOf(address(this));
        uint256 outBefore = outToken.balanceOf(address(this));

        // (4) pull funds from the pool. The pool verifies the Groth16 proof, spends the
        //     nullifier BEFORE _push (double-spend/reentrancy dead by construction),
        //     inserts the change commitment, and transfers withdrawnValue to us.
        pool.withdraw(w, proof);

        uint256 withdrawn = inToken.balanceOf(address(this)) - inBefore;
        if (withdrawn == 0) revert ZeroWithdrawn(); // base pool doesn't guard 0; we do

        // (6) fee split on the withdrawn input.
        uint256 fee = (withdrawn * p.relayFeeBPS) / 10_000;
        uint256 spendAmount = withdrawn - fee;
        if (fee > 0) inToken.safeTransfer(p.feeRecipient, fee);

        // (6b) approve-exact -> call -> zero-approve, atomically.
        inToken.forceApprove(p.callTarget, spendAmount);
        (bool ok,) = p.callTarget.call(p.callData);
        if (!ok) revert CallReverted();
        inToken.forceApprove(p.callTarget, 0);

        // (7) slippage floor on the produced output. F1/F2: outDelta MUST be > 0 (a
        //     value-spending call that yields no measurable output on the declared
        //     outputToken is a silent failure — the beneficiary got nothing here).
        //     With minOut > 0 enforced above, `outDelta >= minOut` already implies > 0,
        //     but we assert it explicitly for clarity and defense.
        uint256 outDelta = outToken.balanceOf(address(this)) - outBefore;
        if (outDelta == 0) revert NoOutputProduced();
        if (outDelta < p.minOut) revert SlippageTooHigh();

        // (8) sweep output to the bound recipient.
        outToken.safeTransfer(p.finalRecipient, outDelta);

        // (8b) AUDIT-A (2026-07-09): refund residual INPUT instead of reverting.
        //      Many legitimate, standard, non-malicious targets pull LESS than the full
        //      approved `spendAmount` (ERC-4626 share-rounding, exact-out routers,
        //      "spend up to N" patterns). Previously any such under-consumption tripped
        //      `ResidualInput` and reverted a VALID withdrawal (a liveness DoS across a
        //      broad target class — never a fund-loss, since the nullifier spend rolls
        //      back atomically, but it narrowed the safe whitelist far below "standard
        //      token protocol"). Instead, sweep the leftover input to `finalRecipient`.
        //      This preserves the theft defense (the executor STILL ends at `inBefore`,
        //      asserted below), strands nothing, and widens the usable target set.
        //      `finalRecipient` is context-bound, so a relayer cannot redirect the refund.
        uint256 inNow = inToken.balanceOf(address(this));
        if (inNow > inBefore) {
            inToken.safeTransfer(p.finalRecipient, inNow - inBefore);
        }

        // (9) honeypot defense: no residual balance, no standing approval. After (8b) the
        //     input balance must be back to `inBefore`; a remaining discrepancy (e.g. a
        //     fee-on-transfer input token that shorted the refund) still fails closed here.
        if (inToken.balanceOf(address(this)) != inBefore) revert ResidualInput();
        if (outToken.balanceOf(address(this)) != outBefore) revert ResidualOutput();
        if (inToken.allowance(address(this), p.callTarget) != 0) revert ResidualApproval();

        emit PrivateCallExecuted(
            p.callTarget, p.finalRecipient, p.inputToken, p.outputToken, spendAmount, outDelta, fee
        );
    }

    /*//////////////////////////////////////////////////////////////
                               HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev First 4 bytes of calldata; 0x00000000 if shorter than a selector.
    function _selectorOf(bytes memory data) internal pure returns (bytes4 sel) {
        if (data.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(data, 0x20))
        }
    }
}
