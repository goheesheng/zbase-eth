import { headers } from "next/headers";
import Link from "next/link";
import { explorerAddressUrl } from "@/lib/contracts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ApiResp = {
  totalDeposits: number;
  seededDeposits: number;
  organicDeposits: number;
  perPool: Array<{
    address: string;
    label: string;
    total: number;
    seeded: number;
    organic: number;
  }>;
  growth7d: { seeded: number; organic: number };
  growth30d: { seeded: number; organic: number };
  disclosureMode: "raw" | "bootstrap";
  ts: string;
  blockRange: { from: number; to: number };
};

async function fetchData(): Promise<ApiResp | { error: string }> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3009";
  const proto = host.startsWith("localhost") ? "http" : "https";
  try {
    const res = await fetch(`${proto}://${host}/api/anonymity-set`, {
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    return (await res.json()) as ApiResp;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export default async function AnonymitySetPage() {
  const data = await fetchData();

  if ("error" in data) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-3xl font-semibold">Anonymity set</h1>
        <p className="mt-4 text-zinc-600">
          API unavailable: {data.error}. Try{" "}
          <Link href="/api/anonymity-set" className="underline">
            /api/anonymity-set
          </Link>{" "}
          directly.
        </p>
      </main>
    );
  }

  const bootstrap = data.disclosureMode === "bootstrap";

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 font-sans">
      <header className="mb-12">
        <p className="text-xs uppercase tracking-widest text-zinc-500">
          zBase — Privacy Pools on Base Sepolia
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">
          Anonymity set — live
        </h1>
        <p className="mt-4 text-zinc-600">
          Privacy compounds with depositors. zBase publishes this metric in
          real-time so the privacy claim is measurable, not aspirational.
        </p>
      </header>

      <section className="mb-12 rounded-2xl border border-zinc-200 bg-white p-8">
        <p className="text-xs uppercase tracking-widest text-zinc-500">
          Total commitments
        </p>
        <p className="mt-1 text-6xl font-light tabular-nums">
          {data.totalDeposits}
        </p>
        {bootstrap ? (
          <p className="mt-3 text-sm text-amber-700">
            🌱 Bootstrap mode — organic depositor count below 30. Ratios are
            intentionally hidden to avoid broadcasting a thin organic set.
            See{" "}
            <Link
              href="/anonymity-set-disclosure"
              className="underline underline-offset-2"
            >
              disclosure policy
            </Link>
            .
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-500">
                Organic
              </p>
              <p className="text-3xl font-light tabular-nums">
                {data.organicDeposits}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-500">
                Seeded
              </p>
              <p className="text-3xl font-light tabular-nums">
                {data.seededDeposits}
              </p>
            </div>
          </div>
        )}
      </section>

      <section className="mb-12">
        <h2 className="mb-4 text-lg font-medium">Per-pool</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-widest text-zinc-500">
            <tr>
              <th className="pb-2">Pool</th>
              <th className="pb-2 text-right">Total</th>
              {!bootstrap && (
                <>
                  <th className="pb-2 text-right">Organic</th>
                  <th className="pb-2 text-right">Seeded</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {data.perPool.map((p) => (
              <tr key={p.address} className="border-t border-zinc-200">
                <td className="py-3">
                  <span className="font-medium">{p.label}</span>
                  <br />
                  <a
                    href={explorerAddressUrl(p.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-zinc-600 underline underline-offset-2 hover:text-zinc-900 break-all"
                    title="Open on block explorer"
                  >
                    {p.address}
                  </a>
                </td>
                <td className="py-3 text-right tabular-nums">{p.total}</td>
                {!bootstrap && (
                  <>
                    <td className="py-3 text-right tabular-nums">
                      {p.organic}
                    </td>
                    <td className="py-3 text-right tabular-nums">
                      {p.seeded}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {!bootstrap && (
        <section className="mb-12 grid grid-cols-2 gap-6">
          <div className="rounded-xl border border-zinc-200 p-6">
            <p className="text-xs uppercase tracking-widest text-zinc-500">
              7-day growth
            </p>
            <p className="mt-1 text-2xl tabular-nums">
              +{data.growth7d.organic}{" "}
              <span className="text-sm text-zinc-500">organic</span>
            </p>
            <p className="text-sm tabular-nums text-zinc-500">
              +{data.growth7d.seeded} seeded
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 p-6">
            <p className="text-xs uppercase tracking-widest text-zinc-500">
              30-day growth
            </p>
            <p className="mt-1 text-2xl tabular-nums">
              +{data.growth30d.organic}{" "}
              <span className="text-sm text-zinc-500">organic</span>
            </p>
            <p className="text-sm tabular-nums text-zinc-500">
              +{data.growth30d.seeded} seeded
            </p>
          </div>
        </section>
      )}

      <details className="mb-8 rounded-xl border border-zinc-200 p-6">
        <summary className="cursor-pointer text-sm font-medium">
          How to interpret this page
        </summary>
        <div className="mt-4 space-y-3 text-sm text-zinc-700">
          <p>
            <strong>Seeded</strong> = deposits from the zBase treasury wallet
            (intentional bootstrap, locked until 2026-12-01, commitments stay
            in the Merkle tree forever even after reclaim).
          </p>
          <p>
            <strong>Organic</strong> = real users.
          </p>
          <p>
            <strong>Bootstrap mode</strong> hides the ratio when organic
            depositors &lt; 30. Publishing &quot;100 seeded vs 3 organic&quot;
            would shrink the effective anonymity set for the first 3 organic
            users by signposting them directly. Once organic ≥ 30, full
            ratios appear.
          </p>
          <p>
            <strong>Decoy scheduler</strong> additionally emits Poisson-timed
            dummy withdrawals to defeat FIFO timing correlation. Its status is
            shown separately in <code>STATUS.md</code>.
          </p>
          <p>
            <strong>No yield, no custody games:</strong> the deployed pool is a
            plain <a href="https://github.com/0xbow-io/privacy-pools-core" target="_blank" rel="noopener noreferrer">0xbow PrivacyPool</a> &mdash;
            your USDC sits in the pool contract itself, not in any yield market
            (verified on-chain: the contract reverts on every yield/vault getter).
            There is <em>no</em> Morpho integration. A yield-distribution variant
            exists on disk but was never deployed and is not on the roadmap &mdash;
            keeping the pool simple is the point.
          </p>
        </div>
      </details>

      <footer className="border-t border-zinc-200 pt-6 text-xs text-zinc-500">
        <p>
          Last updated:{" "}
          <span className="tabular-nums">{data.ts}</span> · Blocks{" "}
          <span className="tabular-nums">
            {data.blockRange.from}–{data.blockRange.to}
          </span>
        </p>
        <p className="mt-2">
          Source:{" "}
          <Link href="/api/anonymity-set" className="underline">
            /api/anonymity-set
          </Link>{" "}
          · Methodology:{" "}
          <Link href="/anonymity-set-disclosure" className="underline">
            disclosure policy
          </Link>{" "}
          · Threat model:{" "}
          <Link href="/threat-model" className="underline">
            /threat-model
          </Link>
        </p>
      </footer>
    </main>
  );
}
