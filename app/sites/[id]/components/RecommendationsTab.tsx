"use client";

import { useState } from "react";
import {
  COPPER,
  CARD,
  BORDER,
  T2,
  T3,
  GREEN,
  RED,
} from "../design-tokens";
import type { SiteDerivedData } from "../hooks/useSiteData";

interface RecommendationsTabProps {
  data: SiteDerivedData;
}

export default function RecommendationsTab({ data }: RecommendationsTabProps) {
  const { recs } = data;

  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function normPriority(p: string): string {
    const l = p.toLowerCase();
    if (l === "critical") return "CRIT";
    if (l === "high") return "HIGH";
    if (l === "med" || l === "medium") return "MED";
    return "LOW";
  }
  const counts: Record<string, number> = {};
  for (const r of recs) {
    const k = normPriority(r.priority);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const countLabels = ["CRIT", "HIGH", "MED", "LOW"]
    .filter(k => (counts[k] ?? 0) > 0)
    .map(k => `${counts[k]} ${k}`);

  return (
    <div data-testid="recommendations-tab">
      {(() => {
        return (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>
              {recs.length} Recommendations — sorted by priority
            </div>
            <div style={{ fontSize: 12, color: T2 }}>
              {countLabels.join(" · ")}
            </div>
          </div>
        );
      })()}
      {recs.length > 0 ? recs.map((r, i) => {
        const isOpen = expanded.has(i);
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
          <div key={r.title + i} style={{ background: CARD, borderRadius: 12, border: `1px solid ${isOpen ? "rgba(194, 101, 42, 0.35)" : BORDER}`, boxShadow: isOpen ? "0 0 0 1px rgba(194, 101, 42, 0.15), 0 4px 16px rgba(194, 101, 42, 0.12)" : "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", marginBottom: 8, overflow: "hidden", transition: "all .2s" }}>
            <div
              style={{ display: "flex", alignItems: "center", padding: "14px 18px", gap: 12, cursor: "pointer" }}
              onClick={() => {
                const next = new Set(expanded);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                setExpanded(next);
              }}
            >
              <div style={{ width: 18, height: 18, border: `2px solid ${BORDER}`, borderRadius: "50%", flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: T3, width: 20, textAlign: "center", flexShrink: 0 }}>{i + 1}</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, flexShrink: 0, width: 48, textAlign: "center", ...pStyle }}>
                {r.priority === "critical" ? "CRIT" : r.priority === "medium" ? "MED" : (r.priority ?? "low").toUpperCase()}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{r.title}</span>
              {timeStr && <span style={{ fontSize: 11, color: T2, flexShrink: 0 }}>{timeStr}</span>}
              <span style={{ fontSize: 11, color: T3 }}>{isOpen ? "↑" : "↓"}</span>
            </div>
            {isOpen && (
              <div style={{ padding: "0 18px 16px 62px", fontSize: 13, color: T2, lineHeight: 1.6 }}>
                {r.description && <div>{r.description}</div>}
                {r.specificAction && (
                  <div style={{ background: COPPER, borderRadius: 8, padding: "10px 14px", marginTop: 8, fontSize: 12, lineHeight: 1.5, color: "#fff" }}>
                    <strong>Action:</strong> {r.specificAction}
                  </div>
                )}
                {r.estimatedBoost && (
                  <div style={{ fontSize: 11, color: GREEN, fontWeight: 600, marginTop: 8, textTransform: "uppercase" }}>
                    Boost: {r.estimatedBoost}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      }) : <div style={{ fontSize: 13, color: T2 }}>Run a GEO audit to see recommendations.</div>}
    </div>
  );
}
