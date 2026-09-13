// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {
    ExecutorProcessooor,
    Withdrawal,
    WithdrawProof,
    ExecPlan,
    IPrivacyPoolLike
} from "@zbase-protocol/contracts/ExecutorProcessooor.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/*//////////////////////////////////////////////////////////////
                              MOCKS
//////////////////////////////////////////////////////////////*/

/// @notice Faithful stand-in for 0xbow PrivacyPool for the security-relevant behavior:
///  - reverts unless msg.sender == w.processooor (validWithdrawal caller check)
///  - marks the nullifier spent BEFORE pushing funds (double-spend / reentrancy defense)
///  - transfers withdrawnValue (pubSignals[2]) of the pool asset to the processooor
/// It does NOT verify the Groth16 proof or the context — the EXECUTOR is what binds
/// context; the pool trusts the proof. This mirrors the real trust split.
contract MockPrivacyPool is IPrivacyPoolLike {
    IERC20 public immutable asset;
    mapping(uint256 => bool) public nullifierSpent;

    error NotProcessooor();
    error AlreadySpent();

    uint256 public constant POOL_SCOPE = 42; // mirrors the test's SCOPE

    constructor(IERC20 _asset) {
        asset = _asset;
    }

    function ASSET() external view override returns (address) {
        return address(asset);
    }

    function SCOPE() external pure override returns (uint256) {
        return POOL_SCOPE;
    }

    function withdraw(Withdrawal memory w, WithdrawProof memory p) external override {
        if (msg.sender != w.processooor) revert NotProcessooor();
        uint256 nullifier = p.pubSignals[1];
        if (nullifierSpent[nullifier]) revert AlreadySpent(); // spend-before-push
        nullifierSpent[nullifier] = true;
        uint256 value = p.pubSignals[2];
        asset.transfer(w.processooor, value); // _push to processooor
    }
}

/// @notice Minimal ERC-4626-shaped vault: pulls `assets` of underlying, mints 1:1 "shares"
///         (a separate MockUSDC acting as the share token) to `receiver`.
contract MockVault4626 {
    IERC20 public immutable asset; // underlying (USDC)
    MockUSDC public immutable shareToken; // output token minted to receiver

    constructor(IERC20 _asset, MockUSDC _shareToken) {
        asset = _asset;
        shareToken = _shareToken;
    }

    /// @dev ERC-4626 deposit(assets, receiver). Selector 0x6e553f65.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        asset.transferFrom(msg.sender, address(this), assets);
        shareToken.mint(receiver, assets); // 1:1
        return assets;
    }
}

/// @notice A malicious "vault" that tries to reenter the executor during its deposit call.
contract ReentrantVault {
    IERC20 public immutable asset;
    MockUSDC public immutable shareToken;
    ExecutorProcessooor public executor;
    IPrivacyPoolLike public pool;
    Withdrawal internal reentryW;
    WithdrawProof internal reentryProof;
    uint256 internal reentryScope;
    bool public armed;

    constructor(IERC20 _asset, MockUSDC _shareToken) {
        asset = _asset;
        shareToken = _shareToken;
    }

    function arm(
        ExecutorProcessooor _executor,
        IPrivacyPoolLike _pool,
        Withdrawal calldata _w,
        WithdrawProof calldata _proof,
        uint256 _scope
    ) external {
        executor = _executor;
        pool = _pool;
        reentryW = _w;
        reentryProof = _proof;
        reentryScope = _scope;
        armed = true;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        asset.transferFrom(msg.sender, address(this), assets);
        shareToken.mint(receiver, assets);
        if (armed) {
            armed = false;
            // Attempt reentry — must be blocked by nonReentrant.
            executor.executeFromPool(pool, reentryW, reentryProof, reentryScope);
        }
        return assets;
    }
}

/// @notice A vault that leaves a token dangling in the executor (to trip ResidualOutput)
///         by minting FEWER shares than expected is not the residual case; instead this
///         one mints the output to the EXECUTOR rather than the receiver-of-record path.
///         We test residual by having the vault NOT pull the full approved input.
contract UnderspendVault {
    IERC20 public immutable asset;
    MockUSDC public immutable shareToken;

    constructor(IERC20 _asset, MockUSDC _shareToken) {
        asset = _asset;
        shareToken = _shareToken;
    }

    /// @dev Pulls LESS than `assets` — leaves input dust in the executor => ResidualInput.
    function deposit(uint256 assets, address receiver) external returns (uint256) {
        uint256 short = assets - 1; // leave 1 wei behind
        asset.transferFrom(msg.sender, address(this), short);
        shareToken.mint(receiver, short);
        return short;
    }
}

/// @notice Minimal Uniswap-V3-shaped swap router. `exactInputSingle` pulls `amountIn` of
///         tokenIn from the caller and mints `amountIn * rateBps / 10000` of tokenOut to
///         `params.recipient` (which — per audit F1 — must be the executor, so the executor
///         measures its own outDelta and sweeps). Selector 0x04e45aaf.
contract MockRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    uint256 public rateBps = 10_000; // 1:1 by default; settable to simulate price/slippage

    function setRate(uint256 _rateBps) external {
        rateBps = _rateBps;
    }

    /// @dev exactInputSingle(params) — selector 0x04e45aaf.
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = (params.amountIn * rateBps) / 10_000;
        MockUSDC(params.tokenOut).mint(params.recipient, amountOut);
        require(amountOut >= params.amountOutMinimum, "router: slippage");
        return amountOut;
    }
}

/*//////////////////////////////////////////////////////////////
                              TESTS
//////////////////////////////////////////////////////////////*/

contract ExecutorProcessooorTest is Test {
    ExecutorProcessooor internal executor;
    MockPrivacyPool internal pool;
    MockUSDC internal usdc; // input token (pool asset)
    MockUSDC internal shareToken; // output token (vault shares)
    MockVault4626 internal vault;

    address internal treasury = address(0xFEE);
    address internal recipient = address(0xBEEF);
    uint256 internal constant SCOPE = 42;
    uint256 internal constant WITHDRAW_VALUE = 1_000_000; // 1 USDC (6dp)
    uint256 internal constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ERC-4626 deposit(uint256,address) selector.
    bytes4 internal constant DEPOSIT_SEL = bytes4(keccak256("deposit(uint256,address)"));

    function setUp() public {
        usdc = new MockUSDC();
        shareToken = new MockUSDC();
        pool = new MockPrivacyPool(IERC20(address(usdc)));
        vault = new MockVault4626(IERC20(address(usdc)), shareToken);

        address[] memory targets = new address[](1);
        bytes4[] memory sels = new bytes4[](1);
        targets[0] = address(vault);
        sels[0] = DEPOSIT_SEL;
        executor = new ExecutorProcessooor(targets, sels);

        // Fund the pool so it can push on withdraw.
        usdc.mint(address(pool), 100_000_000);
    }

    /*//////////////////////// helpers ////////////////////////*/

    /// @dev Build an ExecPlan whose callData deposits `spend` into the vault, output to `recipient`.
    function _plan(uint256 relayFeeBPS, uint256 minOut) internal view returns (ExecPlan memory p) {
        uint256 fee = (WITHDRAW_VALUE * relayFeeBPS) / 10_000;
        uint256 spend = WITHDRAW_VALUE - fee;
        p = ExecPlan({
            callTarget: address(vault),
            inputToken: address(usdc),
            outputToken: address(shareToken),
            minOut: minOut,
            finalRecipient: recipient,
            feeRecipient: treasury,
            relayFeeBPS: relayFeeBPS,
            callData: abi.encodeWithSelector(DEPOSIT_SEL, spend, address(executor))
        });
    }

    /// @dev Assemble a Withdrawal + a proof whose context correctly binds (w, SCOPE).
    function _withdrawalAndProof(ExecPlan memory p, uint256 nullifier)
        internal
        view
        returns (Withdrawal memory w, WithdrawProof memory proof)
    {
        w = Withdrawal({processooor: address(executor), data: abi.encode(p)});
        uint256 ctx = uint256(keccak256(abi.encode(w, SCOPE))) % SNARK_FIELD;
        uint256[8] memory sig;
        sig[1] = nullifier; // existingNullifierHash
        sig[2] = WITHDRAW_VALUE; // withdrawnValue
        sig[7] = ctx; // context
        proof = WithdrawProof({pA: [uint256(0), 0], pB: [[uint256(0), 0], [uint256(0), 0]], pC: [uint256(0), 0], pubSignals: sig});
    }

    /*//////////////////////// 0. happy path ////////////////////////*/

    function test_HappyPath_DepositsAndSweeps() public {
        ExecPlan memory p = _plan(100, 1); // 1% fee, minOut=1 (vault mints 1:1 so output=spend)
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 1);
        uint256 fee = (WITHDRAW_VALUE * 100) / 10_000;
        uint256 spend = WITHDRAW_VALUE - fee;

        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);

        assertEq(shareToken.balanceOf(recipient), spend, "recipient gets shares");
        assertEq(usdc.balanceOf(treasury), fee, "treasury gets fee");
        assertEq(usdc.balanceOf(address(executor)), 0, "no residual input");
        assertEq(shareToken.balanceOf(address(executor)), 0, "no residual output");
        assertEq(usdc.allowance(address(executor), address(vault)), 0, "no residual approval");
    }

    /*//////////////////////// 1. context mismatch (redirect attack) ////////////////////////*/

    function test_Redirect_TamperRecipient_Reverts() public {
        ExecPlan memory p = _plan(0, 0);
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 1);
        // Attacker mutates the plan AFTER the proof's context was fixed: swap recipient.
        ExecPlan memory evil = abi.decode(w.data, (ExecPlan));
        evil.finalRecipient = address(0xBAD);
        w.data = abi.encode(evil); // context in `proof` no longer matches `w`
        vm.expectRevert(ExecutorProcessooor.ContextMismatch.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    function test_Redirect_TamperScope_Reverts() public {
        ExecPlan memory p = _plan(0, 0);
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 1);
        vm.expectRevert(ExecutorProcessooor.ContextMismatch.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE + 1);
    }

    /*//////////////////////// 2. reentrancy ////////////////////////*/

    function test_Reentrancy_Blocked() public {
        ReentrantVault evil = new ReentrantVault(IERC20(address(usdc)), shareToken);
        address[] memory targets = new address[](1);
        bytes4[] memory sels = new bytes4[](1);
        targets[0] = address(evil);
        sels[0] = DEPOSIT_SEL;
        ExecutorProcessooor ex2 = new ExecutorProcessooor(targets, sels);

        uint256 spend = WITHDRAW_VALUE;
        ExecPlan memory p = ExecPlan({
            callTarget: address(evil),
            inputToken: address(usdc),
            outputToken: address(shareToken),
            minOut: 1,
            finalRecipient: recipient,
            feeRecipient: treasury,
            relayFeeBPS: 0,
            callData: abi.encodeWithSelector(DEPOSIT_SEL, spend, address(ex2))
        });
        Withdrawal memory w = Withdrawal({processooor: address(ex2), data: abi.encode(p)});
        uint256 ctx = uint256(keccak256(abi.encode(w, SCOPE))) % SNARK_FIELD;
        uint256[8] memory sig;
        sig[1] = 7;
        sig[2] = WITHDRAW_VALUE;
        sig[7] = ctx;
        WithdrawProof memory proof =
            WithdrawProof({pA: [uint256(0), 0], pB: [[uint256(0), 0], [uint256(0), 0]], pC: [uint256(0), 0], pubSignals: sig});

        evil.arm(ex2, IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
        // The inner reentry hits ReentrancyGuard; the outer executor catches the failed
        // external call and surfaces CallReverted(). Asserting the EXACT outer error
        // proves the guard fired (verified in the trace: inner = ReentrancyGuardReentrantCall).
        vm.expectRevert(ExecutorProcessooor.CallReverted.selector);
        ex2.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
        // And the nullifier must NOT be consumed by a reverted attempt (atomic rollback).
        assertFalse(pool.nullifierSpent(7), "reverted reentry must not spend nullifier");
    }

    /*//////////////////////// 3. slippage bind ////////////////////////*/

    function test_Slippage_BelowMinOut_Reverts() public {
        // Vault mints 1:1, so out == spend. Require more than that => revert.
        ExecPlan memory p = _plan(0, WITHDRAW_VALUE + 1);
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 1);
        vm.expectRevert(ExecutorProcessooor.SlippageTooHigh.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /*//////////////////////// 4. residual input (honeypot) ////////////////////////*/

    /// AUDIT-A (2026-07-09): a target that pulls LESS than the full approved amount used to
    /// revert `ResidualInput` (a liveness DoS across ERC-4626/router targets). It now
    /// SUCCEEDS and refunds the leftover input to `finalRecipient`. The executor must still
    /// end EMPTY (theft defense preserved). `UnderspendVault` leaves exactly 1 wei behind.
    function test_Underspend_RefundsResidualInputToRecipient() public {
        UnderspendVault under = new UnderspendVault(IERC20(address(usdc)), shareToken);
        address[] memory targets = new address[](1);
        bytes4[] memory sels = new bytes4[](1);
        targets[0] = address(under);
        sels[0] = DEPOSIT_SEL;
        ExecutorProcessooor ex2 = new ExecutorProcessooor(targets, sels);

        uint256 spend = WITHDRAW_VALUE;
        ExecPlan memory p = ExecPlan({
            callTarget: address(under),
            inputToken: address(usdc),
            outputToken: address(shareToken),
            minOut: 1,
            finalRecipient: recipient,
            feeRecipient: treasury,
            relayFeeBPS: 0,
            callData: abi.encodeWithSelector(DEPOSIT_SEL, spend, address(ex2))
        });
        Withdrawal memory w = Withdrawal({processooor: address(ex2), data: abi.encode(p)});
        uint256 ctx = uint256(keccak256(abi.encode(w, SCOPE))) % SNARK_FIELD;
        uint256[8] memory sig;
        sig[1] = 9;
        sig[2] = WITHDRAW_VALUE;
        sig[7] = ctx;
        WithdrawProof memory proof =
            WithdrawProof({pA: [uint256(0), 0], pB: [[uint256(0), 0], [uint256(0), 0]], pC: [uint256(0), 0], pubSignals: sig});

        uint256 recipUsdcBefore = usdc.balanceOf(recipient);

        // Previously reverted; now succeeds.
        ex2.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);

        // The 1 wei the vault left behind is refunded to the recipient (context-bound).
        assertEq(usdc.balanceOf(recipient) - recipUsdcBefore, 1, "residual input not refunded");
        // The executor holds NO input token (theft/honeypot defense intact).
        assertEq(usdc.balanceOf(address(ex2)), 0, "executor retained input");
        // The recipient still got the output shares (spend - 1).
        assertEq(shareToken.balanceOf(recipient), spend - 1, "recipient missing shares");
    }

    /*//////////////////////// 5. non-whitelisted target ////////////////////////*/

    function test_NonWhitelistedTarget_Reverts() public {
        MockVault4626 rogue = new MockVault4626(IERC20(address(usdc)), shareToken);
        ExecPlan memory p = _plan(0, 0);
        p.callTarget = address(rogue); // not whitelisted
        Withdrawal memory w = Withdrawal({processooor: address(executor), data: abi.encode(p)});
        uint256 ctx = uint256(keccak256(abi.encode(w, SCOPE))) % SNARK_FIELD;
        uint256[8] memory sig;
        sig[2] = WITHDRAW_VALUE;
        sig[7] = ctx;
        WithdrawProof memory proof =
            WithdrawProof({pA: [uint256(0), 0], pB: [[uint256(0), 0], [uint256(0), 0]], pC: [uint256(0), 0], pubSignals: sig});
        vm.expectRevert(ExecutorProcessooor.TargetNotWhitelisted.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /*//////////////////////// 6. bad selector ////////////////////////*/

    function test_BadSelector_Reverts() public {
        ExecPlan memory p = _plan(0, 0);
        // Whitelisted target, but a selector that isn't allowed.
        p.callData = abi.encodeWithSelector(bytes4(keccak256("redeem(uint256,address,address)")), uint256(1), recipient, recipient);
        Withdrawal memory w = Withdrawal({processooor: address(executor), data: abi.encode(p)});
        uint256 ctx = uint256(keccak256(abi.encode(w, SCOPE))) % SNARK_FIELD;
        uint256[8] memory sig;
        sig[2] = WITHDRAW_VALUE;
        sig[7] = ctx;
        WithdrawProof memory proof =
            WithdrawProof({pA: [uint256(0), 0], pB: [[uint256(0), 0], [uint256(0), 0]], pC: [uint256(0), 0], pubSignals: sig});
        vm.expectRevert(ExecutorProcessooor.SelectorNotWhitelisted.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /*//////////////////////// 7. fee split ////////////////////////*/

    function test_FeeSplit_Exact() public {
        ExecPlan memory p = _plan(300, 1); // 3%, minOut=1
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 1);
        uint256 fee = (WITHDRAW_VALUE * 300) / 10_000;
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
        assertEq(usdc.balanceOf(treasury), fee, "treasury exact fee");
        assertEq(shareToken.balanceOf(recipient), WITHDRAW_VALUE - fee, "recipient exact");
    }

    function test_FeeTooHigh_Reverts() public {
        ExecPlan memory p = _plan(0, 1); // minOut=1 so we reach the fee guard (after the minOut>0 gate)
        p.relayFeeBPS = 1001; // > MAX_RELAY_FEE_BPS
        Withdrawal memory w = Withdrawal({processooor: address(executor), data: abi.encode(p)});
        uint256 ctx = uint256(keccak256(abi.encode(w, SCOPE))) % SNARK_FIELD;
        uint256[8] memory sig;
        sig[2] = WITHDRAW_VALUE;
        sig[7] = ctx;
        WithdrawProof memory proof =
            WithdrawProof({pA: [uint256(0), 0], pB: [[uint256(0), 0], [uint256(0), 0]], pC: [uint256(0), 0], pubSignals: sig});
        vm.expectRevert(ExecutorProcessooor.RelayFeeTooHigh.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /*//////////////////////// 8. double-spend ////////////////////////*/

    function test_DoubleSpend_SameNullifier_Reverts() public {
        ExecPlan memory p = _plan(0, 1); // minOut=1 so the FIRST call fully executes
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 55);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
        // Second time: the pool has spent nullifier 55 already => AlreadySpent.
        vm.expectRevert(MockPrivacyPool.AlreadySpent.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /*//////////////////////// 9. wrong caller / self-processooor ////////////////////////*/

    function test_NotSelfProcessooor_Reverts() public {
        ExecPlan memory p = _plan(0, 0);
        // Name a DIFFERENT processooor than the executor.
        Withdrawal memory w = Withdrawal({processooor: address(0x1234), data: abi.encode(p)});
        uint256 ctx = uint256(keccak256(abi.encode(w, SCOPE))) % SNARK_FIELD;
        uint256[8] memory sig;
        sig[2] = WITHDRAW_VALUE;
        sig[7] = ctx;
        WithdrawProof memory proof =
            WithdrawProof({pA: [uint256(0), 0], pB: [[uint256(0), 0], [uint256(0), 0]], pC: [uint256(0), 0], pubSignals: sig});
        vm.expectRevert(ExecutorProcessooor.NotSelfProcessooor.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /*//////////////////////// 10. immutability / constructor guards ////////////////////////*/

    function test_Constructor_EmptyWhitelist_Reverts() public {
        address[] memory t = new address[](0);
        bytes4[] memory s = new bytes4[](0);
        vm.expectRevert(ExecutorProcessooor.EmptyWhitelist.selector);
        new ExecutorProcessooor(t, s);
    }

    function test_Constructor_LengthMismatch_Reverts() public {
        address[] memory t = new address[](1);
        bytes4[] memory s = new bytes4[](2);
        t[0] = address(vault);
        vm.expectRevert(ExecutorProcessooor.LengthMismatch.selector);
        new ExecutorProcessooor(t, s);
    }

    function test_NoOwnerNoAdmin() public view {
        // Sanity: the executor exposes no admin surface. We assert the whitelist is
        // read-only (no setter exists to call) by confirming the getters are the only
        // state accessors — compile-time guaranteed; here we just confirm the frozen values.
        assertTrue(executor.isWhitelistedTarget(address(vault)));
        assertTrue(executor.isWhitelistedSelector(address(vault), DEPOSIT_SEL));
    }

    /*//////////////////////// AUDIT FIXES (2026-07) ////////////////////////*/

    /// @dev F1/F2 — THE headline exploit: a plan whose call routes output to a THIRD
    /// party (not the executor) must now REVERT (was: silently succeed with recipient
    /// getting nothing when minOut==0). Output never lands on the executor → outDelta==0
    /// → NoOutputProduced.
    function test_F1_OutputRoutedElsewhere_Reverts() public {
        ExecPlan memory p = _plan(0, 1);
        // Malicious/buggy callData: vault mints shares to attacker, NOT the executor.
        p.callData = abi.encodeWithSelector(DEPOSIT_SEL, WITHDRAW_VALUE, address(0xBAD));
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 101);
        vm.expectRevert(ExecutorProcessooor.NoOutputProduced.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /// @dev F1/F2 — a zero slippage floor is now rejected outright.
    function test_F2_ZeroMinOut_Reverts() public {
        ExecPlan memory p = _plan(0, 0);
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 102);
        vm.expectRevert(ExecutorProcessooor.ZeroMinOut.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /// @dev F3 — inputToken must equal the pool's real ASSET; a wrong one (which would
    /// strand the withdrawn USDC) now reverts fast.
    function test_F3_WrongInputToken_Reverts() public {
        ExecPlan memory p = _plan(0, 1);
        p.inputToken = address(shareToken); // != pool.ASSET() (usdc)
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 103);
        vm.expectRevert(ExecutorProcessooor.WrongInputToken.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /// @dev F5 — inputToken == outputToken breaks the two-snapshot accounting; rejected.
    function test_F5_SameInOutToken_Reverts() public {
        ExecPlan memory p = _plan(0, 1);
        p.outputToken = address(usdc); // == inputToken
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 104);
        vm.expectRevert(ExecutorProcessooor.SameInOutToken.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /// @dev F6 — calldata shorter than a selector is rejected (no fallback/empty-data surface).
    function test_F6_CalldataTooShort_Reverts() public {
        ExecPlan memory p = _plan(0, 1);
        p.callData = hex"6e55"; // 2 bytes < 4
        (Withdrawal memory w, WithdrawProof memory proof) = _withdrawalAndProof(p, 105);
        vm.expectRevert(ExecutorProcessooor.CalldataTooShort.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /// @dev F6 — constructor rejects a zero (0x00000000) selector.
    function test_F6_Constructor_ZeroSelector_Reverts() public {
        address[] memory t = new address[](1);
        bytes4[] memory s = new bytes4[](1);
        t[0] = address(vault);
        s[0] = bytes4(0);
        vm.expectRevert(ExecutorProcessooor.ZeroSelector.selector);
        new ExecutorProcessooor(t, s);
    }
}

/*//////////////////////////////////////////////////////////////
        SWAP-AS-SETTLEMENT (router target) — Deploy B path
//////////////////////////////////////////////////////////////*/

/// @notice Proves the executor works with a Uniswap-V3-style SWAP router as the
///         whitelisted target (not just an ERC-4626 vault): agent pays USDC, seller
///         receives a DIFFERENT token, in one unlinkable settlement. Contract is
///         UNCHANGED — a router is the same call shape as a vault deposit, subject to
///         the same F1/F5/slippage invariants.
contract ExecutorSwapTest is Test {
    ExecutorProcessooor internal executor;
    MockPrivacyPool internal pool;
    MockUSDC internal usdc; // input token (pool asset)
    MockUSDC internal outToken; // output token the seller wants (e.g. EURC)
    MockRouter internal router;

    address internal treasury = address(0xFEE);
    address internal seller = address(0xBEEF);
    uint256 internal constant SCOPE = 42;
    uint256 internal constant WITHDRAW_VALUE = 1_000_000; // 1 USDC (6dp)
    uint256 internal constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // Uniswap V3 SwapRouter02 exactInputSingle selector.
    bytes4 internal constant SWAP_SEL =
        bytes4(keccak256("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"));

    function setUp() public {
        usdc = new MockUSDC();
        outToken = new MockUSDC();
        pool = new MockPrivacyPool(IERC20(address(usdc)));
        router = new MockRouter();

        address[] memory targets = new address[](1);
        bytes4[] memory sels = new bytes4[](1);
        targets[0] = address(router);
        sels[0] = SWAP_SEL;
        executor = new ExecutorProcessooor(targets, sels);

        usdc.mint(address(pool), 100_000_000);
    }

    /// @dev Build a swap ExecPlan. F1: router recipient MUST be the executor.
    function _swapPlan(uint256 relayFeeBPS, uint256 minOut) internal view returns (ExecPlan memory p) {
        uint256 fee = (WITHDRAW_VALUE * relayFeeBPS) / 10_000;
        uint256 spend = WITHDRAW_VALUE - fee;
        MockRouter.ExactInputSingleParams memory sp = MockRouter.ExactInputSingleParams({
            tokenIn: address(usdc),
            tokenOut: address(outToken),
            fee: 500,
            recipient: address(executor), // ★ F1: output to executor, not the seller
            amountIn: spend,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });
        p = ExecPlan({
            callTarget: address(router),
            inputToken: address(usdc),
            outputToken: address(outToken),
            minOut: minOut,
            finalRecipient: seller,
            feeRecipient: treasury,
            relayFeeBPS: relayFeeBPS,
            callData: abi.encodeWithSelector(SWAP_SEL, sp)
        });
    }

    function _wp(ExecPlan memory p, uint256 nullifier)
        internal
        view
        returns (Withdrawal memory w, WithdrawProof memory proof)
    {
        w = Withdrawal({processooor: address(executor), data: abi.encode(p)});
        uint256 ctx = uint256(keccak256(abi.encode(w, SCOPE))) % SNARK_FIELD;
        uint256[8] memory sig;
        sig[1] = nullifier;
        sig[2] = WITHDRAW_VALUE;
        sig[7] = ctx;
        proof = WithdrawProof({pA: [uint256(0), 0], pB: [[uint256(0), 0], [uint256(0), 0]], pC: [uint256(0), 0], pubSignals: sig});
    }

    /// Happy path: seller receives the OTHER token, treasury takes fee, no residuals.
    function test_Swap_SettlesToSellerInDifferentToken() public {
        ExecPlan memory p = _swapPlan(100, 1); // 1% fee, 1:1 router → output = spend
        (Withdrawal memory w, WithdrawProof memory proof) = _wp(p, 1);
        uint256 fee = (WITHDRAW_VALUE * 100) / 10_000;
        uint256 spend = WITHDRAW_VALUE - fee;

        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);

        assertEq(outToken.balanceOf(seller), spend, "seller receives the output token");
        assertEq(usdc.balanceOf(treasury), fee, "treasury gets fee");
        assertEq(usdc.balanceOf(address(executor)), 0, "no residual input");
        assertEq(outToken.balanceOf(address(executor)), 0, "no residual output");
        assertEq(usdc.allowance(address(executor), address(router)), 0, "no residual approval");
        assertEq(usdc.balanceOf(seller), 0, "seller never touches USDC");
    }

    /// F1: if the router sends output to the seller directly (not the executor),
    /// the executor sees outDelta == 0 → NoOutputProduced.
    function test_Swap_OutputToSellerDirectly_Reverts() public {
        uint256 spend = WITHDRAW_VALUE; // relayFeeBPS = 0
        MockRouter.ExactInputSingleParams memory sp = MockRouter.ExactInputSingleParams({
            tokenIn: address(usdc), tokenOut: address(outToken), fee: 500,
            recipient: seller, // ★ WRONG on purpose
            amountIn: spend, amountOutMinimum: 1, sqrtPriceLimitX96: 0
        });
        ExecPlan memory p = ExecPlan({
            callTarget: address(router), inputToken: address(usdc), outputToken: address(outToken),
            minOut: 1, finalRecipient: seller, feeRecipient: treasury, relayFeeBPS: 0,
            callData: abi.encodeWithSelector(SWAP_SEL, sp)
        });
        (Withdrawal memory w, WithdrawProof memory proof) = _wp(p, 1);
        vm.expectRevert(ExecutorProcessooor.NoOutputProduced.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /// F5: same in/out token is rejected before any call.
    function test_Swap_SameInOutToken_Reverts() public {
        ExecPlan memory p = _swapPlan(0, 1);
        p.outputToken = address(usdc); // == inputToken
        (Withdrawal memory w, WithdrawProof memory proof) = _wp(p, 1);
        vm.expectRevert(ExecutorProcessooor.SameInOutToken.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /// Slippage: the EXECUTOR's own minOut floor is independent of (and stricter than)
    /// the router's internal amountOutMinimum. Here the router accepts a low internal
    /// min (so it does NOT self-revert) but the executor demands more → SlippageTooHigh.
    /// This proves the executor is not merely trusting the router's slippage check.
    function test_Swap_BelowMinOut_Reverts() public {
        router.setRate(5_000); // 0.5x — router outputs half of spend
        // Router calldata carries a LENIENT internal min (1) so the router itself passes;
        // the ExecPlan minOut is strict (full spend) so the EXECUTOR rejects the shortfall.
        uint256 spend = WITHDRAW_VALUE; // relayFeeBPS = 0
        MockRouter.ExactInputSingleParams memory sp = MockRouter.ExactInputSingleParams({
            tokenIn: address(usdc), tokenOut: address(outToken), fee: 500,
            recipient: address(executor), amountIn: spend,
            amountOutMinimum: 1, // lenient: router won't self-revert
            sqrtPriceLimitX96: 0
        });
        ExecPlan memory p = ExecPlan({
            callTarget: address(router), inputToken: address(usdc), outputToken: address(outToken),
            minOut: WITHDRAW_VALUE, // strict: executor demands full 1:1, router gives 0.5x
            finalRecipient: seller, feeRecipient: treasury, relayFeeBPS: 0,
            callData: abi.encodeWithSelector(SWAP_SEL, sp)
        });
        (Withdrawal memory w, WithdrawProof memory proof) = _wp(p, 1);
        vm.expectRevert(ExecutorProcessooor.SlippageTooHigh.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }

    /// A non-whitelisted router selector is rejected (whitelist is per target+selector).
    function test_Swap_WrongSelector_Reverts() public {
        ExecPlan memory p = _swapPlan(0, 1);
        // Replace calldata with a different (non-whitelisted) selector on the same target.
        p.callData = abi.encodeWithSelector(bytes4(keccak256("exactOutputSingle()")));
        // pad to >= 4 bytes is automatic; but this selector isn't whitelisted.
        (Withdrawal memory w, WithdrawProof memory proof) = _wp(p, 1);
        vm.expectRevert(ExecutorProcessooor.SelectorNotWhitelisted.selector);
        executor.executeFromPool(IPrivacyPoolLike(address(pool)), w, proof, SCOPE);
    }
}
