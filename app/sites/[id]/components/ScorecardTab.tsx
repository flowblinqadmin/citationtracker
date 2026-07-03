"use client";

import { useState, useMemo } from "react";
import {
  COPPER,
  CARD,
  BORDER,
  TEXT,
  T2,
  T3,
  GREEN,
  ORANGE,
  RED,
  scoreTier,
} from "../design-tokens";
import type { SiteDerivedData } from "../hooks/useSiteData";

interface ScorecardTabProps {
  data: SiteDerivedData;
  isMobile: boolean;
}

export default function ScorecardTab({ data, isMobile }: ScorecardTabProps) {
  const { pillars, tierCounts, recs } = data;

  const [tierFilter, setTierFilter] = useState<"All" | "Poor" | "Weak" | "Fair" | "Good">("All");

  // Default-expand the first 2 pillars with score < 25 on mount
  const initialExpanded = useMemo(() => {
    const ids = pillars
      .filter((p) => (p.score ?? 0) < 25)
      .slice(0, 2)
      .map((p) => p.pillar);
    return new Set(ids);
  }, [pillars]);

  const [expandedPillars, setExpandedPillars] = useState<Set<string>>(initialExpanded);
  const [hoveredPillar, setHoveredPillar] = useState<string | null>(null);

  const filteredPillars = pillars
    .filter(p => tierFilter === "All" || scoreTier(p.score ?? 0) === tierFilter)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0)); // lowest score first

  return (
    <div data-testid="scorecard-tab">
      <div style={{ background: CARD, borderRadius: 12, padding: "18px 20px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}`, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>All {pillars.length} Pillars</div>
          <div style={{ display: "flex", gap: 4 }}>
            {(["All", "Poor", "Weak", "Fair", "Good"] as const).filter(t =>
              t === "All" || tierCounts[t as keyof typeof tierCounts] > 0
            ).map(t => (
              <button
                key={t}
                onClick={() => setTierFilter(t)}
                style={{
                  fontSize: 12, padding: "4px 12px", borderRadius: 6,
                  border: `1px solid ${tierFilter === t ? COPPER : BORDER}`,
                  background: tierFilter === t ? COPPER : CARD,
                  color: tierFilter === t ? "#fff" : TEXT,
                  cursor: "pointer", fontWeight: 500,
                }}
              >
                {t !== "All" ? `${t} (${tierCounts[t as keyof typeof tierCounts]})` : "All"}
              </button>
            ))}
          </div>
        </div>
        {filteredPillars.length > 0 ? filteredPillars.map(p => {
          const tier = scoreTier(p.score ?? 0);
          const badgeStyle = tier === "Poor" ? { background: "#fef2f2", color: RED }
            : tier === "Weak" ? { background: "#fff8e1", color: "#e65100" }
            : tier === "Fair" ? { background: "#e8f5e9", color: "#2e7d32" }
            : null;
          const s = p.score ?? 0;
          const barBg = s < 35 ? RED : s < 55 ? ORANGE : GREEN;
          const sClr = s < 35 ? RED : s < 55 ? ORANGE : GREEN;
          const isOpen = expandedPillars.has(p.pillar);
          const linkedRec = recs.find(r => r.pillar === p.pillar);
          return (
            <div key={p.pillar} style={{ background: CARD, borderRadius: 10, border: `1px solid ${isOpen ? "rgba(194, 101, 42, 0.35)" : BORDER}`, marginBottom: 6, overflow: "hidden", transition: "all .2s", boxShadow: isOpen ? "0 0 0 1px rgba(194, 101, 42, 0.15), 0 4px 16px rgba(194, 101, 42, 0.12)" : hoveredPillar === p.pillar ? "0 4px 12px rgba(0,0,0,0.08)" : "none" }}>
              <div
                style={{ display: "flex", alignItems: "center", padding: "12px 16px", gap: 12, cursor: "pointer" }}
                onClick={() => {
                  const next = new Set(expandedPillars);
                  if (next.has(p.pillar)) next.delete(p.pillar);
                  else next.add(p.pillar);
                  setExpandedPillars(next);
                }}
                onMouseEnter={() => setHoveredPillar(p.pillar)}
                onMouseLeave={() => setHoveredPillar(null)}
              >
                <span style={{ fontSize: 13, fontWeight: 600, width: isMobile ? 100 : 160, flexShrink: 0 }}>{p.pillarName}</span>
                <div style={{ flex: 1, height: 8, background: "#f0f0f2", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${s}%`, height: "100%", borderRadius: 4, background: barBg, transition: "width .4s" }} />
                </div>
                <span style={{ fontSize: 14, fontWeight: 700, width: 32, textAlign: "right", flexShrink: 0, fontVariantNumeric: "tabular-nums", color: sClr }}>{s}</span>
                {badgeStyle
                  ? <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, width: 52, textAlign: "center", flexShrink: 0, ...badgeStyle }}>{tier}</span>
                  : <span style={{ width: 52, flexShrink: 0 }} />
                }
                <span style={{ fontSize: 14, color: isOpen ? COPPER : T2, flexShrink: 0, fontWeight: 600, lineHeight: 1, transition: "color .15s" }}>{isOpen ? "↑" : "↓"}</span>
              </div>
              {isOpen && (
                <div style={{ padding: "0 16px 16px 16px", borderTop: `1px solid ${BORDER}` }}>
                  {p.findings && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 4 }}>Finding</div>
                      <div style={{ fontSize: 13, color: TEXT, lineHeight: 1.6 }}>{p.findings}</div>
                    </div>
                  )}
                  {p.recommendation && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 4 }}>Recommendation</div>
                      <div style={{ fontSize: 13, color: TEXT, lineHeight: 1.6 }}>{p.recommendation}</div>
                    </div>
                  )}
                  {linkedRec?.specificAction && (
                    <div style={{ background: COPPER, borderRadius: 8, padding: "10px 14px", marginTop: 10, fontSize: 12, lineHeight: 1.5, color: "#fff" }}>
                      <strong>Action:</strong> {linkedRec.specificAction}
                    </div>
                  )}
                  {p.impactedPages && p.impactedPages.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 4 }}>Impacted Pages ({p.impactedPages.length})</div>
                      <div style={{ fontSize: 12, color: T2, lineHeight: 1.8 }}>
                        {p.impactedPages.slice(0, 5).map(url => (
                          <div key={url} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</div>
                        ))}
                        {p.impactedPages.length > 5 && <div style={{ color: T3 }}>+ {p.impactedPages.length - 5} more</div>}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        }) : <div style={{ fontSize: 13, color: T2, padding: "20px 0" }}>No pillars match this filter.</div>}
      </div>
    </div>
  );
}
