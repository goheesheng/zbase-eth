/**
 * /anonymity-set-disclosure
 *
 * Server-renders the source-of-truth disclosure policy at
 * docs/gitbook/anonymity-set-disclosure.md as a real HTML page.
 *
 * Why this exists: /anonymity-set links to this URL as "disclosure policy".
 * The markdown also lives in the published GitBook, but the founder is still
 * on Sepolia so the GitBook isn't deployed at a stable URL yet. Serving the
 * same file directly from the Next.js app keeps the link unbroken.
 *
 * Renderer: deliberately minimal (no markdown dep). Handles headings, lists,
 * tables, code, links, and paragraphs. Anything fancier (e.g. footnotes)
 * is not in the disclosure doc, so we don't pay for a library.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";

export const dynamic = "force-static";

const DOC_PATH = join(
  process.cwd(),
  "docs",
  "gitbook",
  "anonymity-set-disclosure.md",
);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Tiny inline renderer. Order matters: headings/blocks first, inline last.
 */
function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inTable = false;
  let inCode = false;
  let codeLang = "";
  let codeBuffer: string[] = [];
  let inList = false;

  function flushList() {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  }
  function flushTable() {
    if (inTable) {
      out.push("</tbody></table>");
      inTable = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");

    // Code fence
    if (line.startsWith("```")) {
      if (!inCode) {
        flushList();
        flushTable();
        inCode = true;
        codeLang = line.slice(3).trim();
        codeBuffer = [];
      } else {
        out.push(
          `<pre class="overflow-x-auto rounded-md bg-zinc-900 p-4 text-xs text-zinc-100"><code data-lang="${escapeHtml(codeLang)}">${escapeHtml(codeBuffer.join("\n"))}</code></pre>`,
        );
        inCode = false;
        codeLang = "";
        codeBuffer = [];
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(raw);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line)) {
      flushList();
      flushTable();
      out.push('<hr class="my-8 border-zinc-200" />');
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushList();
      flushTable();
      const level = h[1].length;
      const text = inline(h[2]);
      const sizes = [
        "text-4xl font-semibold tracking-tight mt-12 mb-6",
        "text-3xl font-semibold tracking-tight mt-10 mb-4",
        "text-2xl font-medium mt-8 mb-3",
        "text-xl font-medium mt-6 mb-2",
        "text-lg font-medium mt-4 mb-2",
        "text-base font-medium mt-3 mb-1",
      ];
      const cls = sizes[level - 1];
      out.push(`<h${level} class="${cls}">${text}</h${level}>`);
      continue;
    }

    // Table: detect header + separator
    if (line.startsWith("|") && lines[i + 1]?.match(/^\|[-:|\s]+\|$/)) {
      flushList();
      const headers = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      out.push(
        '<table class="my-4 w-full text-sm"><thead><tr class="border-b-2 border-zinc-300 text-left">',
      );
      for (const h of headers) {
        out.push(`<th class="py-2 pr-4 font-medium">${inline(h)}</th>`);
      }
      out.push("</tr></thead><tbody>");
      inTable = true;
      i++; // skip separator
      continue;
    }
    if (inTable && line.startsWith("|")) {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      out.push('<tr class="border-b border-zinc-200">');
      for (const c of cells) {
        out.push(`<td class="py-2 pr-4">${inline(c)}</td>`);
      }
      out.push("</tr>");
      continue;
    }
    if (inTable && !line.startsWith("|")) {
      flushTable();
    }

    // Unordered list
    if (/^-\s+/.test(line)) {
      if (!inList) {
        out.push('<ul class="my-3 list-disc pl-6 space-y-1">');
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^-\s+/, ""))}</li>`);
      continue;
    } else if (inList && line === "") {
      flushList();
    }

    // Paragraph or blank
    if (line === "") {
      flushList();
      continue;
    }
    flushList();
    out.push(`<p class="my-3 text-zinc-700 leading-relaxed">${inline(line)}</p>`);
  }

  flushList();
  flushTable();
  return out.join("\n");
}

/**
 * URL allowlist: only http(s), mailto, and same-origin relative URLs.
 * Blocks javascript:, data:, vbscript:, file:, etc. — defense in depth even
 * though the markdown source is in-repo today.
 */
function sanitizeUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  // Empty or pure fragment / query — safe
  if (!url || url.startsWith("#") || url.startsWith("?")) return url;
  // Relative same-origin URLs
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    return url;
  }
  // Match scheme — anything not in allowlist becomes "#"
  const schemeMatch = url.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!schemeMatch) {
    // No scheme but not relative-starting — treat as relative
    return url;
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") {
    return url;
  }
  // Unknown / dangerous scheme — neutralize
  return "#unsafe-url-blocked";
}

/**
 * Inline: bold, italic, code, links. Markdown order matters for nesting.
 *
 * All user-visible content runs through escapeHtml first; we only inject
 * a fixed set of tags (`code`, `a`, `strong`, `em`) with known-safe attrs.
 * URLs are run through sanitizeUrl to block javascript:/data: schemes.
 */
function inline(s: string): string {
  // Escape first; then re-introduce intentional html
  let out = escapeHtml(s);

  // Code spans `code`
  out = out.replace(
    /`([^`]+)`/g,
    '<code class="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.9em]">$1</code>',
  );

  // Links [text](url) — sanitize URL, escape text already escaped by escapeHtml above
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text, url) => {
      const safeUrl = escapeHtml(sanitizeUrl(url));
      return `<a href="${safeUrl}" class="text-zinc-900 underline underline-offset-2 hover:text-zinc-600" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  );

  // Bold **x**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic *x*
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");

  return out;
}

export default function AnonymitySetDisclosurePage() {
  let md: string;
  try {
    md = readFileSync(DOC_PATH, "utf8");
  } catch (err) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 font-sans">
        <h1 className="text-3xl font-semibold">Disclosure policy unavailable</h1>
        <p className="mt-4 text-zinc-600">
          Could not read <code>{DOC_PATH}</code>: {(err as Error).message}
        </p>
        <Link href="/anonymity-set" className="mt-6 inline-block underline">
          ← Back to anonymity-set dashboard
        </Link>
      </main>
    );
  }

  const html = renderMarkdown(md);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 font-sans">
      <nav className="mb-8 text-xs text-zinc-500">
        <Link href="/anonymity-set" className="underline">
          ← Anonymity-set dashboard
        </Link>
        <span className="mx-2">·</span>
        <Link
          href="https://github.com/goheesheng/zBase/blob/main/docs/gitbook/anonymity-set-disclosure.md"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Source on GitHub
        </Link>
      </nav>
      <article
        // Renderer is in-repo (this file). Markdown source is in-repo
        // (docs/gitbook/anonymity-set-disclosure.md). No user input — safe.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </main>
  );
}
