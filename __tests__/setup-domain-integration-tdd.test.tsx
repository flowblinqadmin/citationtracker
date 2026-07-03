/**
 * ES-074 — Setup Tab Domain Integration
 * Phase 1 — ScriptDev TDD tests (drive implementation)
 *
 * Minimal tests covering core behaviors:
 * - Visibility gating (domainVerified)
 * - 7 platform tabs with tab switching
 * - Step pill badges
 * - Copy button
 * - Schema injection mandatory (not Optional)
 * - "Other" tab generate flow
 * - Test Connection flow
 * - Template variables with site.slug
 * - Green banner with domain name
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

afterEach(() => cleanup());

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const mockClipboard = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText: mockClipboard } });

vi.mock("@ai-sdk/react", () => ({ useChat: () => ({ messages: [], input: "", handleInputChange: vi.fn(), handleSubmit: vi.fn(), isLoading: false }) }));
vi.mock("ai", () => ({ DefaultChatTransport: vi.fn() }));
vi.mock("lucide-react", () => new Proxy({}, { get: () => () => null }));
vi.mock("@/app/components/chatbot/ChatWidget", () => ({ default: () => null }));
vi.mock("@/app/components/UpgradeModal", () => ({ default: () => null }));
vi.mock("@/app/dashboard/BuyCreditsButton", () => ({ default: () => null }));
vi.mock("@/app/dashboard/SignOutButton", () => ({ default: () => null }));

// ── Import ───────────────────────────────────────────────────────────────────

import SitePageClient from "@/app/sites/[id]/SitePageClient";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSite(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-1",
    domain: "mysite.io",
    slug: "my-slug",
    pipelineStatus: "complete",
    pipelineError: null,
    geoScorecard: { overallScore: 65, pillars: [], topThreeImprovements: [] },
    executiveSummary: null,
    generatedLlmsTxt: "# llms",
    generatedLlmsFullTxt: null,
    generatedBusinessJson: null,
    generatedSchemaBlocks: null,
    discoveryData: null,
    platformDetected: null,
    manualRunsThisMonth: 0,
    crawlCount: 1,
    lastCrawlAt: "2026-04-01T00:00:00Z",
    nextCrawlAt: null,
    createdAt: "2026-03-01T00:00:00Z",
    domainVerified: true,
    verifyToken: null,
    tier: "paid",
    credits: 50,
    baselineScore: null,
    improvementDelta: null,
    token: "tok-abc",
    ...overrides,
  } as unknown as Parameters<typeof SitePageClient>[0]["site"];
}

function renderAndGoSetup(siteOverrides: Record<string, unknown> = {}) {
  const site = makeSite(siteOverrides);
  render(
    <SitePageClient
      site={site}
      siteId="site-1"
      initialToken="tok-abc"
      allTeamDomains={[]}
      lastCitationCheck={null}
      citationHistory={[]}
      credits={50}
      userEmail="u@t.com"
    />
  );
  sessionStorage.setItem("geo-token-site-1", "tok-abc");
  fireEvent.click(screen.getByText("Setup"));
  return site;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ES-074 TDD — Domain Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    sessionStorage.setItem("geo-token-site-1", "tok-abc");
  });

  it("hidden when domainVerified=false", () => {
    renderAndGoSetup({ domainVerified: false });
    expect(screen.queryByText(/Add the config below/i)).toBeNull();
  });

  it("visible when domainVerified=true", () => {
    renderAndGoSetup({ domainVerified: true });
    expect(screen.getByText(/Add the config below/i)).toBeTruthy();
  });

  it("renders all 7 platform tabs", () => {
    renderAndGoSetup({ domainVerified: true });
    for (const label of ["Vercel", "Netlify", "Cloudflare", "nginx", "WordPress", "Apache", "Other ✦"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("default tab is Vercel with copper background", () => {
    renderAndGoSetup({ domainVerified: true });
    const tab = screen.getByText("Vercel");
    const btn = tab.closest("button") ?? tab;
    const bg = btn.style.background || btn.style.backgroundColor;
    expect(bg).toMatch(/c2652a|rgb\(194,?\s*101,?\s*42\)/i);
  });

  it("switching to Netlify changes code block content", async () => {
    renderAndGoSetup({ domainVerified: true });
    fireEvent.click(screen.getByText("Netlify"));
    await waitFor(() => {
      const pres = document.querySelectorAll("pre");
      const configPre = Array.from(pres).find(p => p.textContent!.includes("netlify.toml"));
      expect(configPre).toBeTruthy();
    });
  });

  it("step pill badges visible", () => {
    renderAndGoSetup({ domainVerified: true });
    expect(screen.getByText(/1\.\s*Add rewrites config/)).toBeTruthy();
    expect(screen.getByText(/2\.\s*Inject schema in layout/)).toBeTruthy();
    expect(screen.getByText(/3\.\s*Update robots\.txt/)).toBeTruthy();
  });

  it("schema injection is mandatory — no (Optional) in any platform config", () => {
    renderAndGoSetup({ domainVerified: true });
    for (const label of ["Vercel", "Netlify", "Cloudflare", "nginx", "WordPress", "Apache"]) {
      fireEvent.click(screen.getByText(label));
      const pres = document.querySelectorAll("pre");
      const configPre = Array.from(pres).find(p => p.textContent!.includes("Step 3") && p.textContent!.length > 50);
      expect(configPre, `${label} config block should exist`).toBeTruthy();
      expect(configPre!.textContent).not.toContain("(Optional)");
      expect(configPre!.textContent!.toLowerCase()).toContain("mandatory");
    }
  });

  it("copy button copies config text to clipboard", () => {
    renderAndGoSetup({ domainVerified: true });
    // Find all Copy buttons, the integration section one is the last
    const copyBtns = screen.getAllByText(/^Copy$/i);
    const last = copyBtns[copyBtns.length - 1];
    fireEvent.click(last);
    expect(mockClipboard).toHaveBeenCalledTimes(1);
    expect(typeof mockClipboard.mock.calls[0][0]).toBe("string");
    expect(mockClipboard.mock.calls[0][0].length).toBeGreaterThan(10);
  });

  it("template variables contain site.slug", () => {
    renderAndGoSetup({ domainVerified: true, slug: "my-slug" });
    const pres = document.querySelectorAll("pre");
    const configPre = Array.from(pres).find(p => p.textContent!.includes("geo.flowblinq.com"));
    expect(configPre).toBeTruthy();
    expect(configPre!.textContent).toContain("my-slug");
  });

  it("green banner shows domain name", () => {
    renderAndGoSetup({ domainVerified: true, domain: "mysite.io" });
    const matches = screen.getAllByText(/mysite\.io/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/serve your AI files/i)).toBeTruthy();
  });

  it("Other tab: shows input + Generate button", () => {
    renderAndGoSetup({ domainVerified: true });
    fireEvent.click(screen.getByText("Other ✦"));
    expect(screen.getByPlaceholderText(/shopify|caddy|render/i)).toBeTruthy();
    expect(screen.getByText(/^Generate$/)).toBeTruthy();
  });

  it("Other tab: Generate disabled when input empty", () => {
    renderAndGoSetup({ domainVerified: true });
    fireEvent.click(screen.getByText("Other ✦"));
    const btn = screen.getByText(/^Generate$/).closest("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("Other tab: Generate calls API and displays result", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ instructions: "# Shopify steps\n1. Do stuff" }),
    });
    renderAndGoSetup({ domainVerified: true });
    fireEvent.click(screen.getByText("Other ✦"));

    const input = screen.getByPlaceholderText(/shopify|caddy|render/i);
    fireEvent.change(input, { target: { value: "Shopify" } });
    fireEvent.click(screen.getByText(/^Generate$/).closest("button")!);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/integration-instructions",
        expect.objectContaining({ method: "POST" })
      );
      const pre = Array.from(document.querySelectorAll("pre")).find(p => p.textContent!.includes("Shopify steps"));
      expect(pre).toBeTruthy();
    });
  });

  it("Other tab: API error shows error text", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    renderAndGoSetup({ domainVerified: true });
    fireEvent.click(screen.getByText("Other ✦"));

    const input = screen.getByPlaceholderText(/shopify|caddy|render/i);
    fireEvent.change(input, { target: { value: "Caddy" } });
    fireEvent.click(screen.getByText(/^Generate$/).closest("button")!);

    await waitFor(() => {
      expect(screen.getByText(/Failed to generate/i)).toBeTruthy();
    });
  });

  it("Test Connection button is present", () => {
    renderAndGoSetup({ domainVerified: true });
    expect(screen.getByText(/Test Connection/i)).toBeTruthy();
  });

  it("Test Connection calls verify-connection API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ connected: true, detail: "OK" }),
    });
    renderAndGoSetup({ domainVerified: true });
    fireEvent.click(screen.getByText(/Test Connection/i).closest("button")!);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/sites/site-1/verify-connection",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("Test Connection: green dot on success", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("verify-connection")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ connected: true, detail: "llms.txt found" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    renderAndGoSetup({ domainVerified: true });
    fireEvent.click(screen.getByText(/Test Connection/i).closest("button")!);

    await waitFor(() => {
      expect(screen.getByText(/llms\.txt found/)).toBeTruthy();
    });
  });

  it("Test Connection: red dot on failure", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("verify-connection")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ connected: false, detail: "404 not found" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    renderAndGoSetup({ domainVerified: true });
    fireEvent.click(screen.getByText(/Test Connection/i).closest("button")!);

    await waitFor(() => {
      expect(screen.getByText(/404 not found/)).toBeTruthy();
    });
  });

  it("Test Connection: shows Testing… while loading", async () => {
    mockFetch.mockReturnValueOnce(new Promise(() => {}));
    renderAndGoSetup({ domainVerified: true });
    fireEvent.click(screen.getByText(/Test Connection/i).closest("button")!);

    await waitFor(() => {
      const btn = screen.getByText(/Testing…/i).closest("button")!;
      expect(btn.disabled).toBe(true);
    });
  });

  it("Other tab: shows Generating… while loading", async () => {
    mockFetch.mockReturnValueOnce(new Promise(() => {}));
    renderAndGoSetup({ domainVerified: true });
    fireEvent.click(screen.getByText("Other ✦"));

    const input = screen.getByPlaceholderText(/shopify|caddy|render/i);
    fireEvent.change(input, { target: { value: "X" } });
    fireEvent.click(screen.getByText(/^Generate$/).closest("button")!);

    await waitFor(() => {
      const btn = screen.getByText(/^Generating…$/).closest("button")!;
      expect(btn.disabled).toBe(true);
    });
  });

  it("platform tab bar has overflow-x auto", () => {
    renderAndGoSetup({ domainVerified: true });
    const vercelTab = screen.getByText("Vercel");
    let el = vercelTab.closest("div");
    while (el && !el.style.overflowX?.includes("auto")) el = el.parentElement;
    expect(el).toBeTruthy();
  });
});
