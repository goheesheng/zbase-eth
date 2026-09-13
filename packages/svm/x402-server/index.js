require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { paymentMiddleware } = require("@x402/express");
const { x402ResourceServer, HTTPFacilitatorClient } = require("@x402/core/server");
const { SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } = require("@x402/svm");
const { ExactSvmScheme } = require("@x402/svm/exact/server");
const { declareDiscoveryExtension } = require("@x402/extensions/bazaar");
const { Keypair, Connection, PublicKey } = require("@solana/web3.js");
const { getAccount, getAssociatedTokenAddress } = require("@solana/spl-token");
const { Program, AnchorProvider, Wallet } = require("@coral-xyz/anchor");
const BN = require("bn.js");

const app = express();
app.use(express.json());

// --- Config ---
const PORT = process.env.PORT || 4020;
const NETWORK = SOLANA_DEVNET_CAIP2; // Switch to SOLANA_MAINNET_CAIP2 for mainnet
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM");
const USDC_MINT_MAINNET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_MINT_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PRIVATE_TOKEN_MINT = new PublicKey(
  process.env.ZX402_TOKEN_MINT || USDC_MINT_DEVNET.toBase58(),
);

// Solana is paused by default. Re-enable only after the exact reviewed SBF
// artifact is deployed and independently dumped/hash-checked from devnet.
const SVM_REQUESTED =
  String(process.env.ZX402_SVM_READY ?? "false").toLowerCase() === "true";
const REVIEWED_SVM_ARTIFACT_SHA256 =
  "6961e45a7604c45eadec3c4f9f3424c1353e9acbdd8289460983b2d9d1912a3b";
// `solana program dump` returns the complete 532,200-byte ProgramData
// allocation. This is the reviewed artifact above with zero padding.
const EXPECTED_SVM_PROGRAMDATA_SHA256 =
  "a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f";
const UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

// Load the relayer without requiring a machine-global Solana CLI profile.
// Managed deployments should inject the JSON array via a secret; local
// development falls back to the normal Solana keypair path.
function loadRelayerKeypair() {
  const inline = process.env.ZX402_RELAYER_SECRET_KEY;
  const serialized = inline || fs.readFileSync(
    process.env.ZX402_RELAYER_KEYPAIR_PATH ||
      path.join(os.homedir(), ".config/solana/id.json"),
    "utf8",
  );
  const parsed = JSON.parse(serialized);
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error("relayer secret key must be a JSON array containing 64 bytes");
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}
const walletKeypair = loadRelayerKeypair();
const PAY_TO = walletKeypair.publicKey.toBase58();
const SVM_STATIC_BLOCKING_REASONS = [
  ...(SVM_REQUESTED ? [] : ["ZX402_SVM_READY is false"]),
  ...(process.env.ZX402_DEPLOYED_BINARY_SHA256 === EXPECTED_SVM_PROGRAMDATA_SHA256
    ? []
    : ["devnet program binary has not been verified against the reviewed build hash"]),
];
const PAUSED_DISCLOSURE =
  "Solana/SVM is paused pending a verified program upgrade. Do not deposit; use the Base facilitator path.";

// --- x402 setup for Solana ---
const facilitator = new HTTPFacilitatorClient({ url: "https://www.x402.org/facilitator" });
const server = new x402ResourceServer(facilitator);
server.register(NETWORK, new ExactSvmScheme());

// --- Solana connection + Anchor program ---
const connection = new Connection(RPC_URL, "confirmed");
const anchorWallet = new Wallet(walletKeypair);
const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
const idlPath = path.join(__dirname, "..", "zx402-privacy-pool", "target", "idl", "zx402_privacy_pool.json");
let program = null;
if (fs.existsSync(idlPath)) {
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  program = new Program(idl, provider);
}

// Read the upgradeable-loader accounts directly. ProgramData has a fixed
// 45-byte metadata prefix; `solana program dump` hashes the bytes after it.
// Requiring this live hash prevents an environment variable alone from
// advertising a stale or different binary as reviewed.
async function attestDeployedProgram() {
  const programInfo = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
  if (!programInfo) throw new Error("program account does not exist");
  if (!programInfo.executable) throw new Error("program account is not executable");
  if (!programInfo.owner.equals(UPGRADEABLE_LOADER_ID)) {
    throw new Error(`program owner is ${programInfo.owner.toBase58()}, not the upgradeable loader`);
  }
  if (programInfo.data.length < 36 || programInfo.data.readUInt32LE(0) !== 2) {
    throw new Error("program account has an invalid upgradeable-loader layout");
  }
  const programDataAddress = new PublicKey(programInfo.data.subarray(4, 36));
  const programDataInfo = await connection.getAccountInfo(
    programDataAddress,
    "confirmed",
  );
  if (!programDataInfo) throw new Error("ProgramData account does not exist");
  if (!programDataInfo.owner.equals(UPGRADEABLE_LOADER_ID)) {
    throw new Error("ProgramData account is not owned by the upgradeable loader");
  }
  if (programDataInfo.data.length < 45 || programDataInfo.data.readUInt32LE(0) !== 3) {
    throw new Error("ProgramData account has an invalid upgradeable-loader layout");
  }
  const deployedBytes = programDataInfo.data.subarray(45);
  return {
    programDataAddress: programDataAddress.toBase58(),
    programDataLength: deployedBytes.length,
    sha256: crypto.createHash("sha256").update(deployedBytes).digest("hex"),
  };
}

let programAttestationProvider = attestDeployedProgram;
let readinessCache;
async function getSvmReadiness() {
  const now = Date.now();
  if (readinessCache && readinessCache.expiresAt > now) {
    return readinessCache.value;
  }
  const blockingReasons = [...SVM_STATIC_BLOCKING_REASONS];
  let attestation = null;
  if (blockingReasons.length === 0) {
    try {
      attestation = await programAttestationProvider();
      if (attestation.sha256 !== EXPECTED_SVM_PROGRAMDATA_SHA256) {
        blockingReasons.push(
          `on-chain ProgramData hash ${attestation.sha256} does not match the reviewed build`,
        );
      }
    } catch (error) {
      blockingReasons.push(`on-chain program attestation failed: ${error.message}`);
    }
  }
  const value = {
    ready: blockingReasons.length === 0,
    blockingReasons,
    attestation,
  };
  readinessCache = { value, expiresAt: now + 30_000 };
  return value;
}

// --- Logging ---
const LOG_DIR = process.env.ZX402_LOG_DIR || path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logRequest(endpoint, wallet, status, amount) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    endpoint,
    wallet: wallet || "unknown",
    status,
    amount: amount || "0",
  });
  fs.appendFileSync(path.join(LOG_DIR, "requests.ndjson"), entry + "\n");
}

// --- Free endpoints ---

app.get("/health", async (req, res) => {
  const readiness = await getSvmReadiness();
  res.json({
    status: "ok",
    service: readiness.ready
      ? "zBase Solana Privacy Facilitator"
      : "zBase Solana Facilitator (paused — reviewed binary not verified)",
    version: "1.0.0",
    network: "solana-devnet",
    program: PROGRAM_ID.toBase58(),
    wallet: PAY_TO,
    uptime: process.uptime(),
    ready: readiness.ready,
    customerReady: false,
    blockingReasons: readiness.blockingReasons,
    programAttestation: readiness.attestation,
    ...(readiness.ready ? {} : { disclosure: PAUSED_DISCLOSURE, statusDoc: "STATUS.md" }),
  });
});

app.get(["/api/zbase/supported", "/api/zx402/supported"], async (req, res) => {
  const readiness = await getSvmReadiness();
  const features = readiness.ready
    ? {
        privacy: "Sender-recipient unlinkability via Groth16; amounts and timing remain public",
        yield: "DISABLED (no external yield CPI)",
        compliance: "ASP root enforced; production witness distribution remains a launch gate",
        agentIdentity: "Registration exists; relay spend permissions are not yet enforced",
      }
    : {
        privacy: "PAUSED — reviewed source is not the binary currently on devnet",
        yield: "DISABLED",
        compliance: "PAUSED — post-upgrade checks have not run",
        agentIdentity: "Instruction exists; permissions not yet enforced on relay",
      };

  res.json({
    service: readiness.ready
      ? "zBase Solana Privacy Facilitator"
      : "zBase Solana Facilitator (paused)",
    version: "1.0.0",
    ready: readiness.ready,
    customerReady: false,
    description: readiness.ready
      ? "Devnet-only private-exact x402 facilitator. Clients generate proofs and retain note secrets."
      : "Private SVM x402 facilitator is implemented but paused until the reviewed SBF artifact is verified on devnet.",
    network: NETWORK,
    program: PROGRAM_ID.toBase58(),
    endpoints: {
      "POST /api/zbase/privacy-check": { price: "$0.005", description: "Scan wallet for x402 payment exposure" },
      "POST /api/zbase/premium-data": { price: "$0.01", description: "Premium data endpoint (demo service)" },
    },
    features,
    blockingReasons: readiness.blockingReasons,
    programAttestation: readiness.attestation,
    ...(readiness.ready ? {} : { disclosure: PAUSED_DISCLOSURE, statusDoc: "STATUS.md" }),
    links: { github: "https://github.com/goheesheng/zx402" },
  });
});

// --- Payment middleware ---
// These demo merchant routes remain ordinary public `exact` SVM payments.
// Private resource servers register `PrivateExactSvmServerScheme`; a public
// transaction signature is never accepted as a bearer token to bypass x402.
app.use(
  paymentMiddleware(
    {
      "POST /api/zbase/privacy-check": {
        accepts: {
          scheme: "exact",
          price: ".005",
          network: NETWORK,
          payTo: PAY_TO,
        },
        description: "Scan a Solana wallet for x402 payment trail exposure. Returns visible payments, services used, and privacy risk score.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { address: "BWTaGJeK2..." },
            inputSchema: {
              properties: { address: { type: "string" } },
              required: ["address"],
            },
            bodyType: "json",
            output: {
              example: {
                address: "BWTaGJeK2...",
                totalTransfers: 23,
                x402PaymentsDetected: 8,
                riskLevel: "MEDIUM",
                summary: "8 identifiable x402 payments detected on Solana.",
              },
              schema: {
                properties: {
                  address: { type: "string" },
                  totalTransfers: { type: "number" },
                  x402PaymentsDetected: { type: "number" },
                  riskLevel: { type: "string" },
                  summary: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "POST /api/zbase/premium-data": {
        accepts: {
          scheme: "exact",
          price: ".01",
          network: NETWORK,
          payTo: PAY_TO,
        },
        description: "Premium market intelligence data after payment.",
        mimeType: "application/json",
      },
      "POST /api/zx402/privacy-check": {
        accepts: {
          scheme: "exact",
          price: ".005",
          network: NETWORK,
          payTo: PAY_TO,
        },
        description: "Scan a Solana wallet for x402 payment trail exposure. Returns visible payments, services used, and privacy risk score.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { address: "BWTaGJeK2..." },
            inputSchema: {
              properties: { address: { type: "string" } },
              required: ["address"],
            },
            bodyType: "json",
            output: {
              example: {
                address: "BWTaGJeK2...",
                totalTransfers: 23,
                x402PaymentsDetected: 8,
                riskLevel: "MEDIUM",
                summary: "8 identifiable x402 payments detected on Solana.",
              },
              schema: {
                properties: {
                  address: { type: "string" },
                  totalTransfers: { type: "number" },
                  x402PaymentsDetected: { type: "number" },
                  riskLevel: { type: "string" },
                  summary: { type: "string" },
                },
              },
            },
          }),
        },
      },
      "POST /api/zx402/premium-data": {
        accepts: {
          scheme: "exact",
          price: ".01",
          network: NETWORK,
          payTo: PAY_TO,
        },
        description: "Premium data endpoint. Returns exclusive market intelligence. Demo service for testing the full x402 payment flow.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: {},
            inputSchema: { properties: {} },
            bodyType: "json",
            output: {
              example: {
                data: "Premium market intelligence",
                timestamp: "2026-05-07T00:00:00Z",
                source: "zBase Privacy Facilitator",
              },
              schema: {
                properties: {
                  data: { type: "string" },
                  timestamp: { type: "string" },
                  source: { type: "string" },
                },
              },
            },
          }),
        },
      },
    },
    server,
    undefined,
    undefined,
    false,
  ),
);

// --- Protected endpoints ---

app.post(["/api/zbase/privacy-check", "/api/zx402/privacy-check"], async (req, res) => {
  try {
    const readiness = await getSvmReadiness();
    const { address } = req.body;
    if (!address) {
      return res.status(400).json({ error: "Solana address required in body: { address: '...' }" });
    }

    const pubkey = new PublicKey(address);

    // Fetch recent signatures for the address
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 100 });

    // Classify: small USDC transfers are likely x402 payments
    let x402Count = 0;
    const providers = new Set();

    // Simple heuristic: count confirmed transactions (in production, parse for SPL transfers)
    for (const sig of signatures) {
      if (sig.confirmationStatus === "finalized" || sig.confirmationStatus === "confirmed") {
        x402Count++;
      }
    }

    const riskScore = Math.min(x402Count * 2, 100);
    const riskLevel = riskScore >= 70 ? "HIGH" : riskScore >= 40 ? "MEDIUM" : "LOW";

    const result = {
      address,
      totalTransfers: signatures.length,
      x402PaymentsDetected: Math.min(x402Count, signatures.length),
      riskLevel,
      riskScore,
      summary: `${signatures.length} transactions found for this address on Solana. ${riskLevel} exposure level.`,
      note: readiness.ready
        ? "Full ZK private payments available via the zBase privacy pool."
        : "Private SVM settlement is paused until the reviewed program upgrade is verified. See STATUS.md.",
      paidVia: "x402-direct",
    };

    logRequest("privacy-check", address, 200, "0.005");
    res.json(result);
  } catch (err) {
    logRequest("privacy-check", req.body?.address, 500, "0.005");
    res.status(500).json({ error: "Analysis failed", details: err.message });
  }
});

app.post(["/api/zbase/premium-data", "/api/zx402/premium-data"], async (req, res) => {
  try {
    const readiness = await getSvmReadiness();
    // This is a demo premium endpoint that returns data after x402 payment
    const result = {
      data: "Premium market intelligence: Solana x402 volume trending up 15% week-over-week. Top 3 paid APIs: Gemini, BigQuery, Vertex AI via Pay.sh.",
      timestamp: new Date().toISOString(),
      source: "zBase Privacy Facilitator",
      paidWith: "x402 on Solana",
      paidVia: "x402-direct",
      privacyNote: readiness.ready
        ? "This demo route uses vanilla exact x402. Private resources must advertise the private-exact scheme."
        : "DEMO ONLY — this payment is not routed through the paused privacy pool. See STATUS.md.",
    };

    logRequest("premium-data", "unknown", 200, "0.01");
    res.json(result);
  } catch (err) {
    logRequest("premium-data", "unknown", 500, "0.01");
    res.status(500).json({ error: "Failed", details: err.message });
  }
});

// --- Facilitator endpoints (for the privacy pool) ---

app.get(["/api/zbase/pool-stats", "/api/zx402/pool-stats"], async (req, res) => {
  try {
    if (!program) {
      return res.json({ error: "Program IDL not loaded", stats: null });
    }

    // Find pool accounts. Some legacy V0 PoolState accounts may still squat
    // on PDAs from earlier deploys — those have a smaller layout (211 bytes)
    // than V1 expects, so anchor's bulk fetch throws on them. Fall back to
    // per-account fetch + skip the ones that don't deserialize.
    let accounts;
    let skippedV0 = 0;
    try {
      accounts = await program.account.poolState.all();
    } catch {
      // Bulk fetch threw because of a V0 ghost. Manually filter.
      accounts = [];
      // PoolState V1 = 2325 bytes (128 + 96 + 3 + 32 + 1033 + 1024 + 1 + 8 disc).
      // V0 was 211 bytes — reject anything that small via dataSize filter.
      const raw = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: 2325 }],
      });
      for (const r of raw) {
        try {
          // Anchor 1.0 expects camelCase (poolState), not the IDL's PoolState.
          const decoded = await program.account.poolState.fetch(r.pubkey);
          accounts.push({ publicKey: r.pubkey, account: decoded });
        } catch {
          skippedV0++;
        }
      }
    }
    const stats = accounts.map((acc) => ({
      pool: acc.publicKey.toBase58(),
      depositCount: acc.account.depositCount.toNumber(),
      scope: Buffer.from(acc.account.scope).toString("hex"),
      paused: acc.account.paused,
      vettingFeeBps: acc.account.vettingFeeBps.toNumber(),
    }));

    res.json({
      pools: stats,
      program: PROGRAM_ID.toBase58(),
      ...(skippedV0 ? { skippedV0Ghosts: skippedV0 } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Private SVM facilitator API ---
// The buyer generates the proof locally. This process rejects raw note spend
// secrets and accepts only the standard x402 v2 proof-bearing envelope below.

async function requireReady(res) {
  const readiness = await getSvmReadiness();
  if (!readiness.ready) {
    res.status(503).json({
      error: "SVM_NOT_READY",
      disclosure: PAUSED_DISCLOSURE,
      statusDoc: "STATUS.md",
      blockingReasons: readiness.blockingReasons,
      programAttestation: readiness.attestation,
    });
    return false;
  }
  return true;
}

// --- Standard x402 v2 facilitator surface ---
// The payload contains a client-generated proof, never note spend secrets.
let privateFacilitatorPromise;
async function getPrivateFacilitator() {
  if (!privateFacilitatorPromise) {
    privateFacilitatorPromise = import(
      process.env.ZX402_SVM_SDK_PATH || "@zbase-protocol/svm"
    ).then(({ SvmFacilitator }) =>
      new SvmFacilitator({
        connection,
        wallet: walletKeypair,
        network: NETWORK === SOLANA_MAINNET_CAIP2 ? "mainnet-beta" : "devnet",
        usdcMint: PRIVATE_TOKEN_MINT,
        circuitsUrl:
          process.env.ZX402_CIRCUITS_URL ||
          path.resolve(__dirname, "..", "..", "..", "public", "circuits"),
        minimumSettlementAmount:
          process.env.ZX402_MIN_SETTLEMENT_AMOUNT || "5000",
        // Merchants provision their own token account. Letting an untrusted
        // payment choose a fresh wallet here would spend relayer SOL on rent.
        createRecipientTokenAccount: false,
      }),
    );
  }
  return privateFacilitatorPromise;
}

async function standardSupported(req, res) {
  try {
    const readiness = await getSvmReadiness();
    const privateFacilitator = await getPrivateFacilitator();
    const supported = privateFacilitator.getSupported();
    res.json({
      ...(readiness.ready ? supported : { ...supported, kinds: [] }),
      ready: readiness.ready,
      customerReady: false,
      program: PROGRAM_ID.toBase58(),
      reviewedArtifactSha256: REVIEWED_SVM_ARTIFACT_SHA256,
      expectedProgramDataSha256: EXPECTED_SVM_PROGRAMDATA_SHA256,
      blockingReasons: readiness.blockingReasons,
      programAttestation: readiness.attestation,
      disclosure: readiness.ready
        ? "Devnet-only. Sender-recipient unlinkability; amounts and timing remain public."
        : PAUSED_DISCLOSURE,
    });
  } catch (err) {
    res.status(503).json({
      kinds: [],
      extensions: [],
      signers: {},
      ready: false,
      error: "FACILITATOR_NOT_INITIALIZED",
      message: err.message,
    });
  }
}

app.get(["/supported", "/api/facilitator/supported"], standardSupported);
app.post("/supported", standardSupported);

async function standardVerify(req, res) {
  if (!(await requireReady(res))) return;
  const { x402Version, paymentPayload, paymentRequirements } = req.body || {};
  if (!paymentPayload || !paymentRequirements || x402Version !== 2) {
    return res.status(400).json({
      isValid: false,
      invalidReason: "invalid_request",
      invalidMessage:
        "body must be an x402 v2 { x402Version, paymentPayload, paymentRequirements } envelope",
    });
  }
  try {
    const privateFacilitator = await getPrivateFacilitator();
    const result = await privateFacilitator.verify(paymentPayload, paymentRequirements);
    logRequest("x402/verify", "private", result.isValid ? 200 : 400, paymentRequirements.amount);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      isValid: false,
      invalidReason: "verify_failed",
      invalidMessage: err.message,
    });
  }
}

async function standardSettle(req, res) {
  if (!(await requireReady(res))) return;
  const { x402Version, paymentPayload, paymentRequirements } = req.body || {};
  if (!paymentPayload || !paymentRequirements || x402Version !== 2) {
    return res.status(400).json({
      success: false,
      errorReason: "invalid_request",
      errorMessage:
        "body must be an x402 v2 { x402Version, paymentPayload, paymentRequirements } envelope",
      transaction: "",
      network: NETWORK,
    });
  }
  try {
    const privateFacilitator = await getPrivateFacilitator();
    const result = await privateFacilitator.settle(paymentPayload, paymentRequirements);
    logRequest("x402/settle", "private", result.success ? 200 : 400, paymentRequirements.amount);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      success: false,
      errorReason: "settle_failed",
      errorMessage: err.message,
      transaction: "",
      network: paymentRequirements?.network || NETWORK,
    });
  }
}

app.post(["/verify", "/api/facilitator/verify"], standardVerify);
app.post(["/settle", "/api/facilitator/settle"], standardSettle);

// --- Start ---
function startServer(port = PORT, host) {
  const listener = app.listen(port, host, async () => {
    const readiness = await getSvmReadiness();
    const address = listener.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const banner = readiness.ready
      ? "zBase Solana Privacy Facilitator"
      : "zBase Solana Facilitator (PAUSED — reviewed binary not verified)";
    console.log(`\n${banner} running on port ${actualPort}`);
    console.log(`Network: Solana Devnet (${NETWORK})`);
    console.log(`RPC: ${RPC_URL}`);
    console.log(`Program: ${PROGRAM_ID.toBase58()}`);
    console.log(`Wallet: ${PAY_TO}`);
    console.log(`Ready: ${readiness.ready}`);
    if (!readiness.ready) {
      console.log(`Disclosure: ${PAUSED_DISCLOSURE}`);
      console.log(`Blocking: ${readiness.blockingReasons.join("; ")}`);
    }
    console.log(`\nEndpoints:`);
    console.log(`  GET  /health                          - Free`);
    console.log(`  GET  /api/zbase/supported              - Free`);
    console.log(`  GET  /api/zbase/pool-stats              - Free`);
    console.log(`  POST /api/zbase/privacy-check          - $0.005 USDC (x402)`);
    console.log(`  POST /api/zbase/premium-data           - $0.01 USDC (x402)`);
    console.log(`  GET  /api/facilitator/supported        - Free`);
    console.log(`  POST /api/facilitator/verify           - Free (zBase facilitator API)`);
    console.log(`  POST /api/facilitator/settle           - Free (zBase facilitator API)\n`);
  });
  return listener;
}

// Test harnesses import the app and inject an in-memory facilitator. Running
// the file directly retains the existing standalone-server behavior.
if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  setPrivateFacilitatorForTesting(value) {
    privateFacilitatorPromise = Promise.resolve(value);
  },
  setProgramAttestationForTesting(provider) {
    programAttestationProvider = provider;
    readinessCache = undefined;
  },
};
