"use client";

import React, { useState } from "react";
import {
  CARD,
  BORDER,
  T2,
  T3,
  RED,
  ORANGE,
  GREEN,
  TEXT,
  scoreColor,
} from "../design-tokens";
import type { SiteDerivedData } from "../hooks/useSiteData";
import type { CitationCheckScore } from "@/lib/db/schema";

interface HeroMetricsProps {
  data: SiteDerivedData;
  lastCitationCheck: CitationCheckScore | null;
  isMobile: boolean;
  setActiveTab: (tab: string) => void;
}

const BASE_CARD_STYLE = {
  background: CARD,
  borderRadius: 12,
  padding: "16px 18px",
  boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)",
  border: `1px solid ${BORDER}`,
  cursor: "pointer" as const,
  transition: "box-shadow 0.15s, transform 0.15s",
};

const HOVERED_CARD_STYLE = {
  ...BASE_CARD_STYLE,
  transform: "translateY(-1px)",
  boxShadow: "0 4px 12px rgba(194, 101, 42, 0.18), 0 12px 32px rgba(194, 101, 42, 0.14)",
};

function useCardHover() {
  const [hovered, setHovered] = useState(false);
  return {
    style: hovered ? HOVERED_CARD_STYLE : BASE_CARD_STYLE,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  };
}

export default function HeroMetrics({ data, lastCitationCheck, isMobile, setActiveTab }: HeroMetricsProps) {
  const lc = lastCitationCheck;
  const { liveScore, projectedScore, citationRate, providerAggregates, ourSOV, topCompetitor } = data;

  const card1 = useCardHover();
  const card2 = useCardHover();
  const card3 = useCardHover();
  const card4 = useCardHover();
  const card5 = useCardHover();

  return (
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2,1fr)" : "repeat(5,1fr)", gap: 12, marginBottom: 16 }}>
      {/* Card 1: AI Visibility */}
      <div
        {...card1}
        onClick={() => document.getElementById("section-evidence")?.scrollIntoView({ behavior: "smooth" })}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>AI Visibility</div>
        <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-1px", lineHeight: 1.1, color: lc?.overallVisibility != null ? scoreColor(lc.overallVisibility) : T2 }}>
          {lc?.overallVisibility != null ? `${lc.overallVisibility}%` : "—"}
        </div>
      </div>

      {/* Card 2: GEO Audit Score */}
      <div
        {...card2}
        onClick={() => setActiveTab("scorecard")}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>GEO Audit Score</div>
        <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-1px", lineHeight: 1.1, color: liveScore !== null ? scoreColor(liveScore) : T2 }}>
          {liveScore !== null ? <>{liveScore}<span style={{ fontSize: 18, color: T3 }}>/100</span></> : "—"}
        </div>
        <div style={{ height: 4, borderRadius: 2, background: `linear-gradient(to right,${RED} 0%,${RED} 30%,${ORANGE} 30%,${ORANGE} 50%,#e6b800 50%,#e6b800 70%,${GREEN} 70%)`, marginTop: 8, position: "relative" }}>
          {liveScore !== null && <div style={{ position: "absolute", top: -3, left: `${liveScore}%`, width: 10, height: 10, background: TEXT, borderRadius: "50%", border: "2px solid #fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transform: "translateX(-50%)" }} />}
        </div>
        {projectedScore !== null && projectedScore !== liveScore && (
          <div style={{ fontSize: 12, color: T2, marginTop: 4 }}>
            Est. after fixes: {projectedScore}
            {liveScore !== null && (
              <span style={{ color: GREEN, fontWeight: 600, marginLeft: 4 }}>
                (+{projectedScore - liveScore})
              </span>
            )}
          </div>
        )}
      </div>

      {/* Card 3: Citation Rate */}
      <div
        {...card3}
        onClick={() => document.getElementById("section-evidence")?.scrollIntoView({ behavior: "smooth" })}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>Citation Rate</div>
        <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-1px", lineHeight: 1.1, color: citationRate !== null ? scoreColor(citationRate) : T2 }}>
          {citationRate !== null ? `${citationRate}%` : "—"}
        </div>
        {providerAggregates.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {providerAggregates.map(p => {
              const pillStyle = p.visibilityScore < 30 ? { background: "#fef2f2", color: RED }
                : p.visibilityScore < 70 ? { background: "#fff8e1", color: "#e65100" }
                : { background: "#e8f5e9", color: "#2e7d32" };
              return (
                <span
                  key={p.name}
                  title={`Out of ${p.totalQueries} questions asked to ${p.name}, your site was cited ${p.mentionCount} times`}
                  style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, fontWeight: 600, ...pillStyle }}
                >
                  {p.name} {p.mentionCount} of {p.totalQueries}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Card 4: Brand Visibility (formerly Competitive SOV) */}
      <div
        {...card4}
        onClick={() => document.getElementById("section-sov")?.scrollIntoView({ behavior: "smooth" })}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>Brand Visibility</div>
        <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-1px", lineHeight: 1.1, color: lc != null && lc.overallVisibility != null ? scoreColor(lc.overallVisibility) : T2 }}>
          {lc == null
            ? <span style={{ fontSize: 14, fontWeight: 600, color: T2, lineHeight: 1.4 }}>Run Citation Scan</span>
            : lc.overallVisibility != null
              ? `${lc.overallVisibility}%`
              : "—"}
        </div>
        {lc != null && topCompetitor && (
          <div style={{ fontSize: 12, color: T2, marginTop: 4 }}>Leading · {topCompetitor.name} {topCompetitor.shareOfVoice}%</div>
        )}
      </div>

      {/* Card 5: Citation Quality */}
      <div
        {...card5}
        onClick={() => document.getElementById("section-what-ai-said")?.scrollIntoView({ behavior: "smooth" })}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>Citation Quality</div>
        <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-1px", lineHeight: 1.1, color: lc?.citationQualityScore != null ? scoreColor(lc.citationQualityScore) : T2 }}>
          {lc?.citationQualityScore != null ? `${lc.citationQualityScore}%` : "—"}
        </div>
        {lc?.citationQualityScore != null && lc.citationQualityScore >= 70 && (
          <div style={{ fontSize: 12, color: T2, marginTop: 4 }}>When cited, quality is high</div>
        )}
      </div>
    </div>
  );
}
