// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PrivacyPoolMorpho, IMorphoYieldVault} from "../PrivacyPoolMorpho.sol";
import {MockUSDC} from "./MockUSDC.sol";

/**
 * Tunable mock vault. `pretendYieldBps` lets each test dial in a
 * Morpho-style gain (e.g. 500 = "5% growth since deposit"). The mock
 * holds USDC 1:1 with shares at deposit, then on redeem returns
 * `(shares * (BPS + yieldBps)) / BPS` USDC — capped at its balance.
 */
contract MockMorphoVault is IMorphoYieldVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    uint256 public pretendYieldBps; // e.g. 500 = +5% on redeem

    constructor(IERC20 _usdc) {
        usdc = _usdc;
    }

    function setYieldBps(uint256 bps) external {
        pretendYieldBps = bps;
    }

    function supply(uint256 assets, address /*onBehalf*/ ) external returns (uint256) {
        usdc.safeTransferFrom(msg.sender, address(this), assets);
        // 1:1 share minting at deposit time (Morpho-ish: shares are the
        // accounting unit, value grows over time via `previewRedeem`).
        return assets;
    }

    function _grossUp(uint256 shares) internal view returns (uint256) {
        return (shares * (10_000 + pretendYieldBps)) / 10_000;
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        uint256 quoted = _grossUp(shares);
        uint256 bal = usdc.balanceOf(address(this));
        return quoted > bal ? bal : quoted;
    }

    function redeem(uint256 shares, address receiver) external returns (uint256) {
        uint256 amount = _grossUp(shares);
        uint256 bal = usdc.balanceOf(address(this));
        if (amount > bal) amount = bal;
        usdc.safeTransfer(receiver, amount);
        return amount;
    }
}

contract PrivacyPoolMorphoYieldTest is Test {
    // Re-declared here so `vm.expectEmit` can use it; must match the
    // signature in PrivacyPoolMorpho exactly.
    event YieldDistributed(
        address indexed recipient,
        uint256 principal,
        uint256 yieldAmount,
        uint256 fee
    );

    MockUSDC internal usdc;
    MockMorphoVault internal vault;
    PrivacyPoolMorpho internal pool;

    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant DEPOSITOR = address(0xD0);
    address internal constant RECIPIENT = address(0xE0);

    // The commitment value is opaque to this layer (computed off-chain by the
    // Poseidon proof pipeline) — we just pick a non-zero placeholder.
    uint256 internal constant COMMITMENT = uint256(keccak256("zbase-test-commitment"));

    function setUp() public {
        usdc = new MockUSDC();
        vault = new MockMorphoVault(IERC20(address(usdc)));
        pool = new PrivacyPoolMorpho(address(usdc), address(vault), FEE_RECIPIENT);

        // Pool needs USDC pre-loaded so it can `_pull` (simulating the upstream
        // `deposit()` flow which transfers USDC into the pool, then calls _pull).
        usdc.mint(address(pool), 1_000_000e6);
        // Vault stockpile so it can pay yield in the +5% test.
        usdc.mint(address(vault), 1_000_000e6);
    }

    // ─────────────────────────────────────────────────────────────
    // test_NoYieldNoFee
    // Testnet path: 0% yield → 0% fee → recipient gets full principal.
    // ─────────────────────────────────────────────────────────────
    function test_NoYieldNoFee() public {
        vault.setYieldBps(0);

        uint256 principal = 1_000e6; // 1000 USDC

        pool._pull(COMMITMENT, principal);

        uint256 recipientBefore = usdc.balanceOf(RECIPIENT);
        uint256 feeBefore = usdc.balanceOf(FEE_RECIPIENT);

        pool._push(COMMITMENT, principal, RECIPIENT);

        assertEq(
            usdc.balanceOf(RECIPIENT) - recipientBefore,
            principal,
            "recipient should get full principal when there is no yield"
        );
        assertEq(
            usdc.balanceOf(FEE_RECIPIENT) - feeBefore,
            0,
            "no fee should be charged when there is no yield"
        );
    }

    // ─────────────────────────────────────────────────────────────
    // test_YieldFullyDistributed
    // Mainnet-ish path: +5% Morpho gain → depositor gets 100% of yield.
    // PROTOCOL_FEE_BPS = 0 per the v0 revenue policy (yield is a
    // customer benefit, not a revenue line). The fee-skim branch is
    // preserved in the contract so a future shipment can re-enable it
    // by changing the constant + redeploying.
    // ─────────────────────────────────────────────────────────────
    function test_YieldFullyDistributed() public {
        vault.setYieldBps(500); // +5%

        uint256 principal = 1_000e6; // 1000 USDC
        pool._pull(COMMITMENT, principal);

        // Expected math (BPS = 0):
        //   currentValue = 1_000e6 * 1.05            = 1_050e6
        //   yield        = 1_050e6 - 1_000e6         =     50e6
        //   fee          = 50e6 * 0 / 10_000         =      0
        //   payout       = 1_050e6 - 0               =  1_050_000_000
        uint256 expectedCurrent = 1_050e6;
        uint256 expectedYield = 50e6;
        uint256 expectedFee = 0;
        uint256 expectedPayout = expectedCurrent;

        uint256 recipientBefore = usdc.balanceOf(RECIPIENT);
        uint256 feeBefore = usdc.balanceOf(FEE_RECIPIENT);

        // Expect the YieldDistributed event with exact fields.
        vm.expectEmit(true, false, false, true, address(pool));
        emit YieldDistributed(RECIPIENT, principal, expectedYield, expectedFee);

        pool._push(COMMITMENT, principal, RECIPIENT);

        assertEq(
            usdc.balanceOf(RECIPIENT) - recipientBefore,
            expectedPayout,
            "recipient should get principal + 100% of yield"
        );
        assertEq(
            usdc.balanceOf(FEE_RECIPIENT) - feeBefore,
            expectedFee,
            "no fee should be charged (BPS=0 policy)"
        );
    }

    // ─────────────────────────────────────────────────────────────
    // test_ZeroYieldZeroFee
    // Edge case: previewRedeem == originalDepositValue exactly. Same
    // assertion as test_NoYieldNoFee but exercised through the explicit
    // "currentValue <= withdrawnValue" branch, which is the path that
    // protects depositors from being charged on Morpho rounding-down.
    // ─────────────────────────────────────────────────────────────
    function test_ZeroYieldZeroFee() public {
        vault.setYieldBps(0);

        uint256 principal = 12_345_678; // odd-shaped to surface rounding
        pool._pull(COMMITMENT, principal);

        uint256 recipientBefore = usdc.balanceOf(RECIPIENT);
        uint256 feeBefore = usdc.balanceOf(FEE_RECIPIENT);

        vm.expectEmit(true, false, false, true, address(pool));
        emit YieldDistributed(RECIPIENT, principal, 0, 0);

        pool._push(COMMITMENT, principal, RECIPIENT);

        assertEq(usdc.balanceOf(RECIPIENT) - recipientBefore, principal, "exact-equal payout");
        assertEq(usdc.balanceOf(FEE_RECIPIENT) - feeBefore, 0, "no fee on exact-equal");
    }

    // ─────────────────────────────────────────────────────────────
    // test_FeeRecipientIsImmutable
    // Governance assertion: no setter exists. Changing the destination
    // requires a redeploy + multisig ceremony (per CLAUDE.md).
    // ─────────────────────────────────────────────────────────────
    function test_FeeRecipientIsImmutable() public view {
        assertEq(pool.PROTOCOL_FEE_RECIPIENT(), FEE_RECIPIENT);
        assertEq(pool.PROTOCOL_FEE_BPS(), 0);
        assertEq(pool.BPS_DENOMINATOR(), 10_000);
    }

    // ─────────────────────────────────────────────────────────────
    // test_PartialWithdrawalProportionalShares
    // Sanity check that partial withdrawals only redeem a slice of
    // shares and leave the rest earning. Not strictly part of the
    // fee spec but the load-bearing accounting invariant.
    // ─────────────────────────────────────────────────────────────
    function test_PartialWithdrawalProportionalShares() public {
        vault.setYieldBps(0);

        uint256 principal = 1_000e6;
        pool._pull(COMMITMENT, principal);

        uint256 sharesBefore = pool.sharesByCommitment(COMMITMENT);
        uint256 principalBefore = pool.principalByCommitment(COMMITMENT);
        assertEq(sharesBefore, principal, "shares = 1:1 at deposit in mock");
        assertEq(principalBefore, principal);

        // Withdraw 40% of the note.
        uint256 partialAmount = 400e6;
        pool._push(COMMITMENT, partialAmount, RECIPIENT);

        assertEq(
            pool.principalByCommitment(COMMITMENT),
            principal - partialAmount,
            "remaining principal should drop by withdrawn amount"
        );
        assertEq(
            pool.sharesByCommitment(COMMITMENT),
            sharesBefore - (sharesBefore * partialAmount) / principal,
            "remaining shares should drop proportionally"
        );
        assertEq(usdc.balanceOf(RECIPIENT), partialAmount, "recipient gets exactly the partial");
    }
}
