require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { paymentMiddleware } = require("@x402/express");
const { x402ResourceServer, HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { declareDiscoveryExtension } = require("@x402/extensions/bazaar");
const { createPublicClient, http, parseAbi, getAddress } = require("viem");
const { base, baseSepolia } = require("viem/chains");

const app = express();
app.use(express.json());

// --- Config ---
const PAY_TO = process.env.X402_RECIPIENT || "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21";
const PORT = process.env.PORT || 4020;

// --- Network selection (explicit, fail-safe) ---
// Settlement network is chosen by X402_NETWORK (mainnet|sepolia), NOT by the
// mere presence of CDP keys — a copied key must never silently move real money.
// Default is Sepolia. Mainnet additionally REQUIRES the CDP facilitator creds.
const X402_NETWORK = (process.env.X402_NETWORK || "sepolia").toLowerCase();
if (!["mainnet", "sepolia"].includes(X402_NETWORK)) {
  console.error(`FATAL: X402_NETWORK must be 'mainnet' or 'sepolia', got '${X402_NETWORK}'`);
  process.exit(1);
}
const USE_MAINNET = X402_NETWORK === "mainnet";
if (USE_MAINNET && !(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET)) {
  console.error("FATAL: X402_NETWORK=mainnet requires CDP_API_KEY_ID + CDP_API_KEY_SECRET");
  process.exit(1);
}
const NETWORK = USE_MAINNET ? "eip155:8453" : "eip155:84532";
// USDC + scan chain track the settlement network (no more scanning mainnet
// while settling on Sepolia).
const USDC_ADDRESS = USE_MAINNET
  ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" // Circle USDC, Base mainnet
  : "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Circle USDC, Base Sepolia
const SCAN_CHAIN = USE_MAINNET ? base : baseSepolia;
const SCAN_RPC = USE_MAINNET ? "https://mainnet.base.org" : "https://sepolia.base.org";

let facilitator;
if (USE_MAINNET) {
  const { facilitator: cdpFacilitator } = require("@coinbase/x402");
  facilitator = new HTTPFacilitatorClient(cdpFacilitator);
  console.log("Using CDP facilitator (Base mainnet)");
} else {
  facilitator = new HTTPFacilitatorClient({ url: "https://www.x402.org/facilitator" });
  console.log("Using x402.org facilitator (Base Sepolia) — set X402_NETWORK=mainnet (+ CDP keys) for mainnet");
}
const server = new x402ResourceServer(facilitator);
server.register(NETWORK, new ExactEvmScheme());

// --- On-chain client for privacy checks (tracks the settlement network) ---
const publicClient = createPublicClient({
  chain: SCAN_CHAIN,
  transport: http(SCAN_RPC),
});

// Known x402 service provider addresses (from bazaar)
const KNOWN_PROVIDERS = {
  "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f": "Nansen",
  // Add more as discovered
};

// --- Logging ---
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Privacy: this is a privacy product — never log raw wallet addresses to disk.
// Store a salted hash prefix (enough to correlate for rate/abuse analysis,
// not enough to recover the address). Set X402_LOG_SALT to a stable secret so
// hashes are consistent across restarts but not reversible by log readers.
const LOG_SALT = process.env.X402_LOG_SALT || "zbase-x402-log-v1";
function hashWallet(addr) {
  if (!addr) return "unknown";
  return "w_" + crypto.createHash("sha256").update(LOG_SALT + addr.toLowerCase()).digest("hex").slice(0, 16);
}

function logRequest(endpoint, walletAddress, status, amount) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    endpoint,
    wallet: hashWallet(walletAddress),
    status,
    amount: amount || "0",
  });
  fs.appendFileSync(path.join(LOG_DIR, "requests.ndjson"), entry + "\n");
}

// --- Free endpoints (before payment middleware) ---

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "zBase Privacy API",
    version: "1.0.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/zx402/supported", (req, res) => {
  res.json({
    service: "zBase Privacy API",
    version: "1.0.0",
    description:
      "Privacy infrastructure for AI agent payments on Base. Analyze your payment trail exposure, and (coming soon) make private payments via ZK proofs.",
    network: NETWORK,
    endpoints: {
      "POST /api/zx402/privacy-check": {
        price: "$0.005",
        description: "Quick scan: x402 payment exposure for a wallet address",
      },
      "POST /api/zx402/exposure-report": {
        price: "$0.01",
        description: "Full report: payment trail analysis with risk score",
      },
    },
    roadmap: {
      phase1: "Privacy check & exposure reports (live now)",
      phase2: "Agent identity registry with spend limits",
      phase3: "Full ZK privacy facilitator — private x402 payments via Groth16 proofs",
    },
    competitive: {
      vs_CDP: "CDP facilitator = public payments. zBase = private payments.",
      vs_Railgun: "Railgun = human wallets. zBase = AI agent payments. Not on Base.",
      vs_0xbow: "0xbow = ETH mainnet only. zBase = Base-native with x402 integration.",
    },
    links: {
      github: "https://github.com/goheesheng/zx402",
      docs: "https://github.com/goheesheng/zx402/blob/main/README.md",
    },
  });
});

// --- Payment middleware ---
app.use(
  paymentMiddleware(
    {
      "POST /api/zx402/privacy-check": {
        accepts: {
          scheme: "exact",
          price: "0.005",
          network: NETWORK,
          payTo: PAY_TO,
        },
        description:
          "Quick privacy scan: analyze a wallet address for x402 payment trail exposure on Base. Returns visible payments, services used, and total spend exposed on-chain.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                address: "0x1234...5678",
                totalTransfers: 47,
                x402PaymentsDetected: 12,
                servicesExposed: ["Nansen", "x-router AI", "CoinGecko"],
                totalSpendVisible: "23.50",
                riskLevel: "HIGH",
                summary:
                  "Your agent has made 12 identifiable x402 payments totaling $23.50 USDC. Anyone can see which services you use and how much you spend.",
              },
              schema: {
                properties: {
                  address: { type: "string" },
                  totalTransfers: { type: "number" },
                  x402PaymentsDetected: { type: "number" },
                  servicesExposed: {
                    type: "array",
                    items: { type: "string" },
                  },
                  totalSpendVisible: { type: "string" },
                  riskLevel: { type: "string" },
                  summary: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "POST /api/zx402/exposure-report": {
        accepts: {
          scheme: "exact",
          price: "0.01",
          network: NETWORK,
          payTo: PAY_TO,
        },
        description:
          "Full privacy exposure report: detailed analysis of all x402 payment history for a wallet on Base. Includes service categorization, spend patterns, timing analysis, counterparty list, and privacy risk score (0-100).",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                address: "0x1234...5678",
                riskScore: 78,
                riskLevel: "HIGH",
                totalTransfers: 147,
                x402Payments: {
                  count: 34,
                  totalUSDC: "156.30",
                  uniqueProviders: 8,
                },
                serviceBreakdown: [
                  { provider: "Nansen", payments: 12, totalUSDC: "0.12" },
                  { provider: "x-router AI", payments: 8, totalUSDC: "45.00" },
                ],
                timingPatterns: {
                  mostActiveHour: 14,
                  mostActiveDay: "Tuesday",
                  averagePaymentsPerDay: 4.2,
                },
                recommendations: [
                  "Your LLM inference spending pattern reveals your AI strategy",
                  "Timing analysis shows your agent runs on a predictable schedule",
                  "Use zBase private payments to break the on-chain link",
                ],
              },
              schema: {
                properties: {
                  address: { type: "string" },
                  riskScore: { type: "number" },
                  riskLevel: { type: "string" },
                  totalTransfers: { type: "number" },
                  x402Payments: { type: "object" },
                  serviceBreakdown: { type: "array" },
                  timingPatterns: { type: "object" },
                  recommendations: { type: "array" },
                },
              },
            },
          }),
        },
      },
    },
    server,
  ),
);

// --- Protected endpoints ---

const USDC_TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

async function analyzeWallet(address) {
  const checksumAddress = getAddress(address);

  // Get recent USDC transfers FROM this address (last ~50k blocks ≈ 1 day on Base)
  const latestBlock = await publicClient.getBlockNumber();
  const fromBlock = latestBlock - 50000n;

  const logs = await publicClient.getLogs({
    address: USDC_ADDRESS,
    event: USDC_TRANSFER_ABI[0],
    args: { from: checksumAddress },
    fromBlock,
    toBlock: latestBlock,
  });

  // Analyze transfers
  const transfers = logs.map((log) => ({
    to: log.args.to,
    amount: Number(log.args.value) / 1e6,
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash,
  }));

  // Match against known x402 providers
  const x402Payments = [];
  const unknownPayments = [];

  for (const t of transfers) {
    const providerName = KNOWN_PROVIDERS[t.to];
    if (providerName) {
      x402Payments.push({ ...t, provider: providerName });
    } else {
      // Small payments ($0.001-$1) to unknown addresses are likely x402
      if (t.amount >= 0.001 && t.amount <= 1.0) {
        x402Payments.push({ ...t, provider: "Unknown x402 service" });
      } else {
        unknownPayments.push(t);
      }
    }
  }

  const totalSpend = x402Payments.reduce((sum, p) => sum + p.amount, 0);

  // Count unique providers
  const providerCounts = {};
  for (const p of x402Payments) {
    const key = p.provider || p.to;
    if (!providerCounts[key]) providerCounts[key] = { payments: 0, totalUSDC: 0 };
    providerCounts[key].payments++;
    providerCounts[key].totalUSDC += p.amount;
  }

  // Risk score (0-100)
  let riskScore = 0;
  riskScore += Math.min(x402Payments.length * 3, 40); // More payments = more exposure
  riskScore += Math.min(Object.keys(providerCounts).length * 10, 30); // More providers = more info leaked
  riskScore += totalSpend > 10 ? 20 : totalSpend > 1 ? 10 : 0; // Higher spend = higher value target
  riskScore += transfers.length > 50 ? 10 : 0; // High activity

  const riskLevel =
    riskScore >= 70 ? "HIGH" : riskScore >= 40 ? "MEDIUM" : "LOW";

  return {
    address: checksumAddress,
    totalTransfers: transfers.length,
    x402PaymentsDetected: x402Payments.length,
    totalSpendVisible: totalSpend.toFixed(2),
    riskScore,
    riskLevel,
    providerCounts,
    x402Payments,
    servicesExposed: [
      ...new Set(x402Payments.map((p) => p.provider)),
    ],
  };
}

app.post("/api/zx402/privacy-check", async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: "Valid Ethereum address required in body: { address: '0x...' }" });
    }

    const analysis = await analyzeWallet(address);

    const result = {
      address: analysis.address,
      totalTransfers: analysis.totalTransfers,
      x402PaymentsDetected: analysis.x402PaymentsDetected,
      servicesExposed: analysis.servicesExposed,
      totalSpendVisible: analysis.totalSpendVisible,
      riskLevel: analysis.riskLevel,
      summary: `Your agent has made ${analysis.x402PaymentsDetected} identifiable x402 payments totaling $${analysis.totalSpendVisible} USDC. ${analysis.riskLevel === "HIGH" ? "Anyone can see which services you use and how much you spend." : analysis.riskLevel === "MEDIUM" ? "Some payment patterns are visible on-chain." : "Limited exposure detected."}`,
    };

    logRequest("privacy-check", address, 200, "0.005");
    res.json(result);
  } catch (err) {
    logRequest("privacy-check", req.body?.address, 500, "0.005");
    res.status(500).json({ error: "Analysis failed", details: err.message });
  }
});

app.post("/api/zx402/exposure-report", async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: "Valid Ethereum address required in body: { address: '0x...' }" });
    }

    const analysis = await analyzeWallet(address);

    // Timing analysis
    const timingPatterns = {
      totalBlocksAnalyzed: 50000,
      paymentsInWindow: analysis.x402Payments.length,
      averagePaymentsPerDay: +(analysis.x402Payments.length / 1).toFixed(1), // ~1 day window
    };

    // Service breakdown
    const serviceBreakdown = Object.entries(analysis.providerCounts).map(
      ([provider, data]) => ({
        provider,
        payments: data.payments,
        totalUSDC: data.totalUSDC.toFixed(4),
      }),
    );
    serviceBreakdown.sort((a, b) => b.payments - a.payments);

    // Recommendations
    const recommendations = [];
    if (analysis.x402PaymentsDetected > 5) {
      recommendations.push(
        "Your payment history reveals which AI services your agent uses"
      );
    }
    if (Object.keys(analysis.providerCounts).length > 3) {
      recommendations.push(
        "Multiple service providers exposed — competitors can map your full AI stack"
      );
    }
    if (analysis.totalSpendVisible > 10) {
      recommendations.push(
        `$${analysis.totalSpendVisible} in visible spending makes you a high-value intelligence target`
      );
    }
    if (analysis.x402PaymentsDetected > 0) {
      recommendations.push(
        "Use zBase private payments to break the on-chain link between your wallet and service providers"
      );
    }
    if (recommendations.length === 0) {
      recommendations.push(
        "Low exposure detected. Consider private payments to maintain this status as usage grows."
      );
    }

    const result = {
      address: analysis.address,
      riskScore: analysis.riskScore,
      riskLevel: analysis.riskLevel,
      totalTransfers: analysis.totalTransfers,
      x402Payments: {
        count: analysis.x402PaymentsDetected,
        totalUSDC: analysis.totalSpendVisible,
        uniqueProviders: Object.keys(analysis.providerCounts).length,
      },
      serviceBreakdown,
      timingPatterns,
      recommendations,
      note: "Full ZK private payments coming in Phase 3. Join the waitlist at github.com/goheesheng/zx402",
    };

    logRequest("exposure-report", address, 200, "0.01");
    res.json(result);
  } catch (err) {
    logRequest("exposure-report", req.body?.address, 500, "0.01");
    res.status(500).json({ error: "Analysis failed", details: err.message });
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`zBase Privacy API running on port ${PORT}`);
  console.log(`Payment recipient: ${PAY_TO}`);
  console.log(`Network: ${USE_MAINNET ? "Base mainnet" : "Base Sepolia"} (${NETWORK})`);
  console.log(`Endpoints:`);
  console.log(`  GET  /health                      - Free`);
  console.log(`  GET  /api/zx402/supported          - Free`);
  console.log(`  POST /api/zx402/privacy-check      - $0.005 USDC`);
  console.log(`  POST /api/zx402/exposure-report     - $0.01 USDC`);
});
