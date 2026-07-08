// Domain canonicalization — the fix for the "invalid domain" brand-add blocker.
import { describe, it, expect } from "vitest";
import { normalizeDomain } from "@/lib/domain";
import { brandInputSchema } from "@/app/api/brands/brand-schema";

describe("normalizeDomain", () => {
  it("accepts a bare hostname unchanged", () => {
    expect(normalizeDomain("acme.com")).toBe("acme.com");
    expect(normalizeDomain("sub.acme.co.uk")).toBe("sub.acme.co.uk");
  });

  it("strips scheme, path, query, fragment, port", () => {
    expect(normalizeDomain("https://flowblinq.com")).toBe("flowblinq.com");
    expect(normalizeDomain("http://flowblinq.com/about")).toBe("flowblinq.com");
    expect(normalizeDomain("https://flowblinq.com/a/b?x=1#y")).toBe("flowblinq.com");
    expect(normalizeDomain("flowblinq.com/")).toBe("flowblinq.com");
    expect(normalizeDomain("flowblinq.com:8080")).toBe("flowblinq.com");
  });

  it("lowercases, trims, and drops leading www. and trailing dots", () => {
    expect(normalizeDomain("  WWW.FlowBlinq.COM  ")).toBe("flowblinq.com");
    expect(normalizeDomain("flowblinq.com.")).toBe("flowblinq.com");
    expect(normalizeDomain("https://www.Acme.com/")).toBe("acme.com");
  });

  it("rejects input with no plausible hostname", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
    expect(normalizeDomain("flowblinq")).toBeNull();        // no TLD dot
    expect(normalizeDomain("acme .com")).toBeNull();         // space → illegal char
    expect(normalizeDomain("acme_underscore.com")).toBeNull(); // underscore illegal
    expect(normalizeDomain(".com")).toBeNull();              // leading dot
    expect(normalizeDomain("acme..com")).toBeNull();         // empty label
    expect(normalizeDomain("-acme.com")).toBeNull();         // leading hyphen
  });
});

describe("brandInputSchema normalizes the domain (server trust boundary)", () => {
  it("accepts a pasted URL and stores the bare hostname", () => {
    const r = brandInputSchema.safeParse({ name: "FlowBlinq", domain: "https://www.FlowBlinq.com/about" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.domain).toBe("flowblinq.com");
  });

  it("normalizes competitor domains too", () => {
    const r = brandInputSchema.safeParse({
      name: "Acme", domain: "acme.com",
      competitors: [{ name: "Rival", domain: "HTTPS://www.Rival.io/" }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.competitors?.[0].domain).toBe("rival.io");
  });

  it("still rejects a genuinely invalid domain with a clear message", () => {
    const r = brandInputSchema.safeParse({ name: "X", domain: "notadomain" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe("invalid domain");
  });
});
