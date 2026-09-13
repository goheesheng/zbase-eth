import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server build for the Docker/VPS deployment (deploy/).
  // Vercel ignores this and uses its own output mode.
  output: "standalone",
  async rewrites() {
    return [
      // Lowercase alias serves the one canonical static skill file (public/SKILL.md).
      {
        source: "/skill.md",
        destination: "/SKILL.md",
      },
    ];
  },
  async redirects() {
    return [
      // Legacy finalist URLs now redirect to the root landing
      {
        source: "/finalist",
        destination: "/",
        permanent: true,
      },
      {
        source: "/finalist/:path*",
        destination: "/",
        permanent: true,
      },
      // /demo was folded into /app#try on 2026-06-02. The API at
      // /api/demo/run is unchanged and still serves the showcase backend.
      // 308 permanent so external links (README, INTRO, GitBook, Twitter
      // posts) keep working and SEO juice transfers to /app.
      {
        source: "/demo",
        destination: "/app#try",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
