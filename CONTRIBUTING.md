# Contributing to zBase

Thanks for thinking about contributing. zBase is private payment infrastructure for AI agents on Solana and Base, built on Vitalik Buterin's Privacy Pools research and the 0xbow Apache 2.0 codebase. Most useful contributions today are bug reports, integration examples, and small focused PRs.

## Before you start

- **Security-sensitive code** (cryptographic primitives, on-chain verifier, ASP attestation, relayer signing): coordinate before sending a PR — these areas benefit from design discussion first. DM [@zbase__](https://x.com/zbase__) on Twitter or open a draft issue describing what you want to change.
- **Vulnerability reports go through SECURITY.md**, not public issues.
- **The license is Apache 2.0.** By contributing, you agree your changes are licensed under the same terms.

## What contributions help most right now

1. **Integration examples** — `examples/` is missing entries for Eliza, Virtuals, Sendai, Solana AgentKit, Coinbase x402. If you've integrated zBase into any of these, a working example PR is high-value.
2. **Bug reports with reproduction steps** — open a GitHub issue. Include the package version, the chain (Solana devnet / Base Sepolia), and a curl/code snippet that reproduces.
3. **Documentation improvements** — `docs/gitbook/` is the public docs source. Typos, clarifications, broken links, missing concepts. Small PRs welcome.
4. **Tests** — additional Foundry tests for the contracts, additional unit tests for the SDK, edge-case coverage anywhere.

## What contributions probably won't merge

- **Rewrites of core protocol logic** — the cryptographic primitives come from 0xbow upstream; protocol-level changes there belong in the 0xbow repo, not this implementation.
- **Refactors without a use case** — moving code around for aesthetic reasons usually slows the project down.
- **New features added speculatively** — propose first, build after discussion.
- **Anything that breaks the Apache 2.0 license posture** — no AGPL contributions, no CLA gymnastics.

## Development setup

```bash
# Clone
git clone https://github.com/goheesheng/zBase.git
cd zBase

# Install root dependencies
npm install

# Install workspace packages (Yarn for the protocol fork)
yarn

# Compile contracts
forge build

# Run contract tests
forge test -vv

# Start the Next.js app
npm run dev
```

Open zbase.app/test (or `http://localhost:3000/test` locally) for an interactive dev surface that exercises the deposit + withdraw flow against the production stack.

## Environment variables

The repo ships `.env.local.example` with placeholder values for the required env. Read it before running anything that signs transactions — the key roles (POSTMAN, TREASURY, DEMO_WALLET) are documented inline with consequences if you mix them up.

## Code style

- TypeScript / React: project uses Tailwind CSS + Next.js App Router. Follow existing patterns; don't introduce a new state-management library without discussion.
- Solidity: contracts use Foundry. Solhint config is in `foundry.toml`.
- Rust (Solana / Anchor): standard Anchor conventions. Run `cargo fmt + clippy` before submitting.
- Comments: explain **why**, not what. Don't write `// increment i` comments. Do write `// 32-slot ring buffer to match Solana's recent-blockhashes cap` comments.

## PR workflow

1. Fork or branch
2. Make your change
3. Run `npm run build` and `forge test -vv` locally
4. Open a PR against `main`
5. Vercel auto-builds a preview; that build must pass (it's a required status check)
6. A maintainer reviews and merges, or asks for changes

Expect a 1-3 day response time. Solo maintainer, real-life constraints — be patient.

## Commit message style

Follow conventional commits:

```
feat(svm): add stealth recipient derivation to facilitator settle
fix(api): /api/asp-update no longer drops new commitments on rate-limited RPC
docs(gitbook): explain how the ASP attestation differs from KYC
chore(deps): bump viem from 2.48 to 2.49
```

Subject line under 72 chars. Body explains why if non-obvious. Include `Co-Authored-By:` lines for collaborators.

## Releases

- `@zbase-protocol/sdk`, `@zbase-protocol/svm`, `@zbase-protocol/mcp` follow semver. Breaking changes only on major version bumps.
- Tagged releases on GitHub align with npm publishes.
- Changelog: `CHANGELOG.md` is the canonical record. Add an entry to the `[Unreleased]` section as part of your PR; the maintainer cuts the actual release.

## Code of conduct

Be direct, be technical, be respectful. Disagreements about architecture are fine and expected. Personal attacks aren't. If a discussion is going sideways, the maintainer will close the thread and we move on.

## Questions

- Twitter / X: DM [@zbase__](https://x.com/zbase__) — primary contact
- Open a GitHub Discussion for design questions (issues are for bugs + features)
