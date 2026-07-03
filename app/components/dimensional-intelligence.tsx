"use client";

import { useState, useMemo, memo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Cell, LabelList, ResponsiveContainer,
} from "recharts";
import type {
  CitationCheckResult,
  TierVisibility,
  GeoVisibility,
  CategoryVisibility,
  LocationCompetitor,
  CategoryCompetitor,
  DominanceMap,
  RealPromptDiscovery,
  VisibilityGapEntry,
} from "@/lib/types/citation";
import type { CitationCheckScore } from "@/lib/db/schema";
import { ScoreArc } from "@/app/components/citation-analytics";

// ── Design tokens (match citation-analytics.tsx) ────────────────────────────
const TEXT    = "#1c1917";
const TEXT_2  = "#78716c";
const TEXT_3  = "#a8a29e";
const BORDER  = "rgba(0,0,0,0.07)";
const TRACK   = "#e8e5e0";
const GREEN   = "#16a34a";
const AMBER   = "#d97706";
const RED     = "#dc2626";
const ACCENT  = "#b45309";

const SECTION_HEADING: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: TEXT_3,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: "0 0 12px",
};

const CARD: React.CSSProperties = {
  border: `1px solid ${BORDER}`,
  borderRadius: 10,
  overflow: "hidden",
  background: "#fff",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function visibilityColor(v: number): string {
  if (v >= 40) return GREEN;
  if (v >= 15) return AMBER;
  return RED;
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ flex: 1, height: 4, background: TRACK, borderRadius: 2, minWidth: 60 }}>
      {value > 0 && (
        <div style={{ height: "100%", width: `${Math.min(value, 100)}%`, background: color, borderRadius: 2 }} />
      )}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 style={SECTION_HEADING}>{children}</h3>;
}

function VisibilityValue({ v }: { v: number }) {
  const color = visibilityColor(v);
  return (
    <span style={{ fontSize: 14, fontWeight: 700, color, fontVariantNumeric: "tabular-nums", width: 40, textAlign: "right", flexShrink: 0 }}>
      {v}%
    </span>
  );
}

function DimensionBadge({ dimension }: { dimension: "geo" | "category" | "tier" }) {
  const colors: Record<string, string> = { geo: "#2563eb", category: "#7c3aed", tier: "#d97706" };
  const labels: Record<string, string> = { geo: "GEO", category: "CAT", tier: "TIER" };
  const c = colors[dimension] ?? TEXT_3;
  return (
    <span style={{
      fontSize: 9, fontWeight: 700,
      color: c, background: c + "18", border: `1px solid ${c}30`,
      borderRadius: 4, padding: "1px 5px", flexShrink: 0,
    }}>
      {labels[dimension] ?? dimension.toUpperCase()}
    </span>
  );
}

// ── Data extraction (same pattern as getScores in citation-analytics.tsx) ───

function getDimensionalData(r: CitationCheckResult | CitationCheckScore) {
  if ("scores" in r && typeof r.scores === "object" && r.scores !== null) {
    // CitationCheckResult (live scan path — dimensional fields nested in scores)
    const s = r.scores as Record<string, unknown>;
    return {
      geoVisibility:        (s.geoVisibility        ?? []) as GeoVisibility[],
      categoryVisibility:   (s.categoryVisibility   ?? []) as CategoryVisibility[],
      tierVisibility:       (s.tierVisibility       ?? []) as TierVisibility[],
      visibilityGapAnalysis:(s.visibilityGapAnalysis ?? []) as VisibilityGapEntry[],
      locationCompetitors:  (s.locationCompetitors  ?? []) as LocationCompetitor[],
      categoryCompetitors:  (s.categoryCompetitors  ?? []) as CategoryCompetitor[],
      dominanceMap:         (s.dominanceMap         ?? null) as DominanceMap | null,
      realPromptDiscovery:  (s.realPromptDiscovery  ?? null) as RealPromptDiscovery[] | null,
    };
  }
  // CitationCheckScore (preloaded path — fields are flat on the object)
  const score = r as CitationCheckScore;
  return {
    geoVisibility:        (score.geoVisibility        ?? []) as GeoVisibility[],
    categoryVisibility:   (score.categoryVisibility   ?? []) as CategoryVisibility[],
    tierVisibility:       (score.tierVisibility       ?? []) as TierVisibility[],
    visibilityGapAnalysis:(score.visibilityGapAnalysis ?? []) as VisibilityGapEntry[],
    locationCompetitors:  (score.locationCompetitors  ?? []) as LocationCompetitor[],
    categoryCompetitors:  (score.categoryCompetitors  ?? []) as CategoryCompetitor[],
    dominanceMap:         (score.dominanceMap         ?? null) as DominanceMap | null,
    realPromptDiscovery:  (score.realPromptDiscovery  ?? null) as RealPromptDiscovery[] | null,
  };
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface DimensionalIntelligenceProps {
  result: CitationCheckResult | CitationCheckScore | null;
  domain: string;
  history?: CitationCheckScore[];
}

// ── MiniSparkline — inline SVG trend (E5) ────────────────────────────────────

function MiniSparkline({ values }: { values: number[] }) {
  if (values.length < 3) return null;
  const w = 40; const h = 16;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - (v / max) * h;
    return `${x},${y}`;
  });
  const latest = values[values.length - 1];
  const first  = values[0];
  const color  = latest > first ? GREEN : latest < first ? RED : TEXT_3;
  return (
    <svg
      data-testid="mini-sparkline"
      role="img"
      aria-label={`Trend: ${values.join(', ')}`}
      width={w} height={h} viewBox={`0 0 ${w} ${h}`}
      style={{ display: "inline-block", verticalAlign: "middle", marginLeft: 8 }}
    >
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

// ── Section 1: Buyer Intent Breakdown (B7: arc gauges) ──────────────────────

function BuyerIntentSection({ tierVisibility }: { tierVisibility: TierVisibility[] }) {
  if (tierVisibility.length === 0) return null;

  const TIER_LABELS: Record<string, string> = { buy: "Buy", solve: "Solve", learn: "Learn" };
  const sorted = ["buy", "solve", "learn"];

  return (
    <div style={{ marginBottom: 32 }}>
      <SectionHeading>Buyer Intent Breakdown</SectionHeading>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {sorted.map(tier => {
          const row = tierVisibility.find(t => t.tier === tier);
          if (!row) return null;
          return (
            <div key={tier}>
              <ScoreArc value={row.visibility} label={TIER_LABELS[tier] ?? tier} size={72} />
              <div style={{ textAlign: "center", fontSize: 9, color: TEXT_3, marginTop: 2 }}>
                {row.mentionCount}/{row.promptCount} prompts
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Row with expandable competitor panel ─────────────────────────────────────
// FIX-5: React.memo prevents sibling re-renders on expand/collapse toggle

const ExpandableRow = memo(function ExpandableRow({
  name, promptCount, mentionCount, visibility,
  competitors,
}: {
  name: string;
  promptCount: number;
  mentionCount: number;
  visibility: number;
  competitors: LocationCompetitor["competitors"] | CategoryCompetitor["competitors"] | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasCompetitors = (competitors?.length ?? 0) > 0;
  const color = visibilityColor(visibility);
  const panelId = `panel-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

  return (
    <div className="di-table-row" style={{ borderBottom: `1px solid ${BORDER}` }}>
      <button
        aria-expanded={expanded && hasCompetitors}
        aria-controls={hasCompetitors ? panelId : undefined}
        onClick={() => hasCompetitors && setExpanded(e => !e)}
        style={{
          display: "flex", alignItems: "center", gap: 12,
          width: "100%", textAlign: "left",
          background: "none", border: "none",
          cursor: hasCompetitors ? "pointer" : "default",
          padding: "10px 14px",
        }}
      >
        <span className="di-row-label" style={{ fontSize: 13, fontWeight: 500, color: TEXT, flex: "1 1 0", minWidth: 0 }}>
          {name}
        </span>
        <span style={{ fontSize: 11, color: TEXT_3, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
          {mentionCount}/{promptCount}
        </span>
        <ProgressBar value={visibility} color={color} />
        <VisibilityValue v={visibility} />
        {hasCompetitors && (
          <span style={{ fontSize: 9, color: TEXT_3, flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
        )}
      </button>

      {expanded && hasCompetitors && (
        <div id={panelId} className="di-competitor-panel" style={{ padding: "4px 14px 12px 14px", background: "#fafaf9" }}>
          <div style={{ fontSize: 10, color: TEXT_3, marginBottom: 6, letterSpacing: "0.04em", textTransform: "uppercase", fontWeight: 600 }}>
            Top Competitors
          </div>
          {competitors?.slice(0, 3).map(c => (
            <div key={c.domain} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
              <span style={{ fontSize: 12, color: TEXT_2, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.name || c.domain}
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, color: RED, flexShrink: 0 }}>{c.shareOfVoice}% SOV</span>
              {c.rankedAboveBrand > 0 && (
                <span style={{ fontSize: 10, color: TEXT_3, flexShrink: 0 }}>↑{c.rankedAboveBrand}% above you</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// ── Section 2: Geographic Performance (E1, E3) ──────────────────────────────

function GeoSection({
  geoVisibility, locationCompetitors, domain, geoTrends,
}: {
  geoVisibility: GeoVisibility[];
  locationCompetitors: LocationCompetitor[];
  domain: string;
  geoTrends: Map<string, number[]>;
}) {
  if (geoVisibility.length === 0) return null;

  const sorted = useMemo(
    () => [...geoVisibility].sort((a, b) => a.visibility - b.visibility).slice(0, 12),
    [geoVisibility],
  );

  // E3 fallback: if exactly 1 locationCompetitors entry, use expandable table (ES-057 pattern)
  if (locationCompetitors.length > 0 && locationCompetitors.length < 2) {
    return (
      <div style={{ marginBottom: 32 }}>
        <SectionHeading>Geographic Performance</SectionHeading>
        <div className="di-table" style={CARD}>
          {sorted.map(geo => {
            const lc = locationCompetitors.find(c => c.geoId === geo.geoId);
            return (
              <ExpandableRow
                key={geo.geoId}
                name={geo.geoName}
                promptCount={geo.promptCount}
                mentionCount={geo.mentionCount}
                visibility={geo.visibility}
                competitors={lc?.competitors ?? null}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // E3: Per-geo small multiples — only when ≥2 locationCompetitors entries
  const showSmallMultiples = locationCompetitors.length >= 2;
  const brandSlug = domain.replace(/^www\./, "").replace(/\.[a-z]+$/i, "");

  const geoCompSmall = showSmallMultiples
    ? sorted.slice(0, 3).map(geo => {
        const lc = locationCompetitors.find(c => c.geoId === geo.geoId);
        if (!lc || lc.competitors.length === 0) return null;
        return {
          geoName: geo.geoName,
          bars: [
            { name: `${brandSlug} (you)`, sov: geo.visibility, isBrand: true },
            ...lc.competitors.slice(0, 3).map(c => ({
              name: c.domain.replace(/\.[a-z]+$/i, ""),
              sov:  c.shareOfVoice,
              isBrand: false,
            })),
          ],
        };
      }).filter(Boolean)
    : [];

  const barHeight = Math.max(160, sorted.length * 36);

  return (
    <div style={{ marginBottom: 32 }}>
      <SectionHeading>Geographic Performance</SectionHeading>
      <ResponsiveContainer width="100%" height={barHeight}>
        <BarChart data={sorted} layout="vertical" margin={{ left: 100, right: 48, top: 4, bottom: 4 }}>
          <XAxis type="number" domain={[0, 100]} tick={{ fill: TEXT_2, fontSize: 10 }}
                 axisLine={{ stroke: BORDER }} tickLine={false} />
          <YAxis
            type="category" dataKey="geoName" tick={{ fill: TEXT_2, fontSize: 11 }}
            width={100} axisLine={false} tickLine={false}
            tickFormatter={(val: string) => {
              const geo = sorted.find(g => g.geoName === val);
              if (!geo) return val;
              const trend = geoTrends.get(geo.geoId) ?? [];
              return val; // label only — sparkline is rendered via custom tick shape
            }}
          />
          <Bar dataKey="visibility" radius={[0, 4, 4, 0]} barSize={20}>
            <LabelList dataKey="visibility" position="right" fill={TEXT_2} fontSize={10}
                       formatter={(v) => `${v}%`} />
            {sorted.map((entry) => (
              <Cell key={entry.geoName} fill={visibilityColor(entry.visibility)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {/* Inline sparklines below the chart */}
      {geoTrends.size > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {sorted.map(geo => {
            const trend = geoTrends.get(geo.geoId) ?? [];
            if (trend.length < 3) return null;
            return (
              <span key={geo.geoId} style={{ fontSize: 11, color: TEXT_2 }}>
                {geo.geoName}
                <MiniSparkline values={trend} />
              </span>
            );
          })}
        </div>
      )}
      {/* E3: Competitor per-geo small multiples */}
      {geoCompSmall.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginTop: 16 }}>
          {geoCompSmall.map(item => item && (
            <div key={item.geoName}>
              <div style={{ fontSize: 10, color: TEXT_3, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {item.geoName}
              </div>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={item.bars} layout="vertical" margin={{ left: 80, right: 40, top: 2, bottom: 2 }}>
                  <XAxis type="number" domain={[0, 100]} hide />
                  <YAxis type="category" dataKey="name" tick={{ fill: TEXT_2, fontSize: 10 }} width={80} axisLine={false} tickLine={false} />
                  <Bar dataKey="sov" radius={[0, 4, 4, 0]} barSize={14}>
                    <LabelList dataKey="sov" position="right" fill={TEXT_2} fontSize={9} formatter={(v) => `${v}%`} />
                    {item.bars.map((b) => (
                      <Cell key={b.name} fill={b.isBrand ? ACCENT : RED} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section 3: Category Performance (E2) ────────────────────────────────────

function CategorySection({
  categoryVisibility, categoryCompetitors,
}: {
  categoryVisibility: CategoryVisibility[];
  categoryCompetitors: CategoryCompetitor[];
}) {
  if (categoryVisibility.length === 0) return null;

  const sorted = useMemo(
    () => [...categoryVisibility].sort((a, b) => a.visibility - b.visibility).slice(0, 12),
    [categoryVisibility],
  );

  // Fallback to expandable table when exactly 1 categoryCompetitors entry
  if (categoryCompetitors.length > 0 && categoryCompetitors.length < 2) {
    return (
      <div style={{ marginBottom: 32 }}>
        <SectionHeading>Category Performance</SectionHeading>
        <div className="di-table" style={CARD}>
          {sorted.map(cat => {
            const cc = categoryCompetitors.find(c => c.categoryId === cat.categoryId);
            return (
              <ExpandableRow
                key={cat.categoryId}
                name={cat.categoryName}
                promptCount={cat.promptCount}
                mentionCount={cat.mentionCount}
                visibility={cat.visibility}
                competitors={cc?.competitors ?? null}
              />
            );
          })}
        </div>
      </div>
    );
  }

  const barHeight = Math.max(160, sorted.length * 36);

  return (
    <div style={{ marginBottom: 32 }}>
      <SectionHeading>Category Performance</SectionHeading>
      <ResponsiveContainer width="100%" height={barHeight}>
        <BarChart data={sorted} layout="vertical" margin={{ left: 120, right: 48, top: 4, bottom: 4 }}>
          <XAxis type="number" domain={[0, 100]} tick={{ fill: TEXT_2, fontSize: 10 }}
                 axisLine={{ stroke: BORDER }} tickLine={false} />
          <YAxis type="category" dataKey="categoryName" tick={{ fill: TEXT_2, fontSize: 11 }}
                 width={120} axisLine={false} tickLine={false} />
          <Bar dataKey="visibility" radius={[0, 4, 4, 0]} barSize={20}>
            <LabelList dataKey="visibility" position="right" fill={TEXT_2} fontSize={10}
                       formatter={(v) => `${v}%`} />
            {sorted.map((entry) => (
              <Cell key={entry.categoryName} fill={visibilityColor(entry.visibility)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Section 4: Dominance Insights ────────────────────────────────────────────

function insightSeverity(insight: string): { bg: string; border: string; dot: string } {
  const lower = insight.toLowerCase();
  if (lower.includes("dominates")) return { bg: RED + "08",   border: RED + "25",   dot: RED   };
  if (lower.includes("competitive"))return { bg: AMBER + "08", border: AMBER + "25", dot: AMBER };
  if (lower.includes("lead"))       return { bg: GREEN + "08", border: GREEN + "25", dot: GREEN };
  return { bg: "#f5f2ee", border: BORDER, dot: TEXT_3 };
}

// ── E4: Dominance diverging bars ─────────────────────────────────────────────

function DominanceDivergingRow({ entry, maxSov }: {
  entry: { geoId?: string | null; categoryId?: string | null; brandSOV: number; topBrand?: string | null; topBrandSOV: number };
  maxSov: number;
}) {
  const yourPct   = maxSov > 0 ? (entry.brandSOV   / maxSov) * 100 : 0;
  const leaderPct = maxSov > 0 ? (entry.topBrandSOV / maxSov) * 100 : 0;
  const label     = entry.geoId
    ? (entry.categoryId ? `${entry.geoId} / ${entry.categoryId}` : entry.geoId)
    : "Global";

  return (
    <div
      aria-label={`${label}: your SOV ${entry.brandSOV}% vs leader ${entry.topBrandSOV}%`}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${BORDER}` }}
    >
      {/* Your SOV — right-aligned bar */}
      <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 10, color: ACCENT, fontWeight: 600 }}>{entry.brandSOV}%</span>
        <div data-testid="dominance-your-bar" style={{ height: 16, width: `${yourPct}%`, background: ACCENT, borderRadius: "4px 0 0 4px", minWidth: entry.brandSOV > 0 ? 4 : 0 }} />
      </div>
      {/* Center label */}
      <div style={{ width: 80, textAlign: "center", fontSize: 10, color: TEXT_2, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </div>
      {/* Leader SOV — left-aligned bar */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4 }}>
        <div data-testid="dominance-leader-bar" style={{ height: 16, width: `${leaderPct}%`, background: RED, borderRadius: "0 4px 4px 0", minWidth: entry.topBrandSOV > 0 ? 4 : 0 }} />
        <span style={{ fontSize: 10, color: RED, fontWeight: 600 }}>{entry.topBrandSOV}%</span>
      </div>
    </div>
  );
}

function DominanceSection({ dominanceMap }: { dominanceMap: DominanceMap | null }) {
  if (!dominanceMap || dominanceMap.entries.length === 0) return null;

  const insights = dominanceMap.insights ?? [];
  const gap = (e: typeof dominanceMap.entries[number]) => e.topBrandSOV - e.brandSOV;
  const sorted = [...dominanceMap.entries].sort((a, b) => gap(b) - gap(a)).slice(0, 8);
  const maxSov = Math.max(...sorted.flatMap(e => [e.brandSOV, e.topBrandSOV]), 1);

  return (
    <div style={{ marginBottom: 32 }}>
      <SectionHeading>Dominance Map</SectionHeading>
      {/* Header row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        <div style={{ flex: 1, textAlign: "right", fontSize: 10, fontWeight: 600, color: ACCENT }}>You</div>
        <div style={{ width: 80 }} />
        <div style={{ flex: 1, fontSize: 10, fontWeight: 600, color: RED }}>Leader</div>
      </div>
      {sorted.map((entry, i) => (
        <DominanceDivergingRow key={entry.geoId ?? entry.categoryId ?? i} entry={entry} maxSov={maxSov} />
      ))}
      {/* Insight cards below if available */}
      {insights.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
          {insights.map((insight) => {
            const { bg, border, dot } = insightSeverity(insight);
            return (
              <div key={insight} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, flexShrink: 0, marginTop: 5 }} />
                <span style={{ fontSize: 13, color: TEXT, lineHeight: 1.5 }}>{insight}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Section 5: Real User Questions ───────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  paa:    "#2563eb",
  reddit: "#ea580c",
  quora:  "#dc2626",
};
const SOURCE_LABELS: Record<string, string> = {
  paa:    "PAA",
  reddit: "Reddit",
  quora:  "Quora",
};

function RealQuestionsSection({ realPromptDiscovery }: { realPromptDiscovery: RealPromptDiscovery[] | null }) {
  const [expanded, setExpanded] = useState(false);
  const prompts = realPromptDiscovery ?? [];
  if (prompts.length === 0) return null;

  return (
    <div style={{ marginBottom: 32 }}>
      <SectionHeading>Real User Questions</SectionHeading>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          fontSize: 12, color: TEXT_2, background: "none", border: `1px solid ${BORDER}`,
          borderRadius: 6, padding: "5px 10px", cursor: "pointer", marginBottom: 10,
        }}
      >
        {expanded ? "Hide ▲" : `Show ${prompts.length} real questions ▼`}
      </button>
      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {prompts.map((q, i) => {
            const color = SOURCE_COLORS[q.source] ?? TEXT_3;
            const truncated = q.context && q.context.length > 150
              ? q.context.slice(0, 150).split(" ").slice(0, -1).join(" ") + "…"
              : q.context;
            return (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start", gap: 8,
                padding: "8px 12px",
                border: `1px solid ${BORDER}`, borderRadius: 8, background: "#fff",
              }}>
                <span style={{
                  fontSize: 9, fontWeight: 700, color, background: color + "18",
                  border: `1px solid ${color}30`, borderRadius: 4, padding: "1px 5px",
                  flexShrink: 0, marginTop: 2,
                }}>
                  {SOURCE_LABELS[q.source] ?? q.source}
                </span>
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: "0 0 4px", fontSize: 13, color: TEXT, lineHeight: 1.4 }}>{q.query}</p>
                  {truncated && (
                    <p style={{ margin: 0, fontSize: 11, color: TEXT_3, lineHeight: 1.4 }}>
                      {truncated}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Section 6: Visibility Gap Analysis ───────────────────────────────────────

function GapAnalysisSection({ visibilityGapAnalysis }: { visibilityGapAnalysis: VisibilityGapEntry[] }) {
  if (visibilityGapAnalysis.length === 0) return null;

  const capped = visibilityGapAnalysis.slice(0, 10);

  return (
    <div style={{ marginBottom: 32 }}>
      <SectionHeading>Visibility Gap Analysis</SectionHeading>
      <div className="di-table" style={CARD}>
        {capped.map((entry, i) => (
          <div key={i} style={{
            padding: "10px 14px",
            borderBottom: `1px solid ${BORDER}`,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
              <DimensionBadge dimension={entry.dimension} />
              <span style={{ fontSize: 13, fontWeight: 500, color: TEXT }}>{entry.name}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: visibilityColor(entry.visibility), marginLeft: "auto" }}>
                {entry.visibility}%
              </span>
            </div>
            <p style={{ margin: "0 0 3px", fontSize: 12, color: TEXT_2 }}>{entry.gap}</p>
            <p style={{ margin: 0, fontSize: 11, color: TEXT_3 }}>{entry.recommendation}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function DimensionalIntelligence({ result, domain, history }: DimensionalIntelligenceProps) {
  if (!result) return null;

  const {
    tierVisibility, geoVisibility, categoryVisibility,
    locationCompetitors, categoryCompetitors,
    dominanceMap, realPromptDiscovery, visibilityGapAnalysis,
  } = getDimensionalData(result);

  // E5: Extract geo trend data from V2 history (≥3 entries)
  // Must be before any conditional return to satisfy Rules of Hooks
  const geoTrends = useMemo<Map<string, number[]>>(() => {
    const map = new Map<string, number[]>();
    if (!history || history.length < 3) return map;
    const v2History = history
      .filter(h => (h as unknown as { promptArchitectureVersion?: number }).promptArchitectureVersion === 2)
      .slice(0, 5)
      .reverse();
    if (v2History.length < 3) return map;
    for (const check of v2History) {
      const geos = ((check as unknown as { geoVisibility?: GeoVisibility[] }).geoVisibility) ?? [];
      for (const geo of geos) {
        const trend = map.get(geo.geoId) ?? [];
        trend.push(geo.visibility);
        map.set(geo.geoId, trend);
      }
    }
    return map;
  }, [history]);

  // E6: Detect V1↔V2 boundary in history for version banner
  const showVersionBanner = useMemo(() => {
    if (!history || history.length < 2) return false;
    let sawV2 = false;
    for (const h of history) {
      const v = (h as unknown as { promptArchitectureVersion?: number }).promptArchitectureVersion;
      if (v === 2) { sawV2 = true; }
      else if (sawV2) { return true; } // boundary found
    }
    return false;
  }, [history]);

  const hasAny =
    tierVisibility.length > 0 ||
    geoVisibility.length > 0 ||
    categoryVisibility.length > 0 ||
    (dominanceMap !== null && dominanceMap.entries.length > 0) ||
    (realPromptDiscovery !== null && realPromptDiscovery.length > 0) ||
    visibilityGapAnalysis.length > 0;

  if (!hasAny) return null;

  return (
    <div style={{ paddingTop: 4 }}>
      <style>{`
        .di-table { display: block; }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .di-section { animation: fadeSlideIn 0.3s ease forwards; opacity: 0; }
        .di-section:nth-child(1) { animation-delay: 0ms; }
        .di-section:nth-child(2) { animation-delay: 100ms; }
        .di-section:nth-child(3) { animation-delay: 200ms; }
        .di-section:nth-child(4) { animation-delay: 300ms; }
        .di-section:nth-child(5) { animation-delay: 400ms; }
        .di-section:nth-child(6) { animation-delay: 500ms; }
        .di-chart-pair { display: flex; flex-direction: column; gap: 24px; }
        @media (min-width: 1024px) {
          .di-chart-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
        }
        @media (max-width: 640px) {
          .di-row-label { font-size: 12px !important; }
          .di-table-row { flex-direction: column; }
          .di-competitor-panel { padding-left: 12px !important; }
        }
        @media (min-width: 640px) and (max-width: 1024px) {
          .di-gap-grid { grid-template-columns: 1fr 1fr; }
        }
        @media (prefers-reduced-motion: reduce) { .di-section { animation: none; opacity: 1; } }
      `}</style>
      {/* E6: Version banner */}
      {showVersionBanner && (
        <div style={{
          padding: "8px 12px", marginBottom: 16,
          background: "#d9770608",
          borderTop: "1px solid #d9770630",
          borderBottom: "1px solid #d9770630",
          fontSize: 11, color: AMBER, fontWeight: 500,
        }}>
          Measurement upgraded — scores after this date use improved prompts
        </div>
      )}
      <div className="di-section"><BuyerIntentSection tierVisibility={tierVisibility} /></div>
      <div className="di-chart-pair di-section">
        <GeoSection
          geoVisibility={geoVisibility}
          locationCompetitors={locationCompetitors}
          domain={domain}
          geoTrends={geoTrends}
        />
        <CategorySection categoryVisibility={categoryVisibility} categoryCompetitors={categoryCompetitors} />
      </div>
      <div className="di-section"><DominanceSection dominanceMap={dominanceMap} /></div>
      <div className="di-section"><RealQuestionsSection realPromptDiscovery={realPromptDiscovery} /></div>
      <div className="di-section"><GapAnalysisSection visibilityGapAnalysis={visibilityGapAnalysis} /></div>
    </div>
  );
}
