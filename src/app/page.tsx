import type { Metadata } from "next";
import {
  Instrument_Serif,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  Fraunces,
  Space_Grotesk,
  Bricolage_Grotesque,
} from "next/font/google";
import FinalistClient from "./client";

const instrument = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-display",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-tech",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-spacegro",
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz", "wdth"],
  variable: "--font-bricolage",
});

export const metadata: Metadata = {
  title: "Private payments for AI agents · zBase on Base",
  description:
    "zBase is a zero-knowledge privacy facilitator for x402 agent payments. Built on Vitalik Buterin's Privacy Pools, live on Base Sepolia with Base mainnet launch in progress. Solana is paused pending audit fixes. On-chain Groth16 verification, ASP-compliant by construction. Base Batches 003 Finalist.",
};

// JSON-LD structured data for SEO + GEO retrieval.
// Serialized via next/script (which renders <script type="application/ld+json"> safely)
// rather than dangerouslySetInnerHTML.
const JSON_LD_GRAPH = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://zbase.app/#org",
      name: "zBase",
      alternateName: ["zBase Labs", "z-Base"],
      url: "https://zbase.app",
      logo: "https://zbase.app/icon-512.png",
      sameAs: [
        "https://x.com/zbase__",
        "https://github.com/goheesheng/zBase",
      ],
      description:
        "zBase is a zero-knowledge privacy facilitator for x402 agent payments, built on Vitalik Buterin's Privacy Pools, live on Base Sepolia with Base mainnet launch in progress.",
      foundingDate: "2026",
      areaServed: "Worldwide",
    },
    {
      "@type": "WebSite",
      "@id": "https://zbase.app/#website",
      url: "https://zbase.app",
      name: "zBase",
      description: "Private payments for AI agents on Base.",
      publisher: { "@id": "https://zbase.app/#org" },
      inLanguage: "en-US",
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://zbase.app/#product",
      name: "zBase",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web, EVM, SVM",
      description:
        "ZK privacy facilitator for x402 agent payments. Live on Base Sepolia with Base mainnet launch in progress. Open source, ASP-compliant, Groth16 on-chain verification.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: { "@id": "https://zbase.app/#org" },
      keywords:
        "x402, Privacy Pools, zero-knowledge, Groth16, Base, Solana, AI agents, ASP, agentic payments, Kohaku",
    },
    {
      "@type": "FAQPage",
      "@id": "https://zbase.app/#faq",
      mainEntity: [
        {
          "@type": "Question",
          name: "What is zBase?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "zBase is a zero-knowledge privacy facilitator for x402 agent payments. It is built on Vitalik Buterin's Privacy Pools, live on Base Sepolia with Base mainnet launch in progress, with on-chain Groth16 verification and compliance enforced by an Association Set Provider (ASP).",
          },
        },
        {
          "@type": "Question",
          name: "How is zBase different from Tornado Cash?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "zBase is compliant by construction. It uses an Association Set Provider that blocks illicit funds at deposit and lets users prove membership of the clean subset on withdrawal. This is the same architecture Vitalik Buterin and Ameen Soleimani co-authored in the 2023 Privacy Pools paper, and that the Ethereum Foundation integrated into Kohaku.",
          },
        },
        {
          "@type": "Question",
          name: "Which chains does zBase support?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "zBase is built on Base (EVM) and Solana (SVM). The protocol is chain-agnostic at the circuit layer, so additional EVM and SVM chains can be added without re-auditing the ZK circuits.",
          },
        },
        {
          "@type": "Question",
          name: "What is x402 and why does zBase use it?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "x402 is the HTTP 402 Payment Required standard for AI agents to pay for API access. Every x402 payment is a public on-chain transfer that leaks the sender, receiver, and amount. zBase acts as the privacy facilitator between an agent's wallet and a paid endpoint, so the wire stays private without breaking the x402 protocol.",
          },
        },
        {
          "@type": "Question",
          name: "Is zBase open source?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Yes. zBase is built on 0xbow's Privacy Pools implementation under the Apache 2.0 license. The 0xbow contracts are referenced as a dependency; the x402 facilitator, Solana port, MCP server, threshold ASP, and on-chain fee-split mechanism are zBase's original work (~6,900 lines). Source published at github.com/goheesheng/zBase.",
          },
        },
        {
          "@type": "Question",
          name: "What is Base Batches 003?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Base Batches 003 is the third cohort of Coinbase's Base Batches accelerator program for projects building on the Base L2. zBase was selected as a finalist for the 2026 program.",
          },
        },
      ],
    },
  ],
};

export default function FinalistPage() {
  return (
    <main
      className={`${instrument.variable} ${plexMono.variable} ${plexSans.variable} ${fraunces.variable} ${spaceGrotesk.variable} ${bricolage.variable} finalist-root`}
    >
      {/* JSON-LD for SEO + GEO. Static, server-rendered, safe to inline. */}
      <script
        type="application/ld+json"
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD_GRAPH) }}
      />
      <FinalistClient />
    </main>
  );
}
