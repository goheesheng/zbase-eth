import { NextResponse } from "next/server";
import { isAddress } from "viem";
import crypto from "crypto";

/**
 * POST /api/agent/register
 *
 * Register an AI agent with identity and permissions.
 * This solves the a16z problem: "prove who it represents + what it's allowed to do"
 *
 * Body: {
 *   name: string,           // Agent name (e.g. "Research Bot")
 *   owner: string,          // Owner wallet address
 *   publicKey?: string,     // Optional Ed25519 public key for signing
 *   permissions: {
 *     maxSpendPerTx: string,   // Max USDC per transaction (raw units)
 *     maxSpendPerDay: string,  // Max USDC per day (raw units)
 *     allowedCategories: string[],  // e.g. ["inference", "search", "data"]
 *     allowedProviders?: string[],  // Specific provider addresses (empty = any)
 *   }
 * }
 */

// In-memory store (production would use a database or on-chain registry)
interface AgentRecord {
  id: string;
  name: string;
  owner: string;
  publicKey: string;
  permissions: {
    maxSpendPerTx: string;
    maxSpendPerDay: string;
    allowedCategories: string[];
    allowedProviders: string[];
  };
  registeredAt: string;
  totalSpent: string;
  txCount: number;
  dailySpent: string;
  dailyResetAt: string;
}

// Global agent registry (resets on server restart -- demo only)
const agentRegistry = new Map<string, AgentRecord>();

export function getAgentRegistry() {
  return agentRegistry;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, owner, publicKey, permissions } = body;

    // Validate
    if (!name || typeof name !== "string" || name.length < 2) {
      return NextResponse.json({ error: "Agent name required (min 2 chars)" }, { status: 400 });
    }

    if (!owner || !isAddress(owner)) {
      return NextResponse.json({ error: "Valid owner wallet address required" }, { status: 400 });
    }

    if (!permissions) {
      return NextResponse.json({ error: "Permissions object required" }, { status: 400 });
    }

    const maxSpendPerTx = permissions.maxSpendPerTx || "1000000"; // default 1 USDC
    const maxSpendPerDay = permissions.maxSpendPerDay || "10000000"; // default 10 USDC
    const allowedCategories = permissions.allowedCategories || ["all"];
    const allowedProviders = permissions.allowedProviders || [];

    // Generate agent ID
    const id = `agent_${crypto.randomBytes(8).toString("hex")}`;

    // Generate a keypair if none provided (demo -- in production, agent brings its own key)
    const agentPublicKey = publicKey || `pk_${crypto.randomBytes(32).toString("hex")}`;

    const record: AgentRecord = {
      id,
      name,
      owner,
      publicKey: agentPublicKey,
      permissions: {
        maxSpendPerTx,
        maxSpendPerDay,
        allowedCategories,
        allowedProviders,
      },
      registeredAt: new Date().toISOString(),
      totalSpent: "0",
      txCount: 0,
      dailySpent: "0",
      dailyResetAt: new Date().toISOString(),
    };

    agentRegistry.set(id, record);

    // Log only the opaque id — never the owner wallet (ties an agent to a real
    // wallet in persistent logs).
    console.log(`[Agent Registry] Registered agent ${id}`);

    return NextResponse.json({
      registered: true,
      agent: {
        id,
        name,
        owner,
        publicKey: agentPublicKey,
        permissions: {
          maxSpendPerTx,
          maxSpendPerDay,
          allowedCategories,
          allowedProviders: allowedProviders.length > 0 ? allowedProviders : "any",
        },
        registeredAt: record.registeredAt,
      },
      note: "Save the agent ID and public key. You'll need the ID when calling facilitator/verify and facilitator/settle.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message?.slice(0, 300) || "Unknown error" },
      { status: 500 }
    );
  }
}

// GET /api/agent/register?id=agent_xxx -- look up an agent
//
// Privacy note (Phase 1C, per plan file):
//   txCount, totalSpent, dailySpent are stable real-time counters that
//   leak agent activity. A poller hitting this endpoint can timestamp
//   every settle by every agent and correlate to on-chain events. They
//   are kept server-side for permission enforcement (see
//   /api/facilitator/{verify,settle}) but stripped from any public read.
//   Owner-authenticated readback is a follow-up — until then, agent
//   owners check their own stats via the settle response's `agent`
//   object (still includes counters for the legitimate caller path).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  // Public read view. Strip `owner` (the controlling wallet) and
  // `permissions.allowedProviders`: publishing agent_id → owner EOA → the exact
  // providers that agent is allowed to pay lets anyone map an agent to a wallet
  // and to its payees, and settle/verify reference the agent_id — together that
  // de-anonymizes payer↔recipient. Spend limits/categories are non-linking
  // config and stay. Owner-authenticated readback of full config is a follow-up.
  const toPublic = (a: AgentRecord) => ({
    id: a.id,
    name: a.name,
    permissions: {
      maxSpendPerTx: a.permissions.maxSpendPerTx,
      maxSpendPerDay: a.permissions.maxSpendPerDay,
      allowedCategories: a.permissions.allowedCategories,
    },
    registeredAt: a.registeredAt,
  });

  if (!id) {
    const agents = Array.from(agentRegistry.values()).map(toPublic);
    return NextResponse.json({
      agents,
      count: agents.length,
      note: "Agent registry -- public view (owner wallet + provider whitelist withheld)",
    });
  }

  const agent = agentRegistry.get(id);
  if (!agent) {
    return NextResponse.json({ error: `Agent ${id} not found` }, { status: 404 });
  }

  return NextResponse.json({ agent: toPublic(agent) });
}
