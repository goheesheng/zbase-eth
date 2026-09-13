/**
 * Authorization store + pricing model for the zBase facilitator.
 *
 * Path D (2026-06-06): buyers pre-pay an access fee to unlock their
 * nullifier for unlimited settles.
 *
 * PRICING MODEL (2026-07-10): ONE flat 5% tier — compliant by default.
 *
 *   - single tier:  5.00% take, $0.002 floor (Sepolia) / $0.001 (mainnet)
 *                   → ZK-unlinkable settles WITH universal OFAC/ASP screening.
 *                     zBase is compliant BY DESIGN: every deposit + withdrawal is
 *                     screened regardless of tier, so there is no separate
 *                     "compliance" product to upsell — compliance is the baseline.
 *                     (The old standard/compliance split charged 3× for the
 *                     identical settlement; collapsed here. The `compliance` tier
 *                     label is a deprecated alias that also resolves to 5%.)
 *   - enterprise:   flat monthly subscription ($2,500-$25,000/mo), no per-settle take
 *                   → the REAL premium product is DATA: a self-sovereign,
 *                     viewing-key-gated dataset of the enterprise's OWN agents'
 *                     transactions, for their AML screening / reporting. Only a
 *                     privacy-native facilitator can offer "self-custody your
 *                     compliance data." Sales-managed onboarding; the data-export
 *                     feature lands with the UTXO/notes rail (needs encrypted
 *                     per-note transfers to scan).
 *
 * Rate rationale (5% flat):
 *   - Matches BlockRun's 5% ceiling — the profitable revenue reference in this
 *     lane. Priced AT the ceiling (not under) because zBase is compliant-by-
 *     default + no-token + owns the payee-side x402 settlement lane. Privacy is a
 *     premium; competing on being cheapest is a weak position.
 *   - $0.002 / $0.001 floor catches micropayment cases where pure-percentage
 *     would collapse below cost. minimumSettleAtomic recomputes from bps+floor.
 *
 * Reality check: revenue bottleneck is DEMAND, not the rate. A 5% rate on a
 * product with no paying users yet is a positioning statement, not revenue.
 * FEE_REQUIRED stays false until the anonymity set is dense; validate the rate
 * with a paying integrator before assuming it holds.
 */

import { Redis } from "@upstash/redis";
import type { Chain } from "viem";
import { base, baseSepolia, sepolia } from "viem/chains";
import { activeNetwork } from "@/lib/contracts";

// ── Backend selection ──────────────────────────────────────────────
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const USE_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

// B7 fail-closed (audit-sweep-2026-06-17): without Upstash, authorization +
// consumed-tx replay protection degrade to PER-INSTANCE in-memory maps. On
// Vercel's multi-instance serverless that is a real fee + replay bypass at
// scale (an access-token tx can be consumed once per instance; authorizations
// recorded on one instance are invisible to others and lost on cold start).
// On mainnet that means lost revenue + double-spend of paid access. Refuse to
// run the facilitator on mainnet with the in-memory fallback — fail loudly at
// module load rather than silently bypassing. Sepolia (testnet $) still allows
// the in-memory fallback for local dev.
if (activeNetwork() === "mainnet" && !USE_UPSTASH) {
  throw new Error(
    "facilitator-authz: NEXT_PUBLIC_NETWORK=mainnet requires a shared Upstash/KV " +
      "store (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or the " +
      "KV_REST_API_* equivalents). The in-memory fallback is per-instance and " +
      "would allow fee/replay bypass on mainnet. Refusing to start.",
  );
}

const redis = USE_UPSTASH
  ? new Redis({ url: UPSTASH_URL!, token: UPSTASH_TOKEN! })
  : null;

// In-memory fallback (used when Upstash env vars are absent — dev/Sepolia only;
// mainnet is blocked above).
const memAuthorized = new Map<string, string>(); // key → tier
const memConsumedTxHashes = new Set<string>();
// User-wallet freemium (Step G, 2026-06-23): which user addresses hold a premium
// upgrade. Same store + in-memory-fallback rules as authorizations.
const memUserPremium = new Set<string>();

// Redis key namespace + TTLs.
const AUTH_KEY = (network: string, nullifier: string) =>
  `zbase:authz:${network}:${nullifier.toLowerCase()}`;
// AUDIT MEDIUM #5 (2026-07-09): the consumed-tx key is namespaced by PURPOSE.
// Previously /authorize (facilitator access) and /user/upgrade (premium) shared
// one key `zbase:consumed-tx:{network}:{txHash}`, so a single treasury payment
// could be consumed by whichever endpoint ran first — burning the other and
// denying a user the thing they paid for. Distinct purposes → distinct keyspaces.
export type TxConsumePurpose = "authz" | "premium";
const TX_KEY = (network: string, txHash: string, purpose: TxConsumePurpose) =>
  `zbase:consumed-tx:${purpose}:${network}:${txHash.toLowerCase()}`;
const PREMIUM_KEY = (network: string, address: string) =>
  `zbase:premium:${network}:${address.toLowerCase()}`;
const AUTH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const TX_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const PREMIUM_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days (subscription window)

// ── Pricing config ─────────────────────────────────────────────────
//
// Take rate expressed in basis points (bps). 1 bp = 0.01%.
//   500 bps = 5.00% — SINGLE flat tier (compliant by default).
//
// 2026-07-10: collapsed the old standard(100)/compliance(300) split to one 5% rate.
// The split charged 3× for the identical settlement (screening is universal, no
// attestation ever backed the "compliance" tier). 5% matches BlockRun's ceiling;
// priced AT it (not under) because zBase is compliant-by-default + no-token + owns
// the payee-side x402 lane — privacy is a premium, not a race to cheapest. Both
// tier labels resolve to 500 bps (compliance is a deprecated alias). The real
// premium is the enterprise DATA product, not a settle surcharge. Env-reversible.
//
// Floors are in atomic USDC (6 decimals). $0.002 = 2000 atomic.
//
// All env-var configurable so we can tune post-launch without redeploy.

const TREASURY_ADDRESS = (
  process.env.ZBASE_FEE_TREASURY ??
  "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21"
).toLowerCase();

export type PricingTier = "standard" | "compliance" | "enterprise";

// PRICING MODEL (2026-07-10): SINGLE 5% flat tier. zBase is compliant-by-DESIGN —
// the OFAC/ASP screening runs on EVERY deposit + withdrawal regardless of tier, so
// "standard" was already compliant and the old "compliance" tier charged 3× for the
// identical product (no attestation/report ever existed behind it). Collapsed to one
// 5% rate (matching BlockRun's 5% ceiling; justified by compliant-by-default +
// no-token + the payee-side x402 lane). Both `standard` and `compliance` resolve to
// 500 bps so any nullifier authorized under either label bills identically and
// resolveEffectiveFeeTier keeps working; the `compliance` label is deprecated (a
// future revision removes it). The REAL premium product is enterprise — a
// self-sovereign, viewing-key-gated dataset of an enterprise's OWN agents'
// transactions for their AML/reporting (a data product, not a settle surcharge).
const TAKE_BPS: Record<PricingTier, bigint> = {
  standard: BigInt(process.env.ZBASE_FEE_STANDARD_BPS ?? "500"), // 5.00% (single compliant-by-default rate)
  compliance: BigInt(process.env.ZBASE_FEE_COMPLIANCE_BPS ?? "500"), // 5.00% — deprecated alias of standard
  enterprise: 0n, // enterprise is a flat-fee subscription + data product, no per-settle take
};

// Single floor per network now that there's one rate. minimumSettleAtomic =
// ceil(floor*10000/bps) recomputes from these automatically (L268).
const FLOOR_SEPOLIA: Record<PricingTier, bigint> = {
  standard: BigInt(process.env.ZBASE_FEE_FLOOR_STANDARD_SEPOLIA ?? "2000"), // $0.002
  compliance: BigInt(process.env.ZBASE_FEE_FLOOR_COMPLIANCE_SEPOLIA ?? "2000"), // $0.002 (unified)
  enterprise: 0n,
};

const FLOOR_MAINNET: Record<PricingTier, bigint> = {
  // 2026-06-20: lowered so small agent micropayments aren't HTTP-400-rejected. The
  // floor sets minimumSettleAtomic = ceil(floor*10000/bps). At $0.001 floor / 500bps
  // (the 5% rate) the minimum settle is ceil(1000*10000/500) = 20000 atomic = ~$0.02
  // — rejects only true dust. Reversible via env. Not enforced while FEE_REQUIRED=false.
  standard: BigInt(process.env.ZBASE_FEE_FLOOR_STANDARD_MAINNET ?? "1000"), // $0.001
  compliance: BigInt(process.env.ZBASE_FEE_FLOOR_COMPLIANCE_MAINNET ?? "1000"), // $0.001 (unified)
  enterprise: 0n,
};

// Access-token fee charged at /authorize time (one-time per nullifier).
// Separate from the per-settle take. This is the "ticket purchase" — proves
// the buyer paid for facilitator access. One value per network now (one tier).
const ACCESS_FEE_SEPOLIA: Record<PricingTier, bigint> = {
  standard: BigInt(process.env.ZBASE_ACCESS_STANDARD_SEPOLIA ?? "1000"), // $0.001
  compliance: BigInt(process.env.ZBASE_ACCESS_COMPLIANCE_SEPOLIA ?? "1000"), // $0.001 (unified)
  enterprise: 0n, // enterprise gets access via offline-signed contract, not /authorize
};

const ACCESS_FEE_MAINNET: Record<PricingTier, bigint> = {
  standard: BigInt(process.env.ZBASE_ACCESS_STANDARD_MAINNET ?? "5000"), // $0.005
  compliance: BigInt(process.env.ZBASE_ACCESS_COMPLIANCE_MAINNET ?? "5000"), // $0.005 (unified)
  enterprise: 0n,
};

const FEE_REQUIRED =
  String(process.env.ZBASE_FEE_REQUIRED ?? "false").toLowerCase() === "true";

// ETHONLINE-2026: Ethereum Sepolia added as a first-class facilitator network
// alongside Base Sepolia + Base mainnet. It is a TESTNET, so it shares the
// Sepolia fee/floor/access tables (via isTestnetNetwork) rather than getting
// its own copy — only chain-specific values (chainId, viem Chain, USDC
// address) get a dedicated entry.
export const FACILITATOR_NETWORKS = [
  "eip155:84532",
  "eip155:8453",
  "eip155:11155111",
] as const;
export type FacilitatorNetwork = (typeof FACILITATOR_NETWORKS)[number];

export function isFacilitatorNetwork(x: unknown): x is FacilitatorNetwork {
  return (
    typeof x === "string" &&
    (FACILITATOR_NETWORKS as readonly string[]).includes(x)
  );
}

const CHAIN_ID_BY_NETWORK: Record<FacilitatorNetwork, 84532 | 8453 | 11155111> = {
  "eip155:84532": 84532,
  "eip155:8453": 8453,
  "eip155:11155111": 11155111,
};

export function chainIdForNetwork(
  network: FacilitatorNetwork,
): 84532 | 8453 | 11155111 {
  return CHAIN_ID_BY_NETWORK[network];
}

const VIEM_CHAIN_BY_NETWORK: Record<FacilitatorNetwork, Chain> = {
  "eip155:84532": baseSepolia,
  "eip155:8453": base,
  "eip155:11155111": sepolia,
};

export function viemChainForNetwork(network: FacilitatorNetwork): Chain {
  return VIEM_CHAIN_BY_NETWORK[network];
}

/**
 * True for testnet networks (Base Sepolia + Ethereum Sepolia). Used to select
 * the shared testnet fee/floor/access tables instead of maintaining a
 * separate copy per testnet — only `eip155:8453` (Base mainnet) is "not
 * testnet" here.
 */
export function isTestnetNetwork(network: FacilitatorNetwork): boolean {
  return network === "eip155:84532" || network === "eip155:11155111";
}

// ── Public pricing API ─────────────────────────────────────────────

/**
 * Access-token fee a buyer must pay at /authorize to unlock the tier.
 * This is the on-chain USDC transfer to treasury verified by /authorize.
 */
export function accessFeeAtomic(
  network: FacilitatorNetwork,
  tier: PricingTier,
): bigint {
  const table = isTestnetNetwork(network) ? ACCESS_FEE_SEPOLIA : ACCESS_FEE_MAINNET;
  return table[tier];
}

/**
 * Compute the per-settle fee for a given payment amount + tier.
 * Returns: max(payment * bps / 10000, floor).
 *
 * The fee is taken OUT of the settle amount on-chain by the pool contract
 * (via the relay struct's feeRecipient + relayFeeBPS fields — landed in
 * PR2026-06-08). The contract enforces the percentage; this function
 * computes the SAME number client-side so SDKs can estimate cost without
 * a round-trip. The floor is enforced separately via minimumSettleAtomic()
 * (see below) — settles below the floor are rejected at /settle with HTTP 400
 * so the percentage take always meets or exceeds the floor.
 *
 * Example for standard tier on Sepolia ($0.005 settle):
 *   take = max(5000 × 30 / 10000, 2000) = max(15, 2000) = 2000 atomic
 *   recipient gets: $0.005 - $0.002 = $0.003
 *   treasury gets:  $0.002
 *
 * Note: because the on-chain pool only enforces bps (not a floor), and
 * minimumSettleAtomic() rejects sub-floor settles upstream, the actual
 * on-chain fee always equals (paymentAmount × bps / 10000) — the floor
 * is purely a gate, not a separate on-chain mechanism.
 */
export function perSettleFeeAtomic(
  paymentAmount: bigint,
  network: FacilitatorNetwork,
  tier: PricingTier,
): bigint {
  if (tier === "enterprise") return 0n;
  const bps = TAKE_BPS[tier];
  const floors = isTestnetNetwork(network) ? FLOOR_SEPOLIA : FLOOR_MAINNET;
  const percentageFee = (paymentAmount * bps) / 10000n;
  const floor = floors[tier];
  return percentageFee > floor ? percentageFee : floor;
}

/**
 * The per-settle take rate (basis points) for a tier. Single source of truth so
 * API responses never hardcode a stale rate. `takePercentFor` returns the
 * human percent string.
 */
export function takeBpsFor(tier: PricingTier): number {
  return Number(TAKE_BPS[tier]);
}
export function takePercentFor(tier: PricingTier): string {
  return (Number(TAKE_BPS[tier]) / 100).toString() + "%";
}

/**
 * Minimum settle amount that keeps the on-chain percentage take at or
 * above the configured floor. Below this, the bps-only on-chain fee would
 * be less than the floor and /settle rejects the request with HTTP 400.
 *
 * Math: ceil(floor × 10000 / bps) — the smallest integer payment whose
 * percentage take (truncated by BigInt division) still meets or exceeds
 * the floor. Pre-fix used `floor × 10000 / bps + 1` which was off-by-one
 * on standard tier (returned 666667 but 666667 × 30 / 10000 truncates to
 * 1999, below the 2000 floor — found 2026-06-08 by QA agent).
 *
 * Ceiling formula in BigInt: `(a + b - 1) / b` rounds a/b up. Substituting
 * a = floor × 10000, b = bps gives:
 *   `(floor * 10000 + bps - 1) / bps`
 *
 * Verify: standard Sepolia = (2000 × 10000 + 30 - 1) / 30 = 20000029 / 30
 * = 666667 (truncated). 666667 × 30 / 10000 = 19999990 / 10000 = 1999...
 * still 1999! The issue is that ANY payment exactly at the ceiling has
 * take = floor - tiny_fraction, which truncates down. We need the SMALLEST
 * payment whose `(payment × bps) / 10000 >= floor` HOLDS in BigInt.
 *
 * Correct algorithm: solve `payment × bps >= floor × 10000` →
 *   payment >= floor × 10000 / bps (real division)
 *   payment >= ceil(floor × 10000 / bps) (integer)
 *
 * Verify: floor=2000, bps=30 → 2000*10000=20000000, divide by 30 → 666666.67
 * → ceil = 666667. Check: 666667 × 30 = 20000010, divide by 10000 = 2000 ✓
 *
 * So ceiling formula DOES work — the test was wrong about 666667 being broken.
 * Let me re-derive: 666667 × 30 = 20,000,010. Divide by 10000 (BigInt trunc)
 * = 2000. Exactly meets the floor. So the +1 was unnecessary AND incorrect.
 * Drop the +1, use pure ceiling.
 *
 * For standard Sepolia: ceil(2000 × 10000 / 30) = ceil(666666.67) = 666667 atomic.
 * For compliance Sepolia: ceil(10000 × 10000 / 100) = 1000000 atomic exactly.
 *
 * Returns 0 for enterprise (no per-settle take, no minimum).
 */
export function minimumSettleAtomic(
  network: FacilitatorNetwork,
  tier: PricingTier,
): bigint {
  if (tier === "enterprise") return 0n;
  const bps = TAKE_BPS[tier];
  const floors = isTestnetNetwork(network) ? FLOOR_SEPOLIA : FLOOR_MAINNET;
  const floor = floors[tier];
  // Ceiling division: (a + b - 1) / b rounds a/b up when a, b are positive.
  const numerator = floor * 10000n;
  return (numerator + bps - 1n) / bps;
}

export function treasuryAddress(): string {
  return TREASURY_ADDRESS;
}

export function feeEnforced(): boolean {
  return FEE_REQUIRED;
}

export function storageBackend(): "upstash" | "memory" {
  return USE_UPSTASH ? "upstash" : "memory";
}

/**
 * Public pricing structure for /api/facilitator/supported.
 *
 * Framing (2026-06-08): testnet free for development / mainnet paid for
 * production. Per-settle take is enforced ON-CHAIN via the pool contract's
 * relayFeeBPS field — buyers see actual on-chain bills on testnet before
 * mainnet, so there are no economic surprises at flip time.
 *
 * Returns the full pricing matrix so SDKs/integrators can compute their
 * own cost estimates client-side without round-tripping.
 */
export function pricingStructure() {
  return {
    model: "Per-deposit access fee + on-chain per-settle percentage take",
    enforced: FEE_REQUIRED,
    storageBackend: storageBackend(),
    networks: {
      "eip155:84532": {
        name: "Base Sepolia (testnet)",
        pricingMode: "free-for-testing",
        note:
          "Testnet is free for development. Access fee + per-settle take are " +
          "paid in Sepolia USDC (faucet-funded, no real value). The same fee " +
          "mechanism that runs on mainnet runs here too, so you can size your " +
          "agent's economics before flipping to production.",
      },
      "eip155:8453": {
        name: "Base mainnet (production)",
        pricingMode: "paid",
        note:
          "Production pricing. Access fee + per-settle take are real USDC " +
          "routed on-chain to the treasury wallet.",
      },
      "eip155:11155111": {
        name: "Ethereum Sepolia (testnet)",
        pricingMode: "free-for-testing",
        note:
          "Testnet is free for development. Shares the Base Sepolia fee/floor " +
          "tables (both testnets use the same pricing) — access fee + per-settle " +
          "take are paid in Ethereum Sepolia USDC (faucet-funded, no real value).",
      },
    },
    tiers: {
      standard: {
        takeBps: Number(TAKE_BPS.standard),
        takePercent: (Number(TAKE_BPS.standard) / 100).toString() + "%",
        accessFee: {
          sepoliaAtomic: ACCESS_FEE_SEPOLIA.standard.toString(),
          sepoliaUsdc: (Number(ACCESS_FEE_SEPOLIA.standard) / 1_000_000).toString(),
          mainnetAtomic: ACCESS_FEE_MAINNET.standard.toString(),
          mainnetUsdc: (Number(ACCESS_FEE_MAINNET.standard) / 1_000_000).toString(),
        },
        minimumSettle: {
          sepoliaAtomic: minimumSettleAtomic("eip155:84532", "standard").toString(),
          sepoliaUsdc: (Number(minimumSettleAtomic("eip155:84532", "standard")) / 1_000_000).toFixed(6),
          mainnetAtomic: minimumSettleAtomic("eip155:8453", "standard").toString(),
          mainnetUsdc: (Number(minimumSettleAtomic("eip155:8453", "standard")) / 1_000_000).toFixed(6),
        },
        target: "AI agents wanting basic ZK-unlinkable settles. No SLA. No compliance attestation.",
      },
      compliance: {
        takeBps: Number(TAKE_BPS.compliance),
        takePercent: (Number(TAKE_BPS.compliance) / 100).toString() + "%",
        accessFee: {
          sepoliaAtomic: ACCESS_FEE_SEPOLIA.compliance.toString(),
          sepoliaUsdc: (Number(ACCESS_FEE_SEPOLIA.compliance) / 1_000_000).toString(),
          mainnetAtomic: ACCESS_FEE_MAINNET.compliance.toString(),
          mainnetUsdc: (Number(ACCESS_FEE_MAINNET.compliance) / 1_000_000).toString(),
        },
        minimumSettle: {
          sepoliaAtomic: minimumSettleAtomic("eip155:84532", "compliance").toString(),
          sepoliaUsdc: (Number(minimumSettleAtomic("eip155:84532", "compliance")) / 1_000_000).toFixed(6),
          mainnetAtomic: minimumSettleAtomic("eip155:8453", "compliance").toString(),
          mainnetUsdc: (Number(minimumSettleAtomic("eip155:8453", "compliance")) / 1_000_000).toFixed(6),
        },
        target: "Regulated agent operators. Audit-ready settle receipts.",
      },
      enterprise: {
        takeBps: 0,
        subscription: "custom",
        target: "Dedicated infra, custom ASP signer, white-label endpoint. Contact @zbase__ on Twitter.",
        howToAccess: "Out-of-band onboarding; nullifiers recorded by zBase sales, not via /authorize.",
      },
    },
    treasury: TREASURY_ADDRESS,
    note:
      "Per-settle fee = paymentAmount × takeBps / 10000, enforced ON-CHAIN by the pool " +
      "contract via the relay struct's feeRecipient + relayFeeBPS fields. Settles below " +
      "minimumSettle are rejected with HTTP 400 (so the percentage take is always ≥ floor).",
    docs: "https://docs.zbase.app",
  };
}

// ── Authorization API ────────────────────────────────────────────
//
// Authorization now records the TIER as well — the tier the buyer paid
// for at /authorize time. The settle endpoint reads the tier back to
// compute the right per-settle fee.

// Tier priority for upgrade-only writes. Higher number = higher-paying tier.
// Used by recordAuthorization to prevent downgrade attacks (FIND-302):
// a buyer who authorized compliance ($0.010 access + 100 bps) cannot
// re-authorize the same nullifier as standard ($0.001 access + 30 bps)
// to save 70 bps on settles.
const TIER_RANK: Record<PricingTier, number> = {
  standard: 1,
  compliance: 2,
  enterprise: 3,
};

/**
 * AUDIT HIGH #3 (2026-07-09): resolve the EFFECTIVE fee tier from the seller's
 * provider tier and the payer's nullifier tier. The prior code used
 * `providerTier ?? nullifierTier`, so a `standard` provider record
 * UNCONDITIONALLY overrode a `compliance` nullifier — downgrading the take from
 * 300 to 100 bps (the same compliance→standard downgrade FIND-302 fixed for
 * re-authorization, re-introduced at settle/withdraw fee resolution).
 *
 * Correct rule: charge the HIGHER take. We compare by actual bps (via
 * takeBpsFor) rather than TIER_RANK, because `enterprise` ranks highest but
 * means 0 bps — so a rank-max would wrongly zero the fee. Comparing bps yields
 * the fee the protocol actually committed to on /supported + /authorize.
 * `null` tiers contribute 0 bps (fee-free grace path is preserved).
 */
export function resolveEffectiveFeeTier(
  providerTier: PricingTier | null,
  nullifierTier: PricingTier | null,
): PricingTier | null {
  if (!providerTier) return nullifierTier;
  if (!nullifierTier) return providerTier;
  const providerBps = providerTier === "enterprise" ? 0 : takeBpsFor(providerTier);
  const nullifierBps = nullifierTier === "enterprise" ? 0 : takeBpsFor(nullifierTier);
  return providerBps >= nullifierBps ? providerTier : nullifierTier;
}

export async function recordAuthorization(
  network: FacilitatorNetwork,
  nullifierHash: string,
  tier: PricingTier = "standard",
): Promise<void> {
  // Upgrade-only semantics: if a tier is already recorded for this nullifier,
  // only overwrite if the new tier is RANK-HIGHER. Closes FIND-302 from the
  // 2026-06-08 pentest (compliance→standard downgrade race).
  const existing = await getAuthorizedTier(network, nullifierHash);
  if (existing && TIER_RANK[existing] >= TIER_RANK[tier]) {
    // No-op: existing tier is same or higher. Refresh TTL only.
    if (redis) {
      await redis.expire(AUTH_KEY(network, nullifierHash), AUTH_TTL_SECONDS);
    }
    return;
  }
  if (redis) {
    // Store the tier as the value (not "ok" — old hardcoded sentinel).
    // Pre-fix legacy values may be `1` (number) or `"ok"` (string) — those
    // are treated as standard tier by isAuthorized's null-check.
    await redis.set(AUTH_KEY(network, nullifierHash), tier, {
      ex: AUTH_TTL_SECONDS,
    });
  } else {
    memAuthorized.set(`${network}:${nullifierHash.toLowerCase()}`, tier);
  }
}

/**
 * Read the tier a nullifier was authorized for. Returns null if not authorized.
 *
 * Handles three Upstash value shapes due to historical migrations:
 *   - "standard" | "compliance" | "enterprise" (post-2026-06-07 hybrid model)
 *   - "ok" (post-2026-06-07 KV migration, pre-hybrid — treat as standard)
 *   - 1 as number (pre-2026-06-07 KV migration when we wrote "1" + auto-deser
 *     parsed it back as number — treat as standard)
 *
 * Returns null only when Redis has no key at all.
 */
export async function getAuthorizedTier(
  network: FacilitatorNetwork,
  nullifierHash: string,
): Promise<PricingTier | null> {
  if (redis) {
    const v = await redis.get(AUTH_KEY(network, nullifierHash));
    if (v === null || v === undefined) return null;
    if (v === "compliance") return "compliance";
    if (v === "enterprise") return "enterprise";
    // "standard", "ok", 1, or any other non-null value → treat as standard
    return "standard";
  }
  const tier = memAuthorized.get(`${network}:${nullifierHash.toLowerCase()}`);
  if (!tier) return null;
  if (tier === "compliance" || tier === "enterprise") return tier;
  return "standard";
}

/**
 * Convenience: boolean wrapper for callers that don't care about tier.
 * Returns true if the nullifier has ANY authorization (any tier).
 */
export async function isAuthorized(
  network: FacilitatorNetwork,
  nullifierHash: string,
): Promise<boolean> {
  return (await getAuthorizedTier(network, nullifierHash)) !== null;
}

// ── User-wallet freemium (Step G, 2026-06-23) ────────────────────
//
// The human revenue line: free to transact, pay for opt-in PREMIUM value-adds
// (instant withdraw, higher limits, …) — NOT a deposit tax (that's Veil's me-too
// trap; we keep the no-gate wedge). This is the storage + flag layer; the first
// premium feature gated on it is the expedited withdraw path. Inert while
// FEE_REQUIRED=false. Mirrors the authorization store (Upstash → in-memory
// fallback, mainnet requires Upstash via the guard above).

/** Mark a user address as premium (after a verified upgrade payment). 30-day window. */
export async function recordUserPremium(
  network: FacilitatorNetwork,
  address: string,
): Promise<void> {
  if (redis) {
    await redis.set(PREMIUM_KEY(network, address), "premium", {
      ex: PREMIUM_TTL_SECONDS,
    });
  } else {
    memUserPremium.add(`${network}:${address.toLowerCase()}`);
  }
}

/** True if the user address currently holds a premium upgrade. */
export async function userIsPremium(
  network: FacilitatorNetwork,
  address: string,
): Promise<boolean> {
  if (redis) {
    const v = await redis.get(PREMIUM_KEY(network, address));
    return v !== null && v !== undefined;
  }
  return memUserPremium.has(`${network}:${address.toLowerCase()}`);
}

// ── Replay protection: consumed access-token tx hashes ───────────

export async function tryConsumeTxHash(
  network: FacilitatorNetwork,
  txHash: string,
  purpose: TxConsumePurpose = "authz",
): Promise<boolean> {
  if (redis) {
    const result = await redis.set(TX_KEY(network, txHash, purpose), "ok", {
      ex: TX_TTL_SECONDS,
      nx: true,
    });
    return result !== null;
  }
  const key = `${purpose}:${network}:${txHash.toLowerCase()}`;
  if (memConsumedTxHashes.has(key)) return false;
  memConsumedTxHashes.add(key);
  return true;
}

// ── Deprecated single-tier API (kept for backwards-compat callers) ──

/**
 * @deprecated Use accessFeeAtomic(network, tier) instead.
 * Returns the STANDARD tier's access fee for backwards compatibility.
 */
export function expectedFeeAtomic(network: FacilitatorNetwork): bigint {
  return accessFeeAtomic(network, "standard");
}
