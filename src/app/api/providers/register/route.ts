/**
 * POST /api/providers/register
 *
 * Provider opt-in for Shipment B.1 — ERC-5564 stealth recipients.
 *
 * After registering, every settlement that targets `payTo = metaAddress`
 * (or that provider's registered fallback address) will land on a fresh
 * stealth address derived from the meta-address. The facilitator publishes
 * the ephemeral pubkey + view tag so the provider can scan + sweep.
 *
 * Body: {
 *   providerName: string,     // human-readable, e.g. "Nansen API"
 *   metaAddress:  string,     // "st:base:0x<132 hex>"
 *   contactEmail: string,     // for compliance + breakglass notifications
 *   fallbackPayTo?: string,   // optional 0x-address — settlements whose payTo
 *                             // matches this address get rewritten to a stealth
 *                             // address. Useful for x402 endpoints that already
 *                             // hard-code a recipient address in their 402 response.
 * }
 *
 * GET /api/providers/register             → list all registered providers (public)
 * GET /api/providers/register?id=prov_xxx → look up one
 * GET /api/providers/register?metaAddress=st:base:... → reverse-lookup by meta-address
 */

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isAddress } from "viem";
// audit-sweep-2026-06-17: use the core package's stealth impl (F8-fixed); the
// stale src/lib/stealth.ts duplicate was deleted.
import { parseMetaAddress, isStealthMetaAddress } from "@zbase-protocol/core";
import type { PricingTier } from "@/lib/facilitator-authz";
import { activeNetwork } from "@/lib/contracts";

const REGISTRY_PATH = path.join(process.cwd(), "data", "providers.json");

/**
 * Provider-side fee tier (revenue-model-recommendation-2026-06-18.md). Only the
 * two billable tiers register here; `enterprise` is an offline-signed contract,
 * not a self-serve registration. Data-model only for now — settle still resolves
 * the fee from the payer's nullifier tier; provider-tier billing is wired with
 * the contract-invariant fee fix in the post-ceremony UTXO redesign.
 */
export type ProviderTier = Exclude<PricingTier, "enterprise">;

export interface ProviderRecord {
  id: string;
  providerName: string;
  metaAddress: string;
  contactEmail: string;
  /** Optional. When settle sees `payTo === fallbackPayTo`, it stealth-routes. */
  fallbackPayTo: string | null;
  registeredAt: string;
  schemeId: 1;
  /** How many stealth derivations have been issued for this provider. */
  derivationCount: number;
  /** Last time a stealth address was issued (ISO 8601). */
  lastDerivationAt: string | null;
  /**
   * Fee tier this provider settles at (revenue-model safe phase, 2026-06-20).
   * Optional for back-compat: records written before this field default to
   * "standard" on read. NOT yet used by settle — see ProviderTier doc.
   */
  tier?: ProviderTier;
  /**
   * Provider-controlled payout address the future contract-invariant fee check
   * will bind to (distinct from `fallbackPayTo`, which is stealth-routing). Null
   * until the provider authorizes one. Optional for back-compat.
   */
  payToAuthorized?: string | null;
}

interface RegistryFile {
  version: 1;
  providers: ProviderRecord[];
}

// In-process cache so concurrent requests don't repeatedly hit disk. The
// canonical store is still data/providers.json on disk.
let cache: RegistryFile | null = null;

async function loadRegistry(): Promise<RegistryFile> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf8");
    cache = JSON.parse(raw) as RegistryFile;
    if (!cache || cache.version !== 1 || !Array.isArray(cache.providers)) {
      cache = { version: 1, providers: [] };
    }
  } catch (err) {
    // First-run, file doesn't exist.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[provider-registry] could not read registry, starting fresh:", err);
    }
    cache = { version: 1, providers: [] };
  }
  return cache;
}

async function saveRegistry(reg: RegistryFile): Promise<void> {
  cache = reg;
  await fs.mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
  // Write to a temp file and rename for atomic durability.
  const tmp = REGISTRY_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(reg, null, 2) + "\n", "utf8");
  await fs.rename(tmp, REGISTRY_PATH);
}

/**
 * Exported for the facilitator. Returns the registered provider matching
 * either a meta-address or a fallback payTo. Case-insensitive on payTo.
 */
export async function findProviderByPayTo(
  payTo: string,
): Promise<ProviderRecord | null> {
  const reg = await loadRegistry();
  if (!payTo) return null;
  if (isStealthMetaAddress(payTo)) {
    const hit = reg.providers.find((p) => p.metaAddress === payTo);
    if (hit) return hit;
  }
  if (payTo.startsWith("0x")) {
    const lower = payTo.toLowerCase();
    const hit = reg.providers.find(
      (p) => p.fallbackPayTo && p.fallbackPayTo.toLowerCase() === lower,
    );
    if (hit) return hit;
  }
  return null;
}

/** Exported for the facilitator. Bumps stats after a stealth address is issued. */
export async function recordStealthDerivation(providerId: string): Promise<void> {
  const reg = await loadRegistry();
  const p = reg.providers.find((x) => x.id === providerId);
  if (!p) return;
  p.derivationCount += 1;
  p.lastDerivationAt = new Date().toISOString();
  await saveRegistry(reg);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    const metaAddress = typeof body.metaAddress === "string" ? body.metaAddress.trim() : "";
    const contactEmail = typeof body.contactEmail === "string" ? body.contactEmail.trim() : "";
    const fallbackPayToRaw = typeof body.fallbackPayTo === "string" ? body.fallbackPayTo.trim() : "";

    if (providerName.length < 2 || providerName.length > 120) {
      return NextResponse.json({ error: "providerName must be 2-120 chars" }, { status: 400 });
    }
    if (!isStealthMetaAddress(metaAddress)) {
      return NextResponse.json(
        { error: "metaAddress must be an ERC-5564 meta-address (st:<chain>:0x<132 hex chars>)" },
        { status: 400 },
      );
    }

    // Hard-validate by parsing; this catches bad hex / off-curve points.
    try {
      parseMetaAddress(metaAddress);
    } catch (e) {
      return NextResponse.json(
        { error: `metaAddress failed validation: ${(e as Error).message}` },
        { status: 400 },
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      return NextResponse.json({ error: "contactEmail must be a valid email" }, { status: 400 });
    }

    let fallbackPayTo: string | null = null;
    if (fallbackPayToRaw) {
      if (!isAddress(fallbackPayToRaw)) {
        return NextResponse.json(
          { error: "fallbackPayTo must be a valid 0x-prefixed Ethereum address" },
          { status: 400 },
        );
      }
      fallbackPayTo = fallbackPayToRaw;
    }

    // Fee tier (revenue-model safe phase, 2026-06-20). Optional; defaults to
    // "standard". Reject "enterprise" — that is an offline-signed contract, not a
    // self-serve registration (mirrors authorize/route.ts tier validation).
    const tierRaw = typeof body.tier === "string" ? body.tier.trim() : "standard";
    if (tierRaw !== "standard" && tierRaw !== "compliance") {
      return NextResponse.json(
        { error: 'tier must be "standard" or "compliance" (enterprise is offline-signed, not self-serve)' },
        { status: 400 },
      );
    }
    const tier: ProviderTier = tierRaw;

    // Provider-controlled payout address the future contract-invariant fee check
    // will bind to. Optional; validated as an Ethereum address when present.
    const payToAuthorizedRaw =
      typeof body.payToAuthorized === "string" ? body.payToAuthorized.trim() : "";
    let payToAuthorized: string | null = null;
    if (payToAuthorizedRaw) {
      if (!isAddress(payToAuthorizedRaw)) {
        return NextResponse.json(
          { error: "payToAuthorized must be a valid 0x-prefixed Ethereum address" },
          { status: 400 },
        );
      }
      payToAuthorized = payToAuthorizedRaw;
    }

    const reg = await loadRegistry();

    // Reject duplicate meta-address — keeps the reverse-lookup unambiguous.
    if (reg.providers.some((p) => p.metaAddress === metaAddress)) {
      return NextResponse.json(
        { error: "A provider with this metaAddress is already registered" },
        { status: 409 },
      );
    }
    if (
      fallbackPayTo &&
      reg.providers.some(
        (p) => p.fallbackPayTo && p.fallbackPayTo.toLowerCase() === fallbackPayTo!.toLowerCase(),
      )
    ) {
      return NextResponse.json(
        { error: "A provider with this fallbackPayTo is already registered" },
        { status: 409 },
      );
    }

    // Ownership proof (security-sweep-2026-06-25, HIGH: payout hijack).
    // Without this, anyone could register a victim's payout address as their own
    // fallbackPayTo/payToAuthorized; settle's findProviderByPayTo would then match
    // the attacker's record and stealth-route the victim's USDC to an address the
    // ATTACKER controls. So a claimed payout address MUST prove control via an
    // EIP-191 signature over a canonical message. Gated like authorize's F6:
    // enforced on mainnet (or when ZBASE_REQUIRE_PROVIDER_OWNERSHIP=true), optional
    // on Sepolia for back-compat with existing test registrations.
    const requireOwnership =
      String(process.env.ZBASE_REQUIRE_PROVIDER_OWNERSHIP ?? "").toLowerCase() === "true" ||
      activeNetwork() === "mainnet";
    if (requireOwnership) {
      const claimed = [fallbackPayTo, payToAuthorized].filter(
        (a): a is string => typeof a === "string" && a.length > 0,
      );
      if (claimed.length === 0) {
        return NextResponse.json(
          {
            error:
              "Ownership proof required: register at least one payout address (fallbackPayTo or payToAuthorized) and prove control of it via `ownershipSignature`.",
          },
          { status: 401 },
        );
      }
      const { verifyMessage } = await import("viem");
      const sig =
        typeof body.ownershipSignature === "string" ? body.ownershipSignature.trim() : "";
      const ownershipMessage =
        `zBase provider registration\n` +
        `metaAddress: ${metaAddress}\n` +
        `payout: ${claimed.map((a) => a.toLowerCase()).join(",")}`;
      let ownerOk = false;
      if (/^0x[0-9a-fA-F]{130}$/.test(sig)) {
        // Every claimed payout address must be controlled by the SAME signer key.
        try {
          const results = await Promise.all(
            claimed.map((addr) =>
              verifyMessage({
                address: addr as `0x${string}`,
                message: ownershipMessage,
                signature: sig as `0x${string}`,
              }),
            ),
          );
          ownerOk = results.every(Boolean);
        } catch {
          ownerOk = false;
        }
      }
      if (!ownerOk) {
        return NextResponse.json(
          {
            error:
              "Ownership proof required: sign the registration message with EACH payout wallet and resend as `ownershipSignature`. (One signer must control all claimed payout addresses.)",
            ownershipMessage,
          },
          { status: 401 },
        );
      }
    }

    const id = `prov_${crypto.randomBytes(8).toString("hex")}`;
    const record: ProviderRecord = {
      id,
      providerName,
      metaAddress,
      contactEmail,
      fallbackPayTo,
      registeredAt: new Date().toISOString(),
      schemeId: 1,
      derivationCount: 0,
      lastDerivationAt: null,
      tier,
      payToAuthorized,
    };

    reg.providers.push(record);
    await saveRegistry(reg);

    console.log(`[provider-registry] registered: ${providerName} (${id})`);

    return NextResponse.json({
      registered: true,
      provider: {
        id,
        providerName,
        metaAddress,
        contactEmail,
        fallbackPayTo,
        schemeId: 1,
        registeredAt: record.registeredAt,
        tier,
        payToAuthorized,
      },
      note:
        "Settlements whose payTo equals this metaAddress (or the registered fallbackPayTo) " +
        "will be routed to a fresh stealth address. Scan ephemeralPubkey events to claim funds.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message?.slice(0, 300) || "Unknown error" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const meta = url.searchParams.get("metaAddress");

  const reg = await loadRegistry();

  if (id) {
    const p = reg.providers.find((x) => x.id === id);
    if (!p) {
      return NextResponse.json({ error: `Provider ${id} not found` }, { status: 404 });
    }
    return NextResponse.json({ provider: publicView(p) });
  }

  if (meta) {
    const p = reg.providers.find((x) => x.metaAddress === meta);
    if (!p) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }
    return NextResponse.json({ provider: publicView(p) });
  }

  return NextResponse.json({
    providers: reg.providers.map(publicView),
    count: reg.providers.length,
  });
}

function publicView(p: ProviderRecord) {
  // Surface only fields safe to expose. Email is kept out of the listing.
  // Back-compat: records written before the fee-tier fields default tier to
  // "standard" and payToAuthorized to null on read (2026-06-20).
  return {
    id: p.id,
    providerName: p.providerName,
    metaAddress: p.metaAddress,
    fallbackPayTo: p.fallbackPayTo,
    schemeId: p.schemeId,
    registeredAt: p.registeredAt,
    derivationCount: p.derivationCount,
    lastDerivationAt: p.lastDerivationAt,
    tier: p.tier ?? "standard",
    payToAuthorized: p.payToAuthorized ?? null,
  };
}
