"use client";

/**
 * X402Playground
 * ──────────────
 * Construct a zBase-flavored x402 paymentDetails + zbaseDeposit body and hit
 * /api/facilitator/verify live. Shows the request payload + the raw response,
 * lets agent devs validate the wire shape before they integrate.
 *
 * This is NOT a generic EIP-3009 signer (vanilla x402 has one in the standard
 * SDKs). It's the zBase-specific extension: the verify endpoint accepts a
 * `zbaseDeposit` field carrying the depositor's secrets so the facilitator
 * can confirm the payment will route through the privacy pool. Agent devs
 * cannot copy this from x402 docs — it's only documented here and in the
 * source at src/app/api/facilitator/verify/route.ts.
 *
 * Form fields:
 *   - payTo (recipient/provider address)
 *   - maxAmountRequired (atomic 6-decimal USDC)
 *   - deposit picker (selects from localStorage deposits the user has made)
 *
 * The pre-filled deposit dropdown reads from the same encrypted deposit
 * vault DepositWithdraw uses (src/lib/deposit-vault.ts — which dual-reads
 * the legacy zbase-/zx402- localStorage keys until migration), so a user
 * can deposit on the same page and immediately test verify against it.
 */

import { useState, useMemo } from "react";
import { useAccount } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { useDepositVault } from "@/lib/deposit-vault";
import CodeSample from "./CodeSample";

interface StoredDeposit {
  nullifier: string;
  secret: string;
  precommitment: string;
  value: string;
  label?: string;
  commitment?: string;
  txHash: string;
  amountHuman: string;
  asset: string;
  status: "pending" | "indexed" | "spent";
  createdAt: number;
}

interface Props {
  stack: {
    // Always "production" post-staging-abandonment 2026-06-01.
    label: "production";
    entrypoint: string;
    usdcPool: string;
    usdc: string;
  } | null;
}

type VerifyResponse = {
  valid?: boolean;
  reason?: string;
  [k: string]: unknown;
};

export default function X402Playground({ stack }: Props) {
  const { address, isConnected } = useAccount();
  // Shared vault store: deposits made in DepositWithdraw above appear here
  // live, including after an unlock migrates them off localStorage.
  const { deposits, status: vaultStatus, unlock: unlockDepositVault } =
    useDepositVault<StoredDeposit>(address);
  const [payTo, setPayTo] = useState<string>(
    "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21",
  );
  const [amountHuman, setAmountHuman] = useState<string>("0.5");
  const [depositIdx, setDepositIdx] = useState<number>(-1);
  const [pending, setPending] = useState(false);
  const [response, setResponse] = useState<VerifyResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");

  // The verify request body, computed live so the user sees what they will
  // send before they send it.
  const requestBody = useMemo(() => {
    let amountAtomic = "0";
    try {
      amountAtomic = parseUnits(amountHuman || "0", 6).toString();
    } catch {
      amountAtomic = "0";
    }
    const body: Record<string, unknown> = {
      paymentDetails: {
        scheme: "exact",
        networkId: "eip155:84532",
        payTo: payTo || null,
        maxAmountRequired: amountAtomic,
      },
    };
    const chosen = deposits[depositIdx];
    if (chosen) {
      body.zbaseDeposit = {
        nullifier: chosen.nullifier,
        secret: chosen.secret,
        value: chosen.value,
        label: chosen.label || "0",
        commitment: chosen.commitment || "0",
      };
    }
    return body;
  }, [payTo, amountHuman, deposits, depositIdx]);

  async function handleVerify() {
    setPending(true);
    setResponse(null);
    setErrorMessage("");
    try {
      const res = await fetch("/api/facilitator/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const data = (await res.json()) as VerifyResponse;
      setResponse(data);
    } catch (err) {
      setErrorMessage((err as Error).message || "verify call failed");
    } finally {
      setPending(false);
    }
  }

  const indexedDeposits = deposits
    .map((d, i) => ({ d, i }))
    .filter((x) => x.d.status !== "spent");

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-gray-200 bg-white p-8">
        <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
          {/* ── payTo ── */}
          <label className="md:col-span-2">
            <span className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
              Pay to (provider / recipient)
            </span>
            <input
              value={payTo}
              onChange={(e) => setPayTo(e.target.value)}
              placeholder="0x…"
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-4 py-3 font-mono text-[13px] text-black outline-none"
            />
          </label>

          {/* ── maxAmountRequired ── */}
          <label>
            <span className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
              Max amount required (USDC)
            </span>
            <div className="mt-1 flex items-center rounded-md border border-gray-300 bg-white">
              <input
                value={amountHuman}
                onChange={(e) => setAmountHuman(e.target.value)}
                inputMode="decimal"
                className="w-full bg-transparent px-4 py-3 font-mono text-[14px] tabular-nums text-black outline-none"
                placeholder="0.50"
              />
              <span className="px-4 font-inter text-[12px] text-gray-500">
                USDC
              </span>
            </div>
          </label>

          {/* ── deposit picker ── */}
          <label>
            <span className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
              zBase deposit (provides ZK proof input)
            </span>
            <select
              value={depositIdx}
              onChange={(e) => setDepositIdx(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-4 py-3 font-mono text-[13px] text-black outline-none"
            >
              <option value={-1}>None — standard x402 verify only</option>
              {indexedDeposits.map(({ d, i }) => (
                <option key={d.txHash} value={i}>
                  {Number(formatUnits(BigInt(d.value || "0"), 6)).toFixed(2)}{" "}
                  USDC ·{" "}
                  {d.txHash.slice(0, 8)}… · {d.status}
                </option>
              ))}
            </select>
            {deposits.length === 0 && (
              <span className="mt-1 block font-inter text-[11px] text-gray-400">
                No deposits found. Deposit above to populate this list.
                {isConnected && vaultStatus !== "unlocked" && (
                  <>
                    {" "}Already deposited before?{" "}
                    <button
                      type="button"
                      onClick={() => unlockDepositVault()}
                      disabled={vaultStatus === "unlocking"}
                      className="text-indigo-500 underline hover:text-indigo-700 disabled:opacity-50"
                    >
                      {vaultStatus === "unlocking"
                        ? "Unlocking vault…"
                        : "Unlock your encrypted vault"}
                    </button>
                  </>
                )}
              </span>
            )}
          </label>
        </div>

        <div className="mt-6 flex items-center gap-4">
          <button
            onClick={handleVerify}
            disabled={!isConnected || pending}
            className="rounded-md bg-indigo-600 px-5 py-3 font-syne text-[12px] uppercase tracking-[0.14em] text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {!isConnected
              ? "Connect wallet"
              : pending
              ? "Verifying…"
              : "POST /api/facilitator/verify"}
          </button>
          <a
            href="/api/facilitator/supported"
            target="_blank"
            rel="noopener noreferrer"
            className="font-syne text-[10px] uppercase tracking-[0.14em] text-gray-500 hover:text-black"
          >
            See /supported →
          </a>
        </div>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[#deb6a8] bg-[#f0d6cf] px-3 py-2 font-inter text-[12px] text-[#6b2e1f]">
            {errorMessage}
          </div>
        )}

        {/* ── Response panel ── */}
        {response && (
          <div className="mt-6 rounded-md border border-gray-200 bg-[#f8f7f4] p-4">
            <div className="flex items-center justify-between">
              <span className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
                Response
              </span>
              <span
                className={`inline-flex rounded-full border px-2.5 py-[3px] font-inter text-[10px] font-medium tracking-wide ${
                  response.valid
                    ? "bg-[#e8eee0] text-[#3d4a2c] border-[#cfdbbf]"
                    : "bg-[#f0d6cf] text-[#6b2e1f] border-[#deb6a8]"
                }`}
              >
                {response.valid ? "valid" : "invalid"}
              </span>
            </div>
            {response.reason && (
              <div className="mt-2 font-inter text-[12px] text-gray-700">
                {response.reason}
              </div>
            )}
            <pre className="mt-3 overflow-x-auto rounded bg-[#1a1815] p-3 font-mono text-[11px] text-[#e8e3d6]">
              <code>{JSON.stringify(response, null, 2)}</code>
            </pre>
          </div>
        )}
      </div>

      {/* ── Live request preview + code sample ── */}
      <div>
        <div className="mb-2 font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
          Live request preview
        </div>
        <pre className="overflow-x-auto rounded-md border border-gray-200 bg-white p-4 font-mono text-[11px] text-gray-700">
          <code>{JSON.stringify(requestBody, null, 2)}</code>
        </pre>
      </div>

      <CodeSample
        caption="Verify equivalent"
        samples={{
          curl: `curl -X POST https://zbase.app/api/facilitator/verify \\
  -H 'content-type: application/json' \\
  -d '${JSON.stringify(requestBody).replace(/'/g, "'\\''")}'`,
          typescript: `// Standard x402 client: point facilitatorUrl at zBase
const facilitatorUrl = "https://zbase.app/api/facilitator";

// Or call verify directly with the zBase extension
const res = await fetch(\`\${facilitatorUrl}/verify\`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(${JSON.stringify(requestBody, null, 2)}),
});
const { valid, reason } = await res.json();`,
          python: `import requests

r = requests.post(
    "https://zbase.app/api/facilitator/verify",
    json=${JSON.stringify(requestBody, null, 2)},
)
result = r.json()
assert result["valid"], result.get("reason")`,
        }}
      />
    </div>
  );
}
