/**
 * POST /api/forwarding/register  — Phase 2 forwarding rail (auto-privatize)
 *
 * Register a WATCHED RECEIVING ADDRESS. After registering, the forwarding engine
 * (scripts/forwarding-engine.ts) watches this address for inbound USDC and — once
 * the payer passes ASP/OFAC screening — auto-deposits the funds into the pool on
 * the user's behalf, at a commitment DERIVED FROM THE USER'S OWN SEED (D3). The
 * relayer can deposit but never spend; the user recovers notes by scan-by-commitment.
 *
 * The server stores only the PUBLIC half: the watched address, the authority mode,
 * and the CURRENT precommitment to deposit at next. It NEVER receives the mnemonic
 * or the spend secrets — those are derived client-side (see
 * @zbase-protocol/core `deriveForwardingNote`).
 *
 * Body: {
 *   watchedAddress: string,   // the receiving EOA a payer sends an ordinary transfer to
 *   authorityMode: "b1",      // only B1 (relayer session key) in v1; "b2" reserved
 *   precommitment: string,    // D3-derived precommitment for the NEXT deposit index
 *   nextIndex: number,        // the index `precommitment` was derived at (advisory only —
 *                             // recovery is scan-by-commitment, so this is not trusted for
 *                             // fund-safety; it just lets the engine deposit at a fresh slot)
 *   contactEmail?: string,    // optional, for compliance/breakglass notifications
 * }
 *
 * GET /api/forwarding/register                     → list all watched addresses (public metadata)
 * GET /api/forwarding/register?address=0x..        → look up one
 *
 * SECURITY NOTE: this route does NOT itself move funds or hold a key. The B1
 * relayer key and the actual deposit happen in the engine daemon, behind the
 * `DepositAuthority` seam — a separate, key-custody-gated component.
 */

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isAddress, getAddress, verifyMessage } from "viem";
import { activeNetwork } from "@/lib/contracts";

/**
 * SECURITY (2026-07-09, fixes CRITICAL unauth-takeover flagged in review):
 * Watched addresses are PUBLIC (payers send to them on-chain). A bare
 * address-match register/update would let ANYONE overwrite a watched address's
 * `precommitment` with THEIR OWN — the engine would then deposit the victim's
 * inbound funds at a commitment the attacker's seed can spend (fund theft).
 *
 * So EVERY register/update MUST carry a signature, made by the private key of
 * `watchedAddress`, over the exact (watchedAddress, precommitment, nextIndex)
 * being registered. Only the controller of the receiving address can bind a
 * precommitment to it. The message is domain-separated + network-scoped so a
 * signature can't be replayed across chains or against a different field set.
 */
export function registrationMessage(
  watchedAddress: `0x${string}`,
  precommitment: string,
  nextIndex: number,
  network: string,
): string {
  return [
    "zBase forwarding registration",
    `network:${network}`,
    `address:${watchedAddress.toLowerCase()}`,
    `precommitment:${precommitment}`,
    `nextIndex:${nextIndex}`,
  ].join("\n");
}

const REGISTRY_PATH = path.join(process.cwd(), "data", "forwarding.json");

/** Only B1 (relayer session key) ships in v1. B2 (smart-account) is reserved. */
export type ForwardingAuthorityMode = "b1" | "b2";

export interface ForwardingRecord {
  id: string;
  /** Checksummed watched receiving address (a payer sends an ordinary transfer here). */
  watchedAddress: `0x${string}`;
  authorityMode: ForwardingAuthorityMode;
  /** D3 precommitment the engine should deposit at NEXT. Public — reveals no secret. */
  precommitment: string;
  /**
   * Advisory index that `precommitment` was derived at. NOT trusted for fund-safety
   * (recovery is scan-by-commitment from the seed); the engine uses it only to know
   * which fresh slot to fill and to detect obviously-stale registrations.
   */
  nextIndex: number;
  contactEmail: string | null;
  network: "mainnet" | "sepolia";
  registeredAt: string;
  /** How many inbound transfers the engine has auto-deposited for this address. */
  depositCount: number;
  lastDepositAt: string | null;
}

async function readRegistry(): Promise<ForwardingRecord[]> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ForwardingRecord[]) : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function writeRegistry(records: ForwardingRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(records, null, 2));
}

/** Validate a decimal field-element string (nullifier/secret/precommitment shape). */
function isFieldString(s: unknown): s is string {
  return typeof s === "string" && /^\d+$/.test(s) && s.length > 0 && s.length <= 78;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  if (!isAddress(String(b.watchedAddress ?? ""))) {
    return NextResponse.json(
      { error: "watchedAddress must be a valid 0x address." },
      { status: 400 },
    );
  }
  const watchedAddress = getAddress(String(b.watchedAddress)) as `0x${string}`;

  const authorityMode = b.authorityMode === "b2" ? "b2" : "b1";
  if (authorityMode === "b2") {
    // B2 (on-chain-enforced smart-account authority) is designed but not shipped.
    return NextResponse.json(
      { error: 'authorityMode "b2" is not available yet; use "b1".' },
      { status: 400 },
    );
  }

  if (!isFieldString(b.precommitment)) {
    return NextResponse.json(
      { error: "precommitment must be a decimal field-element string." },
      { status: 400 },
    );
  }

  const nextIndex = Number(b.nextIndex);
  if (!Number.isInteger(nextIndex) || nextIndex < 0) {
    return NextResponse.json(
      { error: "nextIndex must be a non-negative integer." },
      { status: 400 },
    );
  }

  const contactEmail =
    typeof b.contactEmail === "string" && b.contactEmail.includes("@")
      ? b.contactEmail
      : null;

  const network = activeNetwork() === "mainnet" ? "mainnet" : "sepolia";

  // ── AUTHZ (fixes CRITICAL unauth-takeover): require a signature by the
  //    watchedAddress key over (address, precommitment, nextIndex). Only the
  //    controller of the receiving address may bind a precommitment to it.
  const signature = b.signature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return NextResponse.json(
      { error: "Missing `signature`: sign the registration message with the watchedAddress key." },
      { status: 401 },
    );
  }
  const message = registrationMessage(
    watchedAddress,
    String(b.precommitment),
    nextIndex,
    network,
  );
  let sigValid = false;
  try {
    sigValid = await verifyMessage({
      address: watchedAddress,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    sigValid = false;
  }
  if (!sigValid) {
    return NextResponse.json(
      {
        error:
          "Invalid signature: it must be signed by the watchedAddress private key over the exact (address, precommitment, nextIndex) being registered.",
      },
      { status: 401 },
    );
  }

  const records = await readRegistry();

  // One watched address per registration; re-registering UPDATES the precommitment
  // (so a user can advance to a fresh slot after a deposit lands). SAFE now: the
  // update path is reached only AFTER the signature above proves the caller
  // controls `watchedAddress`, so an attacker cannot overwrite a victim's record.
  const existing = records.find(
    (r) => r.watchedAddress.toLowerCase() === watchedAddress.toLowerCase(),
  );
  if (existing) {
    existing.precommitment = String(b.precommitment);
    existing.nextIndex = nextIndex;
    if (contactEmail) existing.contactEmail = contactEmail;
    await writeRegistry(records);
    return NextResponse.json({ ok: true, record: existing, updated: true });
  }

  const record: ForwardingRecord = {
    id: `fwd_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    watchedAddress,
    authorityMode,
    precommitment: String(b.precommitment),
    nextIndex,
    contactEmail,
    network,
    registeredAt: new Date().toISOString(),
    depositCount: 0,
    lastDepositAt: null,
  };
  records.push(record);
  await writeRegistry(records);

  return NextResponse.json({ ok: true, record, updated: false });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = url.searchParams.get("address");
  const records = await readRegistry();

  // Public read view: strip PII (contactEmail) and the `precommitment`. The
  // precommitment is the EXACT value the engine deposits on-chain for this
  // address; publishing (watchedAddress, precommitment) lets an observer link
  // the pool deposit back to the public receiving address, breaking payer↔
  // deposit unlinkability. Only the trusted engine needs it — it reads the raw
  // registry via _readForwardingRegistry, not this HTTP surface.
  const toPublic = (r: ForwardingRecord) => ({
    id: r.id,
    watchedAddress: r.watchedAddress,
    authorityMode: r.authorityMode,
    nextIndex: r.nextIndex,
    network: r.network,
    registeredAt: r.registeredAt,
    depositCount: r.depositCount,
    lastDepositAt: r.lastDepositAt,
  });

  if (address) {
    if (!isAddress(address)) {
      return NextResponse.json({ error: "Invalid address." }, { status: 400 });
    }
    const rec = records.find(
      (r) => r.watchedAddress.toLowerCase() === address.toLowerCase(),
    );
    if (!rec) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ record: toPublic(rec) });
  }

  return NextResponse.json({ records: records.map(toPublic), count: records.length });
}

// Exposed for the engine + tests.
export { readRegistry as _readForwardingRegistry };
