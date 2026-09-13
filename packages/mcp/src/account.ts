/**
 * account.ts — the EOAs and notes this wallet derives from its seed.
 *
 * Everything here is a pure function of the seed, which is the whole point: nothing
 * needs backing up except 12 words, and a wiped machine reproduces every address and
 * every note. A note's secrets are the money and are issued exactly once — derivation
 * is what turns "lose the file, lose the funds" into "re-derive".
 */
import { keccak256, encodePacked, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveForwardingNote } from "@zbase-protocol/core";
import { getOrCreateSeed } from "./wallet.js";

/** secp256k1 group order. Private keys must be in [1, n-1]. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * The FUNDING address: where the user sends USDC, and the `from` of the EIP-3009
 * sweep authorization.
 *
 * Derived from the seed with its own domain tag so it can never collide with a note's
 * spend key. It is deliberately STABLE — the user needs an address they can save and
 * reuse, and it holds funds only between "sent" and "swept". It is a way-station, not
 * a balance, and it is not private: anyone can see what lands here. Privacy starts at
 * the pool deposit.
 */
export function deriveFundingKey(seed: string): Hex {
  const raw = BigInt(
    keccak256(encodePacked(["string", "string"], ["zbase-mcp-funding-v1", seed])),
  );
  const k = (raw % (SECP256K1_N - 1n)) + 1n;
  return `0x${k.toString(16).padStart(64, "0")}` as Hex;
}

/** The funding account, ready to sign the sweep authorization. */
export function deriveFundingAccount() {
  return privateKeyToAccount(deriveFundingKey(getOrCreateSeed()));
}

/**
 * The pool note at `index` — the actual money.
 *
 * Separate derivation path from the funding key (ZBASE_FORWARDING_PATH_PREFIX, a
 * hardened BIP32 path) so the address that receives USDC publicly and the secret that
 * spends it privately share no key material.
 */
export function noteAt(index: number) {
  return deriveForwardingNote(getOrCreateSeed(), index);
}
