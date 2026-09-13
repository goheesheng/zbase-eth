/**
 * Shared env loader for scripts — import this INSTEAD of "dotenv/config".
 *
 * Why: the bare `import "dotenv/config"` loads ONLY `.env`, but this repo keeps
 * its real keys in `.env.local` (Next.js convention). Scripts that used
 * `dotenv/config` reported "Missing POSTMAN_PRIVATE_KEY" even though the key was
 * set in `.env.local` (cost a debugging detour 2026-06-25). This loads both, with
 * `.env.local` taking precedence (Next.js order: .env.local > .env). dotenv's
 * path-array applies files left-to-right and does NOT override already-set vars,
 * so listing `.env.local` first makes it win.
 *
 * Usage:  import "./load-env";   // must be the first import in the script
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const candidates = [".env.local", ".env"].map((f) => join(root, f)).filter(existsSync);

if (candidates.length > 0) {
  // First existing file wins; dotenv won't override vars already set by an
  // earlier file or by the real process env.
  config({ path: candidates });
}
