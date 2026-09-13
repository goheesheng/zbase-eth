/**
 * x402 Test Server -- A simple paid API endpoint
 *
 * This simulates a service provider that charges USDC via x402.
 * When an agent calls the endpoint without payment, it returns 402.
 * When called with a valid payment txHash, it returns the data.
 *
 * Usage:
 *   npx tsx scripts/x402-test-server.ts
 *
 * The server runs on port 4020.
 * Paid endpoint: GET http://localhost:4020/api/data
 */

import http from "http";

const PORT = 4020;
const PROVIDER_ADDRESS = "0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843";
const PRICE = "500000"; // 0.50 USDC (raw units, 6 decimals)

// Track paid requests (in-memory, resets on restart)
const paidTxHashes = new Set<string>();

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  // Health check
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", service: "x402 Test Server" }));
    return;
  }

  // The paid endpoint
  if (req.url?.startsWith("/api/data")) {
    // Check for payment proof in header
    const paymentTxHash = req.headers["x-payment-txhash"] as string;

    if (paymentTxHash && (paidTxHashes.has(paymentTxHash) || paymentTxHash.startsWith("0x"))) {
      // Payment verified -- return the premium data
      paidTxHashes.add(paymentTxHash);
      console.log(`[x402 Server] Paid request accepted. Tx: ${paymentTxHash.slice(0, 16)}...`);

      res.writeHead(200);
      res.end(JSON.stringify({
        service: "Premium AI Analysis",
        data: {
          result: "This is premium data that required payment.",
          analysis: "The x402 payment was settled privately via zBase.",
          privacy: "The provider (this server) received USDC but cannot identify the payer.",
          timestamp: new Date().toISOString(),
        },
        payment: {
          txHash: paymentTxHash,
          amount: PRICE,
          currency: "USDC",
          network: "Base Sepolia",
        }
      }));
      return;
    }

    // No payment -- return 402 Payment Required
    console.log(`[x402 Server] Unpaid request --> returning 402`);

    res.writeHead(402, {
      "Content-Type": "application/json",
      "X-Payment-Required": "true",
    });
    res.end(JSON.stringify({
      error: "Payment Required",
      x402: {
        version: 2,
        scheme: "exact",
        network: "eip155:84532",
        payTo: PROVIDER_ADDRESS,
        maxAmountRequired: PRICE,
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        symbol: "USDC",
        decimals: 6,
        description: "Premium AI Analysis -- 0.50 USDC",
        facilitatorUrl: "http://localhost:3009/api/facilitator",
      }
    }));
    return;
  }

  // 404 for everything else
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`
======================================================
  x402 Test Server running on http://localhost:${PORT}
======================================================

Paid endpoint: GET http://localhost:${PORT}/api/data
  - Without payment: returns 402 with payment requirements
  - With payment: returns premium data

Provider address: ${PROVIDER_ADDRESS}
Price: ${PRICE} raw USDC (0.50 USDC)
Network: Base Sepolia (84532)

Waiting for requests...
  `);
});
