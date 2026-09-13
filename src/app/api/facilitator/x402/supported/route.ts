import { NextResponse } from "next/server";
import { getActiveStack } from "@/lib/contracts";
import { buildX402SupportedResponse } from "@/lib/x402-facilitator";

/**
 * GET /api/facilitator/x402/supported
 *
 * Standard x402 v2 facilitator discovery endpoint. A stock
 * HTTPFacilitatorClient appends `/supported`, `/verify`, and `/settle` to the
 * same base URL, so all three handlers must live beneath `/x402`.
 *
 * This is the seller-facing settlement surface. It advertises standard
 * EIP-3009 support even when the buyer privacy pool is in pilot, because a
 * seller may submit any valid exact payment here; privacy, when present, was
 * established upstream before the seller received the payment.
 */
export async function GET() {
  const stack = getActiveStack();
  return NextResponse.json(buildX402SupportedResponse(stack.facilitatorNetwork), {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Compatibility for clients that POST discovery requests. */
export async function POST() {
  return GET();
}
