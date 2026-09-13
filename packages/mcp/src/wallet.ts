/**
 * wallet.ts — the local seed. This is what makes the MCP server a WALLET.
 *
 * The package used to be a stateless HTTP proxy: "No secrets in this file — the MCP
 * server is a thin client wrapper" (the old config.ts). That is exactly why its
 * `deposit` tool could not chain into `pay`, and why EPHEMERAL mode existed at all —
 * it asked the model not to persist deposit secrets, while the secrets travelled
 * through tool arguments that any client may log. When the conversation ended, unspent
 * deposits became unrecoverable.
 *
 * That is inverted here, deliberately. A note's nullifier/secret ARE the money and are
 * handed over exactly once: drop them and the funds are locked in the pool forever —
 * no ragequit, no re-derivation. 0.985 USDC was lost that way on 2026-07-16 by a
 * careful implementation that had read the warning. Asking a language model to be the
 * custodian of bearer secrets is not a security model.
 *
 * So: ONE seed on disk. Every note derives from it, so the agent never handles a
 * secret and a wiped machine restores from 12 words.
 *
 * THREAT MODEL, stated plainly:
 *  - The seed sits in a 0600 file under ZBASE_HOME (default ~/.zbase). Anyone who can
 *    read that file owns the funds. This is the same trust boundary as an SSH key —
 *    honest, conventional, and far better than "a chat transcript may contain it".
 *  - It is NEVER returned by a tool, never logged, and never sent to the facilitator.
 *    The facilitator receives derived note secrets (it needs them to prove), not the
 *    seed — so a compromised facilitator can spend a note, but cannot derive the rest.
 *  - Encryption at rest is deliberately NOT implemented: a passphrase the agent must
 *    supply on every call ends up in the transcript, which is the thing we are fixing.
 *    File permissions are the boundary.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateNewMnemonic, isValidMnemonic } from "@zbase-protocol/core";

/** Where the seed lives. Override for tests or multi-wallet setups. */
export function walletHome(): string {
  return process.env.ZBASE_HOME ?? path.join(os.homedir(), ".zbase");
}

function seedPath(): string {
  return path.join(walletHome(), "seed");
}

/**
 * Load the seed, creating one on first use.
 *
 * ZBASE_SEED (env) wins if set — for CI and ephemeral containers where a file is the
 * wrong place. Otherwise the file is the source of truth.
 *
 * Written 0600 in a 0700 directory, and the DIRECTORY is created first with the right
 * mode: creating it 0755 and chmod-ing later leaves a window where the seed is world-
 * readable. Small window, total loss.
 */
export function getOrCreateSeed(): string {
  const fromEnv = process.env.ZBASE_SEED?.trim();
  if (fromEnv) {
    if (!isValidMnemonic(fromEnv)) {
      throw new Error("ZBASE_SEED is not a valid BIP39 mnemonic.");
    }
    return fromEnv;
  }

  const file = seedPath();
  if (fs.existsSync(file)) {
    const seed = fs.readFileSync(file, "utf8").trim();
    if (!isValidMnemonic(seed)) {
      throw new Error(
        `${file} does not contain a valid BIP39 mnemonic. Refusing to overwrite it — ` +
          "it may be a damaged seed holding real funds. Move it aside deliberately.",
      );
    }
    return seed;
  }

  fs.mkdirSync(walletHome(), { recursive: true, mode: 0o700 });
  const seed = generateNewMnemonic();
  // wx: fail if it appeared between the exists() check and now, rather than clobber a
  // concurrent writer's seed — that would orphan any note already derived from theirs.
  fs.writeFileSync(file, seed + "\n", { mode: 0o600, flag: "wx" });
  return seed;
}

/** True when a seed already exists (so `init` can tell you rather than surprise you). */
export function seedExists(): boolean {
  return Boolean(process.env.ZBASE_SEED?.trim()) || fs.existsSync(seedPath());
}

/**
 * Import an existing seed — the recovery path.
 *
 * Refuses to overwrite. Restoring over a live seed would orphan every note derived
 * from the old one, silently and irreversibly, and "I meant the other wallet" is a
 * very cheap mistake to make in a chat window.
 */
export function importSeed(mnemonic: string): void {
  const seed = mnemonic.trim();
  if (!isValidMnemonic(seed)) throw new Error("Not a valid BIP39 mnemonic.");
  if (seedExists()) {
    throw new Error(
      `A seed already exists at ${seedPath()}. Refusing to overwrite: every note derived ` +
        "from it would become unrecoverable. Move the file aside first if you really mean to.",
    );
  }
  fs.mkdirSync(walletHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(seedPath(), seed + "\n", { mode: 0o600, flag: "wx" });
}
