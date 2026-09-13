import { getAddress, isAddress } from "viem";
import { NextResponse } from "next/server";
import { buildExposureReport, redactExposureReport } from "@/lib/privacy-scanner";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { address } = body;

    if (!address || !isAddress(address)) {
      return NextResponse.json(
        { error: "Valid Ethereum address required in body: { address: '0x...' }" },
        { status: 400 },
      );
    }

    // Rate-limit the unbounded on-chain scan, keyed on the target address so a
    // single wallet can't be re-scanned in a loop to exhaust RPC/CPU.
    const limited = await checkRateLimit(request, "privacy-scan", address.toLowerCase());
    if (!limited.success) return rateLimitResponse(limited);

    const report = redactExposureReport(
      await buildExposureReport(getAddress(address), { reportMode: "redacted" }),
    );

    return NextResponse.json({
      address: report.address,
      totalTransfers: report.walletExposure.totalTransfersScanned,
      x402PaymentsDetected: report.walletExposure.x402PaymentsDetected,
      verifiedX402Payments: report.walletExposure.verifiedX402Payments,
      attributedX402Payments: report.walletExposure.attributedX402Payments,
      possibleX402Payments: report.walletExposure.possibleX402Payments,
      servicesExposed: report.x402ProviderHistory.map((provider) => provider.provider),
      totalSpendVisible: report.walletExposure.totalX402SpendUSDC,
      riskLevel: report.summary.riskLevel,
      summary:
        report.summary.riskLevel === "HIGH"
          ? "Your wallet has visible x402 payment exposure. Exact counterparties and transaction history are hidden in the preview."
          : report.summary.riskLevel === "MEDIUM"
            ? `${report.walletExposure.attributedX402Payments} attributed and ${report.walletExposure.possibleX402Payments} possible x402 payments detected.`
            : `Limited exposure detected. ${report.walletExposure.possibleX402Payments} possible x402-sized payments found.`,
      preview: report,
      paidReport: {
        endpoint: "POST /api/zbase/exposure-report",
        price: "$1.00 USDC",
        unlocks: [
          "Exact tx evidence",
          "Provider-by-provider history",
          "Behavior interpretation",
          "Risk exposure details",
          "Likely next actions",
        ],
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Analysis failed", details: (err as Error).message },
      { status: 500 },
    );
  }
}
