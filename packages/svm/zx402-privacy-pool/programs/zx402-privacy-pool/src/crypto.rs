// Cryptographic primitives for the zx402 privacy pool on Solana.
//
// Everything here mirrors the EVM/Circom side bit-for-bit so a single Groth16
// proof produced by the universal `withdraw.wasm` circuit verifies on either
// chain. Conventions:
//
//   * Field elements are 32-byte big-endian arrays. The BN254 scalar field
//     SNARK_SCALAR_FIELD < 2^254 < 2^256, so 32 bytes is always enough.
//   * Poseidon is the circomlib BN254 x^5 variant (Poseidon::new_circom).
//   * The LeanIMT parent hash is poseidon2(left, right). When a node has no
//     right sibling its parent equals the node itself (NOT poseidon2(node, 0)).
//     This matches @zk-kit/lean-imt and the Withdraw circuit at
//     packages/circuits/circuits/merkleTree.circom in the upstream
//     0xbow/privacy-pools-core repo.
//   * `label = keccak256(scope || nonce_be32) % SNARK_SCALAR_FIELD`.
//   * `context = keccak256(processooor || data || scope_be32) % SNARK_SCALAR_FIELD`.

use anchor_lang::prelude::*;
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use solana_keccak_hasher as keccak;
use solana_poseidon::{hashv as poseidon_hashv, Endianness, Parameters};

/// 32-byte big-endian field element. Always reduced mod the BN254 scalar field
/// where it represents a circuit signal.
pub type Fe = [u8; 32];

/// Maximum LeanIMT depth. Must match the circuit instantiation
/// `Withdraw(maxTreeDepth)` in the upstream Circom source — currently 32.
pub const MAX_TREE_DEPTH: usize = 32;

/// Reduce a 32-byte big-endian integer modulo the BN254 scalar field.
/// Used for `label` and `context` since both come from keccak256 (256-bit).
pub fn reduce_to_field_be(bytes: &[u8; 32]) -> Fe {
    let f = Fr::from_be_bytes_mod_order(bytes);
    let mut out = [0u8; 32];
    let big = f.into_bigint().to_bytes_be();
    // `to_bytes_be()` strips leading zero bytes; left-pad to 32.
    let pad = 32 - big.len();
    out[pad..].copy_from_slice(&big);
    out
}

/// keccak256(scope_be32 || nonce_be8) reduced into the scalar field.
/// Mirrors the EVM `_label = uint256(keccak256(abi.encode(SCOPE, nonce))) % SNARK_FIELD`
/// computation that the upstream pool performs on-chain.
pub fn compute_label(scope: &Fe, nonce: u64) -> Fe {
    let mut buf = [0u8; 32 + 8];
    buf[..32].copy_from_slice(scope);
    buf[32..].copy_from_slice(&nonce.to_be_bytes());
    let h = keccak::hashv(&[&buf]);
    reduce_to_field_be(&h.to_bytes())
}

/// keccak256(pool_id || token_mint) reduced into the scalar field.
/// The exact preimage doesn't matter for verification (the circuit only
/// requires both sides agree on `scope`), but it must be deterministic so
/// the relayer can reproduce it.
pub fn compute_scope(pool_id: &Pubkey, token_mint: &Pubkey) -> Fe {
    let h = keccak::hashv(&[pool_id.as_ref(), token_mint.as_ref()]);
    reduce_to_field_be(&h.to_bytes())
}

/// keccak256(processooor_be32 || withdrawal_data || scope_be32) reduced into
/// the scalar field. Mirrors the EVM-side `context` computation in
/// `src/app/api/withdraw/route.ts`. Because the recipient and relay-fee bps
/// are part of `withdrawal_data`, binding `context` as a public input is what
/// stops a relayer from rewriting the destination.
pub fn compute_context(processooor: &Pubkey, withdrawal_data: &[u8], scope: &Fe) -> Fe {
    let h = keccak::hashv(&[processooor.as_ref(), withdrawal_data, scope]);
    reduce_to_field_be(&h.to_bytes())
}

/// Canonical bytes bound into a Solana withdrawal proof:
/// `recipient || relay_fee_bps_be8 || relayer`.
///
/// This must be constructed from the actual instruction accounts/arguments on
/// chain. Accepting arbitrary caller bytes and hashing those would not bind the
/// proof to the recipient or relayer that receives funds.
pub fn encode_withdrawal_data(
    recipient: &Pubkey,
    relay_fee_bps: u64,
    relayer: &Pubkey,
) -> [u8; 72] {
    let mut out = [0u8; 72];
    out[..32].copy_from_slice(recipient.as_ref());
    out[32..40].copy_from_slice(&relay_fee_bps.to_be_bytes());
    out[40..].copy_from_slice(relayer.as_ref());
    out
}

/// Poseidon hash with a circom-compatible parameter set. `n_inputs` must be
/// 1, 2, or 3 (the only arities used by the Privacy Pools circuits).
fn poseidon_n(n_inputs: usize, inputs: &[&[u8; 32]]) -> Result<Fe> {
    if inputs.len() != n_inputs {
        return err!(crate::ZX402Error::InvalidProof);
    }
    // Use the Solana Poseidon syscall (BN254 / x5 / BE) to keep round
    // constants out of the program stack — light-poseidon's `Poseidon<Fr>`
    // alone overflows the 4KB BPF stack frame.
    let bytes_refs: Vec<&[u8]> = inputs.iter().map(|b| b.as_slice()).collect();
    let hash = poseidon_hashv(Parameters::Bn254X5, Endianness::BigEndian, &bytes_refs)
        .map_err(|_| error!(crate::ZX402Error::InvalidProof))?;
    Ok(hash.to_bytes())
}

/// Poseidon(2)([a, b]) — the LeanIMT parent hash and the precommitment hash.
pub fn poseidon2(a: &Fe, b: &Fe) -> Result<Fe> {
    poseidon_n(2, &[a, b])
}

/// Poseidon(3)([value, label, precommitment]) — the deposit commitment.
pub fn poseidon3(a: &Fe, b: &Fe, c: &Fe) -> Result<Fe> {
    poseidon_n(3, &[a, b, c])
}

/// Encode a u64 value as a 32-byte big-endian field element.
/// The withdraw circuit treats `withdrawnValue` as a SNARK field element, so
/// any u64 amount must be promoted before participating in proof checks.
pub fn fe_from_u64(v: u64) -> Fe {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

/// LeanIMT side-nodes ("frontier") storing the right-most node at every depth.
/// On insert, walk up from depth 0:
///   - if the leaf-index bit at this level is 0: this node has no right
///     sibling yet; record it in `side_nodes[level]` and stop hashing
///     (its parent equals itself).
///   - if the bit is 1: the left sibling lives in `side_nodes[level]`; the
///     parent is poseidon2(side_nodes[level], current_node), then continue.
/// The final "current_node" (after walking through all set bits) is the root.
///
/// `current_depth` is the smallest depth such that `1 << current_depth >= size`.
/// It grows monotonically: when a deposit_count crosses 1, 2, 4, 8, ...,
/// the depth bumps by one. This matches @zk-kit/lean-imt's behavior.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LeanImtFrontier {
    /// One stored side-node per level. Index = level (0 = leaf-row).
    pub side_nodes: [Fe; MAX_TREE_DEPTH],
    /// Number of leaves inserted so far. Doubles as the next leaf index.
    pub size: u64,
    /// `ceil(log2(max(size, 1)))`. Required as a public input in the circuit.
    pub current_depth: u8,
}

// Manual `Space` impl: anchor-derive-space's `InitSpace` doesn't handle
// `[T; N]` fields, so we compute the layout by hand:
//   side_nodes:    32 (depth) * 32 (bytes per Fe) = 1024
//   size:          8
//   current_depth: 1
impl anchor_lang::Space for LeanImtFrontier {
    const INIT_SPACE: usize = 32 * 32 + 8 + 1;
}

impl LeanImtFrontier {
    pub fn empty() -> Self {
        Self {
            side_nodes: [[0u8; 32]; MAX_TREE_DEPTH],
            size: 0,
            current_depth: 0,
        }
    }

    /// Insert a leaf and return the new root.
    ///
    /// `side_nodes[level]` always holds the canonical value of the LEFT subtree
    /// at `level` for the next insertion that will pair against it. We update
    /// it only at the level where the new leaf "parks" (the lowest level whose
    /// path bit is 0 in the new leaf's index). All levels below get cleared.
    pub fn insert(&mut self, leaf: Fe) -> Result<Fe> {
        let leaf_index = self.size;
        let new_size = self
            .size
            .checked_add(1)
            .ok_or_else(|| error!(crate::ZX402Error::InvalidProof))?;
        let new_depth = depth_for_size(new_size);
        if (new_depth as usize) > MAX_TREE_DEPTH {
            return err!(crate::ZX402Error::InvalidProof);
        }

        // Walk up while the path bit is set (i.e. the leaf is a right child),
        // hashing with the cached left sibling. At the first 0-bit level, park.
        let mut node = leaf;
        let mut level = 0usize;
        loop {
            let bit_set = ((leaf_index >> level) & 1) == 1;
            if bit_set {
                let left = self.side_nodes[level];
                node = poseidon2(&left, &node)?;
                // The pair we just consumed is gone; clear the slot. (Not strictly
                // required for correctness because we only ever read levels with
                // a 1-bit, but explicit zeros make root-recomputation simpler.)
                self.side_nodes[level] = [0u8; 32];
                level += 1;
            } else {
                self.side_nodes[level] = node;
                break;
            }
        }

        self.size = new_size;
        self.current_depth = new_depth;
        Ok(self.root())
    }

    /// Compute the current root from the frontier.
    ///
    /// Walks levels 0..current_depth: if size's bit at `level` is 1, fold the
    /// stored side-node into the running value (poseidon2 if both sides have
    /// content, otherwise propagate per LeanIMT's empty-sibling rule).
    pub fn root(&self) -> Fe {
        if self.size == 0 {
            return [0u8; 32];
        }
        // Find the lowest level whose path bit is set; that's the seed.
        let mut level = 0usize;
        while ((self.size >> level) & 1) == 0 && level < self.current_depth as usize {
            level += 1;
        }
        let mut node = self.side_nodes[level];
        level += 1;
        while level <= self.current_depth as usize {
            if ((self.size >> level) & 1) == 1 {
                // Pair with the stored left sibling at this level.
                node = poseidon2_or_zero(&self.side_nodes[level], &node);
            }
            // else: empty right sibling at this level, parent = node (LeanIMT propagation).
            level += 1;
        }
        node
    }
}

/// poseidon2 wrapper for `root()` callers that don't return Result. Zeroes
/// propagate via the LeanIMT rule (parent = the non-zero side), so a sentinel
/// zero side-node behaves correctly.
fn poseidon2_or_zero(left: &Fe, right: &Fe) -> Fe {
    if *left == [0u8; 32] {
        return *right;
    }
    if *right == [0u8; 32] {
        return *left;
    }
    // We accept a panic here because (a) Poseidon::new_circom(2) is infallible
    // for hard-coded arity 2, and (b) `root()` is read-only on otherwise-valid
    // state. If this ever fires it's an upstream library bug, not user input.
    poseidon2(left, right).unwrap_or([0u8; 32])
}

/// Depth that fits `size` leaves.
fn depth_for_size(size: u64) -> u8 {
    if size <= 1 {
        return 0;
    }
    let mut d = 0u8;
    let mut n = size - 1;
    while n > 0 {
        d += 1;
        n >>= 1;
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn withdrawal_data_binds_recipient_fee_and_relayer() {
        let recipient = Pubkey::new_from_array([1u8; 32]);
        let relayer = Pubkey::new_from_array([2u8; 32]);
        let encoded = encode_withdrawal_data(&recipient, 0x0102_0304_0506_0708, &relayer);

        assert_eq!(&encoded[..32], recipient.as_ref());
        assert_eq!(&encoded[32..40], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(&encoded[40..], relayer.as_ref());
    }

    #[test]
    fn depth_growth_matches_lean_imt() {
        // Reference values produced from @zk-kit/lean-imt:
        //   size 1  -> depth 0
        //   size 2  -> depth 1
        //   size 3  -> depth 2
        //   size 4  -> depth 2
        //   size 5  -> depth 3
        //   size 8  -> depth 3
        //   size 9  -> depth 4
        assert_eq!(depth_for_size(0), 0);
        assert_eq!(depth_for_size(1), 0);
        assert_eq!(depth_for_size(2), 1);
        assert_eq!(depth_for_size(3), 2);
        assert_eq!(depth_for_size(4), 2);
        assert_eq!(depth_for_size(5), 3);
        assert_eq!(depth_for_size(8), 3);
        assert_eq!(depth_for_size(9), 4);
    }
}
