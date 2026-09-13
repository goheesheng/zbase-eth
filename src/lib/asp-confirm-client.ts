import type { DepositAspRecord } from "@/lib/asp-update-state";

export async function confirmDepositForAsp(
  txHash: string,
  options: {
    endpoint?: string;
    maxAttempts?: number;
    retryDelayMs?: number;
  } = {},
): Promise<DepositAspRecord> {
  const endpoint = options.endpoint ?? "/api/deposits/confirm";
  // The server permits ten retries per transaction per minute. Keep the client
  // default within that budget so an indexing delay cannot turn into a 429 on
  // the final retry.
  const maxAttempts = options.maxAttempts ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  let last: DepositAspRecord | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash }),
    });
    const body = (await response.json().catch(() => ({}))) as Partial<DepositAspRecord> & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        body.error ?? body.reason ?? `Deposit confirmation failed (HTTP ${response.status})`,
      );
    }
    if (body.status === "included" || body.status === "rejected") {
      return body as DepositAspRecord;
    }
    if (body.status !== "queued") {
      throw new Error("Deposit confirmation returned an invalid status");
    }
    last = body as DepositAspRecord;
    if (attempt + 1 < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(last?.reason ?? "Deposit is confirmed but ASP inclusion is still queued");
}
