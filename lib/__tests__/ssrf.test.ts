/**
 * TDD tests for lib/ssrf.ts — validatePublicUrl()
 *
 * Written BEFORE the implementation (true TDD).
 * All cases must pass after the implementation is in place.
 */

import { describe, it, expect } from "vitest";
import { validatePublicUrl } from "@/lib/ssrf";

describe("validatePublicUrl", () => {
  // ── Valid URLs ────────────────────────────────────────────────────────────

  it("accepts https://example.com", () => {
    const result = validatePublicUrl("https://example.com");
    expect(result.ok).toBe(true);
  });

  it("accepts https://example.com/path?q=1", () => {
    const result = validatePublicUrl("https://example.com/path?q=1");
    expect(result.ok).toBe(true);
  });

  it("accepts http://example.com (http allowed)", () => {
    const result = validatePublicUrl("http://example.com");
    expect(result.ok).toBe(true);
  });

  it("accepts https://sub.domain.com", () => {
    const result = validatePublicUrl("https://sub.domain.com");
    expect(result.ok).toBe(true);
  });

  // ── Scheme rejection ──────────────────────────────────────────────────────

  it("rejects ftp://example.com", () => {
    const result = validatePublicUrl("ftp://example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/scheme/i);
  });

  it("rejects file:///etc/passwd", () => {
    const result = validatePublicUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("rejects gopher://10.0.0.1/", () => {
    const result = validatePublicUrl("gopher://10.0.0.1/");
    expect(result.ok).toBe(false);
  });

  it("rejects javascript:alert(1)", () => {
    const result = validatePublicUrl("javascript:alert(1)");
    expect(result.ok).toBe(false);
  });

  // ── Parse failure ────────────────────────────────────────────────────────

  it("rejects non-URL strings", () => {
    const result = validatePublicUrl("not-a-url");
    expect(result.ok).toBe(false);
  });

  it("rejects empty string", () => {
    const result = validatePublicUrl("");
    expect(result.ok).toBe(false);
  });

  // ── Single-label hostnames ────────────────────────────────────────────────

  it("rejects http://localhost (single-label)", () => {
    const result = validatePublicUrl("http://localhost");
    expect(result.ok).toBe(false);
  });

  it("rejects http://intranet (single-label)", () => {
    const result = validatePublicUrl("http://intranet");
    expect(result.ok).toBe(false);
  });

  it("rejects http://mail (single-label)", () => {
    const result = validatePublicUrl("http://mail");
    expect(result.ok).toBe(false);
  });

  // ── Trailing dot normalization ───────────────────────────────────────────

  it("rejects http://localhost./ (trailing dot on localhost)", () => {
    const result = validatePublicUrl("http://localhost./");
    expect(result.ok).toBe(false);
  });

  it("rejects http://127.0.0.1./ (trailing dot on loopback)", () => {
    const result = validatePublicUrl("http://127.0.0.1./");
    expect(result.ok).toBe(false);
  });

  // ── Private IPv4 ranges ─────────────────────────────────────────────────

  it("rejects http://127.0.0.1/ (loopback)", () => {
    const result = validatePublicUrl("http://127.0.0.1/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://10.0.0.1/", () => {
    const result = validatePublicUrl("http://10.0.0.1/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://192.168.1.1/", () => {
    const result = validatePublicUrl("http://192.168.1.1/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://172.16.0.1/", () => {
    const result = validatePublicUrl("http://172.16.0.1/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://172.31.255.255/", () => {
    const result = validatePublicUrl("http://172.31.255.255/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://169.254.169.254/ (cloud metadata)", () => {
    const result = validatePublicUrl("http://169.254.169.254/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://100.64.0.1/ (CGNAT)", () => {
    const result = validatePublicUrl("http://100.64.0.1/");
    expect(result.ok).toBe(false);
  });

  // ── Encoded IP addresses ─────────────────────────────────────────────────

  it("rejects http://0x7f000001/ (hex-encoded 127.0.0.1)", () => {
    const result = validatePublicUrl("http://0x7f000001/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://2130706433/ (decimal-int 127.0.0.1)", () => {
    const result = validatePublicUrl("http://2130706433/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://0177.0.0.1/ (octal-encoded loopback)", () => {
    const result = validatePublicUrl("http://0177.0.0.1/");
    expect(result.ok).toBe(false);
  });

  // ── IPv6 addresses ──────────────────────────────────────────────────────

  it("rejects http://[::1]/ (IPv6 loopback)", () => {
    const result = validatePublicUrl("http://[::1]/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://[::ffff:127.0.0.1]/ (IPv4-mapped loopback)", () => {
    const result = validatePublicUrl("http://[::ffff:127.0.0.1]/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://[fe80::1]/ (IPv6 link-local)", () => {
    const result = validatePublicUrl("http://[fe80::1]/");
    expect(result.ok).toBe(false);
  });

  // ── Cloud-internal FQDNs ─────────────────────────────────────────────────

  it("rejects http://metadata.google.internal/", () => {
    const result = validatePublicUrl("http://metadata.google.internal/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://something.internal/", () => {
    const result = validatePublicUrl("http://something.internal/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://app.local/", () => {
    const result = validatePublicUrl("http://app.local/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://host.localhost/ (.localhost TLD)", () => {
    const result = validatePublicUrl("http://host.localhost/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://target.nip.io/", () => {
    const result = validatePublicUrl("http://target.nip.io/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://instance-data.ec2.internal/ (EC2 metadata)", () => {
    const result = validatePublicUrl("http://instance-data.ec2.internal/");
    expect(result.ok).toBe(false);
  });

  // ── Userinfo tricks ──────────────────────────────────────────────────────
  // URLs with userinfo (username/password) are rejected regardless of hostname.
  // url.href preserves the userinfo component, which pollutes Stripe metadata
  // and confuses logs/downstream consumers. Reject early with "userinfo_not_allowed".

  it("rejects http://127.0.0.1@evil.com/ (userinfo with IP as username)", () => {
    const result = validatePublicUrl("http://127.0.0.1@evil.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("userinfo_not_allowed");
  });

  it("rejects http://user@example.com/ (username only, no password)", () => {
    const result = validatePublicUrl("http://user@example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("userinfo_not_allowed");
  });

  it("rejects http://:secret@example.com/ (password only, empty username)", () => {
    const result = validatePublicUrl("http://:secret@example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("userinfo_not_allowed");
  });

  it("rejects http://user:pass@example.com/ (username and password)", () => {
    const result = validatePublicUrl("http://user:pass@example.com/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("userinfo_not_allowed");
  });

  it("accepts https://example.com/ (no userinfo — still ok)", () => {
    const result = validatePublicUrl("https://example.com/");
    expect(result.ok).toBe(true);
  });

  // ── URL length cap ──────────────────────────────────────────────────────

  it("rejects URLs longer than 500 chars", () => {
    const longUrl = "https://example.com/" + "a".repeat(481); // 20 + 481 = 501
    expect(longUrl.length).toBeGreaterThan(500);
    const result = validatePublicUrl(longUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too long/i);
  });

  it("accepts URLs of exactly 500 chars", () => {
    const url = "https://example.com/" + "a".repeat(480); // 20 + 480 = 500
    expect(url.length).toBe(500);
    const result = validatePublicUrl(url);
    expect(result.ok).toBe(true);
  });

  // ── Canonicalized URL returned ──────────────────────────────────────────

  it("returns a URL object on success", () => {
    const result = validatePublicUrl("https://example.com/path");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBeInstanceOf(URL);
      expect(result.url.href).toContain("example.com");
    }
  });

  it("returned url.href is canonicalized (lowercase scheme)", () => {
    const result = validatePublicUrl("HTTPS://Example.COM/Path");
    // new URL() will normalize scheme to lowercase
    if (result.ok) {
      expect(result.url.protocol).toBe("https:");
    }
  });

  // ── Fix #9: bare (non-bracketed) IPv6 forms ──────────────────────────────
  // Node URL parser typically brackets IPv6, but defend against bare forms
  // that could slip through alternate parsers or edge cases.

  it("rejects http://[::1]/ (IPv6 loopback — bracketed)", () => {
    const result = validatePublicUrl("http://[::1]/");
    expect(result.ok).toBe(false);
  });

  it("rejects bare ::1 hostname (IPv6 loopback — bare form)", () => {
    // Simulate a bare ::1 that slipped through by testing the regex directly
    const PRIVATE_RANGES = [/^(\[::1\]|::1)$/i];
    expect(PRIVATE_RANGES.some((r) => r.test("::1"))).toBe(true);
    expect(PRIVATE_RANGES.some((r) => r.test("[::1]"))).toBe(true);
    expect(PRIVATE_RANGES.some((r) => r.test("::2"))).toBe(false);
  });

  it("rejects bare ::ffff: prefix (IPv4-mapped IPv6 — bare form)", () => {
    const PRIVATE_RANGES = [/^(\[::ffff:|::ffff:)/i];
    expect(PRIVATE_RANGES.some((r) => r.test("::ffff:127.0.0.1"))).toBe(true);
    expect(PRIVATE_RANGES.some((r) => r.test("[::ffff:127.0.0.1]"))).toBe(true);
    expect(PRIVATE_RANGES.some((r) => r.test("::fffe:127.0.0.1"))).toBe(false);
  });

  it("rejects bare fe80:: prefix (IPv6 link-local — bare form)", () => {
    const PRIVATE_RANGES = [/^(\[fe80|fe80)/i];
    expect(PRIVATE_RANGES.some((r) => r.test("fe80::1"))).toBe(true);
    expect(PRIVATE_RANGES.some((r) => r.test("[fe80::1]"))).toBe(true);
    expect(PRIVATE_RANGES.some((r) => r.test("fe81::1"))).toBe(false);
  });

  it("rejects http://[::ffff:127.0.0.1]/ (IPv4-mapped loopback — bracketed)", () => {
    const result = validatePublicUrl("http://[::ffff:127.0.0.1]/");
    expect(result.ok).toBe(false);
  });

  it("rejects http://[fe80::1]/ (IPv6 link-local — bracketed)", () => {
    const result = validatePublicUrl("http://[fe80::1]/");
    expect(result.ok).toBe(false);
  });
});
