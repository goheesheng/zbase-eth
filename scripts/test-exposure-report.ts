import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  exposureReportOwnershipMessage,
  verifyExposureReportOwner,
} from "../src/lib/exposure-report-auth";
import { fetchBazaarAttributions, fetchX402ScanAttributions } from "../src/lib/x402-attribution-sources";
import { buildExposureReport, redactExposureReport, type Transfer } from "../src/lib/privacy-scanner";
import {
  exposurePaymentConfig,
  exposurePaymentRequirements,
  requireExposurePayment,
} from "../src/lib/exposure-payment";
import {
  createExposureReportJob,
  getExposureReportJob,
  saveExposureReportJob,
} from "../src/lib/exposure-report-store";
import { GET as getReport } from "../src/app/api/zx402/exposure-report/[id]/route";
import type { SanctionsProvider, ReasonCode } from "../src/lib/ofac-screening";

const wallet = "0x1111111111111111111111111111111111111111";
const nansenPayTo = "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f";
const unknownProvider = "0x2222222222222222222222222222222222222222";
const uniswapRouter = "0x2626664c2603336E57B271c5C0b26F421741e481";
const policyMixer = "0x8589427373D6D84E98730d7795D8f6f8731fDA16";
const x402guardPayTo = "0xEF4364Fe4487353dF46eb7c811D4FAc78b856c7F";

const mockProvider: SanctionsProvider = {
  snapshotVersion: "test",
  isSanctioned: async (address) => address.toLowerCase() === policyMixer.toLowerCase(),
  reasonFor: (address): ReasonCode | null =>
    address.toLowerCase() === policyMixer.toLowerCase() ? "policy-mixer" : null,
};

const transfer = (to: string, amount: number, block: number): Transfer => ({
  to: to as `0x${string}`,
  amount,
  amountAtomic: Math.round(amount * 1_000_000).toString(),
  blockNumber: block,
  txHash: `0x${block.toString(16).padStart(64, "0")}` as `0x${string}`,
  confidence: "low",
  classification: "unknown-transfer",
  reason: "fixture",
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function main() {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
    ZBASE_EXPOSURE_ALLOW_DEV_PAYMENT: process.env.ZBASE_EXPOSURE_ALLOW_DEV_PAYMENT,
    ZBASE_EXPOSURE_DEV_PAYMENT_TOKEN: process.env.ZBASE_EXPOSURE_DEV_PAYMENT_TOKEN,
    ZBASE_EXPOSURE_PAY_TO: process.env.ZBASE_EXPOSURE_PAY_TO,
    ZBASE_EXPOSURE_PRICE_ATOMIC: process.env.ZBASE_EXPOSURE_PRICE_ATOMIC,
  };

  const report = await buildExposureReport(wallet, {
    reportMode: "full",
    screeningProvider: mockProvider,
    transfers: [
      transfer(nansenPayTo, 0.5, 100),
      transfer(unknownProvider, 0.025, 101),
      transfer(uniswapRouter, 50, 102),
      transfer(policyMixer, 0.05, 103),
    ],
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.walletExposure.x402PaymentsDetected, 3);
  assert.equal(report.walletExposure.verifiedX402Payments, 0);
  assert.equal(report.walletExposure.attributedX402Payments, 0);
  assert.equal(report.walletExposure.possibleX402Payments, 3);
  assert.equal(report.attributedX402Payments.length, 0);
  assert.equal(report.possibleX402Payments.length, 3);
  assert.equal(report.nonX402DeFiActivity.length, 1);
  assert.equal(report.possibleX402Payments[0].source, "onchain-heuristic");
  assert.equal(report.possibleX402Payments.some((payment) => payment.matchedPayTo === unknownProvider), true);
  assert.equal(report.attributionChecks.some((item) => item.source === "onchain-heuristic"), true);
  assert.equal(report.x402ProviderHistory.some((item) => item.provider === "Nansen AI"), false);
  assert.equal(report.x402ProviderHistory.every((item) => item.classification === "possible-x402"), true);
  assert.equal(report.tradeAndDeFiBehavior.likelyActivities.includes("Token swaps or route-based trading on Base"), true);
  assert.equal(report.riskExposure.directMatches.some((match) => match.reason === "policy-mixer"), true);
  assert.equal(report.recommendations.some((item) => item.includes("zBase")), true);

  const redacted = redactExposureReport(report);
  assert.equal(redacted.summary.reportMode, "redacted");
  assert.equal(redacted.evidence[0].txHash, "0x0000000000000000000000000000000000000000000000000000000000000000");
  assert.equal(redacted.evidence[0].counterparty, "0x0000000000000000000000000000000000000000");
  assert.equal(redacted.x402ProviderHistory.some((item) => item.provider === "Nansen AI"), false);
  assert.equal(redacted.x402ProviderHistory.some((item) => item.domain), false);
  assert.equal(redacted.possibleX402Payments[0].matchedPayTo, "0x0000000000000000000000000000000000000000");

  const bazaarLookup = await fetchBazaarAttributions([unknownProvider], {
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              accepts: [{ amount: "25000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "eip155:8453", payTo: unknownProvider }],
              resource: "https://bazaar.example/api/paid",
              serviceName: "Mock Bazaar API",
              tags: ["data", "api"],
              lastUpdated: "2026-07-11T00:00:00.000Z",
            },
          ],
          pagination: { total: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const bazaarAttribution = bazaarLookup.matches.get(unknownProvider.toLowerCase());
  assert.equal(bazaarAttribution?.classification, "attributed-x402");
  assert.equal(bazaarAttribution?.evidence[0].source, "bazaar");

  const x402scanLookup = await fetchX402ScanAttributions([unknownProvider], {
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          items: [{ address: unknownProvider, serviceName: "Mock x402scan Merchant", resource: "https://merchant.example/paid" }],
          total_pages: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const x402scanAttribution = x402scanLookup.matches.get(unknownProvider.toLowerCase());
  assert.equal(x402scanAttribution?.classification, "attributed-x402");
  assert.equal(x402scanAttribution?.evidence[0].source, "x402scan");

  const externallyAttributedReport = await buildExposureReport(wallet, {
    reportMode: "full",
    transfers: [transfer(unknownProvider, 100, 101)],
    externalAttribution: {
      preloaded: [
        {
          payTo: unknownProvider,
          classification: "verified-x402",
          confidence: "high",
          provider: "Mock Live 402 API",
          providerDomain: "live402.example",
          category: "data-api",
          evidence: [
            {
              source: "live-402",
              status: "matched",
              confidence: "high",
              provider: "Mock Live 402 API",
              providerDomain: "live402.example",
              category: "data-api",
              matchedPayTo: unknownProvider,
              matchedAmount: "25000",
              resourceUrl: "https://live402.example/api/paid",
              lastVerifiedAt: "2026-07-11T00:00:00.000Z",
            },
          ],
        },
      ],
    },
  });
  assert.equal(externallyAttributedReport.walletExposure.verifiedX402Payments, 1);
  assert.equal(externallyAttributedReport.verifiedX402Payments[0].source, "live-402");
  assert.equal(externallyAttributedReport.verifiedX402Payments[0].resourceUrl, "https://live402.example/api/paid");

  const unverifiedRetiredProviderReport = await buildExposureReport(wallet, {
    reportMode: "full",
    transfers: [transfer(x402guardPayTo, 100, 42778915)],
  });
  assert.equal(unverifiedRetiredProviderReport.walletExposure.x402PaymentsDetected, 0);
  assert.equal(unverifiedRetiredProviderReport.walletExposure.attributedX402Payments, 0);
  assert.equal(unverifiedRetiredProviderReport.x402ProviderHistory.length, 0);
  assert.equal(unverifiedRetiredProviderReport.summary.riskLevel, "LOW");

  const paymentRequiredOnlyReport = await buildExposureReport(wallet, {
    reportMode: "full",
    transfers: [transfer(x402guardPayTo, 100, 42778915)],
    externalAttribution: {
      preloaded: [
        {
          payTo: x402guardPayTo,
          evidence: [
            {
              source: "x402scan",
              status: "payment-required",
              confidence: "low",
              lastVerifiedAt: "2026-07-11T00:00:00.000Z",
              whatWeCannotProve: "x402scan requires payment before it returns merchant attribution data.",
            },
          ],
        },
      ],
    },
  });
  assert.equal(paymentRequiredOnlyReport.walletExposure.x402PaymentsDetected, 0);
  assert.equal(paymentRequiredOnlyReport.attributionChecks[0].source, "x402scan");
  assert.equal(paymentRequiredOnlyReport.attributionChecks[0].status, "payment-required");

  const externallyAttributedRetiredProviderReport = await buildExposureReport(wallet, {
    reportMode: "full",
    transfers: [transfer(x402guardPayTo, 100, 42778915)],
    externalAttribution: {
      preloaded: [
        {
          payTo: x402guardPayTo,
          classification: "attributed-x402",
          confidence: "medium",
          provider: "x402guard",
          providerDomain: "x402guard",
          category: "security",
          evidence: [
            {
              source: "x402scan",
              status: "matched",
              confidence: "medium",
              provider: "x402guard",
              providerDomain: "x402guard",
              category: "security",
              matchedPayTo: x402guardPayTo,
              matchedAmount: "100000000",
              resourceUrl: "https://x402guard.example/report",
              lastVerifiedAt: "2026-07-11T00:00:00.000Z",
              whatWeCannotProve: "Fixture attribution does not prove the exact HTTP request made by the wallet.",
            },
          ],
        },
      ],
    },
  });
  assert.equal(externallyAttributedRetiredProviderReport.walletExposure.attributedX402Payments, 1);
  assert.equal(externallyAttributedRetiredProviderReport.attributedX402Payments[0].source, "x402scan");
  assert.equal(externallyAttributedRetiredProviderReport.x402ProviderHistory[0].provider, "x402guard");
  assert.equal(externallyAttributedRetiredProviderReport.x402ProviderHistory[0].category, "security");
  assert.equal(externallyAttributedRetiredProviderReport.summary.riskLevel, "MEDIUM");

  const account = privateKeyToAccount(generatePrivateKey());
  const issuedAt = new Date().toISOString();
  const signature = await account.signMessage({
    message: exposureReportOwnershipMessage(account.address, issuedAt),
  });
  const ownerAuth = await verifyExposureReportOwner({
    address: account.address,
    signature,
    issuedAt,
  });
  assert.equal(ownerAuth.ok, true);
  const mismatchedOwnerAuth = await verifyExposureReportOwner({
    address: wallet,
    signature,
    issuedAt,
  });
  assert.equal(mismatchedOwnerAuth.ok, false);

  const unpaid = await requireExposurePayment(new Request("https://zbase.app/api/zbase/exposure-report"));
  assert.equal(unpaid.ok, false);
  if (!unpaid.ok) {
    assert.equal(unpaid.response.status, 402);
    assert.ok(unpaid.response.headers.get("PAYMENT-REQUIRED"));
  }

  process.env.ZBASE_EXPOSURE_ALLOW_DEV_PAYMENT = "true";
  const paid = await requireExposurePayment(
    new Request("https://zbase.app/api/zbase/exposure-report", {
      headers: { "x-zbase-dev-payment": "dev" },
    }),
  );
  assert.equal(paid.ok, true);
  if (paid.ok) assert.equal(paid.payment.mode, "dev");

  process.env.NODE_ENV = "production";
  const prodBypass = await requireExposurePayment(
    new Request("https://zbase.app/api/zbase/exposure-report", {
      headers: { "x-zbase-dev-payment": "dev" },
    }),
  );
  assert.equal(prodBypass.ok, false);
  if (!prodBypass.ok) assert.equal(prodBypass.response.status, 402);
  restoreEnv("NODE_ENV", originalEnv.NODE_ENV);

  const requirements = exposurePaymentRequirements("https://zbase.app/api/zbase/exposure-report");
  const mismatchedPayment = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://attacker.example/other", mimeType: "application/json" },
      accepted: { ...requirements, amount: "1", extra: { ...requirements.extra, resource: "https://attacker.example/other" } },
      payload: {},
    }),
  ).toString("base64");
  const mismatched = await requireExposurePayment(
    new Request("https://zbase.app/api/zbase/exposure-report", {
      headers: { "PAYMENT-SIGNATURE": mismatchedPayment },
    }),
  );
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.response.status, 402);

  process.env.ZBASE_EXPOSURE_PAY_TO = "not-an-address";
  assert.throws(() => exposurePaymentConfig(), /ZBASE_EXPOSURE_PAY_TO/);
  restoreEnv("ZBASE_EXPOSURE_PAY_TO", originalEnv.ZBASE_EXPOSURE_PAY_TO);
  process.env.ZBASE_EXPOSURE_PRICE_ATOMIC = "0";
  assert.throws(() => exposurePaymentConfig(), /ZBASE_EXPOSURE_PRICE_ATOMIC/);
  restoreEnv("ZBASE_EXPOSURE_PRICE_ATOMIC", originalEnv.ZBASE_EXPOSURE_PRICE_ATOMIC);

  const job = await createExposureReportJob({
    address: wallet,
    payment: { mode: "dev", amountAtomic: "1000000", network: "eip155:8453" },
  });
  assert.equal(job.id.includes(wallet.slice(2, 8).toLowerCase()), false);
  await saveExposureReportJob({ ...job, status: "complete", report });
  assert.ok(await getExposureReportJob(job.id));
  assert.equal(await getExposureReportJob(`rpt_${wallet.slice(2, 8).toLowerCase()}_bad`), null);

  const params = Promise.resolve({ id: job.id });
  const publicRead = await getReport(new Request(`https://zbase.app/api/zbase/exposure-report/${job.id}`), { params });
  const publicBody = await publicRead.json();
  assert.equal(publicBody.access, "redacted");
  assert.equal(publicBody.report.x402ProviderHistory.some((item: { provider: string }) => item.provider === "Nansen AI"), false);

  const queryTokenRead = await getReport(
    new Request(`https://zbase.app/api/zbase/exposure-report/${job.id}?token=${job.accessToken}`),
    { params },
  );
  const queryTokenBody = await queryTokenRead.json();
  assert.equal(queryTokenBody.access, "redacted");

  const bearerRead = await getReport(
    new Request(`https://zbase.app/api/zbase/exposure-report/${job.id}`, {
      headers: { authorization: `Bearer ${job.accessToken}` },
    }),
    { params },
  );
  const bearerBody = await bearerRead.json();
  assert.equal(bearerBody.access, "redacted");
  assert.equal(bearerBody.report.x402ProviderHistory.some((item: { provider: string }) => item.provider === "Nansen AI"), false);

  const authorizedJob = await createExposureReportJob({
    address: wallet,
    payment: { mode: "dev", amountAtomic: "1000000", network: "eip155:8453" },
  });
  await saveExposureReportJob({
    ...authorizedJob,
    status: "complete",
    fullReportAuthorized: true,
    authorization: { type: "target-wallet-signature", subject: wallet, issuedAt },
    report,
  });
  const authorizedParams = Promise.resolve({ id: authorizedJob.id });
  const authorizedBearerRead = await getReport(
    new Request(`https://zbase.app/api/zbase/exposure-report/${authorizedJob.id}`, {
      headers: { authorization: `Bearer ${authorizedJob.accessToken}` },
    }),
    { params: authorizedParams },
  );
  const authorizedBearerBody = await authorizedBearerRead.json();
  assert.equal(authorizedBearerBody.access, "full");
  assert.equal(authorizedBearerBody.report.x402ProviderHistory.some((item: { provider: string }) => item.provider === "Nansen AI"), false);
  assert.equal(authorizedBearerBody.report.x402ProviderHistory.length > 0, true);

  restoreEnv("NODE_ENV", originalEnv.NODE_ENV);
  restoreEnv("VERCEL_ENV", originalEnv.VERCEL_ENV);
  restoreEnv("ZBASE_EXPOSURE_ALLOW_DEV_PAYMENT", originalEnv.ZBASE_EXPOSURE_ALLOW_DEV_PAYMENT);
  restoreEnv("ZBASE_EXPOSURE_DEV_PAYMENT_TOKEN", originalEnv.ZBASE_EXPOSURE_DEV_PAYMENT_TOKEN);
  restoreEnv("ZBASE_EXPOSURE_PAY_TO", originalEnv.ZBASE_EXPOSURE_PAY_TO);
  restoreEnv("ZBASE_EXPOSURE_PRICE_ATOMIC", originalEnv.ZBASE_EXPOSURE_PRICE_ATOMIC);

  console.log("exposure report provider tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
