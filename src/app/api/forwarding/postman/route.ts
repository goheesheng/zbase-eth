import { NextResponse } from "next/server";
import { getActiveChain, getActiveStack } from "@/lib/contracts";
import { getPostmanAddress } from "@/lib/postman-signer";

/**
 * GET /api/forwarding/postman
 *
 * The address a sweep authorization must name as `to`, plus the USDC contract and
 * chain id the client needs to build the EIP-712 domain itself.
 *
 * Why the client needs this: EIP-3009 `receiveWithAuthorization` binds `to` into the
 * signed message and USDC enforces `msg.sender == to`, so the wallet must know the
 * postman's address BEFORE it signs. That is also why publishing it is safe — it is
 * the destination of a transfer the user explicitly authorises.
 *
 * The client should build its own domain from these values rather than trusting a
 * server-supplied one; the sweep route hardcodes its side from getActiveStack()
 * regardless (see forwarding-sweep.ts sweepDomain).
 *
 * PRIVACY: this address is a permanent correlation anchor — every sweep names the
 * same `to`, so an observer can enumerate "addresses that funded zBase". Inherent to
 * routing deposits through one relayer, and the linkability the pool then undoes.
 */
export async function GET() {
  try {
    const chain = getActiveChain();
    const stack = getActiveStack();

    if (!stack.usdc || /^0x0{40}$/i.test(stack.usdc)) {
      return NextResponse.json(
        { error: "Active stack has no USDC — provision the stack first." },
        { status: 503 },
      );
    }

    const postman = await getPostmanAddress(chain.chain);

    return NextResponse.json(
      {
        postman,
        asset: stack.usdc,
        chainId: chain.chain.id,
        network: stack.facilitatorNetwork,
        // Everything the wallet needs to reconstruct the EIP-712 domain locally.
        domain: { name: "USD Coin", version: "2", chainId: chain.chain.id, verifyingContract: stack.usdc },
        primaryType: "ReceiveWithAuthorization",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    // A misconfigured postman must not look like "no postman" — that would invite a
    // client to sign an authorization naming the wrong `to`, which can never settle.
    return NextResponse.json(
      { error: `Postman address unavailable: ${(e as Error).message.slice(0, 200)}` },
      { status: 503 },
    );
  }
}
