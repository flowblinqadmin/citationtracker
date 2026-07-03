import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSiteView } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { applyFixesToHtml, detectUrlFromHtml } from "@/lib/services/fix-html-generator";
import { diffLines } from "diff";

/**
 * Aligned side-by-side diff row. Each row represents one "step" in the diff:
 *   - context: both sides have the same text at synchronized line numbers.
 *   - removed: text is in `pasted` only; `fixed` is null (blank in UI).
 *   - added: text is in `fixed` only; `pasted` is null (blank in UI).
 */
interface SideBySideRow {
  pasted: { lineNo: number; text: string } | null;
  fixed: { lineNo: number; text: string } | null;
  marker: "context" | "removed" | "added";
}

function computeSideBySideDiff(pastedHtml: string, fixedHtml: string): SideBySideRow[] {
  const changes = diffLines(pastedHtml, fixedHtml);
  const rows: SideBySideRow[] = [];
  let leftLine = 1;
  let rightLine = 1;
  for (const ch of changes) {
    const value = ch.value;
    // Split each chunk into individual lines (newline-delimited). diffLines
    // returns trailing-newline-included values, so empty trailing splits are
    // discarded.
    const lines = value.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    if (ch.added) {
      for (const line of lines) {
        rows.push({ pasted: null, fixed: { lineNo: rightLine++, text: line }, marker: "added" });
      }
    } else if (ch.removed) {
      for (const line of lines) {
        rows.push({ pasted: { lineNo: leftLine++, text: line }, fixed: null, marker: "removed" });
      }
    } else {
      for (const line of lines) {
        rows.push({
          pasted: { lineNo: leftLine++, text: line },
          fixed: { lineNo: rightLine++, text: line },
          marker: "context",
        });
      }
    }
  }
  return rows;
}
import { deductCredits } from "@/lib/services/credit-deduction";
import { ACTION_CREDITS } from "@/lib/config";
import type { PerPageFix } from "@/lib/services/page-fix-generator";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface RequestBody {
  pastedHtml?: string;
  selectedUrl?: string;
}

/**
 * POST /api/sites/[id]/fix-html-render?token=...
 *
 * Body: { pastedHtml: string, selectedUrl?: string }
 *
 *   pastedHtml   — required, the user's existing page HTML
 *   selectedUrl  — optional, the URL of the page from the crawl list. If omitted,
 *                  the server auto-detects from canonical/og:url in pastedHtml.
 *
 * Auth     : site access token query param (matched against geoSites.accessToken via the view).
 * Authz    : site.teamId must be set; deducts ACTION_CREDITS.fixHtmlRender (=5) per call.
 * Response : { fixedHtml, detectedUrl, matchedUrl, appliedChanges, warnings, creditsRemaining }
 */
export async function POST(req: NextRequest | Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Reject oversized bodies BEFORE calling req.json() so a 50 MB payload
    // doesn't allocate 50 MB of memory on the Function before being rejected.
    // The 5_000_000 byte cap below is still enforced as a belt-and-suspenders
    // check on trimmed-string length (handles wrapper JSON overhead, base64,
    // etc.) — the Content-Length gate is the primary DoS guard.
    const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
    if (contentLength > 5_500_000) {
      return NextResponse.json({ error: "pastedHtml too large (>5 MB)" }, { status: 413 });
    }

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const pastedHtml = (body.pastedHtml ?? "").trim();
    if (!pastedHtml) {
      return NextResponse.json({ error: "pastedHtml is required" }, { status: 400 });
    }
    if (pastedHtml.length > 5_000_000) {
      return NextResponse.json({ error: "pastedHtml too large (>5 MB)" }, { status: 413 });
    }

    // STEP-2 DEFENSE (hypothesis #2 — geo_site_view missing columns on prod):
    //   Drizzle's `.select()` without arguments emits SELECT * mapped against
    //   the schema definition. If the prod DB ran migration 001 BEFORE
    //   per_page_fixes / generated_schema_blocks were added to the table,
    //   the generated SQL fails with "column does not exist". Select the
    //   exact columns we use and tolerate jsonb columns being missing.
    let view: {
      siteId: string;
      accessToken: string | null;
      teamId: string | null;
      domain: string | null;
      perPageFixes: unknown;
      generatedSchemaBlocks: unknown;
    } | undefined;
    try {
      const rows = await db
        .select({
          siteId: geoSiteView.siteId,
          accessToken: geoSiteView.accessToken,
          teamId: geoSiteView.teamId,
          domain: geoSiteView.domain,
          perPageFixes: geoSiteView.perPageFixes,
          generatedSchemaBlocks: geoSiteView.generatedSchemaBlocks,
        })
        .from(geoSiteView)
        .where(eq(geoSiteView.siteId, id));
      view = rows[0];
    } catch (selectErr) {
      // Fall back to a minimal select that doesn't reference the two
      // late-added jsonb columns. If THIS also fails, the table itself is
      // missing/misnamed and the outer catch surfaces it as a 500 with detail.
      const msg = selectErr instanceof Error ? selectErr.message : String(selectErr);
      const looksLikeMissingJsonbColumn =
        /column.*(per_page_fixes|generated_schema_blocks).*does not exist/i.test(msg);
      if (!looksLikeMissingJsonbColumn) throw selectErr;
      console.warn(
        "[fix_html_render] geo_site_view missing per_page_fixes or generated_schema_blocks — falling back to minimal select",
        msg,
      );
      const rows = await db
        .select({
          siteId: geoSiteView.siteId,
          accessToken: geoSiteView.accessToken,
          teamId: geoSiteView.teamId,
          domain: geoSiteView.domain,
        })
        .from(geoSiteView)
        .where(eq(geoSiteView.siteId, id));
      const r = rows[0];
      if (r) {
        view = { ...r, perPageFixes: null, generatedSchemaBlocks: null };
      }
    }

    if (!view || view.accessToken !== token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!view.teamId) {
      return NextResponse.json({ error: "Pro account required." }, { status: 402 });
    }

    // Resolve target URL: explicit selection wins; otherwise auto-detect from HTML.
    let targetUrl = (body.selectedUrl ?? "").trim() || detectUrlFromHtml(pastedHtml);
    let matchSource: "selected" | "detected" | "none" = body.selectedUrl
      ? "selected"
      : targetUrl
        ? "detected"
        : "none";

    // Find the matching PerPageFix by URL exact match, then by hostname+path fallback.
    const perPageFixes = (view.perPageFixes as PerPageFix[] | null) ?? [];
    let matchedFix: PerPageFix | undefined;
    let matchedUrl: string | null = null;
    if (targetUrl) {
      matchedFix = perPageFixes.find((f) => f.url === targetUrl);
      if (!matchedFix) {
        // Fallback: pathname match (handles http vs https, trailing slash, www mismatch).
        try {
          const u1 = new URL(targetUrl);
          matchedFix = perPageFixes.find((f) => {
            try {
              const u2 = new URL(f.url);
              return (
                u1.pathname.replace(/\/+$/, "") === u2.pathname.replace(/\/+$/, "") &&
                u1.hostname.replace(/^www\./, "") === u2.hostname.replace(/^www\./, "")
              );
            } catch {
              return false;
            }
          });
        } catch {
          // ignore malformed URL
        }
      }
      if (matchedFix) matchedUrl = matchedFix.url;
    }

    const siteSchemaBlocks = (view.generatedSchemaBlocks as string[] | null) ?? [];

    const deduction = await deductCredits({
      teamId: view.teamId,
      cost: ACTION_CREDITS.fixHtmlRender,
      type: "fix_html_render",
      description: `Fix HTML render for ${view.domain} (${matchedUrl ?? "no-match"})`,
      siteId: view.siteId,
    });
    if (!deduction.success) {
      return NextResponse.json({ error: deduction.error }, { status: 402 });
    }

    // STEP-2 DEFENSE (hypothesis #3 — JSDOM crash mid-serialize):
    //   applyFixesToHtml() catches `new JSDOM(html)` failures internally but
    //   downstream operations (dom.serialize(), querySelector, appendChild)
    //   can still throw on pathological HTML. Treat any throw as "leave the
    //   HTML unchanged + return a warning" instead of bubbling up to a 500.
    const start = Date.now();
    let result: {
      fixedHtml: string;
      detectedUrl: string | null;
      appliedChanges: string[];
      warnings: string[];
    };
    try {
      result = applyFixesToHtml({
        pastedHtml,
        fix: matchedFix,
        siteSchemaBlocks,
      });
    } catch (renderErr) {
      const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
      console.error("[fix_html_render] applyFixesToHtml threw — returning unchanged HTML with warning", {
        siteId: id,
        domain: view.domain,
        error: msg,
        stack: renderErr instanceof Error ? renderErr.stack : undefined,
      });
      result = {
        fixedHtml: pastedHtml,
        detectedUrl: null,
        appliedChanges: [],
        warnings: [`HTML parsing/serialization failed: ${msg}. The pasted HTML was returned unchanged — please verify it is well-formed.`],
      };
    }
    const ms = Date.now() - start;

    console.warn(
      JSON.stringify({
        event: "fix_html_render.applied",
        siteId: id,
        domain: view.domain,
        matchSource,
        matchedUrl,
        detectedUrl: result.detectedUrl,
        changeCount: result.appliedChanges.length,
        warningCount: result.warnings.length,
        ms,
      }),
    );

    // STEP-2 DEFENSE: diffLines on enormous HTML can be slow or throw on
    // weird Unicode. Wrap independently so a diff failure doesn't 500 the
    // whole request — the fixed HTML is still returnable.
    let sideBySide: ReturnType<typeof computeSideBySideDiff>;
    try {
      sideBySide = computeSideBySideDiff(pastedHtml, result.fixedHtml);
    } catch (diffErr) {
      const msg = diffErr instanceof Error ? diffErr.message : String(diffErr);
      console.error("[fix_html_render] computeSideBySideDiff threw", { siteId: id, error: msg });
      sideBySide = [];
      result.warnings.push(`Diff computation failed: ${msg}. The fixed HTML is returned but the side-by-side view will be empty.`);
    }

    return NextResponse.json({
      fixedHtml: result.fixedHtml,
      detectedUrl: result.detectedUrl,
      matchedUrl,
      matchSource,
      appliedChanges: result.appliedChanges,
      warnings: result.warnings,
      sideBySide,
      creditsRemaining: deduction.success ? deduction.balanceAfter : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const name = err instanceof Error ? err.name : undefined;
    console.error("[fix_html_render.error]", { message, name, stack });
    return NextResponse.json(
      { error: "Render failed", detail: message, name },
      { status: 500 },
    );
  }
}
