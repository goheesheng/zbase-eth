import { NextResponse } from "next/server";
import { canReadFullReport, getExposureReportJob } from "@/lib/exposure-report-store";
import { redactExposureReport } from "@/lib/privacy-scanner";

function accessTokenFrom(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice("bearer ".length).trim();
  return null;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await getExposureReportJob(id);
  if (!job) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  const full = canReadFullReport(job, accessTokenFrom(request));
  const report = job.report ? (full ? job.report : redactExposureReport(job.report)) : undefined;

  return NextResponse.json(
    {
      reportId: job.id,
      address: full ? job.address : `${job.address.slice(0, 6)}...${job.address.slice(-4)}`,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      expiresAt: job.expiresAt,
      access: full ? "full" : "redacted",
      payment: full ? job.payment : { mode: job.payment.mode, network: job.payment.network },
      error: full ? job.error : job.status === "failed" ? "Report failed" : undefined,
      report,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
