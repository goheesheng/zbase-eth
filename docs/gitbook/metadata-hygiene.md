# Facilitator metadata hygiene

TL;DR — Next.js middleware strips 8 identifying request headers (IP, UA,
cookie, referer, locale) before any handler sees them, and stamps 4 privacy
response headers on the way out.

> Status: live in dev server. Ships automatically with the next Next.js deploy.
> Verified by live HTTP test on 2026-05-29.

## The problem it solves

Even with perfect on-chain privacy, an **operator-side log** can link every
payment to a TLS endpoint, an IP address, and a User-Agent string. A subpoena
to the facilitator host returns the full payer→provider graph. The cryptography
doesn't matter if the facilitator is keeping a CSV.

## The fix

Next.js middleware intercepts every request to:
- `/api/facilitator/:path*`
- `/api/withdraw`
- `/api/asp-update`
- `/api/x402-pay`

**Before** the route handler sees the request, the middleware deletes 8 identifying
headers:

| Header | Why |
|---|---|
| `x-forwarded-for` | proxy-injected client IP |
| `x-real-ip` | same |
| `cf-connecting-ip` | Cloudflare-injected client IP |
| `true-client-ip` | same |
| `user-agent` | browser / SDK fingerprint |
| `accept-language` | locale fingerprint |
| `referer` | source URL leak |
| `cookie` | session linkability |

**After** the handler runs, the middleware stamps 4 privacy response headers:

| Header | Why |
|---|---|
| `Cache-Control: no-store, no-cache, must-revalidate` | don't let intermediaries cache responses |
| `Referrer-Policy: no-referrer` | don't leak our URL to downstream pages |
| `X-Content-Type-Options: nosniff` | prevent MIME-sniffing attacks |
| `Permissions-Policy: interest-cohort=()` | opt out of FLoC and similar |

The middleware contains **zero `console.*` calls** by design. No header content
can leak through logging because the headers never reach the logging layer.

## Things to be honest about

- The middleware strips at the **facilitator's TLS endpoint**. It does not
  protect against a hostile network upstream (your ISP, your DNS resolver, the
  Cloudflare edge if you're behind one).
- For genuine end-to-end network privacy, the client must route through Tor
  or a mixnet (Nym, I2P). That's a roadmap item, not part of this middleware.
- Headers stripped here are still visible to your hosting provider's network
  layer (Vercel, Fly, etc.). The middleware only stops them from reaching
  your application code.

Next → [Developer Guides](developer-guides.md)
