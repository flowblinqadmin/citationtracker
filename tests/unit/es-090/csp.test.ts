/**
 * ES-090 L-2 — Content-Security-Policy (U73-U75).
 *
 * Phase A (RED): main @ 70645cba `middleware.ts:98-106` SECURITY_HEADERS
 * lacks any Content-Security-Policy* key.
 *
 * Spec ref: ES-090 §b.7 — start in Report-Only, follow-up commit flips to enforcing.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: vi.fn(async (req: NextRequest) => {
    const { NextResponse } = await import("next/server");
    return NextResponse.next({ request: req });
  }),
}));

async function runMiddleware(path: string) {
  const { middleware } = await import("@/middleware");
  const req = new NextRequest(`https://example.test${path}`, {
    headers: { "user-agent": "Mozilla/5.0 (es-090-test)" },
  });
  return middleware(req);
}

describe("ES-090 L-2 — CSP headers (ChangedSpec per HP-190, HP-192, HP-194)", () => {
  it("U73: middleware response includes Content-Security-Policy(-Report-Only) AND Reporting-Endpoints header", async () => {
    const res = await runMiddleware("/");
    const csp =
      res.headers.get("content-security-policy") ??
      res.headers.get("content-security-policy-report-only");
    expect(csp, "no CSP header on middleware response").toBeTruthy();
    // HP-190: Reporting-Endpoints header must be set alongside CSP so browsers
    // actually emit violation reports.
    expect(res.headers.get("reporting-endpoints"), "Reporting-Endpoints header missing").toBeTruthy();
  });

  it("U74: script-src has nonce-* + strict-dynamic, NO unsafe-eval (HP-192)", async () => {
    const res = await runMiddleware("/");
    const csp =
      res.headers.get("content-security-policy") ??
      res.headers.get("content-security-policy-report-only") ??
      "";
    const scriptSrc = csp.split(/;\s*/).find((d) => d.startsWith("script-src"));
    expect(scriptSrc, "no script-src directive").toBeTruthy();
    // Per-request nonce.
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    // strict-dynamic token present.
    expect(scriptSrc).toMatch(/'strict-dynamic'/);
    // unsafe-eval MUST NOT be in script-src anymore (HP-192).
    expect(scriptSrc).not.toMatch(/'unsafe-eval'/);
  });

  it("U75: CSP connect-src allow-list includes supabase.co AND report-to/report-uri point at /api/csp-report (HP-190)", async () => {
    const res = await runMiddleware("/");
    const csp =
      res.headers.get("content-security-policy") ??
      res.headers.get("content-security-policy-report-only") ??
      "";
    const connectSrc = csp.split(/;\s*/).find((d) => d.startsWith("connect-src"));
    expect(connectSrc, "no connect-src directive").toBeTruthy();
    expect(connectSrc).toMatch(/supabase\.co/);
    // HP-190: report-to + report-uri must be present.
    const reportTo = csp.split(/;\s*/).find((d) => d.startsWith("report-to"));
    const reportUri = csp.split(/;\s*/).find((d) => d.startsWith("report-uri"));
    expect(reportTo, "report-to directive missing").toBeTruthy();
    expect(reportUri, "report-uri directive missing").toBeTruthy();
    expect(reportUri).toMatch(/\/api\/csp-report/);
  });
});
