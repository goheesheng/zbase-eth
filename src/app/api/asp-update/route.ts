import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { refreshAspRoot } from "@/lib/asp-root-updater";
import { getActiveChain, getActiveStack } from "@/lib/contracts";
import {
  acquireAspUpdateLock,
  aspUpdateSharedStateAvailable,
  ownsAspUpdateLock,
  releaseAspUpdateLock,
} from "@/lib/asp-update-state";

/**
 * POST /api/asp-update — privileged operator repair endpoint.
 *
 * Normal deposits use /api/deposits/confirm, which proves authorization with a
 * confirmed pool event. This endpoint remains bearer-only because it can scan
 * chain history and spend POSTMAN gas without such a proof.
 */
export async function POST(request: Request) {
  try {
    const secret = process.env.ASP_UPDATE_SECRET ?? process.env.CRON_SECRET;
    if (!secret) {
      return NextResponse.json(
        { error: "asp-update is locked: set ASP_UPDATE_SECRET or CRON_SECRET." },
        { status: 503 },
      );
    }
    if (request.headers.get("authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const limited = await checkRateLimit(request, "asp-update");
    if (!limited.success) return rateLimitResponse(limited);

    const stack = getActiveStack();
    if (getActiveChain().network === "mainnet" && !aspUpdateSharedStateAvailable()) {
      return NextResponse.json(
        { error: "asp-update is locked: mainnet requires Upstash Redis." },
        { status: 503 },
      );
    }
    const lock = await acquireAspUpdateLock(stack.facilitatorNetwork, stack.usdcPool);
    if (!lock.acquired) {
      return NextResponse.json(
        { status: "queued", updated: false, reason: "Another ASP update is processing." },
        { status: 202 },
      );
    }
    try {
      return NextResponse.json(
        await refreshAspRoot({
          maySubmitUpdate: () =>
            ownsAspUpdateLock(stack.facilitatorNetwork, stack.usdcPool, lock.token),
        }),
      );
    } finally {
      await releaseAspUpdateLock(stack.facilitatorNetwork, stack.usdcPool, lock.token);
    }
  } catch (error) {
    console.error("[ASP Update] Error:", error);
    return NextResponse.json(
      { error: (error as Error).message?.slice(0, 300) || "ASP update failed" },
      { status: 500 },
    );
  }
}
