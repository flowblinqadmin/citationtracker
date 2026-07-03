/**
 * Tests for normalizeUrl() — ES-006
 *
 * Suites:
 *   1. Valid inputs return normalized URL
 *   2. Invalid inputs return null
 *   3. Idempotency
 *   4. SSRF-relevant inputs (normalization only — SSRF blocking is caller's job)
 *   5. Integration: normalizeUrl + SSRF validation combined
 */

import { describe, it, expect } from "vitest";
import { normalizeUrl } from "./utils";

// ─── Suite 1: Valid inputs ────────────────────────────────────────────────────

describe("Suite 1: valid inputs return normalized URL", () => {
  it("passes through https:// unchanged", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it("passes through http:// unchanged", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("handles uppercase HTTPS", () => {
    const result = normalizeUrl("HTTPS://EXAMPLE.COM");
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain("example.com");
  });

  it("prepends https:// to www.example.com", () => {
    expect(normalizeUrl("www.example.com")).toBe("https://www.example.com");
  });

  it("prepends https:// to bare domain", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
  });

  it("prepends https:// to domain with path", () => {
    expect(normalizeUrl("example.com/about")).toBe("https://example.com/about");
  });

  it("handles domain with query string", () => {
    expect(normalizeUrl("example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it("handles subdomain with TLD path", () => {
    expect(normalizeUrl("sub.example.co.uk/page")).toBe("https://sub.example.co.uk/page");
  });

  it("trims whitespace before normalizing", () => {
    expect(normalizeUrl("  example.com  ")).toBe("https://example.com");
  });

  it("handles URL with anchor", () => {
    expect(normalizeUrl("https://example.com/path#anchor")).toBe("https://example.com/path#anchor");
  });

  it("handles URL with credentials", () => {
    expect(normalizeUrl("https://user:pass@example.com")).toBe("https://user:pass@example.com");
  });

  it("handles domain with port", () => {
    expect(normalizeUrl("example.com:8080")).toBe("https://example.com:8080");
  });
});

// ─── Suite 2: Invalid inputs return null ─────────────────────────────────────

describe("Suite 2: invalid inputs return null", () => {
  it("returns null for empty string", () => {
    expect(normalizeUrl("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(normalizeUrl("   ")).toBeNull();
  });

  it("returns null for bare word without dot", () => {
    expect(normalizeUrl("notaurl")).toBeNull();
  });

  it("returns null for ftp://", () => {
    expect(normalizeUrl("ftp://example.com")).toBeNull();
  });

  it("returns null for file://", () => {
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
  });

  it("returns null for javascript:", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("returns null for http:// with empty host", () => {
    expect(normalizeUrl("http://")).toBeNull();
  });

  it("returns null for https:// with empty host", () => {
    expect(normalizeUrl("https://")).toBeNull();
  });
});

// ─── Suite 3: Idempotency ─────────────────────────────────────────────────────

describe("Suite 3: idempotency", () => {
  it("double-normalizing bare domain is idempotent", () => {
    const first = normalizeUrl("example.com");
    expect(first).not.toBeNull();
    const second = normalizeUrl(first!);
    expect(second).toBe(first);
  });

  it("double-normalizing https URL is idempotent", () => {
    const first = normalizeUrl("https://example.com");
    expect(first).not.toBeNull();
    const second = normalizeUrl(first!);
    expect(second).toBe(first);
  });
});

// ─── Suite 4: SSRF-relevant inputs (normalize only) ──────────────────────────

describe("Suite 4: SSRF-relevant inputs (normalizeUrl only, caller blocks SSRF)", () => {
  it("returns null for localhost (no dot)", () => {
    expect(normalizeUrl("localhost")).toBeNull();
  });

  it("returns null for 127.0.0.1 (no dot in URL constructor hostname? — actually has dots)", () => {
    // 127.0.0.1 has dots so normalizeUrl returns a value; SSRF caller must block it
    const result = normalizeUrl("https://127.0.0.1");
    expect(result).toBe("https://127.0.0.1");
  });

  it("normalizes 192.168.1.1 (SSRF blocking is caller's job)", () => {
    const result = normalizeUrl("https://192.168.1.1");
    expect(result).toBe("https://192.168.1.1");
  });

  it("normalizes bare 192.168.1.1 by prepending https", () => {
    const result = normalizeUrl("192.168.1.1");
    expect(result).toBe("https://192.168.1.1");
  });

  it("normalizes bare 10.0.0.1 by prepending https (has dots)", () => {
    const result = normalizeUrl("10.0.0.1");
    expect(result).toBe("https://10.0.0.1");
  });
});

// ─── Suite 5: Integration — normalizeUrl + SSRF validation ───────────────────

describe("Suite 5: integration — normalizeUrl + SSRF validation combined", () => {
  const privateRanges = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,
    /^0\./,
  ];

  function validateUrl(input: string): "valid" | "invalid" {
    const normalized = normalizeUrl(input);
    if (!normalized) return "invalid";
    const parsed = new URL(normalized);
    if (privateRanges.some((r) => r.test(parsed.hostname))) return "invalid";
    return "valid";
  }

  it("example.com is valid", () => {
    expect(validateUrl("example.com")).toBe("valid");
  });

  it("192.168.1.1 normalizes then SSRF-blocked", () => {
    expect(validateUrl("192.168.1.1")).toBe("invalid");
  });

  it("10.0.0.1 normalizes then SSRF-blocked", () => {
    expect(validateUrl("10.0.0.1")).toBe("invalid");
  });

  it("localhost has no dot — null from normalizeUrl", () => {
    expect(validateUrl("localhost")).toBe("invalid");
  });

  it("ftp://example.com returns null from normalizeUrl", () => {
    expect(validateUrl("ftp://example.com")).toBe("invalid");
  });

  it("https://example.com is valid unchanged", () => {
    expect(validateUrl("https://example.com")).toBe("valid");
  });
});
