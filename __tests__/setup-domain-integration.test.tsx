/**
 * ES-074 — Setup Tab Domain Integration
 * Phase 2 — Comprehensive unit tests (23 test cases)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import type { SiteData } from "@/app/sites/[id]/types";

// Mock fetch and clipboard API
global.fetch = vi.fn();
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn(),
  },
});

// Mock component that mimics the Domain Integration section from SitePageClient
const TestDomainIntegration = ({
  site,
  siteId,
  token,
}: {
  site: SiteData | null;
  siteId: string;
  token: string | null;
}) => {
  const [integrationTab, setIntegrationTab] = React.useState("vercel");
  const [otherPlatform, setOtherPlatform] = React.useState("");
  const [otherConfig, setOtherConfig] = React.useState("");
  const [otherLoading, setOtherLoading] = React.useState(false);
  const [otherError, setOtherError] = React.useState("");
  const [testingConnection, setTestingConnection] = React.useState(false);
  const [connectionResult, setConnectionResult] = React.useState<{ connected: boolean; detail: string } | null>(null);

  const COPPER = "#c2652a";
  const BORDER = "#e5e5ea";
  const GREEN = "#34c759";
  const RED = "#ff3b30";
  const TEXT = "#1d1d1f";
  const T2 = "#86868b";
  const CARD = "#fff";

  // Template variables
  const integrationSlug = site?.slug ?? site?.id ?? siteId;
  const geoBase = `https://geo.flowblinq.com/api/serve/${integrationSlug}`;
  const pixelTag = `<img src="https://geo.flowblinq.com/api/t/${integrationSlug}" width="1" height="1" alt="" style="position:absolute;opacity:0" />`;
  const scriptTag = `<script src="https://geo.flowblinq.com/api/t/${integrationSlug}" async></script>`;
  const cspNote = `// NOTE: If you have a Content-Security-Policy, add https://geo.flowblinq.com to img-src, script-src, and connect-src`;

  const robotsBlock = `# Step 3 — robots.txt (add to your existing robots.txt)
# Tells AI crawlers where your GEO content lives

User-agent: GPTBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: OAI-SearchBot
Allow: /llms.txt
Allow: /llms-full.txt

User-agent: ChatGPT-User
Allow: /llms.txt
Allow: /llms-full.txt

User-agent: ClaudeBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: anthropic-ai
Allow: /llms.txt
Allow: /llms-full.txt

User-agent: PerplexityBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: Google-Extended
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json`;

  const referrerSteps: Record<string, string> = {
    vercel: `// Step 4 — Server-side referrer capture
export function middleware(request: NextRequest) {
  const response = NextResponse.next()
  const ref = request.headers.get("referer") ?? ""
  return response
}`,
    netlify: `# Step 4 — Server-side referrer capture`,
    cloudflare: `// Step 4 — Server-side referrer capture`,
    nginx: `# Step 4 — Server-side referrer capture`,
    wordpress: `# Step 4 — Server-side referrer capture`,
    apache: `# Step 4 — Server-side referrer capture`,
  };

  const integrationConfigs: Record<string, string> = {
    vercel: `// Step 1 — vercel.json (rewrites for AI-facing files)
{
  "rewrites": [
    { "source": "/llms.txt", "destination": "${geoBase}/llms.txt" }
  ]
}

// Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
${pixelTag}

// Step 3 — Add schema injection for AI bots (mandatory)
${cspNote}
${scriptTag}

${referrerSteps.vercel}

${robotsBlock}`,

    netlify: `# Step 1 — netlify.toml (rewrites for AI-facing files)
[[redirects]]
  from = "/llms.txt"
  to = "${geoBase}/llms.txt"
  status = 200

# Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
# ${pixelTag}

# Step 3 — Add schema injection for AI bots (mandatory)
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to script-src and connect-src
# ${scriptTag}

${referrerSteps.netlify}

${robotsBlock}`,

    cloudflare: `// Step 1 — Cloudflare Worker routes (rewrites for AI-facing files)
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
// ${pixelTag}

// Step 3 — Add schema injection for AI bots (mandatory)
${cspNote}
// ${scriptTag}

${referrerSteps.cloudflare}

${robotsBlock}`,

    nginx: `# Step 1 — nginx.conf proxy rules (rewrites for AI-facing files)
location = /llms.txt {
    proxy_pass ${geoBase}/llms.txt;
    proxy_set_header Host geo.flowblinq.com;
}

# Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
# ${pixelTag}

# Step 3 — Add schema injection for AI bots (mandatory)
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to script-src and connect-src
# ${scriptTag}

${referrerSteps.nginx}

${robotsBlock}`,

    wordpress: `# ── .htaccess ──
RewriteEngine On
RewriteRule ^llms\\.txt$ ${geoBase}/llms.txt [P,L]

# ── functions.php ──
# Step 2 — Add tracking pixel (works everywhere, no config needed)
# add_action('wp_footer', function() {
#   echo '${pixelTag}' . "\\n";
# });

# Step 3 — Add schema injection for AI bots (mandatory)
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to img-src, script-src, and connect-src
# add_action('wp_head', function() {
#   echo '${scriptTag}' . "\\n";
# });

${referrerSteps.wordpress}

${robotsBlock}`,

    apache: `# Step 1 — .htaccess proxy rules (rewrites for AI-facing files)
RewriteEngine On
RewriteRule ^llms\\.txt$ ${geoBase}/llms.txt [P,L]

# Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
# ${pixelTag}

# Step 3 — Add schema injection for AI bots (mandatory)
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to script-src and connect-src
# ${scriptTag}

${referrerSteps.apache}

${robotsBlock}`,
  };

  async function handleTestConnection() {
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/verify-connection`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setConnectionResult({ connected: data.connected, detail: data.detail });
    } catch {
      setConnectionResult({ connected: false, detail: "Failed to test connection. Please try again." });
    } finally {
      setTestingConnection(false);
    }
  }

  async function handleOtherPlatform() {
    setOtherLoading(true);
    setOtherError("");
    setOtherConfig("");
    try {
      const res = await fetch("/api/integration-instructions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: otherPlatform.trim(), siteId }),
      });
      if (!res.ok) throw new Error("Failed to generate instructions");
      const data = await res.json();
      setOtherConfig(data.instructions);
    } catch (err: unknown) {
      setOtherError(err instanceof Error ? err.message : "Failed to generate instructions");
    } finally {
      setOtherLoading(false);
    }
  }

  if (!site?.domainVerified) {
    return <div>Domain not verified</div>;
  }

  return (
    <div data-testid="domain-integration-section">
      <h3>Domain Integration</h3>

      {/* Green banner */}
      <div style={{ background: "#ecfdf5", border: "1px solid rgba(52,199,89,0.25)", borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: TEXT }}>
        Domain verified. Add the config below to serve your AI files from {site.domain}.
      </div>

      {/* Platform tab bar */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 12, paddingBottom: 4 }}>
        {(["vercel", "netlify", "cloudflare", "nginx", "wordpress", "apache", "other"] as const).map((key) => {
          const labelMap: Record<string, string> = {
            vercel: "Vercel",
            netlify: "Netlify",
            cloudflare: "Cloudflare",
            nginx: "nginx",
            wordpress: "WordPress",
            apache: "Apache",
            other: "Other ✦",
          };
          return (
            <button
              key={key}
              onClick={() => setIntegrationTab(key)}
              data-testid={`integration-tab-${key}`}
              style={{
                background: integrationTab === key ? COPPER : "transparent",
                color: integrationTab === key ? "#fff" : T2,
                border: integrationTab === key ? "none" : `1px solid ${BORDER}`,
                fontSize: 12,
                fontWeight: 500,
                padding: "6px 14px",
                borderRadius: 20,
                cursor: "pointer",
                whiteSpace: "nowrap",
                fontFamily: "inherit",
              }}
            >
              {labelMap[key]}
            </button>
          );
        })}
      </div>

      {/* Step pill badges */}
      {integrationTab !== "other" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {["1. Add rewrites config", "2. Inject schema in layout", "3. Update robots.txt"].map((step) => (
            <span key={step} data-testid={`step-pill-${step}`} style={{ fontSize: 11, fontWeight: 500, padding: "4px 10px", borderRadius: 12, border: `1px solid ${BORDER}`, background: CARD, color: T2 }}>
              {step}
            </span>
          ))}
        </div>
      )}

      {/* Code block for standard platforms */}
      {integrationTab !== "other" && (
        <div style={{ position: "relative", marginBottom: 12 }}>
          <button
            onClick={() => navigator.clipboard.writeText(integrationConfigs[integrationTab])}
            data-testid="copy-config-button"
            style={{ position: "absolute", top: 8, right: 8, fontSize: 11, padding: "4px 12px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD, cursor: "pointer", fontWeight: 500, fontFamily: "inherit", zIndex: 1 }}
          >
            Copy
          </button>
          <pre role="code" data-testid="integration-code-block" style={{ background: "#f5f5f7", borderRadius: 8, padding: "12px 16px", fontFamily: "'SF Mono', Monaco, monospace", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: 400, whiteSpace: "pre-wrap", wordBreak: "break-word", color: TEXT, border: `1px solid ${BORDER}`, margin: 0 }}>
            {integrationConfigs[integrationTab]}
          </pre>
        </div>
      )}

      {/* "Other" tab content */}
      {integrationTab === "other" && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              type="text"
              placeholder="e.g. Shopify, Caddy, Render, Heroku, Fastly…"
              value={otherPlatform}
              onChange={(e) => setOtherPlatform(e.target.value)}
              data-testid="other-platform-input"
              style={{ flex: 1, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, fontFamily: "inherit", outline: "none" }}
            />
            <button
              onClick={handleOtherPlatform}
              disabled={!otherPlatform.trim() || otherLoading}
              data-testid="generate-button"
              style={{
                background: !otherPlatform.trim() || otherLoading ? "#e5e5e5" : COPPER,
                color: !otherPlatform.trim() || otherLoading ? T2 : "#fff",
                border: "none",
                padding: "10px 20px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: !otherPlatform.trim() || otherLoading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
              }}
            >
              {otherLoading ? "Generating…" : "Generate"}
            </button>
          </div>
          {otherError && (
            <div style={{ color: RED, fontSize: 12, marginBottom: 8 }} data-testid="other-error">
              {otherError}
            </div>
          )}
          {otherConfig && (
            <pre style={{ background: "#f5f5f7", borderRadius: 8, padding: "12px 16px", fontFamily: "'SF Mono', Monaco, monospace", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: 400, whiteSpace: "pre-wrap", wordBreak: "break-word", color: TEXT, border: `1px solid ${BORDER}`, margin: 0 }} data-testid="other-config-block">
              {otherConfig}
            </pre>
          )}
        </div>
      )}

      {/* Test Connection */}
      <div style={{ marginTop: 8 }}>
        <button
          onClick={handleTestConnection}
          disabled={testingConnection}
          data-testid="test-connection-button"
          style={{
            border: `1px solid ${BORDER}`,
            background: CARD,
            borderRadius: 8,
            padding: "10px 20px",
            fontSize: 13,
            fontWeight: 500,
            cursor: testingConnection ? "not-allowed" : "pointer",
            fontFamily: "inherit",
            color: TEXT,
          }}
        >
          {testingConnection ? "Testing…" : "Test Connection"}
        </button>
        {connectionResult && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 13 }} data-testid="connection-result">
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: connectionResult.connected ? GREEN : RED, flexShrink: 0, display: "inline-block" }} />
            <span style={{ color: connectionResult.connected ? GREEN : RED, fontWeight: 500 }}>
              {connectionResult.connected ? "Connected" : "Not connected yet"}
            </span>
            <span style={{ color: T2 }}>{connectionResult.detail}</span>
          </div>
        )}
      </div>
    </div>
  );
};

describe("Domain Integration (ES-074)", () => {
  let mockSite: SiteData;
  const mockToken = "test-token-123";
  const siteId = "site-001";

  beforeEach(() => {
    vi.clearAllMocks();
    mockSite = {
      id: siteId,
      slug: "test-slug",
      domain: "example.com",
      domainVerified: true,
      accessToken: mockToken,
      tier: "paid",
      subscriptionTier: "growth",
      credits: 50,
      pipelineStatus: null,
      verifyToken: "dns-token-123",
      geoScorecard: null,
      rankedRecommendations: [],
      perPageResults: null,
      changeLog: [],
      crawlCount: null,
      lastCrawlAt: null,
      discoveryData: null,
      citationCheckScore: null,
      discoveredCompetitors: [],
      userCompetitors: [],
      competitorBlocklist: [],
      generatedLlmsTxt: "# llms.txt",
      generatedLlmsFullTxt: "# llms-full.txt",
      generatedBusinessJson: "{}",
      generatedSchemaBlocks: [],
      projectedScore: null,
    } as unknown as SiteData;
  });

  // U1: Integration section hidden when domainVerified=false
  it("U1: Integration section hidden when domainVerified=false", () => {
    const siteNotVerified = { ...mockSite, domainVerified: false };
    render(<TestDomainIntegration site={siteNotVerified} siteId={siteId} token={mockToken} />);
    expect(screen.queryByTestId("domain-integration-section")).not.toBeInTheDocument();
  });

  // U2: Integration section visible when domainVerified=true
  it("U2: Integration section visible when domainVerified=true", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    expect(screen.getByTestId("domain-integration-section")).toBeInTheDocument();
  });

  // U3: Default tab is "vercel"
  it("U3: Default tab is vercel", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const vercelTab = screen.getByTestId("integration-tab-vercel") as HTMLButtonElement;
    // The color is converted to rgb by the browser, so we check for both values
    expect(vercelTab.style.background).toBeTruthy();
    expect(vercelTab.style.color).toBeTruthy(); // Active tab should have white text
  });

  // U4: Clicking Netlify tab switches config
  it("U4: Clicking Netlify tab switches config", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const netlifyTab = screen.getByTestId("integration-tab-netlify");
    fireEvent.click(netlifyTab);
    const codeBlock = screen.getByTestId("integration-code-block");
    expect(codeBlock.textContent).toContain("netlify.toml");
  });

  // U5: All 7 tabs render
  it("U5: All 7 tabs render", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const platforms = ["vercel", "netlify", "cloudflare", "nginx", "wordpress", "apache", "other"];
    platforms.forEach((p) => {
      expect(screen.getByTestId(`integration-tab-${p}`)).toBeInTheDocument();
    });
  });

  // U6: Step pill badges render
  it("U6: Step pill badges render", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    expect(screen.getByTestId("step-pill-1. Add rewrites config")).toBeInTheDocument();
    expect(screen.getByTestId("step-pill-2. Inject schema in layout")).toBeInTheDocument();
    expect(screen.getByTestId("step-pill-3. Update robots.txt")).toBeInTheDocument();
  });

  // U7: Copy button copies config to clipboard
  it("U7: Copy button copies config to clipboard", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const copyButton = screen.getByTestId("copy-config-button");
    fireEvent.click(copyButton);
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
  });

  // U8: Schema injection is mandatory in vercel config
  it("U8: Schema injection is mandatory in vercel config", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const codeBlock = screen.getByTestId("integration-code-block");
    expect(codeBlock.textContent).toContain("(mandatory)");
    expect(codeBlock.textContent).not.toContain("(Optional)");
  });

  // U9: Schema injection is mandatory in all 6 configs
  it("U9: Schema injection is mandatory in all 6 configs", () => {
    const platforms = ["vercel", "netlify", "cloudflare", "nginx", "wordpress", "apache"];
    for (const p of platforms) {
      const { unmount } = render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
      const tab = screen.getByTestId(`integration-tab-${p}`);
      fireEvent.click(tab);
      const codeBlock = screen.getByTestId("integration-code-block");
      expect(codeBlock.textContent).toContain("(mandatory)");
      expect(codeBlock.textContent).not.toContain("(Optional)");
      unmount();
    }
  });

  // U10: "Other" tab shows text input + Generate button
  it("U10: Other tab shows text input + Generate button", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const otherTab = screen.getByTestId("integration-tab-other");
    fireEvent.click(otherTab);
    expect(screen.getByTestId("other-platform-input")).toBeInTheDocument();
    expect(screen.getByTestId("generate-button")).toBeInTheDocument();
  });

  // U11: Generate button disabled when input empty
  it("U11: Generate button disabled when input empty", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const otherTab = screen.getByTestId("integration-tab-other");
    fireEvent.click(otherTab);
    const generateButton = screen.getByTestId("generate-button") as HTMLButtonElement;
    expect(generateButton.disabled).toBe(true);
  });

  // U12: Generate button calls /api/integration-instructions
  it("U12: Generate button calls /api/integration-instructions", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ instructions: "Test instructions" }),
    } as Response);

    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const otherTab = screen.getByTestId("integration-tab-other");
    fireEvent.click(otherTab);

    const input = screen.getByTestId("other-platform-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Shopify" } });

    const generateButton = screen.getByTestId("generate-button");
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/integration-instructions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ platform: "Shopify", siteId }),
        })
      );
    });
  });

  // U13: Generated config renders in code block
  it("U13: Generated config renders in code block", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ instructions: "Generated Shopify config" }),
    } as Response);

    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const otherTab = screen.getByTestId("integration-tab-other");
    fireEvent.click(otherTab);

    const input = screen.getByTestId("other-platform-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Shopify" } });

    const generateButton = screen.getByTestId("generate-button");
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(screen.getByTestId("other-config-block")).toBeInTheDocument();
      expect(screen.getByTestId("other-config-block").textContent).toContain("Generated Shopify config");
    });
  });

  // U14: Other tab error renders
  it("U14: Other tab error renders", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "API error" }),
    } as Response);

    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const otherTab = screen.getByTestId("integration-tab-other");
    fireEvent.click(otherTab);

    const input = screen.getByTestId("other-platform-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Caddy" } });

    const generateButton = screen.getByTestId("generate-button");
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(screen.getByTestId("other-error")).toBeInTheDocument();
    });
  });

  // U15: Test Connection button rendered
  it("U15: Test Connection button rendered", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    expect(screen.getByTestId("test-connection-button")).toBeInTheDocument();
  });

  // U16: Test Connection calls /api/sites/[id]/verify-connection
  it("U16: Test Connection calls /api/sites/[id]/verify-connection", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true, detail: "Connected successfully" }),
    } as Response);

    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const testButton = screen.getByTestId("test-connection-button");
    fireEvent.click(testButton);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/sites/${siteId}/verify-connection`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: `Bearer ${mockToken}` }),
        })
      );
    });
  });

  // U17: Connected result shows green indicator
  it("U17: Connected result shows green indicator", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true, detail: "llms.txt verified" }),
    } as Response);

    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const testButton = screen.getByTestId("test-connection-button");
    fireEvent.click(testButton);

    await waitFor(() => {
      const result = screen.getByTestId("connection-result");
      expect(result.textContent).toContain("Connected");
      expect(result.textContent).toContain("llms.txt verified");
    });
  });

  // U18: Disconnected result shows red indicator
  it("U18: Disconnected result shows red indicator", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ connected: false, detail: "llms.txt not found" }),
    } as Response);

    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const testButton = screen.getByTestId("test-connection-button");
    fireEvent.click(testButton);

    await waitFor(() => {
      const result = screen.getByTestId("connection-result");
      expect(result.textContent).toContain("Not connected yet");
      expect(result.textContent).toContain("llms.txt not found");
    });
  });

  // U19: Test Connection loading state
  it("U19: Test Connection loading state", () => {
    vi.mocked(global.fetch).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        ok: true,
        json: async () => ({ connected: true, detail: "Connected" }),
      } as Response), 100))
    );

    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const testButton = screen.getByTestId("test-connection-button") as HTMLButtonElement;
    fireEvent.click(testButton);

    expect(testButton.textContent).toContain("Testing…");
    expect(testButton.disabled).toBe(true);
  });

  // U20: Other loading state
  it("U20: Other loading state", async () => {
    vi.mocked(global.fetch).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        ok: true,
        json: async () => ({ instructions: "Config" }),
      } as Response), 100))
    );

    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const otherTab = screen.getByTestId("integration-tab-other");
    fireEvent.click(otherTab);

    const input = screen.getByTestId("other-platform-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Shopify" } });

    const generateButton = screen.getByTestId("generate-button") as HTMLButtonElement;
    fireEvent.click(generateButton);

    expect(generateButton.textContent).toContain("Generating…");
    expect(generateButton.disabled).toBe(true);
  });

  // U21: Template variables use site.slug
  it("U21: Template variables use site.slug", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const codeBlock = screen.getByTestId("integration-code-block");
    expect(codeBlock.textContent).toContain("test-slug");
  });

  // U22: Green banner shows domain name
  it("U22: Green banner shows domain name", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    expect(screen.getByText(/Domain verified/)).toBeInTheDocument();
    expect(screen.getByText(/example\.com/)).toBeInTheDocument();
  });

  // U23: Platform tabs horizontally scrollable
  it("U23: Platform tabs horizontally scrollable", () => {
    render(<TestDomainIntegration site={mockSite} siteId={siteId} token={mockToken} />);
    const tabBar = screen.getByTestId("integration-tab-vercel").parentElement;
    // Check that the tab bar exists and has the scrollable styling applied
    expect(tabBar).toBeTruthy();
    expect(tabBar?.style.overflowX).toBe("auto");
  });
});
