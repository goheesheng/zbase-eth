import { NextResponse } from "next/server";
import { createPublicClient, http, isAddress } from "viem";
import {
  treasuryAddress,
  feeEnforced,
  recordUserPremium,
  userIsPremium,
  tryConsumeTxHash,
  type FacilitatorNetwork,
} from "@/lib/facilitator-authz";
import { getActiveStack, getActiveChain } from "@/lib/contracts";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

/**
 * POST /api/user/upgrade — user-wallet freemium (Step G, 2026-06-23).
 *
 * The HUMAN revenue line: transacting (deposit/transfer/withdraw) is FREE; a user
 * opts into PREMIUM value-adds (first: instant withdraw) by paying a small upgrade
 * fee in USDC to the treasury, then POSTing the tx hash here. This is NOT a deposit
 * tax (that's Veil's me-too trap) — it's a feature upgrade, so the no-gate wedge is
 * preserved.
 *
 * Verification mirrors /api/facilitator/authorize: confirm an on-chain USDC
 * Transfer to the treasury of >= the upgrade fee, replay-protect the tx hash, then
 * record the user address as premium (30-day window). Inert while FEE_REQUIRED=false
 * (returns a no-op success so dev/testing works without paying).
 *
 * GET /api/user/upgrade?address=0x... — check premium status + the price.
 */

// Upgrade price (atomic USDC). Env-tunable; defaults chosen to be a small, legible
// flat fee, not a % meter. Sepolia tiny for testing; mainnet a real monthly-ish fee.
const UPGRADE_FEE_SEPOLIA = BigInt(process.env.ZBASE_PREMIUM_FEE_SEPOLIA ?? "10000"); // $0.01
const UPGRADE_FEE_MAINNET = BigInt(process.env.ZBASE_PREMIUM_FEE_MAINNET ?? "5000000"); // $5.00

function upgradeFee(network: FacilitatorNetwork): bigint {
  return network === "eip155:8453" ? UPGRADE_FEE_MAINNET : UPGRADE_FEE_SEPOLIA;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = url.searchParams.get("address");
  const network = getActiveStack().facilitatorNetwork;
  const fee = upgradeFee(network);
  const body: Record<string, unknown> = {
    network,
    treasury: treasuryAddress(),
    enforced: feeEnforced(),
    premiumFeeAtomic: fee.toString(),
    premiumFeeUsdc: (Number(fee) / 1_000_000).toString(),
    features: ["instant-withdraw"],
    note: "Free to transact. Premium unlocks opt-in value-adds (currently: instant withdraw). Pay the fee in USDC to the treasury, then POST the tx hash to upgrade.",
  };
  if (address && isAddress(address)) {
    body.address = address;
    body.premium = await userIsPremium(network, address);
  }
  return NextResponse.json(body);
}

export async function POST(request: Request) {
  try {
    const limited = await checkRateLimit(request, "user-upgrade");
    if (!limited.success) return rateLimitResponse(limited);

    const bodyJson = await request.json();
    const address = typeof bodyJson.address === "string" ? bodyJson.address.trim() : "";
    const txHash = typeof bodyJson.txHash === "string" ? bodyJson.txHash.trim() : "";

    if (!isAddress(address)) {
      return NextResponse.json({ error: "address must be a valid 0x address" }, { status: 400 });
    }

    const network = getActiveStack().facilitatorNetwork;

    // When fees are not enforced (dev/cold-start), grant premium without payment
    // so integration/testing works for free — same posture as the rest of the
    // fee layer under FEE_REQUIRED=false.
    if (!feeEnforced()) {
      await recordUserPremium(network, address);
      return NextResponse.json({
        upgraded: true,
        address,
        network,
        enforced: false,
        note: "FEE_REQUIRED=false — premium granted without payment (dev/cold-start). Will require the upgrade fee once fees are enforced.",
      });
    }

    // Enforced path: verify an on-chain USDC Transfer to treasury >= the fee.
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return NextResponse.json(
        { error: "txHash must be a 0x-prefixed 32-byte hex string (the USDC upgrade payment)" },
        { status: 400 },
      );
    }

    const stack = getActiveStack();
    const chain = getActiveChain();
    const client = createPublicClient({ chain: chain.chain, transport: http(chain.readRpcUrl) });

    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (receipt.status !== "success") {
      return NextResponse.json({ error: "upgrade tx did not succeed on-chain" }, { status: 400 });
    }

    const need = upgradeFee(network);
    const treasury = treasuryAddress().toLowerCase();
    const usdc = stack.usdc.toLowerCase();
    // Find a USDC Transfer to treasury of >= the fee in this tx's logs.
    // Minimal topic decode of Transfer(indexed from, indexed to, value):
    // topics[0]=event sig, topics[2]=to (32-byte padded), data=value.
    let paid = false;
    let payer = ""; // Transfer.from of the matched payment — the buyer must equal this.
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== usdc) continue;
      if (log.topics.length < 3) continue;
      const fromAddr = "0x" + log.topics[1]!.toLowerCase().slice(-40);
      const toAddr = "0x" + log.topics[2]!.toLowerCase().slice(-40);
      if (toAddr === treasury && BigInt(log.data) >= need) {
        paid = true;
        payer = fromAddr;
        break;
      }
    }
    if (!paid) {
      return NextResponse.json(
        {
          error: `No USDC Transfer of >= ${(Number(need) / 1_000_000).toString()} USDC to the treasury found in this tx.`,
          treasury: treasuryAddress(),
          requiredAtomic: need.toString(),
        },
        { status: 400 },
      );
    }

    // HIGH fix (black-hat audit 2026-07-09): BIND the upgrade to the PAYER. The
    // route previously granted premium to any `address` for any valid payment tx,
    // so an attacker could front-run a victim's upgrade payment and claim premium
    // for THEIR own address (denying the victim, whose retry hits "already used").
    // Require the premium recipient to be exactly the address that PAID — there is
    // then nothing to steal, since the benefit goes to the payer.
    if (address.toLowerCase() !== payer) {
      return NextResponse.json(
        {
          error:
            "Premium can only be granted to the address that PAID (Transfer.from). The requested `address` did not send this payment tx.",
        },
        { status: 403 },
      );
    }

    // Replay-protect the payment tx (one upgrade per tx). AUDIT MEDIUM #5:
    // namespace by "premium" so an /authorize call on the same tx can't burn it.
    const fresh = await tryConsumeTxHash(network, txHash, "premium");
    if (!fresh) {
      return NextResponse.json({ error: "This upgrade tx was already used." }, { status: 400 });
    }

    await recordUserPremium(network, address);
    return NextResponse.json({
      upgraded: true,
      address,
      network,
      enforced: true,
      premiumFeeAtomic: need.toString(),
      features: ["instant-withdraw"],
      note: "Premium unlocked for 30 days. Withdrawals from this address use the expedited path.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message?.slice(0, 300) || "Unknown error" },
      { status: 500 },
    );
  }
}
