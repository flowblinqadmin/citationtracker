/**
 * Surgical Fix HTML Generator — Phase B v2 (replaces the bulk-zip composed-template approach).
 *
 * Takes the user's pasted page HTML and applies the AI-generated PerPageFix data
 * surgically using jsdom. Preserves all of the user's original DOM structure,
 * inline scripts, CSS, widgets — only replaces/inserts the specific head elements
 * and the page-level h1 that the fix targets.
 */
import { JSDOM } from "jsdom";
import type { PerPageFix } from "./page-fix-generator";

export interface ApplyFixesResult {
  fixedHtml: string;
  detectedUrl: string | null;
  appliedChanges: string[];
  warnings: string[];
}

export interface ApplyFixesOptions {
  /** User's pasted HTML (raw, unmodified). */
  pastedHtml: string;
  /** Per-page fix data, if available. If undefined, only structural additions are applied. */
  fix?: PerPageFix;
  /** Site-level JSON-LD schema blocks from generatedSchemaBlocks. */
  siteSchemaBlocks?: string[];
}

/**
 * Auto-detect the page URL from the pasted HTML by checking, in order:
 *   1. <link rel="canonical" href="...">
 *   2. <meta property="og:url" content="...">
 *   3. <meta property="twitter:url" content="...">
 *   4. <meta name="twitter:url" content="...">
 *
 * Returns null if none match. Caller falls back to user-selected URL.
 */
// Explicit safety options for jsdom on user-supplied HTML:
//   - runScripts is omitted (jsdom default = no script execution); declaring
//     it explicitly to outside-only keeps the posture pinned across future
//     jsdom upgrades that might flip the default.
//   - resources is intentionally undefined so <img>/<link>/<script src> tags
//     never trigger network fetches (would be SSRF surface).
//   - url is a placeholder so relative URL resolution doesn't leak the host
//     name in jsdom-internal warning logs.
const JSDOM_OPTIONS = {
  runScripts: "outside-only" as const,
  url: "https://placeholder.invalid/",
};

export function detectUrlFromHtml(html: string): string | null {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, JSDOM_OPTIONS);
  } catch {
    return null;
  }
  const doc = dom.window.document;

  const canonical = doc.querySelector('link[rel="canonical"]');
  if (canonical) {
    const href = canonical.getAttribute("href");
    if (href && href.trim()) return href.trim();
  }
  const ogUrl = doc.querySelector('meta[property="og:url"]');
  if (ogUrl) {
    const content = ogUrl.getAttribute("content");
    if (content && content.trim()) return content.trim();
  }
  const twitterProp = doc.querySelector('meta[property="twitter:url"]');
  if (twitterProp) {
    const content = twitterProp.getAttribute("content");
    if (content && content.trim()) return content.trim();
  }
  const twitterName = doc.querySelector('meta[name="twitter:url"]');
  if (twitterName) {
    const content = twitterName.getAttribute("content");
    if (content && content.trim()) return content.trim();
  }
  return null;
}

function upsertMeta(
  doc: Document,
  head: Element,
  selector: string,
  attrs: Record<string, string>,
): boolean {
  let meta = doc.querySelector(selector) as HTMLMetaElement | null;
  let inserted = false;
  if (!meta) {
    meta = doc.createElement("meta");
    head.appendChild(meta);
    inserted = true;
  }
  for (const [k, v] of Object.entries(attrs)) {
    meta.setAttribute(k, v);
  }
  return inserted;
}

/**
 * Apply PerPageFix data surgically to the pasted HTML. Returns the modified
 * HTML serialized back as a string, along with a list of human-readable
 * applied-changes for display in the UI.
 *
 * Surgical edits applied (in order):
 *   1. itemscope/itemtype on <html> (if missing)
 *   2. Create <head> (if missing — pathological case)
 *   3. <title> — replace text content with fix.suggestedTitle
 *   4. <meta name="description"> — upsert with fix.suggestedMetaDescription
 *   5. <h1> — replace first <h1>'s text content with fix.h1Fix, or insert if none
 *   6. OG tags — og:title, og:description, og:type (default "website"), og:url
 *   7. JSON-LD <script> blocks — append fix.matchedSchemaBlocks + siteSchemaBlocks
 *      (dedup by whitespace-normalized text content vs existing scripts)
 *   8. <link rel="alternate" type="text/plain" href="/llms.txt">
 *   9. <link rel="canonical">
 *
 * Everything else — body content, inline scripts, CSS, custom widgets, image
 * tags, link tags, third-party embeds — passes through untouched.
 */
export function applyFixesToHtml(opts: ApplyFixesOptions): ApplyFixesResult {
  const { pastedHtml, fix, siteSchemaBlocks = [] } = opts;
  const applied: string[] = [];
  const warnings: string[] = [];

  let dom: JSDOM;
  try {
    dom = new JSDOM(pastedHtml, JSDOM_OPTIONS);
  } catch (e) {
    return {
      fixedHtml: pastedHtml,
      detectedUrl: null,
      appliedChanges: [],
      warnings: [`Failed to parse HTML: ${e instanceof Error ? e.message : "unknown"}`],
    };
  }
  const doc = dom.window.document;

  // Detect URL up-front so we can use it for canonical/og:url defaults
  const detectedUrl = detectUrlFromHtml(pastedHtml);

  // 1. itemscope/itemtype on <html>
  const htmlEl = doc.documentElement;
  if (htmlEl && !htmlEl.hasAttribute("itemscope")) {
    htmlEl.setAttribute("itemscope", "");
    htmlEl.setAttribute("itemtype", "https://schema.org/WebPage");
    applied.push('Added itemscope itemtype="https://schema.org/WebPage" to <html>');
  }

  // 2. Ensure <head>
  let head: HTMLHeadElement | null = doc.head;
  if (!head) {
    head = doc.createElement("head");
    if (htmlEl) htmlEl.insertBefore(head, htmlEl.firstChild);
    applied.push("Created missing <head>");
  }

  if (fix) {
    // 3. Title
    if (fix.suggestedTitle) {
      let title = doc.querySelector("title");
      const before = title?.textContent ?? null;
      if (!title) {
        title = doc.createElement("title");
        head.appendChild(title);
      }
      title.textContent = fix.suggestedTitle;
      const beforePreview = (before ?? "").slice(0, 60);
      const afterPreview = fix.suggestedTitle.slice(0, 60);
      if (before === null) {
        applied.push(`Inserted <title>: "${afterPreview}"`);
      } else if (before !== fix.suggestedTitle) {
        applied.push(`Replaced <title>: "${beforePreview}" → "${afterPreview}"`);
      }
    }

    // 4. Meta description
    if (fix.suggestedMetaDescription) {
      const existed = !!doc.querySelector('meta[name="description"]');
      upsertMeta(doc, head, 'meta[name="description"]', {
        name: "description",
        content: fix.suggestedMetaDescription,
      });
      applied.push(existed ? 'Updated <meta name="description">' : 'Inserted <meta name="description">');
    }

    // 5. H1
    if (fix.h1Fix) {
      const h1 = doc.querySelector("h1");
      if (h1) {
        const before = h1.textContent ?? "";
        if (before.trim() !== fix.h1Fix.trim()) {
          h1.textContent = fix.h1Fix;
          applied.push(`Replaced first <h1>: "${before.slice(0, 60)}" → "${fix.h1Fix.slice(0, 60)}"`);
        }
      } else if (doc.body) {
        const newH1 = doc.createElement("h1");
        newH1.textContent = fix.h1Fix;
        doc.body.insertBefore(newH1, doc.body.firstChild);
        applied.push(`Inserted <h1>: "${fix.h1Fix.slice(0, 60)}"`);
      }
    }

    // 6. Open Graph tags
    if (fix.suggestedTitle) {
      const inserted = upsertMeta(doc, head, 'meta[property="og:title"]', {
        property: "og:title",
        content: fix.suggestedTitle,
      });
      applied.push(inserted ? "Inserted og:title" : "Updated og:title");
    }
    if (fix.suggestedMetaDescription) {
      const inserted = upsertMeta(doc, head, 'meta[property="og:description"]', {
        property: "og:description",
        content: fix.suggestedMetaDescription,
      });
      applied.push(inserted ? "Inserted og:description" : "Updated og:description");
    }
    if (!doc.querySelector('meta[property="og:type"]')) {
      upsertMeta(doc, head, 'meta[property="og:type"]', { property: "og:type", content: "website" });
      applied.push('Inserted og:type="website"');
    }
    if (detectedUrl && !doc.querySelector('meta[property="og:url"]')) {
      upsertMeta(doc, head, 'meta[property="og:url"]', { property: "og:url", content: detectedUrl });
      applied.push("Inserted og:url");
    }
  }

  // 7. JSON-LD schema blocks (combine page-matched + site-level, dedup vs existing)
  const blocks = Array.from(
    new Set<string>([...(fix?.matchedSchemaBlocks ?? []), ...siteSchemaBlocks]),
  ).filter((b) => typeof b === "string" && b.trim().length > 0);

  if (blocks.length > 0) {
    const existingNorm = new Set(
      Array.from(head.querySelectorAll('script[type="application/ld+json"]'))
        .map((s) => (s.textContent ?? "").replace(/\s+/g, "")),
    );
    let injected = 0;
    for (const block of blocks) {
      const normalized = block.replace(/\s+/g, "");
      if (existingNorm.has(normalized)) continue;
      const script = doc.createElement("script");
      script.setAttribute("type", "application/ld+json");
      script.textContent = "\n" + block.trim() + "\n";
      head.appendChild(script);
      injected++;
    }
    if (injected > 0) {
      applied.push(`Injected ${injected} JSON-LD schema block(s) into <head>`);
    }
  }

  // 8. llms.txt link
  if (!doc.querySelector('link[rel="alternate"][type="text/plain"][href="/llms.txt"]')) {
    const link = doc.createElement("link");
    link.setAttribute("rel", "alternate");
    link.setAttribute("type", "text/plain");
    link.setAttribute("href", "/llms.txt");
    head.appendChild(link);
    applied.push('Added <link rel="alternate" type="text/plain" href="/llms.txt">');
  }

  // 9. Canonical link
  if (detectedUrl && !doc.querySelector('link[rel="canonical"]')) {
    const link = doc.createElement("link");
    link.setAttribute("rel", "canonical");
    link.setAttribute("href", detectedUrl);
    head.appendChild(link);
    applied.push(`Added <link rel="canonical" href="${detectedUrl}">`);
  }

  if (!fix) {
    warnings.push(
      "No per-page fix data was found for this URL. Only structural additions (itemscope, llms.txt, canonical, schema blocks) were applied — title/meta/h1 untouched.",
    );
  }

  return {
    fixedHtml: dom.serialize(),
    detectedUrl,
    appliedChanges: applied,
    warnings,
  };
}
