/**
 * ES-090 Phase 1 (ScriptDev) — L-2 Content-Security-Policy (§b.7).
 *
 * ChangedSpec amendments HP-190 + HP-192:
 * - Ship Report-Only first (observation window), then flip to enforcing.
 * - Nonce-based script-src with `'strict-dynamic'`. `'unsafe-eval'` REMOVED.
 * - Reporting-Endpoints header + /api/csp-report route (owned, not Sentry
 *   direct) so we can PII-scrub `document-uri` / `blocked-uri` before
 *   forwarding to Sentry.
 *
 * U73-U75 equivalents:
 * - U73  middleware response includes Content-Security-Policy-Report-Only
 * - U74  CSP forbids default-src * (and no unsafe-eval anywhere)
 * - U75  connect-src allows *.supabase.co
 *
 * Plus HP-190/HP-192-specific assertions:
 * - nonce in script-src, strict-dynamic, Reporting-Endpoints header
 * - per-request nonce varies between requests
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

describe("ES-090 L-2 / middleware CSP", () => {
  it("middleware source references Content-Security-Policy(-Report-Only)", () => {
    const src = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf-8");
    expect(src).toMatch(/Content-Security-Policy(-Report-Only)?/);
  });

  it("middleware source includes per-request nonce generation (16 random bytes)", () => {
    const src = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf-8");
    // HP-192: per-request nonce, not static. Edge-safe via Web Crypto API.
    expect(src).toMatch(/crypto\.getRandomValues\s*\(\s*new\s+Uint8Array\s*\(\s*16\s*\)\s*\)/);
  });

  it("middleware source includes 'strict-dynamic' in script-src", () => {
    const src = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf-8");
    expect(src).toMatch(/'strict-dynamic'/);
  });

  it("middleware source does NOT include 'unsafe-eval' (HP-192)", () => {
    const src = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf-8");
    // HP-192 explicitly REMOVES unsafe-eval. If it reappears, CSP bypass risk.
    expect(src).not.toMatch(/'unsafe-eval'/);
  });

  it("middleware source includes Reporting-Endpoints header (HP-190)", () => {
    const src = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf-8");
    expect(src).toMatch(/Reporting-Endpoints/);
  });

  it("middleware source includes report-uri /api/csp-report directive (HP-190)", () => {
    const src = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf-8");
    expect(src).toMatch(/report-uri[^"'`]*\/api\/csp-report/);
  });

  it("middleware source lists *.supabase.co in connect-src (U75)", () => {
    const src = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf-8");
    expect(src).toMatch(/connect-src[^"`]*\*\.supabase\.co/);
  });

  it("middleware source does NOT include 'default-src *' (U74)", () => {
    const src = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf-8");
    // default-src * would defeat the whole policy.
    expect(src).not.toMatch(/default-src\s+\*/);
  });

  it("middleware source includes frame-ancestors 'none' (clickjack defense)", () => {
    const src = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf-8");
    expect(src).toMatch(/frame-ancestors\s+'none'/);
  });

  it("middleware emits a CSP header at runtime (Report-Only for PR#1)", async () => {
    // Integration-style unit: exercise the actual middleware function.
    const mod = await import("@/middleware");
    const req = new NextRequest(new URL("https://app.test/"), {
      method: "GET",
      headers: { "user-agent": "Mozilla/5.0 test" },
    });
    const res = await mod.middleware(req);
    const reportOnly = res.headers.get("content-security-policy-report-only");
    const enforcing = res.headers.get("content-security-policy");
    // PR#1 rollout: Report-Only. G5 gate follow-up flips to enforcing.
    expect(reportOnly ?? enforcing).toBeTruthy();
  });

  it("per-request nonce differs between two requests (HP-192)", async () => {
    const mod = await import("@/middleware");
    const mkReq = () => new NextRequest(
      new URL("https://app.test/"),
      { method: "GET", headers: { "user-agent": "Mozilla/5.0 test" } },
    );
    const [r1, r2] = await Promise.all([mod.middleware(mkReq()), mod.middleware(mkReq())]);
    const csp1 = r1.headers.get("content-security-policy-report-only") ??
                 r1.headers.get("content-security-policy") ?? "";
    const csp2 = r2.headers.get("content-security-policy-report-only") ??
                 r2.headers.get("content-security-policy") ?? "";
    const nonce1 = csp1.match(/'nonce-([^']+)'/)?.[1] ?? "";
    const nonce2 = csp2.match(/'nonce-([^']+)'/)?.[1] ?? "";
    expect(nonce1).toBeTruthy();
    expect(nonce2).toBeTruthy();
    expect(nonce1).not.toBe(nonce2);
  });
});
