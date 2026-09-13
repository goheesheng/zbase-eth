import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "zBase — Private payments for AI agents",
    short_name: "zBase",
    description:
      "ZK privacy facilitator for x402 agent payments on Base and Solana.",
    start_url: "/",
    display: "standalone",
    background_color: "#d8efd9",
    theme_color: "#d8efd9",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
