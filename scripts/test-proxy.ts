import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { config, proxy } from "../src/proxy.ts";

const matchers = Array.isArray(config.matcher) ? config.matcher : [config.matcher];
for (const url of [
  "/api/facilitator/call",
  "/api/withdraw",
  "/api/asp-update",
  "/api/deposits/confirm",
]) {
  const covered = url.startsWith("/api/facilitator/")
    ? matchers.includes("/api/facilitator/:path*")
    : matchers.includes(url);
  assert.equal(
    covered,
    true,
    `${url} must cross the metadata-hygiene proxy`,
  );
}
assert.equal(
  matchers.includes("/api/health"),
  false,
  "health intentionally remains outside the privacy proxy",
);

const response = proxy(
  new NextRequest("https://zbase.app/api/deposits/confirm", {
    method: "POST",
    headers: {
      "x-forwarded-for": "1.2.3.4",
      "user-agent": "proxy-test-sentinel",
      "content-type": "application/json",
    },
  }),
);
assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
assert.equal(response.headers.get("referrer-policy"), "no-referrer");
assert.equal(response.headers.get("x-content-type-options"), "nosniff");
assert.equal(response.headers.get("permissions-policy"), "interest-cohort=()");

console.log("PROXY: 9 checks passed");
