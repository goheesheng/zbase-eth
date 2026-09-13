/**
 * dev-hypersync-shim — local JSON-RPC front for Envio's *native* HyperSync query API.
 *
 * Why this exists (2026-09-13): our HYPERSYNC_TOKEN lost access to Envio's JSON-RPC
 * product ("HyperRPC", the `*.rpc.hypersync.xyz` endpoints → 403 "does not have access
 * to this product"), but the native query API (`https://<network>.hypersync.xyz/query`)
 * still accepts the token. zBase talks to HyperSync through viem `http()` as plain
 * JSON-RPC, so the smallest fix is a shim that translates `eth_getLogs` into native
 * queries and proxies every other method to a normal RPC. Point `HYPERSYNC_URL` at it
 * (see src/lib/hypersync.ts) — no app code changes.
 *
 * Usage:
 *   npx tsx scripts/dev-hypersync-shim.ts --network base-sepolia --rpc https://sepolia.base.org --port 4090
 *   HYPERSYNC_URL=http://127.0.0.1:4090 npm run dev -- -p 3009
 *
 * Reads HYPERSYNC_TOKEN from the environment (falls back to .env.local). Local dev only:
 * binds 127.0.0.1, no auth of its own.
 */
import http from "http";
import fs from "fs";
import path from "path";

type Json = Record<string, unknown>;

function loadDotEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(1);
}

loadDotEnvLocal();
const NETWORK = arg("network", "base-sepolia"); // hypersync network slug: base-sepolia | base | sepolia | eth
const RPC = arg("rpc", "https://sepolia.base.org");
const PORT = Number(arg("port", "4090"));
const TOKEN = process.env.HYPERSYNC_TOKEN;
if (!TOKEN) {
  console.error("HYPERSYNC_TOKEN not set (env or .env.local)");
  process.exit(1);
}
const QUERY_URL = `https://${NETWORK}.hypersync.xyz/query`;
const HEIGHT_URL = `https://${NETWORK}.hypersync.xyz/height`;

const hex = (n: number | bigint): string => `0x${BigInt(n).toString(16)}`;

async function archiveHeight(): Promise<number> {
  const r = await fetch(HEIGHT_URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const j = (await r.json()) as { height?: number };
  if (typeof j.height !== "number") throw new Error(`hypersync /height: ${JSON.stringify(j).slice(0, 200)}`);
  return j.height;
}

async function blockTagToNumber(tag: unknown, height: () => Promise<number>): Promise<number> {
  if (tag === undefined || tag === null || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") {
    return height();
  }
  if (tag === "earliest") return 0;
  if (typeof tag === "string") return Number(BigInt(tag));
  if (typeof tag === "number") return tag;
  throw new Error(`bad block tag ${String(tag)}`);
}

interface NativeLog {
  block_number: number;
  log_index: number;
  transaction_index: number;
  transaction_hash: string;
  data: string;
  address: string;
  topic0: string | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  block_hash: string;
  removed?: boolean | null;
}

async function ethGetLogs(filter: Json): Promise<Json[]> {
  let cachedHeight: number | null = null;
  const height = async () => (cachedHeight ??= await archiveHeight());
  const from = await blockTagToNumber(filter.fromBlock, height);
  const to = await blockTagToNumber(filter.toBlock, height);
  if (to < from) return [];

  const addrRaw = filter.address;
  const address = addrRaw === undefined || addrRaw === null ? undefined : Array.isArray(addrRaw) ? (addrRaw as string[]) : [addrRaw as string];
  const topicsRaw = (filter.topics as (string | string[] | null)[] | undefined) ?? [];
  const topics = topicsRaw.map((t) => (t === null || t === undefined ? [] : Array.isArray(t) ? t : [t]));
  const logSelector: Json = {};
  if (address) logSelector.address = address;
  if (topics.some((t) => t.length > 0)) logSelector.topics = topics;

  const out: Json[] = [];
  let cursor = from;
  // HyperSync pages: each response covers [from_block, next_block). to_block is exclusive.
  for (let page = 0; page < 10_000; page++) {
    const body = {
      from_block: cursor,
      to_block: to + 1,
      logs: [logSelector],
      field_selection: {
        log: [
          "block_number", "log_index", "transaction_index", "transaction_hash", "data",
          "address", "topic0", "topic1", "topic2", "topic3", "block_hash", "removed",
        ],
      },
    };
    const r = await fetch(QUERY_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as { data?: { logs?: NativeLog[] }[]; next_block?: number; archive_height?: number; error?: string };
    if (j.error || !Array.isArray(j.data)) throw new Error(`hypersync query: ${j.error ?? JSON.stringify(j).slice(0, 200)}`);
    for (const chunk of j.data) {
      for (const l of chunk.logs ?? []) {
        out.push({
          address: l.address,
          topics: [l.topic0, l.topic1, l.topic2, l.topic3].filter((t): t is string => typeof t === "string" && t.length > 0),
          data: l.data ?? "0x",
          blockNumber: hex(l.block_number),
          transactionHash: l.transaction_hash,
          transactionIndex: hex(l.transaction_index),
          blockHash: l.block_hash,
          logIndex: hex(l.log_index),
          removed: Boolean(l.removed),
        });
      }
    }
    const next = j.next_block ?? to + 1;
    if (next > to || (typeof j.archive_height === "number" && next > j.archive_height) || next <= cursor) break;
    cursor = next;
  }
  out.sort((a, b) => {
    const d = Number(BigInt(a.blockNumber as string) - BigInt(b.blockNumber as string));
    return d !== 0 ? d : Number(BigInt(a.logIndex as string) - BigInt(b.logIndex as string));
  });
  return out;
}

async function proxy(req: Json): Promise<Json> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  return (await r.json()) as Json;
}

async function handle(req: Json): Promise<Json> {
  const id = req.id ?? null;
  try {
    if (req.method === "eth_getLogs") {
      const params = (req.params as Json[] | undefined) ?? [];
      const result = await ethGetLogs(params[0] ?? {});
      return { jsonrpc: "2.0", id, result };
    }
    return await proxy(req);
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32000, message: (e as Error).message } };
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ shim: "dev-hypersync-shim", network: NETWORK, rpc: RPC }));
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON" }));
      return;
    }
    const started = Date.now();
    const out = Array.isArray(parsed) ? await Promise.all((parsed as Json[]).map(handle)) : await handle(parsed as Json);
    const methods = (Array.isArray(parsed) ? (parsed as Json[]) : [parsed as Json]).map((r) => r.method).join(",");
    console.log(`[hypersync-shim] ${methods} ${Date.now() - started}ms`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dev-hypersync-shim on http://127.0.0.1:${PORT}  (eth_getLogs → ${QUERY_URL}; other methods → ${RPC})`);
});
