import { describe, it, expect } from "vitest";

// This replicates the private-IP URL validation logic from app/api/sites/route.ts
// Testing it in isolation to verify each range is correctly blocked or allowed.
function validateUrl(url: string): { valid: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "Invalid URL" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, error: "Invalid URL" };
  }

  const privateRanges = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
    /^0\./,
    /^\[::1\]$/,
    /^\[::ffff:/i,
    /^\[f[cd]/i,
    /^\[fe80/i,
  ];

  if (privateRanges.some((r) => r.test(parsed.hostname))) {
    return { valid: false, error: "Invalid URL" };
  }

  return { valid: true };
}

describe("URL validation — private/localhost hostnames are blocked", () => {
  it("blocks http://localhost", () => {
    expect(validateUrl("http://localhost")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks https://localhost", () => {
    expect(validateUrl("https://localhost")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://localhost:3000", () => {
    expect(validateUrl("http://localhost:3000")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://LOCALHOST (case-insensitive)", () => {
    expect(validateUrl("http://LOCALHOST")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks https://127.0.0.1", () => {
    expect(validateUrl("https://127.0.0.1")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://127.0.0.1:8080", () => {
    expect(validateUrl("http://127.0.0.1:8080")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://127.255.255.255", () => {
    expect(validateUrl("http://127.255.255.255")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://10.0.0.1", () => {
    expect(validateUrl("http://10.0.0.1")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://10.255.255.255", () => {
    expect(validateUrl("http://10.255.255.255")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://192.168.1.1", () => {
    expect(validateUrl("http://192.168.1.1")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://192.168.0.0", () => {
    expect(validateUrl("http://192.168.0.0")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://172.16.0.1 (start of RFC 1918 range)", () => {
    expect(validateUrl("http://172.16.0.1")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://172.20.0.1 (middle of RFC 1918 range)", () => {
    expect(validateUrl("http://172.20.0.1")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://172.31.0.1 (end of RFC 1918 range)", () => {
    expect(validateUrl("http://172.31.0.1")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://0.0.0.0", () => {
    expect(validateUrl("http://0.0.0.0")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://0.1.2.3 (0.0.0.0/8 range)", () => {
    expect(validateUrl("http://0.1.2.3")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://169.254.169.254 (AWS/GCP/Azure metadata endpoint)", () => {
    expect(validateUrl("http://169.254.169.254")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://169.254.0.1 (link-local range)", () => {
    expect(validateUrl("http://169.254.0.1")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://100.64.0.1 (CGNAT start)", () => {
    expect(validateUrl("http://100.64.0.1")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://100.127.255.255 (CGNAT end)", () => {
    expect(validateUrl("http://100.127.255.255")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("blocks http://[::1] (IPv6 loopback)", () => {
    // URL().hostname for IPv6 literals is "[::1]" (with brackets)
    const result = validateUrl("http://[::1]");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid URL");
  });
});

describe("URL validation — routable addresses are allowed", () => {
  it("allows https://example.com", () => {
    expect(validateUrl("https://example.com")).toEqual({ valid: true });
  });

  it("allows http://example.com", () => {
    expect(validateUrl("http://example.com")).toEqual({ valid: true });
  });

  it("allows https://www.google.com", () => {
    expect(validateUrl("https://www.google.com")).toEqual({ valid: true });
  });

  it("allows http://172.32.0.1 (just outside RFC 1918 range — 172.32+)", () => {
    // 172.32 is NOT private (range ends at 172.31)
    expect(validateUrl("http://172.32.0.1")).toEqual({ valid: true });
  });

  it("allows http://172.15.0.1 (just below RFC 1918 range — 172.15)", () => {
    // 172.15 is NOT private (range starts at 172.16)
    expect(validateUrl("http://172.15.0.1")).toEqual({ valid: true });
  });

  it("allows http://11.0.0.1 (not in 10.x range)", () => {
    expect(validateUrl("http://11.0.0.1")).toEqual({ valid: true });
  });

  it("allows https://subdomain.example.com", () => {
    expect(validateUrl("https://subdomain.example.com")).toEqual({ valid: true });
  });

  it("allows http://100.128.0.1 (just outside CGNAT range — 100.128+)", () => {
    // CGNAT ends at 100.127.x.x — 100.128+ is routable
    expect(validateUrl("http://100.128.0.1")).toEqual({ valid: true });
  });

  it("allows http://100.63.0.1 (just below CGNAT range — 100.63)", () => {
    // CGNAT starts at 100.64.x.x
    expect(validateUrl("http://100.63.0.1")).toEqual({ valid: true });
  });
});

describe("URL validation — invalid format or protocol", () => {
  it("rejects 'not-a-url' (parse error)", () => {
    expect(validateUrl("not-a-url")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("rejects empty string", () => {
    expect(validateUrl("")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("rejects ftp://example.com (non-http protocol)", () => {
    expect(validateUrl("ftp://example.com")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("rejects file:///etc/passwd (file protocol)", () => {
    expect(validateUrl("file:///etc/passwd")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("rejects javascript:alert(1)", () => {
    expect(validateUrl("javascript:alert(1)")).toEqual({ valid: false, error: "Invalid URL" });
  });

  it("rejects //example.com (protocol-relative — not parseable as absolute URL)", () => {
    expect(validateUrl("//example.com")).toEqual({ valid: false, error: "Invalid URL" });
  });
});
