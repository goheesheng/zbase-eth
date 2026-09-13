import { NextResponse } from "next/server";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Entry = {
  email: string;
  role?: string;
  source?: string;
  ua?: string;
  at: string;
};

const memory: Entry[] = (globalThis as unknown as { __zbaseInterest?: Entry[] })
  .__zbaseInterest ?? [];
(globalThis as unknown as { __zbaseInterest?: Entry[] }).__zbaseInterest = memory;

async function forwardWebhook(entry: Entry) {
  const url = process.env.INTEREST_WEBHOOK_URL;
  if (!url) return { forwarded: false };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.INTEREST_WEBHOOK_TOKEN
          ? { authorization: `Bearer ${process.env.INTEREST_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(entry),
    });
    return { forwarded: true, ok: res.ok };
  } catch {
    return { forwarded: true, ok: false };
  }
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function emailNotify(entry: Entry) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.INTEREST_NOTIFY_EMAIL;
  if (!apiKey || !to) return { emailed: false };
  const from = process.env.RESEND_FROM ?? "zBase <onboarding@resend.dev>";
  const subject = `New zBase signup: ${entry.email}`;
  const e = entry;
  const text = [
    `Email:        ${e.email}`,
    e.role ? `Role:         ${e.role}` : null,
    e.source ? `Source:       ${e.source}` : null,
    `At (UTC):     ${e.at}`,
    e.ua ? `User-Agent:   ${e.ua}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0c1a0e;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
<h2 style="margin:0 0 16px;font-size:20px;font-weight:600;letter-spacing:-0.01em;">New zBase signup</h2>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;">
  <tr><td style="padding:8px 12px 8px 0;color:#666;width:100px;">Email</td><td style="padding:8px 0;"><strong>${htmlEscape(e.email)}</strong></td></tr>
  ${e.role ? `<tr><td style="padding:8px 12px 8px 0;color:#666;">Role</td><td style="padding:8px 0;">${htmlEscape(e.role)}</td></tr>` : ""}
  ${e.source ? `<tr><td style="padding:8px 12px 8px 0;color:#666;">Source</td><td style="padding:8px 0;">${htmlEscape(e.source)}</td></tr>` : ""}
  <tr><td style="padding:8px 12px 8px 0;color:#666;">At (UTC)</td><td style="padding:8px 0;">${htmlEscape(e.at)}</td></tr>
  ${e.ua ? `<tr><td style="padding:8px 12px 8px 0;color:#666;vertical-align:top;">UA</td><td style="padding:8px 0;font-size:12px;color:#666;">${htmlEscape(e.ua)}</td></tr>` : ""}
</table>
<p style="margin-top:24px;font-size:12px;color:#888;">zbase.app · interest list</p>
</body></html>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from, to, subject, text, html }),
    });
    return { emailed: true, ok: res.ok };
  } catch {
    return { emailed: true, ok: false };
  }
}

export async function GET() {
  return NextResponse.json(
    {
      count: memory.length,
      ok: true,
    },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function POST(req: Request) {
  let body: { email?: unknown; role?: unknown; source?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = typeof body.role === "string" ? body.role.trim().slice(0, 120) : "";
  const source =
    typeof body.source === "string" ? body.source.trim().slice(0, 60) : "";

  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }

  if (memory.some((e) => e.email === email)) {
    return NextResponse.json({
      ok: true,
      count: memory.length,
      duplicate: true,
    });
  }

  const entry: Entry = {
    email,
    role: role || undefined,
    source: source || undefined,
    ua: req.headers.get("user-agent")?.slice(0, 200) ?? undefined,
    at: new Date().toISOString(),
  };
  memory.push(entry);

  // Run webhook + email in parallel so we never block on the slower one
  const [webhookResult, emailResult] = await Promise.all([
    forwardWebhook(entry),
    emailNotify(entry),
  ]);

  return NextResponse.json({
    ok: true,
    count: memory.length,
    forwarded: webhookResult.forwarded,
    webhookOk: webhookResult.ok ?? null,
    emailed: emailResult.emailed,
    emailOk: emailResult.ok ?? null,
  });
}
