import { NextResponse } from "next/server";

/**
 * GET /api/prompt  ->  308 redirect to /SKILL.md
 *
 * This route served an older copy-paste agent prompt (Base Sepolia / raw
 * note-secrets model) that has since gone stale. The single source of truth
 * is now `public/SKILL.md` at https://zbase.app/SKILL.md. Legacy alias.
 */
export function GET(request: Request) {
  return NextResponse.redirect(new URL("/SKILL.md", request.url), 308);
}
