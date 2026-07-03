import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Mock Supabase updateSession so middleware tests don't need real Supabase env vars.
// Returns NextResponse.next() (pass-through, no redirect) for all requests.
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: vi.fn(async (_req: NextRequest) => NextResponse.next()),
}));

import { middleware } from "./middleware";

// Helper: build a NextRequest with optional user-agent
function makeRequest(url: string, ua?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (ua !== undefined) {
    headers["user-agent"] = ua;
  }
  return new NextRequest(new Request(url, { headers }));
}

describe("middleware — blocked user agents", () => {
  const blockedUAs = [
    "Nikto/2.1.6",
    "sqlmap/1.0",
    "WPScan v3.8",
    "AhrefsBot/7.0",
    "Mozilla/5.0 (compatible; SemrushBot/7)",
    "Nmap Scripting Engine",
    "masscan/1.0",
    "zgrab/0.x",
    "Nuclei/2.9",
    "Acunetix-Scanner",
    "Nessus",
    "OpenVAS",
    "BurpSuite",
    "Metasploit",
    "w3af.org",
    "havij",
    "WPBot",
    "cms-checker-tool",
    "JoomScan",
    "MJ12bot/5.3",
    "DotBot/1.2",
    "BLEXBot/1.0",
    "DataForSEObot/1.0",
    "FaviconHash",
    "Shodan/1.0",
  ];

  blockedUAs.forEach((ua) => {
    it(`blocks UA: "${ua}"`, async () => {
      const req = makeRequest("http://localhost/api/sites", ua);
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });
  });
});

describe("middleware — blocked paths", () => {
  const blockedPaths = [
    "/wp-admin",
    "/wp-admin/",
    "/wp-login.php",
    "/xmlrpc.php",
    "/wp-json/v2/posts",
    "/wp-config.php",
    "/wp-content/uploads/file.jpg",
    "/wp-includes/js/jquery.js",
    "/.env",
    "/.env.local",
    "/.git/config",
    "/.svn/entries",
    "/.htaccess",
    "/web.config",
    "/.vscode/settings.json",
    "/dump.sql",
    "/backup.sql.gz",
    "/data.bak",
    "/config.old",
    "/file.orig",
    "/phpmyadmin",
    "/adminer",
    "/administrator",
    "/node_modules/package.json",
    "/vendor/autoload.php",
    "/composer.json",
    "/package.json",
    "/debug",
    "/debug/vars",
    "/server-status",
    "/trace",
    "/.well-known/security.txt",
    "/path/to/file.php",
    "/shell.php",
  ];

  const goodUA = "Mozilla/5.0 (compatible; TestBot)";

  blockedPaths.forEach((p) => {
    it(`blocks path: "${p}"`, async () => {
      const req = makeRequest(`http://localhost${p}`, goodUA);
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });
  });
});

describe("middleware — allowlisted paths pass (200)", () => {
  const allowedPaths = [
    "/",
    "/_next/static/chunks/main.js",
    "/favicon.ico",
    "/api/serve/my-site/llms.txt",
    "/api/serve/some-slug/index.json",
    "/api/report/abc123",
    "/sites/abc123",
    "/verify/abc123",
    "/api/pipeline/run",
    "/api/pipeline/stage",
    "/api/cron/something",
    "/api/sites/abc123/auth",
    "/api/sites/abc123/info",
    "/api/sites/abc123/regenerate",
    "/api/sites/abc123/retry-failed",
    "/api/sites/abc123/download-report",
    "/api/sites/abc123/pdf-report",
    "/api/sites/abc123/example-com.pdf",
    "/api/sites/abc123/some-token/example-com.pdf",
    "/api/sites/abc123/verify-domain",
    "/api/sites/abc123/verify-connection",
    "/api/sites/abc123/verify",
    "/api/sites/abc123/citation-narrative",
    "/api/sites/abc123/citation-check",
    "/api/sites/abc123/competitor-discovery",
    "/api/sites/abc123/competitors",
    "/api/sites/abc123/fix-html-render",
    "/api/sites/abc123/consent",
    "/api/sites/abc123",
    "/api/sites",
    "/api/consent",
    "/api/audit/checkout",
    "/audit/abc123",
    "/api/integration-instructions",
    "/api/chatbot",
    "/preview",
    "/api/auth/otp/send",
    "/api/auth/otp/verify",
    "/api/auth/proxy/v1/verify",
    "/api/auth/proxy/v1/token",
    "/api/pricing",
    "/auth/login",
    "/auth/callback",
    "/dashboard",
    "/dashboard/domains/abc123",
    "/api/teams/me",
    "/api/checkout",
    "/api/webhooks/stripe",
    "/pricing",
    "/api/audit-purchase/checkout",
    "/api/audit-purchase/intake",
    "/api/audit-purchase/status",
    "/admin/cleo",
    "/admin/cleo/abc123",
    "/api/admin/cleo/golden",
  ];

  const goodUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

  allowedPaths.forEach((p) => {
    it(`allows path: "${p}"`, async () => {
      const req = makeRequest(`http://localhost${p}`, goodUA);
      const res = await middleware(req);
      expect(res.status).toBe(200);
    });
  });
});

describe("middleware — security headers on passing requests", () => {
  const goodUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

  it("sets X-Frame-Options: DENY", async () => {
    const req = makeRequest("http://localhost/api/serve/test/llms.txt", goodUA);
    const res = await middleware(req);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const req = makeRequest("http://localhost/api/sites/abc123", goodUA);
    const res = await middleware(req);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets Strict-Transport-Security", async () => {
    const req = makeRequest("http://localhost/api/serve/test/llms.txt", goodUA);
    const res = await middleware(req);
    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age=/);
  });

  it("sets X-XSS-Protection", async () => {
    const req = makeRequest("http://localhost/api/sites/abc123", goodUA);
    const res = await middleware(req);
    expect(res.headers.get("X-XSS-Protection")).toBe("1; mode=block");
  });

  it("sets Referrer-Policy", async () => {
    const req = makeRequest("http://localhost/api/sites/abc123", goodUA);
    const res = await middleware(req);
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("sets Permissions-Policy", async () => {
    const req = makeRequest("http://localhost/sites/abc123", goodUA);
    const res = await middleware(req);
    expect(res.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("sets X-Permitted-Cross-Domain-Policies: none", async () => {
    const req = makeRequest("http://localhost/sites/abc123", goodUA);
    const res = await middleware(req);
    expect(res.headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
  });
});

describe("middleware — unknown paths are blocked (403)", () => {
  const goodUA = "Mozilla/5.0 (X11; Linux x86_64)";

  const unknownPaths = [
    "/home",
    "/contact",
    "/about",
    "/admin",
    "/settings",
    "/profile",
  ];

  unknownPaths.forEach((p) => {
    it(`blocks unknown path: "${p}"`, async () => {
      const req = makeRequest(`http://localhost${p}`, goodUA);
      const res = await middleware(req);
      expect(res.status).toBe(403);
    });
  });
});

describe("middleware — empty user-agent handling", () => {
  it("blocks /sites/* with empty UA", async () => {
    const req = makeRequest("http://localhost/sites/abc123", "");
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });

  it("allows /api/serve/* with empty UA (api paths bypass UA check)", async () => {
    const req = makeRequest("http://localhost/api/serve/slug/llms.txt", "");
    const res = await middleware(req);
    expect(res.status).not.toBe(403);
  });

  it("allows /_next/* with empty UA", async () => {
    const req = makeRequest("http://localhost/_next/static/chunk.js", "");
    const res = await middleware(req);
    expect(res.status).not.toBe(403);
  });

  it("blocks /verify/* with empty UA", async () => {
    const req = makeRequest("http://localhost/verify/abc123", "");
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });
});

describe("middleware — UA check is case-insensitive", () => {
  it("blocks uppercase NIKTO", async () => {
    const req = makeRequest("http://localhost/api/sites", "NIKTO/2.1.6");
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });

  it("blocks mixed-case AhrefsBot embedded in longer UA", async () => {
    const req = makeRequest(
      "http://localhost/api/sites",
      "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)"
    );
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });
});

describe("middleware — blocked responses have no body", () => {
  it("403 response body is empty", async () => {
    const req = makeRequest("http://localhost/wp-admin", "Mozilla/5.0");
    const res = await middleware(req);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toBe("");
  });
});
