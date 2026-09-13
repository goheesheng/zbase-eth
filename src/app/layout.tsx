import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Syne, Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
const syne = Syne({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-syne", display: "swap" });
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter", display: "swap" });

const SITE_URL = "https://zbase.app";
const DESCRIPTION =
  "zBase is a zero-knowledge privacy facilitator for x402 agent payments. Built on Vitalik Buterin's Privacy Pools, live on Base Sepolia with Base mainnet launch in progress. Solana is paused pending audit fixes. On-chain Groth16 verification, ASP-compliant by construction. Base Batches 003 Finalist.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "zBase — Private payments for AI agents · Base",
    template: "%s · zBase",
  },
  description: DESCRIPTION,
  applicationName: "zBase",
  generator: "Next.js",
  keywords: [
    "zBase",
    "x402",
    "Privacy Pools",
    "zero-knowledge privacy",
    "ZK privacy",
    "Groth16",
    "Base Batches 003",
    "AI agent payments",
    "private payments",
    "Solana privacy",
    "Base privacy",
    "ASP-compliant privacy",
    "Vitalik Buterin Privacy Pools",
    "agentic payments",
    "x402 facilitator",
    "Kohaku",
    "0xbow",
  ],
  authors: [{ name: "zBase Labs" }],
  creator: "zBase Labs",
  publisher: "zBase Labs",
  category: "technology",
  alternates: {
    canonical: SITE_URL,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    siteName: "zBase",
    title: "zBase — Private payments for AI agents",
    description: DESCRIPTION,
    url: SITE_URL,
    locale: "en_US",
    images: [
      {
        url: "/icon-512.png",
        width: 512,
        height: 512,
        alt: "zBase — ZK privacy for AI agents",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@zbase__",
    creator: "@zbase__",
    title: "zBase — Private payments for AI agents",
    description: DESCRIPTION,
    images: ["/icon-512.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/manifest.webmanifest",
  other: {
    "format-detection": "telephone=no",
  },
};

export const viewport: Viewport = {
  themeColor: "#d8efd9",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${syne.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
