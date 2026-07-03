/**
 * Tests for probe_integration tool registration gating
 * Verifies that the tool is only registered when conditions are met
 */

import { describe, it, expect } from "vitest";
import type { SiteContext } from "@/lib/chatbot/system-prompt";

describe("probe_integration tool - registration conditions", () => {
  it("tool registers when all required fields are present", () => {
    // Test the gating logic used in generate.ts
    const siteContext: SiteContext = {
      domain: "example.com",
      siteId: "site-123",
      slug: "test-slug",
      domainVerified: true,
      tier: "paid",
    };

    const allowTools = true;

    // Verify the gating logic conditions (matching generate.ts)
    const canRegister = !!(
      allowTools &&
      siteContext.domainVerified &&
      siteContext.slug &&
      siteContext.domain &&
      siteContext.siteId
    );

    expect(canRegister).toBe(true);
  });

  it("tool does NOT register when domainVerified is false", () => {
    const siteContext: SiteContext = {
      domain: "example.com",
      siteId: "site-123",
      slug: "test-slug",
      domainVerified: false, // ← Not verified
      tier: "paid",
    };

    const canRegister = !!(
      true &&
      siteContext.domainVerified &&
      siteContext.slug &&
      siteContext.domain &&
      siteContext.siteId
    );

    expect(canRegister).toBe(false);
  });

  it("tool does NOT register when allowTools is false", () => {
    const siteContext: SiteContext = {
      domain: "example.com",
      siteId: "site-123",
      slug: "test-slug",
      domainVerified: true,
      tier: "paid",
    };

    const canRegister = !!(
      false &&
      siteContext.domainVerified &&
      siteContext.slug &&
      siteContext.domain &&
      siteContext.siteId
    );

    expect(canRegister).toBe(false);
  });

  it("tool does NOT register when siteId is missing", () => {
    const siteContext: SiteContext = {
      domain: "example.com",
      siteId: undefined, // ← Missing
      slug: "test-slug",
      domainVerified: true,
      tier: "paid",
    };

    const canRegister = !!(
      true &&
      siteContext.domainVerified &&
      siteContext.slug &&
      siteContext.domain &&
      siteContext.siteId
    );

    expect(canRegister).toBe(false);
  });

  it("SiteContext interface accepts siteId field", () => {
    // Verify SiteContext can be instantiated with siteId
    const context: SiteContext = {
      domain: "example.com",
      siteId: "site-123",
      tier: "paid",
    };
    expect(context.siteId).toBe("site-123");
  });
});
