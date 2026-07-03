"use client";

import React, { useState } from "react";
import {
  COPPER,
  BG,
  CARD,
  BORDER,
  GREEN,
  ORANGE,
  RED,
  TEXT,
  T2,
  T3,
  scoreColor,
  formatDate,
} from "../design-tokens";
import type { SiteDerivedData } from "../hooks/useSiteData";
import type { SiteActions } from "../hooks/useSiteActions";
import type { SiteData } from "../types";
import type { CitationCheckScore } from "@/lib/db/schema";
import HeroMetrics from "./HeroMetrics";

interface OverviewTabProps {
  data: SiteDerivedData;
  actions: SiteActions;
  isMobile: boolean;
  site: SiteData | null;
  lastCitationCheck: CitationCheckScore | null;
  effectiveCompetitors: Array<{ name: string; domain?: string; source: "user" | "discovered" }>;
  slotsRemaining: number;
  setActiveTab: (tab: string) => void;
  setShowUpgradeModal: (show: boolean) => void;
}

// ── Shared Buyer Intent + Top Recommendations card ────────────────────────────
function RecsCard({
  tierVisibility,
  recs,
  setActiveTab,
  cardStyle,
}: {
  tierVisibility: SiteDerivedData["tierVisibility"];
  recs: SiteDerivedData["recs"];
  setActiveTab: (tab: string) => void;
  cardStyle: React.CSSProperties;
}) {
  return (
    <div style={cardStyle}>
      {tierVisibility.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 14 }}>Buyer Intent Coverage</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 8 }}>
            {tierVisibility.map(t => (
              <div key={t.tier} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 11, color: T2, fontWeight: 500 }}>{t.tier.charAt(0).toUpperCase() + t.tier.slice(1)}</div>
                <div style={{ fontSize: 20, fontWeight: 700, margin: "2px 0", color: scoreColor(t.visibility) }}>{t.visibility}%</div>
                <div style={{ fontSize: 10, color: T3 }}>{t.mentionCount}/{t.promptCount} prompts</div>
              </div>
            ))}
          </div>
          <div style={{ height: 16 }} />
        </>
      )}
      <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 14 }}>Top Recommendations</div>
      {recs.length > 0 ? (
        <>
          {recs.slice(0, 4).map((r, i) => {
            const pStyle = ["critical"].includes(r.priority)
              ? { background: "#fef2f2", color: RED }
              : ["HIGH", "high"].includes(r.priority)
              ? { background: "#fff3e0", color: "#e65100" }
              : ["MED", "med", "medium"].includes(r.priority)
              ? { background: "#fffde7", color: "#f57f17" }
              : { background: "#f0f0f2", color: T2 };
            const effortMap: Record<string, string> = { low: "30 min", medium: "1–2 hrs", high: "half day" };
            const timeStr = r.effort ? (effortMap[r.effort] ?? r.effort) : null;
            return (
              <div key={r.title} style={{ display: "flex", alignItems: "center", padding: "10px 0", borderBottom: i < Math.min(recs.length, 4) - 1 ? "1px solid #f0f0f2" : "none", gap: 12 }}>
                <div style={{ width: 18, height: 18, border: `2px solid ${BORDER}`, borderRadius: "50%", flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: T3, width: 20, textAlign: "center", flexShrink: 0 }}>{i + 1}</span>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, flexShrink: 0, width: 48, textAlign: "center", ...pStyle }}>
                  {r.priority === "critical" ? "CRIT" : r.priority === "medium" ? "MED" : (r.priority ?? "low").toUpperCase()}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{r.title}</span>
                {timeStr && <span style={{ fontSize: 11, color: T2, flexShrink: 0 }}>{timeStr}</span>}
              </div>
            );
          })}
          <div style={{ fontSize: 11, color: COPPER, marginTop: 10, cursor: "pointer" }} onClick={() => setActiveTab("recommendations")}>
            View all {recs.length} recommendations →
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: T2 }}>Run a GEO audit to see recommendations.</div>
      )}
    </div>
  );
}

// ── Inline section header (C4 / F-05) ────────────────────────────────────────
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 16, marginTop: 32 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, color: TEXT, margin: 0 }}>{title}</h2>
      <p style={{ fontSize: 12, color: T2, margin: "4px 0 0" }}>{subtitle}</p>
    </div>
  );
}

export default function OverviewTab({
  data,
  actions,
  isMobile,
  site,
  lastCitationCheck,
  effectiveCompetitors,
  slotsRemaining,
  setActiveTab,
  setShowUpgradeModal,
}: OverviewTabProps) {
  // sovSamplesExpanded now only controls "See all" expansion beyond the default 3 (C1 / F-01)
  const [sovSamplesExpanded, setSovSamplesExpanded] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());

  const lc = lastCitationCheck;
  const {
    liveScore,
    allPages,
    pillars,
    criticalCount,
    recs,
    changeLog,
    pillarVisibility,
    geoVisibility,
    categoryVisibility,
    tierVisibility,
    competitorData,
    hiddenCompetitorCount,
    ourSOV,
    hasSovSamples,
    providerResults,
    pillarDisplayName,
  } = data;

  const {
    citationScanActive,
    competitorScanActive,
    handleRemoveCompetitor,
    addCompetitorName,
    setAddCompetitorName,
    addCompetitorLoading,
    addCompetitorError,
    addCompetitorDomain,
    setAddCompetitorDomain,
    showDomainInput,
    setShowDomainInput,
    handleAddCompetitor,
    handleDownloadZip,
  } = actions;

  const providerResultsWithSamples = providerResults;

  // C13 (F-15): all competitors including 0% ones
  const allVisibleCompetitors = competitorData.slice(0, 4);

  // Empty space fix: single column layout when few critical issues
  const useSingleColumnDiagnosis = !isMobile && criticalCount <= 3;

  // Shared card style
  const cardStyle: React.CSSProperties = {
    background: CARD, borderRadius: 12, padding: "18px 20px",
    boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)",
    border: `1px solid ${BORDER}`,
  };

  return (
    <div>
      {/* ── SECTION 1: Health ──────────────────────────────────────────────── */}
      <SectionHeader
        title="Health"
        subtitle="Your current GEO score and how it has changed over time"
      />

      {/* C18 (F-21): Citation scan skeleton OR normal KPI cards */}
      {citationScanActive ? (
        <div>
          {/* Pulsing skeleton for citation metrics area */}
          <div style={{
            ...cardStyle, marginBottom: 16,
            display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5, 1fr)", gap: 12,
          }}>
            {[...Array(5)].map((_, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{
                  height: 10, borderRadius: 4,
                  background: "linear-gradient(90deg, #f0f0f2 25%, #e5e5ea 50%, #f0f0f2 75%)",
                  backgroundSize: "200% 100%", animation: "shimmer 1.5s ease-in-out infinite",
                  width: "60%",
                }} />
                <div style={{
                  height: 28, borderRadius: 6,
                  background: "linear-gradient(90deg, #f0f0f2 25%, #e5e5ea 50%, #f0f0f2 75%)",
                  backgroundSize: "200% 100%", animation: "shimmer 1.5s ease-in-out infinite",
                }} />
                <div style={{
                  height: 10, borderRadius: 4,
                  background: "linear-gradient(90deg, #f0f0f2 25%, #e5e5ea 50%, #f0f0f2 75%)",
                  backgroundSize: "200% 100%", animation: "shimmer 1.5s ease-in-out infinite",
                  width: "80%",
                }} />
              </div>
            ))}
          </div>
          <div style={{
            background: "linear-gradient(135deg, #fffbf5, #fff7ed)", border: "1px solid #f0e6d9",
            borderRadius: 8, padding: "10px 18px", marginBottom: 12,
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: COPPER, animation: "pulse 1.5s ease-in-out infinite", flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: COPPER }}>Running citation scan…</span>
            <span style={{ fontSize: 11, color: T2 }}>This may take a minute. Results will appear when complete.</span>
          </div>
        </div>
      ) : (
        <HeroMetrics data={data} lastCitationCheck={lastCitationCheck} isMobile={isMobile} setActiveTab={setActiveTab} />
      )}

      {/* Download fix report bar */}
      {allPages.length > 0 && (
        <button
          onClick={handleDownloadZip}
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
            <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Full per-page fix report available</div>
            <div style={{ fontSize: 11, color: T2 }}>
              {allPages.length} pages · {allPages.reduce((s, p) => s + (p.vulnerabilities?.length ?? 0), 0)} vulnerabilities
            </div>
          </div>
          <span style={{ fontSize: 12, fontWeight: 600, color: COPPER, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}>
            Download ZIP ↓
          </span>
        </button>
      )}

      {/* Score History timeline */}
      <div style={{ background: CARD, border: "1px solid rgba(0,0,0,0.06)", borderRadius: 8, padding: "14px 18px", margin: "0 0 16px 0", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: T3, flexShrink: 0, whiteSpace: "nowrap" }}>Score History</span>
        <div style={{ flex: 1, height: 32, position: "relative", display: "flex", alignItems: "center" }}>
          <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: BORDER, transform: "translateY(-50%)" }} />
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "flex-start", width: "100%", position: "relative", padding: "0 8px" }}>
            {changeLog.length > 0 ? changeLog.slice(0, 12).map((entry, i) => (
              <React.Fragment key={entry.runAt}>
                <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", zIndex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: TEXT, marginBottom: 4 }}>{entry.overallScore}</div>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: COPPER, border: "2px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.08)" }} />
                  {!isMobile && <div style={{ fontSize: 10, color: T2, whiteSpace: "nowrap", marginTop: 4 }}>{formatDate(entry.runAt)}</div>}
                </div>
                {i < Math.min(changeLog.length - 1, 11) && <div style={{ flex: 1 }} />}
              </React.Fragment>
            )) : (
              <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", zIndex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: TEXT, marginBottom: 4 }}>{liveScore ?? "—"}</div>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: COPPER, border: "2px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.08)" }} />
                <div style={{ fontSize: 10, color: T2, whiteSpace: "nowrap", marginTop: 4 }}>Now</div>
              </div>
            )}
            {changeLog.length <= 1 && (
              <>
                <div style={{ flex: 1 }} />
                <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", zIndex: 1, opacity: 0.4 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: T3, marginBottom: 4 }}>—</div>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: BORDER, border: "2px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.08)" }} />
                  <div style={{ fontSize: 10, color: T2, whiteSpace: "nowrap", marginTop: 4 }}>Next scan</div>
                </div>
              </>
            )}
          </div>
        </div>
        {changeLog.length <= 1 && (
          <span style={{ fontSize: 11, color: T2, flexShrink: 0, whiteSpace: "nowrap", fontStyle: "italic" }}>Run additional scans to track progress</span>
        )}
      </div>

      {/* ── SECTION 2: Evidence ────────────────────────────────────────────── */}
      <div id="section-evidence" />
      <SectionHeader
        title="Evidence"
        subtitle="What AI platforms actually say about your brand and how visible you are"
      />

      {/* Evidence + SOV side-by-side */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12, marginBottom: 16 }}>

        {/* LEFT: Citation Evidence (high-level summary, expand for full text) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* AI Citation Summary — compact per-provider cards */}
          {hasSovSamples && (
            <div id="section-what-ai-said" style={cardStyle}>
              <div style={{ fontSize: 12, fontWeight: 700, color: TEXT, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 12 }}>
                AI Citation Evidence
              </div>
              {data.providerAggregates.map((pr) => {
                const mentioned = pr.mentionCount;
                const total = pr.totalQueries;
                // Find matching raw provider for samples
                const rawPr = providerResultsWithSamples.find(r => r.provider.toLowerCase().includes(pr.name.toLowerCase()) || pr.name.toLowerCase().includes(r.provider.toLowerCase()));
                if (!rawPr?.samples || rawPr.samples.length === 0) return null;
                const isExpanded = expandedProviders.has(pr.name);
                return (
                  <div key={pr.name} style={{ marginBottom: 10 }}>
                    {/* Compact summary row — table-like alignment */}
                    <div
                      style={{ display: "grid", gridTemplateColumns: "90px 1fr auto", alignItems: "center", gap: 10, cursor: "pointer", padding: "7px 10px", borderRadius: 8, background: isExpanded ? "#f9f9fb" : "transparent", transition: "background .15s" }}
                      onClick={() => setExpandedProviders(prev => {
                        const next = new Set(prev);
                        isExpanded ? next.delete(pr.name) : next.add(pr.name);
                        return next;
                      })}
                    >
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#b45309", background: "#fef3e2", padding: "2px 8px", borderRadius: 4, textTransform: "uppercase", letterSpacing: ".5px", textAlign: "center", whiteSpace: "nowrap" }}>
                        {pr.name}
                      </span>
                      <span style={{ fontSize: 12, color: TEXT, fontWeight: 500 }}>
                        <strong style={{ color: mentioned === total ? GREEN : mentioned > 0 ? COPPER : RED }}>{mentioned}/{total}</strong> <span style={{ color: T2 }}>cited</span>
                      </span>
                      <span style={{ fontSize: 10, color: T3, transition: "transform .15s", transform: isExpanded ? "rotate(180deg)" : "none" }}>▼</span>
                    </div>
                    {/* Expanded: full Q&A transcript */}
                    {isExpanded && (
                      <div style={{ padding: "8px 8px 0", borderLeft: `2px solid ${BORDER}`, marginLeft: 8, marginTop: 4 }}>
                        {rawPr.samples.map((s, i) => (
                          <div key={i} style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 11, color: T2, fontStyle: "italic", marginBottom: 3 }}>
                              &ldquo;{s.question}&rdquo;
                            </div>
                            <div style={{
                              fontSize: 11, color: s.mentioned ? "#22c55e" : TEXT,
                              background: "#f5f5f7", borderRadius: 6, padding: "6px 10px",
                              borderLeft: `3px solid ${s.mentioned ? "#22c55e" : "#e5e7eb"}`,
                              lineHeight: 1.5, maxHeight: 80, overflow: "hidden",
                            }}>
                              {(s.answer ?? "").replace(/\*\*/g, "").slice(0, 200)}{(s.answer ?? "").length > 200 ? "…" : ""}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

        </div>{/* end left column */}

        {/* RIGHT: Share of Voice (C13 / F-15: show 0% competitors) */}
        <div id="section-sov" style={cardStyle}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 14 }}>Share of Voice</div>
          {(() => {
            const allSOV = [
              ...(ourSOV !== null ? [ourSOV] : []),
              ...allVisibleCompetitors.map(c => c.shareOfVoice),
            ];
            const sorted = [...new Set(allSOV)].sort((a, b) => b - a);
            const sovColor = (v: number) => {
              if (sorted.length <= 1) return GREEN;
              const rank = sorted.indexOf(v);
              if (rank === 0) return GREEN;
              if (rank === sorted.length - 1) return RED;
              return ORANGE;
            };
            return (
              <>
                {/* SOV row renderer — shared between "you" and competitors */}
                {[
                  // Your brand row
                  ...(ourSOV !== null ? [{ name: site?.domain ?? "You", shareOfVoice: ourSOV, isYou: true, mentionCount: data.totalMentions, sentiment: null, rankedAbove: 0 }] : []),
                  // Competitor rows
                  ...allVisibleCompetitors.map(c => ({ ...c, isYou: false, mentionCount: (c as unknown as { mentionCount?: number }).mentionCount ?? 0, sentiment: (c as unknown as { sentiment?: string }).sentiment ?? null, rankedAbove: (c as unknown as { rankedAbove?: number }).rankedAbove ?? 0 })),
                ].map((entry, i) => {
                  const isZero = entry.shareOfVoice === 0;
                  const key = `comp-${entry.name}`;
                  const isExp = expandedProviders.has(key);
                  return (
                    <div key={entry.name + i} style={{ marginBottom: 2 }}>
                      <div
                        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "4px 0" }}
                        onClick={() => setExpandedProviders(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; })}
                      >
                        <span style={{ fontSize: 12, minWidth: 80, maxWidth: 120, textAlign: "right", flexShrink: 0, fontWeight: entry.isYou ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isZero ? T3 : TEXT }} title={entry.name}>{entry.name}</span>
                        <div style={{ flex: 1, height: 18, background: "#f0f0f2", borderRadius: 4, overflow: "hidden" }}>
                          {isZero
                            ? <div style={{ width: "100%", height: "100%", borderRadius: 4, background: "#e5e5ea" }} />
                            : <div style={{ width: `${entry.shareOfVoice}%`, height: "100%", borderRadius: 4, background: sovColor(entry.shareOfVoice) }} />}
                        </div>
                        {isZero
                          ? <span style={{ fontSize: 11, fontStyle: "italic", color: T3, width: 56, textAlign: "right", flexShrink: 0 }}>Not cited</span>
                          : <span style={{ fontSize: 12, fontWeight: 600, width: 36, fontVariantNumeric: "tabular-nums" }}>{entry.shareOfVoice}%</span>}
                        <span style={{ fontSize: 10, color: T3, flexShrink: 0, transition: "transform .15s", transform: isExp ? "rotate(180deg)" : "none" }}>&#9660;</span>
                      </div>
                      {isExp && (
                        <div style={{ margin: "4px 0 8px", padding: "10px 14px", background: "#f9f9fb", borderRadius: 8, border: `1px solid ${BORDER}` }}>
                          {entry.isYou ? (
                            /* Your brand: show per-provider breakdown */
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 20px", fontSize: 12 }}>
                              {data.providerAggregates.map(pr => (
                                <div key={pr.name} style={{ display: "flex", justifyContent: "space-between" }}>
                                  <span style={{ color: T2, textTransform: "capitalize" }}>{pr.name}</span>
                                  <span style={{ fontWeight: 600, color: pr.mentionCount > 0 ? GREEN : T3 }}>{pr.mentionCount}/{pr.totalQueries} cited</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            /* Competitor: show stats + search samples for mentions */
                            <div style={{ fontSize: 12 }}>
                              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 6, color: T2 }}>
                                <span>Cited in <strong style={{ color: TEXT }}>{entry.mentionCount}</strong> of {data.totalQueryCount} queries</span>
                                {entry.sentiment && <span>Sentiment: <strong style={{ color: entry.sentiment === "positive" ? GREEN : entry.sentiment === "negative" ? RED : TEXT }}>{entry.sentiment}</strong></span>}
                                {entry.rankedAbove > 0 && <span>You ranked above <strong style={{ color: GREEN }}>{entry.rankedAbove}x</strong></span>}
                              </div>
                              {isZero && <div style={{ fontSize: 11, color: T3, fontStyle: "italic" }}>Not mentioned by any AI provider in test queries</div>}
                              {!isZero && (() => {
                                const compName = entry.name.toLowerCase();
                                const found: Array<{ provider: string; question: string; snippet: string }> = [];
                                for (const pr of providerResultsWithSamples) {
                                  if (!pr.samples) continue;
                                  for (const s of pr.samples) {
                                    const answer = (s.answer ?? "").replace(/\*\*/g, "");
                                    if (answer.toLowerCase().includes(compName)) {
                                      const idx = answer.toLowerCase().indexOf(compName);
                                      const start = Math.max(0, idx - 50);
                                      const end = Math.min(answer.length, idx + compName.length + 120);
                                      found.push({ provider: pr.provider, question: s.question, snippet: (start > 0 ? "..." : "") + answer.slice(start, end).trim() + (end < answer.length ? "..." : "") });
                                    }
                                  }
                                }
                                return found.length > 0 ? (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                                    {found.slice(0, 3).map((f, fi) => (
                                      <div key={fi} style={{ padding: "6px 10px", background: "#fff", borderRadius: 6, borderLeft: `3px solid ${ORANGE}` }}>
                                        <div style={{ fontSize: 10, color: T3, marginBottom: 2 }}><strong style={{ textTransform: "uppercase", letterSpacing: ".3px" }}>{f.provider}</strong> — &ldquo;{f.question}&rdquo;</div>
                                        <div style={{ fontSize: 11, color: T2, lineHeight: 1.4 }}>{f.snippet}</div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div style={{ fontSize: 11, color: T3, fontStyle: "italic", marginTop: 2 }}>Mentioned in AI responses (full text not stored — run a new citation scan for details)</div>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {hiddenCompetitorCount > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.45, marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: T2, width: 100, textAlign: "right" }}>
                        +{hiddenCompetitorCount} more
                      </span>
                      <div style={{ flex: 1, height: 12, background: "#2a2a3a", borderRadius: 4 }}>
                        <div style={{ width: "40%", height: "100%", borderRadius: 4, background: "#3a3a4a" }} />
                      </div>
                      <span style={{ fontSize: 12, width: 36, color: T2 }}>—</span>
                    </div>
                    <button
                      onClick={() => setShowUpgradeModal(true)}
                      style={{
                        fontSize: 11, color: "#b45309", background: "none", border: "none",
                        cursor: "pointer", textDecoration: "underline", padding: 0,
                      }}
                    >
                      Upgrade to see {hiddenCompetitorCount} more competitor{hiddenCompetitorCount !== 1 ? "s" : ""}
                    </button>
                  </div>
                )}
              </>
            );
          })()}
          {competitorData.length === 0 && ourSOV === null && (
            <div style={{ fontSize: 13, color: T2 }}>Run a citation scan to see share of voice.</div>
          )}
        </div>
      </div>

      {/* Citation Visibility by Theme — full width */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 4 }}>Citation Visibility by Theme</div>
        <div style={{ fontSize: 12, color: T2, marginBottom: 14 }}>Topics AI providers associate with your brand</div>
        {Object.keys(pillarVisibility).length > 0
          ? <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "6px 24px" }}>
              {Object.entries(pillarVisibility)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([theme, pct]) => {
                  const barColor = pct === 0 ? T3 : pct < 30 ? RED : pct < 50 ? ORANGE : pct < 70 ? "#e6b800" : GREEN;
                  return (
                    <div key={theme} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 500, width: 110, textAlign: "right", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pillarDisplayName(theme)}</span>
                      <div style={{ flex: 1, height: 14, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                        {pct > 0 && <div style={{ width: `${pct}%`, height: "100%", borderRadius: 3, background: barColor, transition: "width .4s" }} />}
                      </div>
                      {pct === 0
                        ? <span style={{ fontSize: 11, fontStyle: "italic", color: T3, width: 90, textAlign: "right", flexShrink: 0 }}>Not yet detected</span>
                        : <span style={{ fontSize: 12, fontWeight: 600, width: 36, textAlign: "right", flexShrink: 0, color: barColor }}>{pct}%</span>
                      }
                    </div>
                  );
                })}
            </div>
          : <div style={{ fontSize: 13, color: T2 }}>{site?.tier === "free" ? "Upgrade to see how AI models cite your brand" : "Run a citation scan to see visibility by theme."}</div>
        }
      </div>

      {/* ── SECTION 3: Diagnosis ───────────────────────────────────────────── */}
      <SectionHeader
        title="Diagnosis"
        subtitle="Critical issues to fix and what to prioritize next"
      />

      {/* Competitor bar (C18 / F-21: spinner when discovering) */}
      <div style={{ background: CARD, border: "1px solid rgba(0,0,0,0.06)", borderRadius: 8, padding: "12px 18px", margin: "0 0 16px 0", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: T3 }}>Comparing against</span>
          <span style={{ fontSize: 10, fontWeight: 500, color: T2 }}>{effectiveCompetitors.length}/6</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {competitorScanActive ? (
            /* C18: spinner + message when discovering competitors */
            <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", marginTop: 4 }}>
              <svg style={{ animation: "spin 1s linear infinite", flexShrink: 0 }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={COPPER} strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
              <span style={{ fontSize: 13, color: COPPER, fontWeight: 500 }}>Discovering competitors…</span>
              <span style={{ fontSize: 11, color: T2 }}>This may take a moment.</span>
            </div>
          ) : effectiveCompetitors.length > 0 ? effectiveCompetitors.map((c, i) => (
            <span key={c.domain ?? `${c.name}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", background: BG, border: "1px solid rgba(0,0,0,0.06)", borderRadius: 6, fontSize: 12, fontWeight: 500, color: TEXT, maxWidth: 160 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.source === "user" ? "#c2652a" : "#a3a3a3", flexShrink: 0 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
              <button
                onClick={() => handleRemoveCompetitor(c.name)}
                style={{ background: "none", border: "none", cursor: "pointer", color: T3, fontSize: 12, padding: "0 2px", lineHeight: 1 }}
                title="Remove competitor"
              >×</button>
            </span>
          )) : (
            <span style={{ fontSize: 12, color: T2 }}>{site?.tier === "free" ? "Upgrade to map and track your competitors" : "No competitors mapped yet — use Map Competitors in the action rail."}</span>
          )}
        </div>
        {!competitorScanActive && slotsRemaining > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="text"
                value={addCompetitorName}
                onChange={(e) => setAddCompetitorName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddCompetitor()}
                placeholder="Add competitor name…"
                style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(0,0,0,0.08)", fontSize: 12, background: BG, color: TEXT, outline: "none", maxWidth: 200 }}
              />
              <button
                onClick={() => setShowDomainInput(!showDomainInput)}
                title={showDomainInput ? "Hide domain" : "Add domain"}
                style={{ background: "none", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 6, cursor: "pointer", color: showDomainInput ? COPPER : T3, fontSize: 14, padding: "4px 8px", lineHeight: 1 }}
              >{showDomainInput ? "−" : "+"}</button>
              <button
                onClick={handleAddCompetitor}
                disabled={addCompetitorLoading || !addCompetitorName.trim()}
                style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid rgba(0,0,0,0.08)", fontSize: 12, fontWeight: 600, cursor: addCompetitorLoading ? "not-allowed" : "pointer", background: addCompetitorName.trim() ? COPPER : BG, color: addCompetitorName.trim() ? "#fff" : T2 }}
              >{addCompetitorLoading ? "…" : "Add"}</button>
              {addCompetitorError && <span style={{ fontSize: 11, color: "#ef4444" }}>{addCompetitorError}</span>}
            </div>
            {showDomainInput && (
              <input
                type="text"
                value={addCompetitorDomain}
                onChange={(e) => setAddCompetitorDomain(e.target.value)}
                placeholder="domain.com (optional)"
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(0,0,0,0.08)", fontSize: 12, background: BG, color: TEXT, outline: "none", maxWidth: 200 }}
              />
            )}
          </div>
        )}
        {!competitorScanActive && slotsRemaining === 0 && effectiveCompetitors.length > 0 && (
          <span style={{ fontSize: 11, color: T2 }}>6/6 — slots full</span>
        )}
      </div>

      {/* Critical Issues — responsive: single col when <= 3, else 2-col */}
      <div style={{
        display: "grid",
        gridTemplateColumns: useSingleColumnDiagnosis ? "1fr" : isMobile ? "1fr" : "1fr 1fr",
        gap: 12,
        marginBottom: useSingleColumnDiagnosis ? 12 : 16,
        alignItems: "start",
      }}>
        {/* Critical Issues table */}
        <div style={cardStyle}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 14 }}>
            GEO Audit — Critical Issues <span style={{ fontWeight: 400, color: T3 }}>({criticalCount} of {pillars.length} pillars)</span>
          </div>
          {criticalCount > 0 ? (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Pillar", "Score", "Finding"].map(h => (
                      <th key={h} style={{ fontSize: 10, fontWeight: 600, color: T3, textTransform: "uppercase", letterSpacing: ".5px", textAlign: "left", padding: "0 0 8px", borderBottom: `1px solid ${BORDER}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pillars.filter(p => (p.score ?? 100) < 25 || p.priority === "critical").slice(0, 7).map(p => {
                    const sColor = (p.score ?? 0) < 35 ? RED : ORANGE;
                    return (
                      <tr key={p.pillar}>
                        <td style={{ padding: "7px 0", fontSize: 13, fontWeight: 500, borderBottom: "1px solid #f0f0f2" }}>{p.pillarName}</td>
                        <td style={{ padding: "7px 0", fontSize: 13, fontWeight: 700, color: sColor, textAlign: "right", width: 50, borderBottom: "1px solid #f0f0f2" }}>{p.score}</td>
                        <td style={{ padding: "7px 0", fontSize: 11, color: T2, paddingLeft: 12, borderBottom: "1px solid #f0f0f2" }}>{p.findings}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: COPPER, marginTop: 10, cursor: "pointer" }} onClick={() => setActiveTab("scorecard")}>
                View all {pillars.length} pillars →
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: T2 }}>
              {pillars.length === 0 ? "Run a GEO audit to see critical issues." : "No critical issues found — great work!"}
            </div>
          )}
        </div>

        {/* Right column in 2-col layout: Geographic + Category stacked */}
        {!useSingleColumnDiagnosis && !isMobile && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Geographic Performance */}
            <div style={cardStyle}>
              <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 14 }}>Geographic Performance</div>
              {geoVisibility.length > 0 ? geoVisibility.slice(0, 5).map(g => (
                <div key={g.geoId} style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8 }}>
                  <span style={{ fontSize: 12, width: 80, textAlign: "right", flexShrink: 0, fontWeight: 500 }}>{g.geoName}</span>
                  <div style={{ flex: 1, height: 14, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${g.visibility}%`, height: "100%", borderRadius: 3, background: "#007aff", opacity: 0.7 }} />
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, width: 36, textAlign: "right" }}>{g.visibility}%</span>
                </div>
              )) : lc ? (
                <div style={{ fontSize: 13, color: T2, lineHeight: 1.5 }}>
                  AI agents mentioned {site?.domain} without any location-specific context — no geographic signal was detected across {(lc.providerResults as Array<{ totalQueries?: number }>)?.reduce((s, p) => s + (p.totalQueries ?? 0), 0) || "all"} queries.
                </div>
              ) : (
                <div style={{ fontSize: 13, color: T2 }}>Run a citation scan to see how AI agents mention you by region.</div>
              )}
            </div>
            {/* Category Performance */}
            <div style={cardStyle}>
              <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 14 }}>Category Performance</div>
              {(() => {
                const knownCategories = categoryVisibility.filter(c => c.categoryId !== "unknown" && c.categoryName !== "unknown");
                if (knownCategories.length > 0) {
                  return knownCategories.slice(0, 5).map(c => (
                    <div key={c.categoryId} style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8 }}>
                      <span style={{ fontSize: 12, width: 80, textAlign: "right", flexShrink: 0, fontWeight: 500 }}>{c.categoryName}</span>
                      <div style={{ flex: 1, height: 14, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${c.visibility}%`, height: "100%", borderRadius: 3, background: ORANGE }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, width: 36, textAlign: "right" }}>{c.visibility}%</span>
                    </div>
                  ));
                }
                if (lc) {
                  return (
                    <div style={{ fontSize: 13, color: T2, lineHeight: 1.5 }}>
                      AI agents didn&apos;t associate {site?.domain} with a recognizable product category. Your site may be too new or too niche for current AI training data.
                    </div>
                  );
                }
                return <div style={{ fontSize: 13, color: T2 }}>Run a citation scan to see how AI agents categorize you.</div>;
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Bottom row: Geo (single-col only) + Category (single-col only) + Buyer Intent/Recs
          Single-col mode: 3-col grid with Geo, Category, Recs
          2-col mode:      Geo+Category already appear in right col above; only Recs shown here */}
      {useSingleColumnDiagnosis ? (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 12, marginBottom: 16, alignItems: "start" }}>
          {/* Geographic Performance */}
          <div style={cardStyle}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 14 }}>Geographic Performance</div>
            {geoVisibility.length > 0 ? geoVisibility.slice(0, 5).map(g => (
              <div key={g.geoId} style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8 }}>
                <span style={{ fontSize: 12, width: 80, textAlign: "right", flexShrink: 0, fontWeight: 500 }}>{g.geoName}</span>
                <div style={{ flex: 1, height: 14, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${g.visibility}%`, height: "100%", borderRadius: 3, background: "#007aff", opacity: 0.7 }} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, width: 36, textAlign: "right" }}>{g.visibility}%</span>
              </div>
            )) : lc ? (
              <div style={{ fontSize: 13, color: T2, lineHeight: 1.5 }}>
                AI agents mentioned {site?.domain} without any location-specific context — no geographic signal was detected across {(lc.providerResults as Array<{ totalQueries?: number }>)?.reduce((s, p) => s + (p.totalQueries ?? 0), 0) || "all"} queries.
              </div>
            ) : (
              <div style={{ fontSize: 13, color: T2 }}>Run a citation scan to see how AI agents mention you by region.</div>
            )}
          </div>
          {/* Category Performance */}
          <div style={cardStyle}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 14 }}>Category Performance</div>
            {(() => {
              const knownCategories = categoryVisibility.filter(c => c.categoryId !== "unknown" && c.categoryName !== "unknown");
              if (knownCategories.length > 0) {
                return knownCategories.slice(0, 5).map(c => (
                  <div key={c.categoryId} style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8 }}>
                    <span style={{ fontSize: 12, width: 80, textAlign: "right", flexShrink: 0, fontWeight: 500 }}>{c.categoryName}</span>
                    <div style={{ flex: 1, height: 14, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${c.visibility}%`, height: "100%", borderRadius: 3, background: ORANGE }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, width: 36, textAlign: "right" }}>{c.visibility}%</span>
                  </div>
                ));
              }
              if (lc) {
                return (
                  <div style={{ fontSize: 13, color: T2, lineHeight: 1.5 }}>
                    AI agents didn&apos;t associate {site?.domain} with a recognizable product category. Your site may be too new or too niche for current AI training data.
                  </div>
                );
              }
              return <div style={{ fontSize: 13, color: T2 }}>Run a citation scan to see how AI agents categorize you.</div>;
            })()}
          </div>
          {/* Buyer Intent + Top Recs */}
          <RecsCard
            tierVisibility={tierVisibility}
            recs={recs}
            setActiveTab={setActiveTab}
            cardStyle={cardStyle}
          />
        </div>
      ) : (
        /* 2-col mode: Geo+Category are in the right column of the critical issues grid above.
           Show Recs spanning full width below. */
        <div style={{ marginBottom: 16 }}>
          <RecsCard
            tierVisibility={tierVisibility}
            recs={recs}
            setActiveTab={setActiveTab}
            cardStyle={cardStyle}
          />
        </div>
      )}
    </div>
  );
}
