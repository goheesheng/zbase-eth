# zBase Target Audiences

Research source: Colosseum Copilot (5,400+ hackathon projects, 84,000+ archive documents)

## The Threat Landscape

Wallet tracking tools on Solana that can spy on agent payments:

| Project | What it does | Users |
|---|---|---|
| Blockvision | Track smart money and successful traders | Retail traders |
| walletSense | Real-time alerts for wallet activity | Copy traders, alpha seekers |
| Boltrade | AI-powered smart money insights | DEX traders |
| iSmarty | Telegram bot tracking wallet patterns | Memecoin traders |
| SolGPT_Pro | Natural language wallet analysis + copy trading | DeFi traders |
| Coresight Bot | Identify and track profitable on-chain traders | On-chain analysts |
| ParrotX | Copy trade top performers automatically | Passive investors |
| Outdotapp | Filter market alpha and auto-execute trades | Crypto investors |

These tools can see every x402 payment an agent makes: which services, how much, when, and to whom.

## Tier 1: Hair on Fire (will pay today)

### Trading bot operators
- Running automated strategies on Solana/Base
- Problem: Copy trading tools track their wallets in real-time. Competitors literally copy their trades.
- Why zBase: If nobody can see which tokens they're buying/selling, nobody can front-run or copy them
- Evidence: aignt.fun, AgentRunner, Tradecraft.finance (all Colosseum projects building automated trading agents)
- Price sensitivity: Low. A bot making $10K/month will pay $500/month for privacy.

### MEV searchers / arbitrage bots
- Problem: Strategies reverse-engineered by watching on-chain payments
- Why zBase: Private payments hide which DEXs and data feeds they use
- Evidence: mev-bot (Colosseum project), plus hundreds of unlisted searchers
- Price sensitivity: Very low. MEV profits justify any privacy cost.

## Tier 2: Aware of the Problem (will pay this quarter)

### AI research companies running agents
- Calling LLMs, data APIs, analytics services via x402
- Problem: Competitors see which AI services they use, how much they spend, when they're active. Reveals entire AI strategy.
- Why zBase: Payment trail invisible. Nobody knows if you're using Gemini, Claude, or GPT.
- Evidence: 50+ APIs on Pay.sh (Google Cloud). Any company with agents calling these APIs.
- Price sensitivity: Medium. $50-500/month for agent fleet privacy.

### Crypto fund managers
- Running DeFi agents for portfolio management
- Problem: walletSense and Boltrade users track "smart money" wallets. If fund agent wallet is identified, every trade is visible.
- Why zBase: Fund agents deposit to privacy pool, all payments from pool address, not fund wallet.
- Evidence: Crypto hedge funds, family offices, DAOs with treasuries
- Price sensitivity: Very low. $100M+ AUM funds will pay for operational security.

## Tier 3: Latent Demand (will pay next year)

### Agent-to-agent commerce operators
- Agents buying services from other agents autonomously
- Problem: Entire agent supply chain is transparent. Anyone can map who buys from whom.
- Why zBase: Business relationships stay private
- Evidence: CORBITS.DEV (won $20K at Colosseum), Latinum Agentic Commerce (won $25K), AI Economy Protocol
- Price sensitivity: Medium. Growing as agent commerce scales.

### Enterprise / institutional agents
- Banks, fintech, traditional companies running on-chain agents
- Problem: Regulatory + competitive. On-chain payments discoverable in litigation.
- Why zBase: Compliant privacy (ASP) satisfies regulators while hiding competitive info
- Evidence: Early adopters of Pay.sh enterprise tier (Google Cloud customers)
- Price sensitivity: Low. Enterprise budgets.

## GTM Sequence

| Timeline | Target | Action |
|---|---|---|
| Week 1-4 | Trading bot operators on Solana | Direct outreach. They feel the pain daily. |
| Month 2-3 | AI research teams calling x402 APIs | Show exposure report. Enterprise sales. |
| Month 4+ | Agent commerce platforms | Integration partnerships (CORBITS.DEV, Pay.sh) |

## The Pitch

> "There are 8+ wallet tracking tools on Solana that can watch every x402 payment your agent makes. Here's what they see: [privacy-check report]. Want to fix this? [zBase]"

## Supporting Evidence

### From Colosseum hackathon projects:
- PrivAgent: "Multi-agent AI system for confidential transactions, MEV protection" — problem tags: transaction privacy, mev frontrunning
- Kalyna Wallet: Privacy-focused wallet — problem tags: identity exposure, lack of payment privacy, data tracking
- Cluster v1-c13: "Solana Privacy and Identity Management" — 260 projects in this space

### From Colosseum archives:
- a16z: "Privacy-Protecting Regulatory Solutions Using Zero-Knowledge Proofs" (Burleson, Korver, Boneh)
- Nick Szabo: "Making visible the ways your competitor is violating their customers' privacy will become a powerful marketing strategy"

### Key insight:
More projects building wallet tracking tools than privacy tools. The surveillance ecosystem is growing faster than the defense ecosystem. That gap is the market.
