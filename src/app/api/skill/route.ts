import { NextResponse } from "next/server";

/**
 * GET /api/skill  ->  308 redirect to /SKILL.md
 *
 * The canonical agent skill is now the single static file `public/SKILL.md`,
 * served at https://zbase.app/SKILL.md (CDN, always fresh, one source of truth).
 * The old inline copy here had drifted stale (Base Sepolia / note-secrets model)
 * while docs pointed agents at /SKILL.md, so this legacy alias now redirects.
 * `curl -L zbase.app/api/skill` still resolves to the current skill.
 */
export function GET(request: Request) {
  return NextResponse.redirect(new URL("/SKILL.md", request.url), 308);
}
