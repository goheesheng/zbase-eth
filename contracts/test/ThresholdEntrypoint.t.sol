// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {ThresholdEntrypoint} from "@zbase-protocol/contracts/ThresholdEntrypoint.sol";

library _TestMessageHash {
    function toEthSignedMessageHash(bytes32 messageHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
    }
}

contract ThresholdEntrypointTest is Test {
    using _TestMessageHash for bytes32;

    ThresholdEntrypoint internal entrypoint;

    // Five canonical signer keypairs. The private keys are deterministic so the test
    // is reproducible and CI-friendly.
    uint256 internal constant PK1 = 0xA1A1A1;
    uint256 internal constant PK2 = 0xB2B2B2;
    uint256 internal constant PK3 = 0xC3C3C3;
    uint256 internal constant PK4 = 0xD4D4D4;
    uint256 internal constant PK5 = 0xE5E5E5;
    uint256 internal constant PK_RANDO = 0xDEADBEEF;

    address internal signer1;
    address internal signer2;
    address internal signer3;
    address internal signer4;
    address internal signer5;
    address internal rando;

    function setUp() public {
        signer1 = vm.addr(PK1);
        signer2 = vm.addr(PK2);
        signer3 = vm.addr(PK3);
        signer4 = vm.addr(PK4);
        signer5 = vm.addr(PK5);
        rando = vm.addr(PK_RANDO);

        address[5] memory set = [signer1, signer2, signer3, signer4, signer5];
        entrypoint = new ThresholdEntrypoint(set, address(0));
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _digest(bytes32 newRoot) internal view returns (bytes32) {
        return keccak256(
            abi.encode(newRoot, entrypoint.nonce(), address(entrypoint), block.chainid)
        ).toEthSignedMessageHash();
    }

    function _sign(uint256 pk, bytes32 newRoot) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(newRoot));
        return abi.encodePacked(r, s, v);
    }

    // ─── Tests ────────────────────────────────────────────────────────────────

    /// @notice 2 signatures must be rejected; 3 must be accepted.
    function test_RequiresThreshold() public {
        bytes32 root = bytes32(uint256(0x1234));
        string memory cid = "QmTestCID";

        // ── 2 signatures rejected ─────────────────────────────────────────────
        address[] memory two = new address[](2);
        two[0] = signer1;
        two[1] = signer2;

        bytes[] memory twoSigs = new bytes[](2);
        twoSigs[0] = _sign(PK1, root);
        twoSigs[1] = _sign(PK2, root);

        vm.expectRevert(
            abi.encodeWithSelector(ThresholdEntrypoint.ThresholdNotMet.selector, uint256(2), uint256(3))
        );
        entrypoint.updateRoot(root, cid, two, twoSigs);

        // ── 3 signatures accepted ─────────────────────────────────────────────
        address[] memory three = new address[](3);
        three[0] = signer1;
        three[1] = signer2;
        three[2] = signer3;

        bytes[] memory threeSigs = new bytes[](3);
        threeSigs[0] = _sign(PK1, root);
        threeSigs[1] = _sign(PK2, root);
        threeSigs[2] = _sign(PK3, root);

        entrypoint.updateRoot(root, cid, three, threeSigs);

        assertEq(entrypoint.latestRoot(), root, "latestRoot not updated");
        assertEq(entrypoint.nonce(), 1, "nonce did not increment");
    }

    /// @notice The same signer listed twice must NOT count toward the threshold.
    function test_RejectsDuplicateSigner() public {
        bytes32 root = bytes32(uint256(0xABCD));

        address[] memory dup = new address[](3);
        dup[0] = signer1;
        dup[1] = signer1; // duplicate
        dup[2] = signer2;

        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _sign(PK1, root);
        sigs[1] = _sign(PK1, root); // identical sig from duplicated signer
        sigs[2] = _sign(PK2, root);

        vm.expectRevert(
            abi.encodeWithSelector(ThresholdEntrypoint.DuplicateSigner.selector, signer1)
        );
        entrypoint.updateRoot(root, "QmDup", dup, sigs);
    }

    /// @notice A signature from a non-quorum key must be rejected, even if real.
    function test_RejectsNonSigner() public {
        bytes32 root = bytes32(uint256(0xBEEF));

        address[] memory mix = new address[](3);
        mix[0] = signer1;
        mix[1] = signer2;
        mix[2] = rando; // not in the quorum

        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _sign(PK1, root);
        sigs[1] = _sign(PK2, root);
        sigs[2] = _sign(PK_RANDO, root);

        vm.expectRevert(
            abi.encodeWithSelector(ThresholdEntrypoint.UnknownSigner.selector, rando)
        );
        entrypoint.updateRoot(root, "QmRando", mix, sigs);
    }

    /// @notice A previously-accepted (root, nonce) bundle cannot be replayed.
    function test_ReplayProtection() public {
        bytes32 root = bytes32(uint256(0xC0FFEE));
        string memory cid = "QmReplay";

        address[] memory three = new address[](3);
        three[0] = signer1;
        three[1] = signer2;
        three[2] = signer3;

        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _sign(PK1, root);
        sigs[1] = _sign(PK2, root);
        sigs[2] = _sign(PK3, root);

        // First submission OK.
        entrypoint.updateRoot(root, cid, three, sigs);
        assertEq(entrypoint.nonce(), 1);

        // Same bundle replayed: nonce has incremented, so the signed digest no longer
        // matches what the contract recomputes. Recovery returns the wrong address.
        // The first signer's slot will be the first to fail.
        vm.expectRevert(); // generic — the recovered address depends on EVM math
        entrypoint.updateRoot(root, cid, three, sigs);

        // Confirm that re-signing with the new nonce works → freshness, not censorship.
        bytes[] memory freshSigs = new bytes[](3);
        freshSigs[0] = _sign(PK1, root);
        freshSigs[1] = _sign(PK2, root);
        freshSigs[2] = _sign(PK3, root);
        entrypoint.updateRoot(root, cid, three, freshSigs);
        assertEq(entrypoint.nonce(), 2);
    }

    // ─── Constructor sanity tests (defense-in-depth) ──────────────────────────

    function test_RejectsZeroAddressInConstructor() public {
        address[5] memory bad = [signer1, signer2, address(0), signer4, signer5];
        vm.expectRevert(ThresholdEntrypoint.ZeroAddress.selector);
        new ThresholdEntrypoint(bad, address(0));
    }

    function test_RejectsDuplicateInConstructor() public {
        address[5] memory bad = [signer1, signer2, signer1, signer4, signer5];
        vm.expectRevert(
            abi.encodeWithSelector(ThresholdEntrypoint.DuplicateSigner.selector, signer1)
        );
        new ThresholdEntrypoint(bad, address(0));
    }

    /// @notice `rootDigest` view must match what the contract verifies internally.
    function test_RootDigestMatches() public view {
        bytes32 root = bytes32(uint256(0x42));
        bytes32 expected = _digest(root);
        assertEq(entrypoint.rootDigest(root), expected);
    }
}
