"use client";

import React, { useState } from "react";
import {
  CARD,
  BORDER,
  TEXT,
  T2,
  T3,
  COPPER,
  GREEN,
  ORANGE,
  RED,
} from "../design-tokens";
import type { SiteDerivedData } from "../hooks/useSiteData";
import type { SiteData } from "../types";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PagesTabProps {
  data: SiteDerivedData;
  site: SiteData | null;
  isMobile: boolean;
  onDownloadZip: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanTitle(title: string): string {
  return title.replace(/^[A-Z0-9]{2,10}\s*[-–—|:]\s*/i, "").trim() || title;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PagesTab({ data, site, onDownloadZip }: PagesTabProps) {
  const [pageFilter, setPageFilter] = useState<"All" | "good" | "needs-work" | "poor">("All");
  const [pageSearch, setPageSearch] = useState("");
  const [pageCursor, setPageCursor] = useState(0);
  const [expandedPageUrls, setExpandedPageUrls] = useState<Set<string>>(new Set());
  const PAGE_SIZE = 25;

  const filteredPages = data.sortedPages.filter(p => {
    const matchSearch =
      p.url.toLowerCase().includes(pageSearch.toLowerCase()) ||
      (p.title ?? "").toLowerCase().includes(pageSearch.toLowerCase());
    const matchFilter = pageFilter === "All" || p.overallPageHealth === pageFilter;
    return matchSearch && matchFilter;
  });
  const pagedRows = filteredPages.slice(pageCursor, pageCursor + PAGE_SIZE);

  const allPages = data.allPages;

  return (
    <div data-testid="pages-tab">
      {site?.perPageResults == null ? (
        <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: T2 }}>Upgrade to see per-page analysis.</div>
      ) : (
        <>
          {/* Download bar */}
          <button
            onClick={onDownloadZip}
            style={{
              display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", marginBottom: 16,
              background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8,
              boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)",
              textDecoration: "none", transition: "border-color 0.15s", cursor: "pointer", width: "100%", fontFamily: "inherit", textAlign: "left",
            }}
          >
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "#e3f2fd", color: "#1565c0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Download full fix report</div>
              <div style={{ fontSize: 11, color: T2 }}>
                Per-page vulnerabilities, suggested fixes, schema blocks, and zone recommendations
              </div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: COPPER, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}>
              Download ZIP ↓
            </span>
          </button>

          {/* Pages card */}
          <div style={{ background: CARD, borderRadius: 12, border: `1px solid ${BORDER}`, boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", overflow: "hidden" }}>
            {/* Card header: summary strip + controls */}
            <div style={{ padding: "16px 20px 0" }}>
              {/* Health summary bar */}
              {(() => {
                const goodCount = allPages.filter(p => p.overallPageHealth === "good").length;
                const needsCount = allPages.filter(p => p.overallPageHealth === "needs-work").length;
                const poorCount = allPages.filter(p => p.overallPageHealth === "poor").length;
                const total = allPages.length;
                const totalVulns = allPages.reduce((s, p) => s + (p.vulnerabilities?.length ?? 0), 0);
                return (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{total} pages</span>
                      <span style={{ fontSize: 12, color: T2 }}>{totalVulns} vulnerabilities</span>
                    </div>
                    {/* Proportional health bar */}
                    <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "#f0f0f2" }}>
                      {goodCount > 0 && <div style={{ width: `${(goodCount / total) * 100}%`, background: GREEN, transition: "width .3s" }} />}
                      {needsCount > 0 && <div style={{ width: `${(needsCount / total) * 100}%`, background: ORANGE, transition: "width .3s" }} />}
                      {poorCount > 0 && <div style={{ width: `${(poorCount / total) * 100}%`, background: RED, transition: "width .3s" }} />}
                    </div>
                    {/* Legend */}
                    <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
                      {goodCount > 0 && <span style={{ fontSize: 11, color: T2, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: GREEN, flexShrink: 0 }} />{goodCount} Good</span>}
                      {needsCount > 0 && <span style={{ fontSize: 11, color: T2, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: ORANGE, flexShrink: 0 }} />{needsCount} Needs Work</span>}
                      {poorCount > 0 && <span style={{ fontSize: 11, color: T2, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: RED, flexShrink: 0 }} />{poorCount} Poor</span>}
                    </div>
                  </div>
                );
              })()}

              {/* Controls row */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", paddingBottom: 12, borderBottom: `1px solid ${BORDER}` }}>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["All", "good", "needs-work", "poor"] as const).map(f => {
                    const label = f === "All" ? "All" : f === "needs-work" ? "Needs Work" : f.charAt(0).toUpperCase() + f.slice(1);
                    const count = f === "All" ? allPages.length : allPages.filter(p => p.overallPageHealth === f).length;
                    if (f !== "All" && count === 0) return null;
                    return (
                      <button
                        key={f}
                        onClick={() => { setPageFilter(f); setPageCursor(0); }}
                        style={{
                          fontSize: 12, padding: "4px 12px", borderRadius: 6,
                          border: `1px solid ${pageFilter === f ? COPPER : BORDER}`,
                          background: pageFilter === f ? COPPER : "transparent",
                          color: pageFilter === f ? "#fff" : TEXT,
                          cursor: "pointer", fontWeight: 500,
                        }}
                      >
                        {f === "All" ? label : `${label} (${count})`}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  placeholder="Search pages..."
                  value={pageSearch}
                  onChange={e => { setPageSearch(e.target.value); setPageCursor(0); }}
                  style={{ width: 240, padding: "6px 12px", fontSize: 13, border: `1px solid ${BORDER}`, borderRadius: 8, outline: "none", background: "transparent" }}
                />
              </div>
            </div>

            {/* Page rows */}
            <div>
              {pagedRows.map((p, i) => {
                const health = p.overallPageHealth;
                const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
                const vulns = (p.vulnerabilities ?? [])
                  .filter(v => !v.finding.startsWith("Flagged by site-level GEO analysis"))
                  .sort((a, b) => (sevOrder[a.severity] ?? 4) - (sevOrder[b.severity] ?? 4));
                const fixCount = vulns.length;
                const critOnlyCount = vulns.filter(v => v.severity === "critical").length;
                const highCount = vulns.filter(v => v.severity === "high").length;
                const critCount = critOnlyCount + highCount;
                const medCount = vulns.filter(v => v.severity === "medium").length;
                const lowCount = fixCount - critCount - medCount;
                const healthDot = health === "good" ? GREEN : health === "needs-work" ? ORANGE : RED;
                const healthLabel = health === "good" ? "Good" : health === "needs-work" ? "Needs Work" : "Poor";
                const urlPath = (() => {
                  try {
                    const u = new URL(p.url);
                    return u.pathname === "/" ? u.hostname + "/" : u.pathname;
                  } catch { return p.url; }
                })();
                const isExpanded = expandedPageUrls.has(p.url);
                const pageTypeLabel = p.pageType ? p.pageType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : null;
                const sevColor = (s: string) => s === "critical" || s === "high" ? RED : s === "medium" ? ORANGE : "#b0b0b8";
                const sevLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
                const pillarLabel = (name: string) => name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
                return (
                  <div
                    key={p.url + i}
                    data-testid="page-row"
                    data-status={health}
                    style={{ borderBottom: i < pagedRows.length - 1 ? `1px solid #f5f5f7` : "none" }}
                  >
                    {/* Summary row — clickable */}
                    <div
                      onClick={() => setExpandedPageUrls(prev => {
                        const next = new Set(prev);
                        isExpanded ? next.delete(p.url) : next.add(p.url);
                        return next;
                      })}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", cursor: fixCount > 0 ? "pointer" : "default" }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: healthDot, flexShrink: 0, marginTop: 1 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                          {p.title && <span style={{ fontSize: 13, fontWeight: 600, color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cleanTitle(p.title)}</span>}
                          {pageTypeLabel && <span style={{ fontSize: 10, fontWeight: 700, color: "#b45309", background: "#fef3e2", padding: "1px 6px", borderRadius: 4, flexShrink: 0, textTransform: "uppercase", letterSpacing: ".4px" }}>{pageTypeLabel}</span>}
                        </div>
                        <div style={{ fontSize: 11, color: T3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{urlPath}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        {fixCount > 0 ? (
                          <>
                            <div style={{ display: "flex", height: 8, width: 80, borderRadius: 4, overflow: "hidden", background: "#f0f0f2" }}>
                              {critCount > 0 && <div style={{ width: `${(critCount / fixCount) * 100}%`, background: RED }} />}
                              {medCount > 0 && <div style={{ width: `${(medCount / fixCount) * 100}%`, background: ORANGE }} />}
                              {lowCount > 0 && <div style={{ width: `${(lowCount / fixCount) * 100}%`, background: "#e6b800" }} />}
                            </div>
                            <span style={{ fontSize: 10, color: T2, whiteSpace: "nowrap" }}>
                              {[
                                critOnlyCount > 0 ? `${critOnlyCount} crit` : null,
                                highCount > 0 ? `${highCount} high` : null,
                                medCount > 0 ? `${medCount} med` : null,
                                lowCount > 0 ? `${lowCount} low` : null,
                              ].filter(Boolean).join(", ")}
                            </span>
                            <span style={{ fontSize: 11, color: T3 }}>{isExpanded ? "▲" : "▼"}</span>
                          </>
                        ) : (
                          <span style={{ fontSize: 11, color: GREEN, fontWeight: 600 }}>{healthLabel}</span>
                        )}
                      </div>
                    </div>
                    {/* Expanded vulnerability list */}
                    {isExpanded && fixCount > 0 && (
                      <div style={{ background: "#f9f9fb", borderTop: `1px solid #f0f0f2`, padding: "14px 20px 16px" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
                          {vulns.map((v, vi) => (
                            <div key={vi} style={{ background: "#fff", border: `1px solid #ebebef`, borderLeft: `3px solid ${sevColor(v.severity)}`, borderRadius: 8, padding: "10px 12px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: sevColor(v.severity), textTransform: "uppercase", letterSpacing: ".4px" }}>{sevLabel(v.severity)}</span>
                                <span style={{ fontSize: 10, color: T3 }}>·</span>
                                <span style={{ fontSize: 11, fontWeight: 600, color: T2 }}>{pillarLabel(v.pillarName)}</span>
                              </div>
                              <div style={{ fontSize: 12, color: TEXT, marginBottom: 6, lineHeight: 1.4 }}>{v.finding}</div>
                              {v.pillar === "structured_data" && site?.domainVerified ? (
                                <div style={{ fontSize: 12, color: GREEN, display: "flex", gap: 4, lineHeight: 1.4, fontWeight: 500 }}>
                                  <span style={{ flexShrink: 0 }}>✓</span>
                                  <span>Your GEO integration is active — JSON-LD schema is automatically injected on this page.</span>
                                </div>
                              ) : v.pillar === "structured_data" && !site?.domainVerified ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  <div style={{ fontSize: 12, color: COPPER, display: "flex", gap: 4, lineHeight: 1.4 }}>
                                    <span style={{ flexShrink: 0 }}>→</span>
                                    <span>{v.recommendation}</span>
                                  </div>
                                  <div style={{ fontSize: 11, color: T2, lineHeight: 1.4 }}>
                                    Or complete the setup tab — GEO will inject schema automatically once your integration is verified.
                                  </div>
                                </div>
                              ) : (
                                <div style={{ fontSize: 12, color: COPPER, display: "flex", gap: 4, lineHeight: 1.4 }}>
                                  <span style={{ flexShrink: 0 }}>→</span>
                                  <span>{v.recommendation}</span>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pagination inside card */}
            {filteredPages.length > PAGE_SIZE && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", padding: "12px 20px", borderTop: `1px solid ${BORDER}` }}>
                <button
                  onClick={() => setPageCursor(Math.max(0, pageCursor - PAGE_SIZE))}
                  disabled={pageCursor === 0}
                  style={{
                    fontSize: 12, padding: "4px 12px", borderRadius: 6,
                    border: `1px solid ${BORDER}`, background: "transparent", color: TEXT,
                    cursor: pageCursor === 0 ? "not-allowed" : "pointer",
                    opacity: pageCursor === 0 ? 0.4 : 1, fontWeight: 500,
                  }}
                >
                  ← Prev
                </button>
                <span style={{ fontSize: 12, color: T2, fontVariantNumeric: "tabular-nums" }}>
                  {pageCursor + 1}–{Math.min(pageCursor + PAGE_SIZE, filteredPages.length)} of {filteredPages.length}
                </span>
                <button
                  onClick={() => setPageCursor(pageCursor + PAGE_SIZE)}
                  disabled={pageCursor + PAGE_SIZE >= filteredPages.length}
                  style={{
                    fontSize: 12, padding: "4px 12px", borderRadius: 6,
                    border: `1px solid ${BORDER}`, background: "transparent", color: TEXT,
                    cursor: pageCursor + PAGE_SIZE >= filteredPages.length ? "not-allowed" : "pointer",
                    opacity: pageCursor + PAGE_SIZE >= filteredPages.length ? 0.4 : 1, fontWeight: 500,
                  }}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
