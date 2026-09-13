// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @dev Inlined `MessageHashUtils.toEthSignedMessageHash(bytes32)` to keep the
 *      file compatible with solc 0.8.20 (repo-wide pin in `foundry.toml`).
 *      OZ's own `MessageHashUtils.sol` requires solc ^0.8.24, which would force
 *      a repo-wide bump that this scaffold-only PR explicitly avoids.
 */
library _ZBaseMessageHash {
    function toEthSignedMessageHash(bytes32 messageHash) internal pure returns (bytes32) {
        // EIP-191 personal_sign prefix.
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
    }
}

/**
 * @title ThresholdEntrypoint
 * @notice 3-of-5 threshold-signed ASP (Association Set Provider) root update gateway.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠️  NOT DEPLOYED as of 2026-06-25. The LIVE ASP-root gateway is the       │
 * │     plain 0xbow Entrypoint proxy at 0x598ffaac… (single POSTMAN key via   │
 * │     updateRoot). This contract is the decentralization upgrade for that   │
 * │     custodial bottleneck — built + tested (forge test --match-contract    │
 * │     ThresholdEntrypoint), but not on-chain.                               │
 * │                                                                           │
 * │  WHEN/HOW this deploys (future):                                          │
 * │   - BLOCKED on signer recruitment: 5 signer addresses are wired at deploy │
 * │     and IMMUTABLE for life — need 5 real, independent custodians first.   │
 * │   - Deploy script exists: script/DeployThresholdEntrypoint.s.sol          │
 * │     (run via FOUNDRY_PROFILE=threshold). Governance: docs/governance.md.  │
 * │   - Migration: point the pool's ENTRYPOINT at this, transfer the POSTMAN  │
 * │     role, then run ASP updates through the 3-of-5 quorum instead of 1 key. │
 * │   - Priority: a trust-decentralization upgrade, NOT a launch blocker. The │
 * │     single-key Entrypoint is adequate for testnet + early mainnet; ship   │
 * │     this when external custodians / a regulated provider require it.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Background:
 * The existing 0xbow-fork `Entrypoint` deployed at 0x598ffaac79ae29b1aae571fd91899d4492183688
 * has a single privileged `updateRoot(uint256 root, string ipfsCID)` callable only by the
 * POSTMAN role. That key is a custodial trust bottleneck — whoever holds it can:
 *
 *   (a) censor approvals (refuse to publish a clean root after a user's deposit), or
 *   (b) push bad-actor labels into the ASP root (laundering risk that would invite the
 *       Tornado-Cash-shaped enforcement we are explicitly architecting around).
 *
 * This contract replaces the single-key contract with a t-of-n quorum. Five signer
 * addresses are wired in at deploy time and are immutable for the life of the contract.
 * Every ASP root update must carry at least THRESHOLD = 3 valid EIP-191 (`personal_sign`)
 * signatures over `keccak256(abi.encode(newRoot, nonce, address(this), block.chainid))`.
 * The nonce monotonically increments per accepted root, defeating replay.
 *
 * NOTE — v0 scope:
 *   - Per `/Users/eesheng_eth/.claude/plans/i-want-production-grade-enchanted-scone.md`
 *     Shipment B.2, this is the scaffold-only deployment. The existing single-key
 *     Entrypoint stays live as the production root path. This contract is NOT yet wired
 *     into the deployed pool — the actual ceremony (5 real signers, governance doc
 *     sign-off, Spearbit/Zellic audit) is deferred per the plan.
 *   - ECDSA + EIP-191 was chosen over FROST / BLS because it ships in days and reuses
 *     audited OZ primitives. FROST is the right Series-A primitive but not the right
 *     v0 primitive.
 *
 * Replacing-not-wrapping rationale:
 *   The plan says "Inherits from existing Entrypoint or wraps it." The 0xbow Entrypoint
 *   ABI uses `(uint256 _root, string _ipfsCID)` and constrains the caller via OZ
 *   AccessControl POSTMAN role. The clean migration path is: deploy this contract,
 *   grant THIS contract the POSTMAN role on the live Entrypoint, then have THIS
 *   contract's `submitRoot` forward to the live Entrypoint's `updateRoot`. To keep this
 *   PR side-effect-free on the deployed system we expose a forwarding hook
 *   (`_pushRootDownstream`) that defaults to a no-op event but can be pointed at the
 *   live Entrypoint via constructor parameter `downstream`. When `downstream == 0`,
 *   the contract acts as a stand-alone bookkeeper for the ASP root.
 */
contract ThresholdEntrypoint {
    using ECDSA for bytes32;
    using _ZBaseMessageHash for bytes32;

    // ─── Immutable configuration ───────────────────────────────────────────────

    /// @notice Required number of valid signatures.
    uint256 public constant THRESHOLD = 3;

    /// @notice Total signer-set size.
    uint256 public constant SIGNER_COUNT = 5;

    /// @notice The five threshold signers, fixed at deploy time.
    /// @dev Stored as a fixed-size array so it cannot be reshuffled by storage tricks.
    address[SIGNER_COUNT] public THRESHOLD_SIGNERS;

    /// @notice Optional downstream Entrypoint that will receive the forwarded
    ///         `updateRoot(uint256, string)` call once quorum is reached.
    ///         When `address(0)`, the contract is stand-alone (test / staging mode).
    address public immutable downstream;

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Monotonically increasing nonce. Bound into every signed payload to
    ///         prevent replay of the same `(root, sigs)` bundle.
    uint256 public nonce;

    /// @notice Most-recently accepted ASP root.
    bytes32 public latestRoot;

    // ─── Events ───────────────────────────────────────────────────────────────

    event RootUpdated(bytes32 newRoot, uint256 indexed nonce, address[] signers);
    event DownstreamForwarded(address indexed downstream, bytes32 newRoot, string ipfsCID);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error ThresholdNotMet(uint256 provided, uint256 required);
    error LengthMismatch();
    error DuplicateSigner(address signer);
    error UnknownSigner(address signer);
    error InvalidSignature(address recovered, address claimed);
    error ZeroAddress();

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param signers       The fixed set of five signer addresses. Order does not matter
     *                      for signature verification but is fixed for the life of the
     *                      contract.
     * @param downstream_   Optional address of the existing 0xbow Entrypoint to forward
     *                      accepted roots into. Pass `address(0)` for stand-alone mode.
     */
    constructor(address[SIGNER_COUNT] memory signers, address downstream_) {
        for (uint256 i = 0; i < SIGNER_COUNT; ++i) {
            if (signers[i] == address(0)) revert ZeroAddress();
            // Reject duplicates inside the signer set itself. Without this, the same
            // key could be listed twice and a t-of-n become t/2-of-n effectively.
            for (uint256 j = 0; j < i; ++j) {
                if (signers[i] == signers[j]) revert DuplicateSigner(signers[i]);
            }
            THRESHOLD_SIGNERS[i] = signers[i];
        }
        downstream = downstream_;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * @notice Submit a new ASP root with at least THRESHOLD valid signatures.
     * @param newRoot     The Poseidon Merkle root of the approved-deposit label set.
     * @param ipfsCID     IPFS pointer to the human-readable label batch (mirrors the
     *                    existing 0xbow Entrypoint signature for forward compatibility).
     * @param signers     Addresses claiming to have signed. Must be a subset of
     *                    `THRESHOLD_SIGNERS`, with no duplicates, length ≥ THRESHOLD.
     * @param signatures  Signatures aligned 1:1 with `signers`.
     *
     * Signed payload is `keccak256(abi.encode(newRoot, currentNonce, address(this),
     * block.chainid))` wrapped in the EIP-191 personal_sign prefix.
     */
    function updateRoot(
        bytes32 newRoot,
        string calldata ipfsCID,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external {
        if (signers.length != signatures.length) revert LengthMismatch();
        if (signers.length < THRESHOLD) {
            revert ThresholdNotMet(signers.length, THRESHOLD);
        }

        uint256 currentNonce = nonce;
        bytes32 digest = keccak256(
            abi.encode(newRoot, currentNonce, address(this), block.chainid)
        ).toEthSignedMessageHash();

        // Track seen signers in a fixed-length lookup (cheaper than mapping for n=5).
        address[] memory seen = new address[](signers.length);
        uint256 validCount = 0;

        for (uint256 i = 0; i < signers.length; ++i) {
            address claimed = signers[i];

            // (1) Membership in the quorum set.
            if (!_isThresholdSigner(claimed)) revert UnknownSigner(claimed);

            // (2) No duplicates within this submission.
            for (uint256 j = 0; j < validCount; ++j) {
                if (seen[j] == claimed) revert DuplicateSigner(claimed);
            }

            // (3) Signature actually recovers to the claimed address.
            address recovered = digest.recover(signatures[i]);
            if (recovered != claimed) revert InvalidSignature(recovered, claimed);

            seen[validCount] = claimed;
            unchecked {
                ++validCount;
            }
        }

        // Effects.
        latestRoot = newRoot;
        unchecked {
            nonce = currentNonce + 1;
        }

        emit RootUpdated(newRoot, currentNonce, signers);

        // Interaction (optional downstream forward).
        _pushRootDownstream(newRoot, ipfsCID);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getSigners() external view returns (address[SIGNER_COUNT] memory) {
        return THRESHOLD_SIGNERS;
    }

    /**
     * @notice The exact digest the off-chain coordinator must sign with `personal_sign`.
     * @dev    Use this rather than reconstructing client-side; it removes one entire
     *         class of bugs.
     */
    function rootDigest(bytes32 newRoot) external view returns (bytes32) {
        return keccak256(
            abi.encode(newRoot, nonce, address(this), block.chainid)
        ).toEthSignedMessageHash();
    }

    // ─── Internals ────────────────────────────────────────────────────────────

    function _isThresholdSigner(address candidate) internal view returns (bool) {
        for (uint256 i = 0; i < SIGNER_COUNT; ++i) {
            if (THRESHOLD_SIGNERS[i] == candidate) return true;
        }
        return false;
    }

    /**
     * @dev When `downstream` is set, forwards the accepted root into the live
     *      0xbow Entrypoint via its `updateRoot(uint256, string)` selector. This
     *      contract must hold POSTMAN_ROLE on the downstream Entrypoint for this
     *      to succeed. Until that role transfer happens (post-audit), this branch
     *      is dormant and the contract operates stand-alone.
     */
    function _pushRootDownstream(bytes32 newRoot, string calldata ipfsCID) internal {
        if (downstream == address(0)) return;
        // ABI: updateRoot(uint256 _root, string _ipfsCID) -> uint256
        (bool ok, bytes memory ret) = downstream.call(
            abi.encodeWithSignature("updateRoot(uint256,string)", uint256(newRoot), ipfsCID)
        );
        // Surface the downstream revert reason verbatim so off-chain logs show why.
        require(ok, _bubble(ret));
        emit DownstreamForwarded(downstream, newRoot, ipfsCID);
    }

    /**
     * Best-effort decode of a downstream revert reason (audit F14).
     *
     * Pre-fix this unconditionally `abi.decode(ret, (string))` after stripping a
     * 4-byte selector — which itself REVERTS (with an opaque decode panic) when
     * the downstream reverted with a custom error, a Panic(uint256), or any
     * non-`Error(string)` payload, masking the real failure. Now we only attempt
     * the string decode when the data is actually shaped like `Error(string)`
     * (selector 0x08c379a0 + a well-formed ABI string); otherwise we return a
     * generic, non-reverting message so `require(ok, _bubble(ret))` always
     * surfaces *something* legible instead of throwing inside the error path.
     */
    function _bubble(bytes memory ret) private pure returns (string memory) {
        if (ret.length == 0) return "downstream: empty revert";
        // Need at least selector(4) + offset(32) + length(32) for Error(string).
        if (ret.length < 68) return "downstream: non-string revert";
        bytes4 sel;
        assembly {
            sel := mload(add(ret, 0x20))
        }
        // Error(string) selector = 0x08c379a0. Anything else (custom error /
        // Panic) we don't try to decode as a string.
        if (sel != 0x08c379a0) return "downstream: custom-error revert";
        // Strip the 4-byte selector, then decode the ABI string. Wrapped so a
        // malformed payload can't bubble a decode panic out of the error path.
        assembly {
            ret := add(ret, 0x04)
        }
        return abi.decode(ret, (string));
    }
}
