/**
 * ES-B9.1 AC-B9.1-1 + AC-B9.1-6 — middleware allow-list parity.
 *
 * Enumerates every `app/api/sites/[id]/*` route directory and asserts each
 * matches one of the ALWAYS_ALLOWED regexes in middleware.ts OR is listed
 * in this test's INTENTIONALLY_AUTHED set (forcing a single-line audit
 * decision when a new route is added).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const MW_SRC = fs.readFileSync(path.resolve(ROOT, "middleware.ts"), "utf8");

// Pull out every regex literal that appears INSIDE the ALWAYS_ALLOWED array.
function extractAllowedRegexes(): RegExp[] {
  const start = MW_SRC.indexOf("ALWAYS_ALLOWED");
  expect(start).toBeGreaterThan(-1);
  const arrayStart = MW_SRC.indexOf("[", start);
  const arrayEnd = MW_SRC.indexOf("];", arrayStart);
  const block = MW_SRC.slice(arrayStart, arrayEnd);
  const regexes: RegExp[] = [];
  // Match `/regex-source/i` or `/regex-source/` lines. Conservatively match
  // patterns inside the block that look like a forward-slash-delimited
  // literal; capture the source + flags. Avoid greedy spans by anchoring
  // each candidate on a line boundary.
  const re = /\/(.+?)\/([gimsuy]*)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    try {
      regexes.push(new RegExp(m[1], m[2]));
    } catch {
      // Skip malformed (shouldn't happen on a valid middleware.ts).
    }
  }
  return regexes;
}

const ALLOWED_REGEXES = extractAllowedRegexes();

const SITE_ROUTES_DIR = path.resolve(ROOT, "app/api/sites/[id]");
const ROUTE_DIRS = fs
  .readdirSync(SITE_ROUTES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

// Routes intentionally NOT in ALWAYS_ALLOWED — they require a Supabase
// session cookie (dashboard-auth gated). Adding a new public route means
// either adding it to middleware.ts ALWAYS_ALLOWED OR adding it here, an
// explicit auditable decision.
const INTENTIONALLY_AUTHED: ReadonlySet<string> = new Set([
  // (empty) — citation-history was previously listed here with a
  // factually-wrong "dashboard-cookie auth" rationale. The route actually
  // authenticates via the site accessToken (Bearer header or ?token=), so it
  // is allow-listed in middleware.ts ALWAYS_ALLOWED (FIX-021), not masked here.
]);

function publicPathFor(route: string): string {
  // Mirror the regex shapes in middleware.ts (e.g. /api/sites/[^/]+/<route>).
  // Next.js dynamic-segment directories (named like [foo] or catch-all
  // [...foo]) need a representative URL that satisfies the route's
  // documented contract — the directory name itself is a placeholder.
  // The PDF download catch-all at app/api/sites/[id]/[...pdfPath]/ handles
  // two URL shapes (v1 single-segment .pdf?purchaseToken= and v2
  // two-segment <token>/<filename>.pdf). Probe with the v2 shape since it
  // exercises both PDF allow-list regexes (the v1 regex matches a
  // 2-segment-after-/sites pattern too).
  if (route === "[...pdfPath]") return "/api/sites/test-id-123/fake-token-abc/example.com.pdf";
  return `/api/sites/test-id-123/${route}`;
}

describe("AC-B9.1-1 — /retry-failed route is in middleware ALWAYS_ALLOWED", () => {
  it("ALWAYS_ALLOWED contains the retry-failed regex pattern", () => {
    expect(MW_SRC).toMatch(/retry-failed\$\//);
  });

  it("Anon POST to /api/sites/<id>/retry-failed passes the allow-list (regex match)", () => {
    const probePath = "/api/sites/abc-123/retry-failed";
    const matched = ALLOWED_REGEXES.some((r) => r.test(probePath));
    expect(matched).toBe(true);
  });
});

describe("AC-B9.1-6 — every site route is either allow-listed or explicitly authed", () => {
  it("regex extraction found > 0 patterns in middleware.ts", () => {
    expect(ALLOWED_REGEXES.length).toBeGreaterThan(0);
  });

  it("each app/api/sites/[id]/* route is allow-listed OR in INTENTIONALLY_AUTHED", () => {
    const orphans: string[] = [];
    for (const route of ROUTE_DIRS) {
      const probe = publicPathFor(route);
      const allowed = ALLOWED_REGEXES.some((r) => r.test(probe));
      if (!allowed && !INTENTIONALLY_AUTHED.has(route)) {
        orphans.push(route);
      }
    }
    expect(orphans).toEqual([]);
  });
});


describe("FIX-021 — allow-list gaps closed + /api/audit over-match anchored", () => {
  const matches = (p: string) => ALLOWED_REGEXES.some((r) => r.test(p));

  it("/api/auth/check is allow-listed (was a terminal 403 — in NEEDS_SUPABASE_SESSION but not ALWAYS_ALLOWED)", () => {
    expect(matches("/api/auth/check")).toBe(true);
  });

  it("/api/sites/<id>/citation-history is allow-listed (accessToken auth in route)", () => {
    expect(matches("/api/sites/test-id-123/citation-history")).toBe(true);
  });

  it("bare /api/audit (public POST create) is still allow-listed after anchoring", () => {
    expect(matches("/api/audit")).toBe(true);
  });

  it("/api/audit/<id> and its sub-routes are allow-listed", () => {
    expect(matches("/api/audit/abc-123")).toBe(true);
    expect(matches("/api/audit/abc-123/verify")).toBe(true);
  });

  it("the three /api/audit-purchase routes are explicitly allow-listed", () => {
    expect(matches("/api/audit-purchase/checkout")).toBe(true);
    expect(matches("/api/audit-purchase/intake")).toBe(true);
    expect(matches("/api/audit-purchase/status")).toBe(true);
  });

  it("the anchored audit pattern no longer over-matches sibling namespaces", () => {
    // Previously /^\/api\/audit/ matched anything prefixed with "audit",
    // silently making /api/audit-purchase/* and /api/auditXYZ public.
    expect(matches("/api/auditXYZ")).toBe(false);
    expect(matches("/api/audit-purchase/evil")).toBe(false);
    expect(matches("/api/audit-purchase")).toBe(false);
  });
});


describe("FIX-022 — /api/subscription PATCH route is allow-listed and session-aware", () => {
  it("/api/subscription matches ALWAYS_ALLOWED", () => {
    expect(ALLOWED_REGEXES.some((r) => r.test("/api/subscription"))).toBe(true);
  });

  it("/api/subscription is in NEEDS_SUPABASE_SESSION (PATCH calls getAuthenticatedUser)", () => {
    // Scope to the NEEDS_SUPABASE_SESSION array body — /api/subscription is in
    // ALWAYS_ALLOWED too, so a whole-file search would false-positive.
    const start = MW_SRC.indexOf("NEEDS_SUPABASE_SESSION");
    expect(start).toBeGreaterThan(-1);
    const arrStart = MW_SRC.indexOf("[", start);
    const arrEnd = MW_SRC.indexOf("];", arrStart);
    const block = MW_SRC.slice(arrStart, arrEnd);
    expect(block).toContain("/^\\/api\\/subscription$/");
  });
});
