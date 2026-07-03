// Security boundary tests for the 2026-05-27 audit critical findings.
// These pin the fixes in place — if a future change regresses any of them,
// the test fails fast.

import { describe, it, expect, beforeEach } from "vitest";
import { getClientIp } from "@/lib/client-ip";

// ── C4: getClientIp ignores spoofable x-forwarded-for ─────────────────────
describe("[C4] getClientIp", () => {
  function makeReq(opts: {
    ip?: string | null;
    headers?: Record<string, string>;
  }): { ip?: string | null; headers: Headers } {
    const headers = new Headers(opts.headers ?? {});
    return { ip: opts.ip, headers };
  }

  it("returns runtime ip when set (Vercel edge socket peer)", () => {
    const req = makeReq({
      ip: "203.0.113.10",
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getClientIp(req as any)).toBe("203.0.113.10");
  });

  it("falls back to x-vercel-forwarded-for (Vercel-trusted) over raw x-forwarded-for", () => {
    const req = makeReq({
      headers: {
        "x-vercel-forwarded-for": "203.0.113.20",
        "x-forwarded-for": "1.1.1.1",
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getClientIp(req as any)).toBe("203.0.113.20");
  });

  it("falls back to x-real-ip when vercel header missing", () => {
    const req = makeReq({
      headers: {
        "x-real-ip": "203.0.113.30",
        "x-forwarded-for": "1.1.1.1",
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getClientIp(req as any)).toBe("203.0.113.30");
  });

  it("NEVER returns raw x-forwarded-for when no trusted source is set", () => {
    const req = makeReq({
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getClientIp(req as any)).toBe("unknown");
  });

  it("returns 'unknown' when no headers and no req.ip", () => {
    const req = makeReq({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getClientIp(req as any)).toBe("unknown");
  });

  it("ignores empty-string x-forwarded-for chains", () => {
    const req = makeReq({ headers: { "x-forwarded-for": ",  ," } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getClientIp(req as any)).toBe("unknown");
  });

  it("trims the first hop of x-vercel-forwarded-for chain", () => {
    const req = makeReq({
      headers: { "x-vercel-forwarded-for": "  203.0.113.40, 10.0.0.1" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getClientIp(req as any)).toBe("203.0.113.40");
  });
});

// ── C3: CRON_SECRET fail-closed ───────────────────────────────────────────
describe("[C3] cron-auth", () => {
  beforeEach(() => {
    // Set valid default for the import below; assertion runs at module load.
    if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 32) {
      process.env.CRON_SECRET =
        "test-cron-secret-32-chars-minimum-aaaa";
    }
  });

  it("rejects requests without an authorization header", async () => {
    const { assertCronAuth } = await import("@/lib/cron-auth");
    const req = new Request("https://x.test/cron");
    const denied = assertCronAuth(req);
    expect(denied).not.toBeNull();
    expect(denied?.status).toBe(401);
  });

  it("rejects requests with a wrong-length token", async () => {
    const { assertCronAuth } = await import("@/lib/cron-auth");
    const req = new Request("https://x.test/cron", {
      headers: { authorization: "Bearer short" },
    });
    expect(assertCronAuth(req)?.status).toBe(401);
  });

  it("rejects requests with a same-length wrong token", async () => {
    const { assertCronAuth } = await import("@/lib/cron-auth");
    const wrong = "x".repeat(process.env.CRON_SECRET!.length);
    const req = new Request("https://x.test/cron", {
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(assertCronAuth(req)?.status).toBe(401);
  });

  it("rejects empty Bearer token (treats '' like any other wrong token)", async () => {
    const { assertCronAuth } = await import("@/lib/cron-auth");
    const req = new Request("https://x.test/cron", {
      headers: { authorization: "Bearer " },
    });
    expect(assertCronAuth(req)?.status).toBe(401);
  });

  it("accepts requests with the correct token", async () => {
    const { assertCronAuth } = await import("@/lib/cron-auth");
    const req = new Request("https://x.test/cron", {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    expect(assertCronAuth(req)).toBeNull();
  });
});

// ── C1: /api/sites middleware-gated ───────────────────────────────────────
describe("[C1] middleware strips spoofable auth headers on /api/sites", () => {
  it("/api/sites is in NEEDS_SUPABASE_SESSION (routes through updateSession)", async () => {
    const middlewareSource = await import("fs").then((fs) =>
      fs.promises.readFile(
        new URL("../middleware.ts", import.meta.url),
        "utf8",
      ),
    );
    // The fix adds /^\/api\/sites$/ to NEEDS_SUPABASE_SESSION.
    expect(middlewareSource).toMatch(/NEEDS_SUPABASE_SESSION[\s\S]*\/\^\\\/api\\\/sites\$\//);
  });

  it("lib/supabase/middleware.ts strips client-supplied auth headers", async () => {
    const middlewareSource = await import("fs").then((fs) =>
      fs.promises.readFile(
        new URL("../lib/supabase/middleware.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(middlewareSource).toContain('request.headers.delete("x-user-id")');
    expect(middlewareSource).toContain('request.headers.delete("x-user-email")');
    expect(middlewareSource).toContain(
      'request.headers.delete("x-supabase-token")',
    );
  });
});

// ── C5: /api/auth/check no longer leaks email existence ───────────────────
describe("[C5] /api/auth/check no enumeration signal", () => {
  it("source returns a constant exists:true response", async () => {
    const routeSource = await import("fs").then((fs) =>
      fs.promises.readFile(
        new URL("../app/api/auth/check/route.ts", import.meta.url),
        "utf8",
      ),
    );
    // The hardened response is a literal `{ exists: true }`.
    expect(routeSource).toContain("{ exists: true }");
    // And it MUST NOT branch on a DB lookup against geoSites.
    expect(routeSource).not.toMatch(/!!site/);
    expect(routeSource).not.toMatch(/from\(geoSites\)/);
  });

  it("source applies per-IP rate limit using getClientIp (not bare XFF)", async () => {
    const routeSource = await import("fs").then((fs) =>
      fs.promises.readFile(
        new URL("../app/api/auth/check/route.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(routeSource).toContain("getClientIp");
    expect(routeSource).toContain("auth_check:");
  });
});

// ── C4 scope: ensure no route reads raw x-forwarded-for ───────────────────
describe("[C4] regression guard — no route reads raw x-forwarded-for", () => {
  const SCANNED_ROUTES = [
    "../app/api/audit-purchase/intake/route.ts",
    "../app/api/audit-purchase/status/route.ts",
    "../app/api/audit-purchase/checkout/route.ts",
    "../app/api/audit/route.ts",
    "../app/api/sites/route.ts",
    "../app/api/sites/[id]/auth/route.ts",
    "../app/api/auth/proxy/[...path]/route.ts",
    "../app/api/auth/check/route.ts",
    "../app/api/t/[slug]/route.ts",
  ];

  it.each(SCANNED_ROUTES)(
    "%s does not read x-forwarded-for as the primary IP source",
    async (relPath) => {
      const fs = await import("fs");
      const src = await fs.promises.readFile(
        new URL(relPath, import.meta.url),
        "utf8",
      );
      // Allow only the audit-purchase/checkout legacy "?? x-forwarded-for"
      // fallback that the audit explicitly notes was already fixed. All
      // other routes must use getClientIp().
      const bareReads = src.match(/headers\.get\(\s*"x-forwarded-for"\s*\)/g) ?? [];
      if (relPath.endsWith("audit-purchase/checkout/route.ts")) {
        // Tolerate the documented req.ip ?? xff fallback — present pre-fix
        // and acceptable because req.ip is preferred first.
        expect(bareReads.length).toBeLessThanOrEqual(1);
      } else {
        expect(bareReads).toEqual([]);
      }
    },
  );
});
