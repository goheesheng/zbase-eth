import { getAddress, isAddress, verifyMessage } from "viem";

const OWNER_SIGNATURE_TTL_MS = Number(process.env.ZBASE_EXPOSURE_OWNER_SIGNATURE_TTL_MS ?? 10 * 60 * 1000);
const OWNER_SIGNATURE_CLOCK_SKEW_MS = 60 * 1000;

export interface ExposureReportOwnerAuthorization {
  type: "target-wallet-signature";
  subject: `0x${string}`;
  issuedAt: string;
}

export function exposureReportOwnershipMessage(address: string, issuedAt: string): string {
  if (!isAddress(address)) throw new Error("Invalid Ethereum address");
  const checksum = getAddress(address);
  return [
    "zBase Exposure Report Authorization",
    `Wallet: ${checksum}`,
    "Purpose: Reveal exact wallet exposure report",
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

export async function verifyExposureReportOwner(args: {
  address: string;
  signature?: string | null;
  issuedAt?: string | null;
  now?: Date;
}): Promise<{ ok: true; authorization: ExposureReportOwnerAuthorization } | { ok: false; error: string }> {
  if (!isAddress(args.address)) return { ok: false, error: "Invalid Ethereum address" };
  if (!args.signature || !/^0x[a-fA-F0-9]+$/.test(args.signature)) {
    return { ok: false, error: "Missing or invalid owner signature" };
  }
  if (!args.issuedAt) return { ok: false, error: "Missing owner signature issuedAt" };

  const issuedAtMs = Date.parse(args.issuedAt);
  if (!Number.isFinite(issuedAtMs)) return { ok: false, error: "Invalid owner signature issuedAt" };

  const nowMs = args.now?.getTime() ?? Date.now();
  if (issuedAtMs > nowMs + OWNER_SIGNATURE_CLOCK_SKEW_MS) {
    return { ok: false, error: "Owner signature issuedAt is in the future" };
  }
  if (nowMs - issuedAtMs > OWNER_SIGNATURE_TTL_MS) {
    return { ok: false, error: "Owner signature expired" };
  }

  const checksum = getAddress(args.address) as `0x${string}`;
  const message = exposureReportOwnershipMessage(checksum, args.issuedAt);
  const valid = await verifyMessage({
    address: checksum,
    message,
    signature: args.signature as `0x${string}`,
  });
  if (!valid) return { ok: false, error: "Owner signature does not match target wallet" };

  return {
    ok: true,
    authorization: {
      type: "target-wallet-signature",
      subject: checksum,
      issuedAt: args.issuedAt,
    },
  };
}

