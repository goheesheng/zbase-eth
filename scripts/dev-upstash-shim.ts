/**
 * dev-upstash-shim — in-memory store speaking the Upstash Redis REST protocol.
 *
 * zBase's shared indexer, settlement store, ASP lock and rate limiter talk to Redis
 * only through `@upstash/redis` (REST). Production uses real Redis behind SRH; local
 * dev has neither, so `/api/facilitator/verify` refuses with INDEXER_NOT_CONFIGURED.
 * This shim gives a laptop a working store for the full deposit → verify → settle
 * flow WITHOUT Docker or an Upstash account. State is process-memory only: it is
 * gone when the shim exits, which is exactly right for a dev run — the indexer
 * re-verifies its cache against the on-chain root on every read anyway.
 *
 * Usage:
 *   npx tsx scripts/dev-upstash-shim.ts --port 4091
 *   UPSTASH_REDIS_REST_URL=http://127.0.0.1:4091 UPSTASH_REDIS_REST_TOKEN=dev npm run dev -- -p 3009
 *
 * Supports: PING GET SET(NX/XX/EX/PX/GET) MGET DEL EXISTS INCR INCRBY DECR EXPIRE
 * PEXPIRE TTL RPUSH LPUSH LRANGE LLEN LINDEX LTRIM HSET HGET HGETALL HDEL SADD
 * SREM SMEMBERS SISMEMBER KEYS, the `Upstash-Encoding: base64` response encoding,
 * `/pipeline` + `/multi-exec`, and EVAL for the four lock scripts the app uses
 * (settlement reserve / finalize / release, the ASP compare-and-delete and the
 * ASP monotonic-record put, and @upstash/ratelimit's sliding window), plus
 * SCRIPT LOAD / EVALSHA for the same scripts (NOSCRIPT otherwise, so the client falls
 * back to EVAL). Any
 * other EVAL returns an error so a new script cannot silently misbehave.
 * Local dev only: binds 127.0.0.1; the bearer token is not checked.
 */
import http from "http";
import { createHash } from "crypto";

const scripts = new Map<string, string>(); // sha1 → Lua source (SCRIPT LOAD / EVALSHA)

type Val = { kind: "str"; v: string } | { kind: "list"; v: string[] } | { kind: "hash"; v: Map<string, string> } | { kind: "set"; v: Set<string> };
const store = new Map<string, Val>();
const expiry = new Map<string, number>();

function alive(key: string): boolean {
  const exp = expiry.get(key);
  if (exp !== undefined && Date.now() >= exp) {
    store.delete(key);
    expiry.delete(key);
    return false;
  }
  return store.has(key);
}
function getStr(key: string): string | null {
  if (!alive(key)) return null;
  const v = store.get(key)!;
  if (v.kind !== "str") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  return v.v;
}
function setStr(key: string, value: string, ttlMs?: number): void {
  store.set(key, { kind: "str", v: value });
  if (ttlMs !== undefined) expiry.set(key, Date.now() + ttlMs);
  else expiry.delete(key);
}
function getList(key: string, create: boolean): string[] | null {
  if (!alive(key)) {
    if (!create) return null;
    const v: Val = { kind: "list", v: [] };
    store.set(key, v);
    return v.v;
  }
  const v = store.get(key)!;
  if (v.kind !== "list") throw new Error("WRONGTYPE");
  return v.v;
}
function getHash(key: string, create: boolean): Map<string, string> | null {
  if (!alive(key)) {
    if (!create) return null;
    const v: Val = { kind: "hash", v: new Map() };
    store.set(key, v);
    return v.v;
  }
  const v = store.get(key)!;
  if (v.kind !== "hash") throw new Error("WRONGTYPE");
  return v.v;
}
function getSet(key: string, create: boolean): Set<string> | null {
  if (!alive(key)) {
    if (!create) return null;
    const v: Val = { kind: "set", v: new Set() };
    store.set(key, v);
    return v.v;
  }
  const v = store.get(key)!;
  if (v.kind !== "set") throw new Error("WRONGTYPE");
  return v.v;
}
function del(key: string): number {
  const had = alive(key);
  store.delete(key);
  expiry.delete(key);
  return had ? 1 : 0;
}
function globToRegex(g: string): RegExp {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

type R = string | number | null | R[];

function evalScript(script: string, keys: string[], argv: string[]): R {
  const s = script.replace(/\s+/g, " ").toLowerCase();
  // settlement-store RESERVE_LUA: SET KEYS[1] ARGV[1] NX EX ARGV[2] → 1 | 0
  if (s.includes("'set', keys[1], argv[1], 'nx', 'ex'")) {
    if (alive(keys[0])) return 0;
    setStr(keys[0], argv[0], Number(argv[1]) * 1000);
    return 1;
  }
  // settlement-store FINALIZE_LUA
  if (s.includes("local lock = redis.call('get', keys[2])") && s.includes("'exists', keys[1]")) {
    const lock = getStr(keys[1]);
    if (lock === argv[0]) {
      setStr(keys[0], argv[1], Number(argv[2]) * 1000);
      del(keys[1]);
      return 1;
    }
    if (!alive(keys[0])) {
      setStr(keys[0], argv[1], Number(argv[2]) * 1000);
      return 2;
    }
    return 0;
  }
  // RELEASE_LUA / asp-update-state compare-and-delete
  if (s.includes("redis.call('get', keys[1]) == argv[1]") && s.includes("'del', keys[1]")) {
    return getStr(keys[0]) === argv[0] ? del(keys[0]) : 0;
  }
  // asp-update-state put(): monotonic terminal record — keep an existing
  // "included"/"rejected" JSON record, otherwise SET KEYS[1]=ARGV[1] EX ARGV[2].
  if (s.includes("cjson.decode") && s.includes("'included'") && s.includes("'rejected'")) {
    const current = getStr(keys[0]);
    if (current !== null) {
      try {
        const decoded = JSON.parse(current) as { status?: string };
        if (decoded.status === "included" || decoded.status === "rejected") return current;
      } catch { /* not JSON → overwrite, same as the Lua pcall branch */ }
    }
    setStr(keys[0], argv[0], Number(argv[1]) * 1000);
    return argv[0];
  }
  // @upstash/ratelimit sliding window (src/lib/rate-limit.ts):
  // KEYS = [currentKey, previousKey, dynamicLimitKey], ARGV = [tokens, nowMs, windowMs, incrementBy]
  // returns [remaining (>= 0, or -1 when limited), effectiveLimit] (ratelimit v2.0.x).
  if (s.includes("previouskey") && s.includes("dynamiclimitkey")) {
    let tokens = Number(argv[0]);
    const now = Number(argv[1]);
    const window = Number(argv[2]);
    const incrementBy = Number(argv[3] ?? 1);
    const dyn = keys[2] ? getStr(keys[2]) : null;
    if (dyn !== null) tokens = Number(dyn);
    const inCurrent = Number(getStr(keys[0]) ?? 0);
    const pctInCurrent = (now % window) / window;
    const inPrevious = Math.floor((1 - pctInCurrent) * Number(getStr(keys[1]) ?? 0));
    // v2.0.x returns {remaining, effectiveLimit}
    if (inPrevious + inCurrent >= tokens) return [-1, tokens];
    const newValue = inCurrent + incrementBy;
    const exp = expiry.get(keys[0]);
    setStr(keys[0], String(newValue));
    if (newValue === incrementBy) expiry.set(keys[0], Date.now() + window * 2 + 1000);
    else if (exp !== undefined) expiry.set(keys[0], exp);
    return [tokens - (newValue + inPrevious), tokens];
  }
  throw new Error(`dev-upstash-shim: unsupported EVAL script — add it to scripts/dev-upstash-shim.ts: ${s.slice(0, 200)}`);
}

function exec(cmd: unknown[]): R {
  const name = String(cmd[0]).toUpperCase();
  const a = cmd.slice(1).map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  switch (name) {
    case "PING": return "PONG";
    case "GET": return getStr(a[0]);
    case "MGET": return a.map((k) => getStr(k));
    case "SET": {
      const [key, value, ...opts] = a;
      let ttl: number | undefined;
      let nx = false, xx = false, get = false;
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i].toUpperCase();
        if (o === "EX") ttl = Number(opts[++i]) * 1000;
        else if (o === "PX") ttl = Number(opts[++i]);
        else if (o === "NX") nx = true;
        else if (o === "XX") xx = true;
        else if (o === "GET") get = true;
        else if (o === "KEEPTTL") { /* ignore */ }
      }
      const exists = alive(key);
      const prev = exists ? getStr(key) : null;
      if ((nx && exists) || (xx && !exists)) return get ? prev : null;
      setStr(key, value, ttl);
      return get ? prev : "OK";
    }
    case "DEL": return a.reduce((n, k) => n + del(k), 0);
    case "EXISTS": return a.reduce((n, k) => n + (alive(k) ? 1 : 0), 0);
    case "INCR":
    case "INCRBY":
    case "DECR": {
      const by = name === "INCR" ? 1 : name === "DECR" ? -1 : Number(a[1]);
      const cur = Number(getStr(a[0]) ?? "0") + by;
      const exp = expiry.get(a[0]);
      setStr(a[0], String(cur));
      if (exp !== undefined) expiry.set(a[0], exp);
      return cur;
    }
    case "EXPIRE": if (!alive(a[0])) return 0; expiry.set(a[0], Date.now() + Number(a[1]) * 1000); return 1;
    case "PEXPIRE": if (!alive(a[0])) return 0; expiry.set(a[0], Date.now() + Number(a[1])); return 1;
    case "TTL": {
      if (!alive(a[0])) return -2;
      const exp = expiry.get(a[0]);
      return exp === undefined ? -1 : Math.max(0, Math.ceil((exp - Date.now()) / 1000));
    }
    case "RPUSH": { const l = getList(a[0], true)!; l.push(...a.slice(1)); return l.length; }
    case "LPUSH": { const l = getList(a[0], true)!; l.unshift(...a.slice(1).reverse()); return l.length; }
    case "LLEN": return getList(a[0], false)?.length ?? 0;
    case "LINDEX": { const l = getList(a[0], false); if (!l) return null; const i = Number(a[1]); return l[i < 0 ? l.length + i : i] ?? null; }
    case "LRANGE": {
      const l = getList(a[0], false) ?? [];
      let s = Number(a[1]), e = Number(a[2]);
      if (s < 0) s = Math.max(0, l.length + s);
      if (e < 0) e = l.length + e;
      return l.slice(s, e + 1);
    }
    case "LTRIM": {
      const l = getList(a[0], false);
      if (!l) return "OK";
      let s = Number(a[1]), e = Number(a[2]);
      if (s < 0) s = Math.max(0, l.length + s);
      if (e < 0) e = l.length + e;
      const kept = l.slice(s, e + 1);
      l.length = 0; l.push(...kept);
      return "OK";
    }
    case "HSET": { const h = getHash(a[0], true)!; let n = 0; for (let i = 1; i + 1 < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], a[i + 1]); } return n; }
    case "HGET": return getHash(a[0], false)?.get(a[1]) ?? null;
    case "HGETALL": { const h = getHash(a[0], false); if (!h) return []; const out: string[] = []; for (const [k, v] of h) out.push(k, v); return out; }
    case "HDEL": { const h = getHash(a[0], false); if (!h) return 0; let n = 0; for (const f of a.slice(1)) if (h.delete(f)) n++; return n; }
    case "SADD": { const s = getSet(a[0], true)!; let n = 0; for (const m of a.slice(1)) { if (!s.has(m)) { s.add(m); n++; } } return n; }
    case "SREM": { const s = getSet(a[0], false); if (!s) return 0; let n = 0; for (const m of a.slice(1)) if (s.delete(m)) n++; return n; }
    case "SMEMBERS": return [...(getSet(a[0], false) ?? [])];
    case "SISMEMBER": return getSet(a[0], false)?.has(a[1]) ? 1 : 0;
    case "KEYS": { const re = globToRegex(a[0] ?? "*"); return [...store.keys()].filter((k) => alive(k) && re.test(k)); }
    case "EVAL": {
      const script = a[0];
      const numKeys = Number(a[1]);
      scripts.set(createHash("sha1").update(script).digest("hex"), script);
      return evalScript(script, a.slice(2, 2 + numKeys), a.slice(2 + numKeys));
    }
    case "EVALSHA": {
      const script = scripts.get(a[0].toLowerCase());
      if (!script) throw new Error("NOSCRIPT No matching script. Please use EVAL.");
      const numKeys = Number(a[1]);
      return evalScript(script, a.slice(2, 2 + numKeys), a.slice(2 + numKeys));
    }
    case "SCRIPT": {
      if (a[0]?.toUpperCase() === "LOAD") {
        const sha = createHash("sha1").update(a[1]).digest("hex");
        scripts.set(sha, a[1]);
        return sha;
      }
      if (a[0]?.toUpperCase() === "EXISTS") return a.slice(1).map((sha) => (scripts.has(sha.toLowerCase()) ? 1 : 0));
      if (a[0]?.toUpperCase() === "FLUSH") { scripts.clear(); return "OK"; }
      throw new Error(`dev-upstash-shim: unsupported SCRIPT ${a[0]}`);
    }
    default:
      throw new Error(`dev-upstash-shim: unsupported command ${name}`);
  }
}

function encode(r: R, b64: boolean): R {
  if (!b64) return r;
  if (typeof r === "string") return Buffer.from(r, "utf8").toString("base64");
  if (Array.isArray(r)) return r.map((x) => encode(x, b64));
  return r;
}

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1] || 4091);

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ shim: "dev-upstash-shim", keys: [...store.keys()].filter(alive).length }));
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const b64 = String(req.headers["upstash-encoding"] ?? "").toLowerCase() === "base64";
    const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON" }));
      return;
    }
    const run = (cmd: unknown[]): { result?: R; error?: string } => {
      try {
        return { result: encode(exec(cmd), b64) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    };
    if (path.endsWith("/pipeline") || path.endsWith("/multi-exec")) {
      const out = (body as unknown[][]).map(run);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }
    const out = run(body as unknown[]);
    res.writeHead(out.error ? 400 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dev-upstash-shim on http://127.0.0.1:${PORT}  (in-memory; state lost on exit)`);
});
