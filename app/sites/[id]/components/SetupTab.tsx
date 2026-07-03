"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import {
  COPPER,
  CARD,
  BORDER,
  GREEN,
  RED,
  TEXT,
  T2,
  T3,
} from "../design-tokens";
import type { SiteActions } from "../hooks/useSiteActions";
import type { getIntegrationConfigs } from "../integration-configs";
import type { SiteData } from "../types";

const AI_FILES = [
  { label: "llms.txt",      field: "generatedLlmsTxt",      slug: "llms" },
  { label: "llms-full.txt", field: "generatedLlmsFullTxt",  slug: "llms-full" },
  { label: "business.json", field: "generatedBusinessJson", slug: "business" },
  { label: "schema.json",   field: "generatedSchemaBlocks", slug: "schema" },
  { label: "urls.txt",      field: null,                    slug: "urls" },
];

interface SetupTabProps {
  site: SiteData | null;
  siteId: string;
  token: string | null;
  actions: SiteActions;
  setSite: React.Dispatch<React.SetStateAction<SiteData | null>>;
  integrationConfigs: ReturnType<typeof getIntegrationConfigs>;
  isMobile: boolean;
}

export default function SetupTab({
  site,
  siteId,
  token,
  actions,
  setSite,
  integrationConfigs,
}: SetupTabProps) {
  const router = useRouter();
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  type IntegrationTabKey = "vercel" | "netlify" | "cloudflare" | "nginx" | "wordpress" | "apache" | "other";
  const [integrationTab, setIntegrationTab] = useState<IntegrationTabKey>("vercel");

  const {
    otherPlatform,
    otherConfig,
    otherLoading,
    otherError,
    setOtherPlatform,
    handleOtherPlatform,
    handleTestConnection,
    testingConnection,
    connectionResult,
  } = actions;

  return (
    <div data-testid="setup-tab">
      {/* AI Files section */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>AI Files</h3>
        {site?.domainVerified && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, marginBottom: 16 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: GREEN, flexShrink: 0, display: "inline-block" }} />
            Domain verified
          </div>
        )}
        {AI_FILES.map(f => {
          const raw = f.field ? (site as unknown as Record<string, unknown>)?.[f.field] : null;
          const hasContent = f.field ? !!raw : true; // urls.txt always available
          const isOpen = expandedFiles.has(f.slug);
          const text = raw ? (typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)) : null;
          return (
            <div key={f.slug} style={{ background: CARD, borderRadius: 10, border: `1px solid ${isOpen ? "rgba(194, 101, 42, 0.35)" : BORDER}`, marginBottom: 6, overflow: "hidden", transition: "all .2s", boxShadow: isOpen ? "0 0 0 1px rgba(194, 101, 42, 0.15), 0 4px 16px rgba(194, 101, 42, 0.12)" : "none" }}>
              <div
                style={{ display: "flex", alignItems: "center", padding: "14px 16px", gap: 12, cursor: hasContent ? "pointer" : "default" }}
                onClick={() => {
                  if (!hasContent) return;
                  const next = new Set(expandedFiles);
                  if (next.has(f.slug)) next.delete(f.slug);
                  else next.add(f.slug);
                  setExpandedFiles(next);
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: hasContent ? COPPER : T3, flex: 1 }}>{f.label}</span>
                {hasContent ? (
                  <>
                    <span style={{ fontSize: 11, color: GREEN, fontWeight: 500 }}>Ready</span>
                    <span style={{ fontSize: 11, color: T3 }}>{isOpen ? "↑" : "↓"}</span>
                  </>
                ) : (
                  <span style={{ fontSize: 11, color: T3 }}>Pending</span>
                )}
              </div>
              {isOpen && text && (
                <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${BORDER}` }}>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "8px 0" }}>
                    <button
                      onClick={() => navigator.clipboard.writeText(text)}
                      style={{ fontSize: 11, padding: "4px 12px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD, cursor: "pointer", fontWeight: 500, fontFamily: "inherit" }}
                    >
                      Copy
                    </button>
                    {site?.slug && (
                      <a
                        href={`/api/serve/${site.slug}/${f.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 11, padding: "4px 12px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD, cursor: "pointer", fontWeight: 500, textDecoration: "none", color: TEXT }}
                      >
                        Open URL
                      </a>
                    )}
                  </div>
                  <pre style={{ background: "#f5f5f7", borderRadius: 8, padding: "12px 16px", fontFamily: "'SF Mono', Monaco, monospace", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: 400, whiteSpace: "pre-wrap", wordBreak: "break-word", color: TEXT, border: `1px solid ${BORDER}`, margin: 0 }}>
                    {text.length > 5000 ? text.slice(0, 5000) + "\n\n… truncated" : text}
                  </pre>
                </div>
              )}
              {isOpen && f.slug === "urls" && (
                <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${BORDER}` }}>
                  <div style={{ fontSize: 12, color: T2, padding: "8px 0", lineHeight: 1.6 }}>
                    Manifest of all AI-readable files for this domain. AI crawlers fetch this URL to discover your files.
                  </div>
                  {site?.slug && (
                    <a
                      href={`/api/serve/${site.slug}/urls.txt`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12, color: COPPER, fontWeight: 500, textDecoration: "none" }}
                    >
                      {`/api/serve/${site.slug}/urls.txt`} ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Domain Verification section */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Domain Verification</h3>
          {site?.domainVerified ? (
            <span style={{ fontSize: 11, fontWeight: 600, color: GREEN, background: "#ecfdf5", border: "1px solid rgba(52,199,89,0.25)", borderRadius: 12, padding: "2px 8px" }}>Verified</span>
          ) : (
            <span style={{ fontSize: 11, fontWeight: 600, color: "#b45309", background: "#fef3e2", border: "1px solid rgba(180,83,9,0.2)", borderRadius: 12, padding: "2px 8px" }}>Not verified</span>
          )}
        </div>
        <p style={{ fontSize: 12, color: T2, margin: "0 0 12px", lineHeight: 1.5 }}>
          Verification enables automatic schema injection, AI file serving, and citation tracking.
        </p>
        {site?.domainVerified ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, marginBottom: 16 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: GREEN, flexShrink: 0, display: "inline-block" }} />
            Your domain is verified
          </div>
        ) : (
          <div style={{ listStyle: "none", padding: 0, margin: 0, counterReset: "step" }}>
            {[
              "Log in to your DNS provider (e.g. Cloudflare, Route 53, GoDaddy).",
              "Add a TXT record for your domain with the value shown below.",
              "Wait up to 24 hours for DNS propagation, then click Verify Domain.",
            ].map((step, i) => (
              <div key={i} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: "1px solid #f0f0f2", fontSize: 13 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T3, background: "#f0f0f2", width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {i + 1}
                </div>
                <span>{step}</span>
              </div>
            ))}
          </div>
        )}
        {!site?.domainVerified && (
          <>
            <div style={{ background: "#f0f0f2", borderRadius: 8, padding: "12px 16px", fontFamily: "'SF Mono', Monaco, monospace", fontSize: 12, marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{site?.verifyToken ?? "Loading..."}</span>
              <button
                onClick={() => { if (site?.verifyToken) navigator.clipboard.writeText(site.verifyToken); }}
                style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD, cursor: "pointer", fontWeight: 500 }}
              >
                Copy
              </button>
            </div>
            <button
              onClick={async () => {
                const res = await fetch(`/api/sites/${siteId}/verify-domain`, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}` },
                });
                const data = await res.json();
                if (data.verified) {
                  setSite((prev) => prev ? { ...prev, domainVerified: true } : prev);
                }
                router.refresh();
              }}
              style={{ background: COPPER, color: "#fff", border: "none", padding: "10px 20px", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", marginTop: 12 }}
            >
              Verify Domain
            </button>
          </>
        )}
      </div>

      {/* Domain Integration section (ES-074) — visible only when domain verified */}
      {site?.domainVerified && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Domain Integration</h3>

          {/* Green banner */}
          <div style={{ background: "#ecfdf5", border: "1px solid rgba(52,199,89,0.25)", borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: TEXT }}>
            Domain verified. Add the config below to serve your AI files.
          </div>

          {/* Platform tab bar */}
          <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 12, paddingBottom: 4 }}>
            {([
              { key: "vercel", label: "Vercel" },
              { key: "netlify", label: "Netlify" },
              { key: "cloudflare", label: "Cloudflare" },
              { key: "nginx", label: "nginx" },
              { key: "wordpress", label: "WordPress" },
              { key: "apache", label: "Apache" },
              { key: "other", label: "Other ✦" },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setIntegrationTab(key)}
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
                {label}
              </button>
            ))}
          </div>

          {/* Step pill badges */}
          {integrationTab !== "other" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {["1. Add rewrites config", "2. Inject schema in layout", "3. Update robots.txt"].map(step => (
                <span key={step} style={{ fontSize: 11, fontWeight: 500, padding: "4px 10px", borderRadius: 12, border: `1px solid ${BORDER}`, background: CARD, color: T2 }}>
                  {step}
                </span>
              ))}
            </div>
          )}

          {/* Code block for standard platforms */}
          {integrationTab !== "other" && (
            <div style={{ position: "relative", marginBottom: 12 }}>
              <button
                onClick={() => navigator.clipboard.writeText(integrationConfigs[integrationTab as Exclude<IntegrationTabKey, "other">])}
                style={{ position: "absolute", top: 8, right: 8, fontSize: 11, padding: "4px 12px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD, cursor: "pointer", fontWeight: 500, fontFamily: "inherit", zIndex: 1 }}
              >
                Copy
              </button>
              <pre role="code" style={{ background: "#f5f5f7", borderRadius: 8, padding: "12px 16px", fontFamily: "'SF Mono', Monaco, monospace", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: 400, whiteSpace: "pre-wrap", wordBreak: "break-word", color: TEXT, border: `1px solid ${BORDER}`, margin: 0 }}>
                {integrationConfigs[integrationTab as Exclude<IntegrationTabKey, "other">]}
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
                  onChange={e => setOtherPlatform(e.target.value)}
                  style={{ flex: 1, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, fontFamily: "inherit", outline: "none" }}
                />
                <button
                  onClick={handleOtherPlatform}
                  disabled={!otherPlatform.trim() || otherLoading}
                  style={{
                    background: !otherPlatform.trim() || otherLoading ? "#e5e5e5" : COPPER,
                    color: !otherPlatform.trim() || otherLoading ? T3 : "#fff",
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
                <div style={{ color: RED, fontSize: 12, marginBottom: 8 }}>{otherError}</div>
              )}
              {otherConfig && (
                <pre style={{ background: "#f5f5f7", borderRadius: 8, padding: "12px 16px", fontFamily: "'SF Mono', Monaco, monospace", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: 400, whiteSpace: "pre-wrap", wordBreak: "break-word", color: TEXT, border: `1px solid ${BORDER}`, margin: 0 }}>
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
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 13 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: connectionResult.connected ? GREEN : RED, flexShrink: 0, display: "inline-block", "--dot-color": connectionResult.connected ? GREEN : RED } as React.CSSProperties} />
                <span style={{ color: connectionResult.connected ? GREEN : RED, fontWeight: 500 }}>
                  {connectionResult.connected ? "Connected" : "Not connected yet"}
                </span>
                <span style={{ color: T2 }}>{connectionResult.detail}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
