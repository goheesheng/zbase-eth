import { getAddress, isAddress } from "viem";
import { NextResponse } from "next/server";
import { verifyExposureReportOwner, type ExposureReportOwnerAuthorization } from "@/lib/exposure-report-auth";
import { buildExposureReport, redactExposureReport } from "@/lib/privacy-scanner";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import {
  paymentResponseHeaders,
  requireExposurePayment,
  settleExposurePayment,
  exposurePaymentConfig,
} from "@/lib/exposure-payment";
import {
  createExposureReportJob,
  getLatestExposureReportJob,
  exposureReportStoreReadinessError,
  saveExposureReportJob,
} from "@/lib/exposure-report-store";

export const maxDuration = 120;

type ExposureReportRouteAuthorization =
  | ExposureReportOwnerAuthorization
  | { type: "enterprise-payer-allowlist"; subject: string; issuedAt?: string };

function invalidAddressResponse() {
  return NextResponse.json(
    { error: "Valid Ethereum address required in body: { address: '0x...' }" },
    { status: 400 },
  );
}

function enterpriseAuthorizationForPayer(payer: string | undefined): ExposureReportRouteAuthorization | null {
  if (!payer || !isAddress(payer)) return null;
  const allowed = (process.env.ZBASE_EXPOSURE_ENTERPRISE_PAYERS ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  const checksumPayer = getAddress(payer);
  return allowed.some((address) => isAddress(address) && getAddress(address).toLowerCase() === checksumPayer.toLowerCase())
    ? { type: "enterprise-payer-allowlist", subject: checksumPayer }
    : null;
}

export async function GET() {
  const cfg = exposurePaymentConfig();
  return NextResponse.json({
    service: "zBase Exposure Report Provider",
    version: "1.0.0",
    x402: {
      scheme: "exact",
      network: cfg.network,
      asset: cfg.asset,
      payTo: cfg.payTo,
      amount: cfg.amountAtomic,
      displayPrice: cfg.displayPrice,
    },
    endpoints: {
      preview: "POST /api/zbase/privacy-check",
      paidReport: "POST /api/zbase/exposure-report",
      reportStatus: "GET /api/zbase/exposure-report/:id with Authorization: Bearer <accessToken>",
    },
    access:
      "Full reports require x402 payment plus target-wallet signature or enterprise payer allowlist. Without that authorization, paid responses and status reads are redacted.",
  });
}

export async function POST(request: Request) {
  const storeReadinessError = exposureReportStoreReadinessError();
  if (storeReadinessError) {
    return NextResponse.json({ error: "Exposure report storage unavailable", details: storeReadinessError }, { status: 503 });
  }

  let ownerAuthorization: ExposureReportOwnerAuthorization | null = null;
  let body: {
    address?: unknown;
    ownerSignature?: unknown;
    ownerSignatureIssuedAt?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return invalidAddressResponse();
  }
  if (!body?.address || typeof body.address !== "string" || !isAddress(body.address)) return invalidAddressResponse();
  const address = getAddress(body.address) as `0x${string}`;

  // Rate-limit the unbounded on-chain scan, keyed on the target address so a
  // single wallet can't be re-scanned in a loop to exhaust RPC/CPU. Checked
  // before requireExposurePayment so a limited caller is never charged.
  const limited = await checkRateLimit(request, "privacy-scan", address.toLowerCase());
  if (!limited.success) return rateLimitResponse(limited);

  if (body.ownerSignature || body.ownerSignatureIssuedAt) {
    const owner = await verifyExposureReportOwner({
      address,
      signature: typeof body.ownerSignature === "string" ? body.ownerSignature : null,
      issuedAt: typeof body.ownerSignatureIssuedAt === "string" ? body.ownerSignatureIssuedAt : null,
    });
    if (!owner.ok) {
      return NextResponse.json({ error: "Invalid owner authorization", details: owner.error }, { status: 400 });
    }
    ownerAuthorization = owner.authorization;
  }

  const paid = await requireExposurePayment(request);
  if (!paid.ok) return paid.response;

  const enterpriseAuthorization = enterpriseAuthorizationForPayer(paid.payment.payer);
  const authorization = ownerAuthorization ?? enterpriseAuthorization ?? undefined;
  const fullReportAuthorized = Boolean(authorization);

  const cached = await getLatestExposureReportJob(address);
  const job = await createExposureReportJob({
    address,
    payment: {
      mode: paid.payment.mode,
      amountAtomic: paid.payment.amountAtomic,
      network: paid.payment.network,
      payer: paid.payment.payer,
    },
  });

  try {
    await saveExposureReportJob({ ...job, status: "running", fullReportAuthorized, authorization });
    const report =
      cached?.status === "complete" && cached.report
        ? { ...cached.report, generatedAt: new Date().toISOString() }
        : await buildExposureReport(address, { reportMode: "full", enableExternalAttribution: true });
    const reportReady = {
      ...job,
      status: "report_ready" as const,
      fullReportAuthorized,
      authorization,
      report,
    };
    await saveExposureReportJob(reportReady);
    await saveExposureReportJob({ ...reportReady, status: "settling" });
    const settlement = await settleExposurePayment(paid.payment);
    const completed = {
      ...reportReady,
      status: "complete" as const,
      payment: {
        ...job.payment,
        transaction: settlement?.transaction,
        payer: settlement?.payer ?? job.payment.payer,
      },
      report,
    };
    let persistenceWarning: string | undefined;
    try {
      await saveExposureReportJob(completed);
    } catch (saveError) {
      persistenceWarning = `Payment settled and report generated, but final receipt persistence failed: ${(saveError as Error).message.slice(0, 180)}`;
    }
    const responseReport = fullReportAuthorized ? report : redactExposureReport(report);

    return NextResponse.json(
      {
        reportId: completed.id,
        status: completed.status,
        access: fullReportAuthorized ? "full" : "redacted",
        accessToken: completed.accessToken,
        payment: completed.payment,
        cachedFrom: cached?.status === "complete" ? cached.id : null,
        authorization: authorization
          ? { type: authorization.type, subject: authorization.subject, issuedAt: authorization.issuedAt }
          : undefined,
        warning: persistenceWarning,
        report: responseReport,
      },
      {
        headers: {
          ...paymentResponseHeaders(settlement),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    try {
      await saveExposureReportJob({
        ...job,
        status: "failed",
        fullReportAuthorized,
        authorization,
        error: (error as Error).message.slice(0, 500),
      });
    } catch {
      // Preserve the original failure for the API response.
    }
    return NextResponse.json(
      {
        reportId: job.id,
        status: "failed",
        error: "Report generation or settlement failed",
        details: (error as Error).message.slice(0, 300),
      },
      { status: 502 },
    );
  }
}
