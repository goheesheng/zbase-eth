import { Redis } from "@upstash/redis";
import type { ExposureReport } from "@/lib/privacy-scanner";

export type ExposureReportStatus = "queued" | "running" | "report_ready" | "settling" | "complete" | "failed";

export interface ExposureReportJob {
  id: string;
  address: `0x${string}`;
  status: ExposureReportStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  accessToken: string;
  payment: {
    mode: "x402" | "dev";
    amountAtomic: string;
    network: string;
    transaction?: string;
    payer?: string;
  };
  fullReportAuthorized?: boolean;
  authorization?: {
    type: "target-wallet-signature" | "enterprise-payer-allowlist";
    subject?: string;
    issuedAt?: string;
  };
  report?: ExposureReport;
  error?: string;
}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const redis =
  UPSTASH_URL && UPSTASH_TOKEN ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN }) : null;

const memJobs = new Map<string, ExposureReportJob>();
const memLatestByAddress = new Map<string, string>();

const REPORT_TTL_SECONDS = Number(process.env.ZBASE_EXPOSURE_REPORT_TTL_SECONDS ?? 60 * 60 * 24 * 7);
const CACHE_TTL_SECONDS = Number(process.env.ZBASE_EXPOSURE_CACHE_TTL_SECONDS ?? 60 * 60 * 6);

const nowIso = () => new Date().toISOString();
const expiresAt = (ttlSeconds: number) => new Date(Date.now() + ttlSeconds * 1000).toISOString();
const REPORT_ID_RE = /^rpt_[a-f0-9]{24}$/;
const jobKey = (id: string) => `zbase:exposure:report:${id}`;
const latestKey = (address: string) => `zbase:exposure:latest:${address.toLowerCase()}`;

function ttlSecondsUntil(iso: string): number {
  const ttl = Math.floor((Date.parse(iso) - Date.now()) / 1000);
  return Math.max(ttl, 60);
}

function randomToken(bytes = 24): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Buffer.from(array).toString("base64url");
}

function newJobId(): string {
  return `rpt_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function expired(job: ExposureReportJob): boolean {
  return Date.parse(job.expiresAt) <= Date.now();
}

function productionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

export function exposureReportStoreAvailable(): boolean {
  return redis !== null;
}

export function exposureReportStoreReadinessError(): string | null {
  if (redis || !productionRuntime()) return null;
  return "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for paid exposure reports in production";
}

export async function createExposureReportJob(args: {
  address: `0x${string}`;
  payment: ExposureReportJob["payment"];
}): Promise<ExposureReportJob> {
  const job: ExposureReportJob = {
    id: newJobId(),
    address: args.address,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt: expiresAt(REPORT_TTL_SECONDS),
    accessToken: randomToken(),
    payment: args.payment,
  };
  await saveExposureReportJob(job);
  return job;
}

export async function saveExposureReportJob(job: ExposureReportJob): Promise<void> {
  const updated = { ...job, updatedAt: nowIso() };
  if (redis) {
    const ttl = ttlSecondsUntil(updated.expiresAt);
    await Promise.all([
      redis.set(jobKey(updated.id), JSON.stringify(updated), { ex: ttl }),
      redis.set(latestKey(updated.address), updated.id, { ex: Math.min(ttl, CACHE_TTL_SECONDS) }),
    ]);
    return;
  }
  memJobs.set(updated.id, updated);
  memLatestByAddress.set(updated.address.toLowerCase(), updated.id);
}

export async function getExposureReportJob(id: string): Promise<ExposureReportJob | null> {
  if (!REPORT_ID_RE.test(id)) return null;
  if (redis) {
    const raw = await redis.get<string>(jobKey(id));
    if (!raw) return null;
    const job = typeof raw === "string" ? (JSON.parse(raw) as ExposureReportJob) : (raw as ExposureReportJob);
    return expired(job) ? null : job;
  }
  const job = memJobs.get(id);
  if (!job) return null;
  if (expired(job)) {
    memJobs.delete(id);
    return null;
  }
  return job;
}

export async function getLatestExposureReportJob(address: `0x${string}`): Promise<ExposureReportJob | null> {
  const lower = address.toLowerCase();
  if (redis) {
    const id = await redis.get<string>(latestKey(lower));
    return id ? getExposureReportJob(id) : null;
  }
  const id = memLatestByAddress.get(lower);
  return id ? getExposureReportJob(id) : null;
}

export function canReadFullReport(job: ExposureReportJob, token: string | null | undefined): boolean {
  return Boolean(job.fullReportAuthorized && token && constantTimeEqual(token, job.accessToken));
}
