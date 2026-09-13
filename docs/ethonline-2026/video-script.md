# Demo video script — zBase, ETHOnline 2026 (Continuity)

Target length: **3:00–3:30**. Hard floor 2:00, ceiling 4:00 (ETHGlobal auto-rejects outside
2–4 minutes). Record at **1080p, 16:9, ≥720p minimum**. Large terminal font (18pt+) so text reads
at video scale. Pre-warm `curl localhost:3011/api/deposits/events` once before recording — the
first scan against a chain HyperSync doesn't have an entitled token for takes ~30–50s over the
`eth_getLogs` RPC fallback; a cold call on camera will kill pacing.

| Time | On-screen action | Spoken line |
|---|---|---|
| **0:00–0:20** | Title card: "zBase — private x402 payments for AI agents." Cut to the live app at `https://zbase.app`. | "zBase is a privacy facilitator for AI agent payments, built on Vitalik Buterin's Privacy Pools design. It already runs on Base. Tonight it learns to speak Ethereum." |
| **0:20–1:30** | Label **"PRE-EXISTING"** on screen. Open `https://zbase.app/app#try`. Click through the no-wallet live demo: trigger a private payment, show the pool deposit, the ZK proof step, then the paid x402 response (`200` + data). | "This is pre-existing work: a payer deposits USDC into a shielded pool, proves membership with a Groth16 proof, and pays an x402 seller — without the payment transaction ever naming the payer's wallet. This exact flow is proven end-to-end on Base mainnet, against real x402 sellers." |
| **1:30–2:40** | Label **"NEW DURING ETHONLINE"**. Switch to terminal. Run: `NEXT_PUBLIC_NETWORK=eth-sepolia npm run dev -- -p 3011`. Then `curl -s localhost:3011/api/facilitator/supported \| jq '{contracts, anonymitySet: .privacy.anonymitySet, aspRoot: .privacy.latestAspRoot, pricing: .pricing.networks["eip155:11155111"]}'` — highlight `"Ethereum Sepolia (11155111)"`, the 0xbow addresses, the live anonymity set (~286) and the `eip155:11155111` pricing entry. Then `curl -s localhost:3011/api/deposits/events \| jq '{network, pool, count, leaves: (.leaves|length), withdrawals: (.withdrawals|length)}'` (pre-warmed; ~36 s cold) — highlight `eip155:11155111`, 80 deposits / 118 leaves / 83 withdrawals. Then `curl -s -X POST localhost:3011/api/withdraw -H 'content-type: application/json' -d '{}'` — show the explicit **501** reason. Open `https://sepolia.etherscan.io/address/0x0b062Fe33c4f1592D8EA63f9a0177FcA44374C0f` in a browser tab to show the live pool contract. Run `git log --oneline` filtered to tonight's commits. | "Tonight's work: zBase's network layer was hardcoded to Base — a closed list of two chains, with a ternary that silently treated any third network as Base Sepolia. We replaced that with an explicit, fail-closed network table, and pointed it at 0xbow's own Ethereum Sepolia Privacy Pool — not a redeploy of our contracts, their independently-deployed instance. The facilitator now advertises Ethereum Sepolia, and reads its deposit events straight from that pool." |
| **2:40–3:10** | Cut back to a slide or terminal with the two lists: "works tonight" vs. "doesn't yet." | "To be direct about what this is: the read path works tonight — supported networks, deposit events, verify. The write path — an actual ZK withdrawal on Ethereum — doesn't, because zBase isn't the ASP postman on 0xbow's pool. That's a named next step: deploy our own pool there, or get included in theirs. Gasless deposits on Ethereum need a paymaster we haven't wired yet either." |
| **3:10–3:30** | Close on zBase logo / URL card: `zbase.app` · `docs.zbase.app` · repo link. | "zBase: private payments for AI agents, on Base today, and now speaking Ethereum. Thanks for watching." |

## Recording tips

- **Resolution:** 1080p (1920×1080), 16:9. Minimum accepted is 720p — don't cut it close.
- **Pre-warm the events call.** Hit `curl localhost:3011/api/deposits/events` once off-camera
  before rolling; the first Ethereum Sepolia scan can take 30–50s over the RPC fallback and will
  read as dead air if shown cold.
- **Terminal font size:** 18pt or larger, high-contrast theme. Viewers will watch this on a laptop
  screen at reduced size.
- **Two clean cuts, not one long take:** record the pre-existing Base demo and the new
  Ethereum-Sepolia terminal segment as separate takes, then edit together — easier to hit the
  2–4 minute window than a single unbroken recording.
- **Show the label cards** ("PRE-EXISTING" / "NEW DURING ETHONLINE") as actual on-screen text —
  judges skim; the labels do half the explaining.
- **Don't narrate the `git log` scroll** — let it play under the "next steps" voiceover from the
  following segment instead of pausing on it.
