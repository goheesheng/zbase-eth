# Demo video script — zBase, ETHOnline 2026 (Continuity)

Target length: **3:00–3:30**. Hard floor 2:00, ceiling 4:00 (ETHGlobal auto-rejects outside
2–4 minutes). Record at **1080p, 16:9, ≥720p minimum**. Large terminal font (18pt+) so text reads
at video scale. Pre-warm `curl localhost:3011/api/deposits/events` once before recording — the
first scan against a chain HyperSync doesn't have an entitled token for takes ~30–50s over the
`eth_getLogs` RPC fallback; a cold call on camera will kill pacing.

| Time | On-screen action | Spoken line |
|---|---|---|
| **0:00–0:20** | Title card: "zBase — private x402 payments for AI agents." Cut to the live app at `https://zbase.app`. | "zBase is a privacy facilitator for AI agent payments, built on Vitalik Buterin's Privacy Pools design. It already runs on Base. Tonight it learns to speak Ethereum." |
| **0:20–1:30** | Label **"PRE-EXISTING"**. Terminal 1: `bash scripts/demo-ethonline.sh base` (already warmed before recording — show its READY line). Terminal 2: `npm run test:x402-agent`. Let it run: 402 → deposit tx → "ASP status: included" → "Verification: VALID, anonymity set N" → "Payment settled in ~9 s" + BaseScan link → premium data → second payment from the change note → data again (~40 s total). | "This is zBase as it existed before the event: an agent hits a paid API, gets a 402, deposits USDC into a Privacy Pool, the deposit is screened against OFAC and added to the association set, and the payment settles with a Groth16 proof — the seller is paid and cannot link the payer. Two payments from one deposit, on Base Sepolia, live." |
| **1:30–2:40** | Label **"NEW DURING ETHONLINE"**. Switch to terminal. Run: `bash scripts/demo-ethonline.sh eth` (stops the Base server, starts :3011 on Ethereum Sepolia). Then `curl -s localhost:3011/api/facilitator/supported \| jq '{contracts, anonymitySet: .privacy.anonymitySet, aspRoot: .privacy.latestAspRoot, pricing: .pricing.networks["eip155:11155111"]}'` — highlight `"Ethereum Sepolia (11155111)"`, the 0xbow addresses, the live anonymity set (~286) and the `eip155:11155111` pricing entry. Then `curl -s localhost:3011/api/deposits/events \| jq '{network, pool, count, leaves: (.leaves|length), withdrawals: (.withdrawals|length)}'` (~3 s via the HyperSync shim) — highlight `eip155:11155111`, 175 deposits / 286 leaves / 111 withdrawals. Then `curl -s -X POST localhost:3011/api/withdraw -H 'content-type: application/json' -d '{}'` — show the explicit **501** reason. Open `https://sepolia.etherscan.io/address/0x0b062Fe33c4f1592D8EA63f9a0177FcA44374C0f` in a browser tab to show the live pool contract. Run `git log --oneline` filtered to tonight's commits. | "Tonight's work: zBase's network layer was hardcoded to Base — a closed list of two chains, with a ternary that silently treated any third network as Base Sepolia. We replaced that with an explicit, fail-closed network table, and pointed it at 0xbow's own Ethereum Sepolia Privacy Pool — not a redeploy of our contracts, their independently-deployed instance. The facilitator now advertises Ethereum Sepolia, and reads its deposit events straight from that pool." |
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
