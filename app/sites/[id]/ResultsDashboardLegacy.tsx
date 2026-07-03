"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import UpgradeModal from "@/app/components/UpgradeModal";
import { matchesPageTarget } from "@/lib/serve-utils";
import { allowedFrequenciesForTier, SUBSCRIPTION_TIERS, type SubscriptionTier } from "@/lib/config";
import { canRetryBulk } from "./_helpers/bulk-retry";

export interface GeoScore {
  pillar: string;
  pillarName: string;
  score: number;
  findings: string;
  recommendation: string;
  priority: string;
  impactedPages: string[];
}

export interface GeoScorecard {
  overallScore: number;
  pillars: GeoScore[];
  topThreeImprovements: string[];
}

export interface SchemaBlock {
  name: string;
  type: string;
  jsonLd: object;
  instructions: string;
  pageTarget: string;
}

export interface RankedRec {
  rank: number;
  title: string;
  description: string;
  impact: string;
  effort: string;
  pillar: string;
  specificAction: string;
  estimatedBoost: string;
}

export interface DiffData {
  snapshotAt?: string;
  scoreDelta?: number;
  previousScore?: number;
  currentScore?: number;
  previousLlmsTxtLength?: number;
  currentLlmsTxtLength?: number;
}

export interface SiteData {
  id: string;
  domain: string;
  slug?: string;
  pipelineStatus: string | null;
  pipelineError: string | null;
  geoScorecard: unknown;
  executiveSummary: string | null;
  rankedRecommendations?: RankedRec[];
  projectedScore?: number | null;
  projectedBoost?: number | null;
  generatedLlmsTxt: string | null;
  generatedLlmsFullTxt: string | null;
  generatedBusinessJson: unknown;
  generatedSchemaBlocks: unknown;
  discoveryData: unknown;
  platformDetected: string | null;
  manualRunsThisMonth: number | null;
  crawlCount: number | null;
  lastCrawlAt: string | null;
  nextCrawlAt: string | null;
  createdAt: string | null;
  diff?: DiffData | null;
  changeLog?: ChangeLogEntry[] | null;
  domainVerified?: boolean;
  verifyToken?: string | null;
  tier: "free" | "paid";
  credits: number;
  baselineScore: number | null;
  improvementDelta: number | null;
  baselineScorecard?: unknown;
  pillarDeltas?: Array<{
    pillar: string;
    before: number | null;
    after: number;
    delta: number | null;
  }>;
  token: string;
  auditMode?: string | null;
  bulkUrlCount?: number | null;
  perPageResults?: unknown;
  perPageFixes?: unknown;
  implementationStatus?: unknown;
  reportZipUrl?: string | null;
  failedUrls?: string[];
  creditLimitedUrls?: string[];
  // Subscription fields
  subscriptionTier?: string;
  crawlFrequency?: string;
  selectedPages?: string[];
  freeRunNumber?: number;
  discoveredUrls?: string[];
}

export interface ChangeLogEntry {
  runAt: string;
  overallScore: number;
  projectedScore: number;
  crawlQuality: { goodPages: number; errorPages: number; coverageScore: number; blockedByAntiBot: boolean; usable: boolean };
  pillarScores: Record<string, number>;
}

// ─── Design System ───────────────────────────────────────────────────────────
const BG       = "#faf8f5";
const CARD     = "#ffffff";
const CARD_ALT = "#f5f2ee";
const BORDER   = "rgba(0,0,0,0.07)";
const TEXT     = "#1c1917";
const TEXT_2   = "#78716c";
const TEXT_3   = "#a8a29e";
const ACCENT   = "#b45309";
const GREEN    = "#16a34a";
const AMBER    = "#d97706";
const RED      = "#dc2626";

function AuthNavButton() {
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    if (sessionStorage.getItem("geo-authed") === "1") {
      setAuthed(true);
    }
    import("@/lib/supabase/client").then(({ createClient }) => {
      createClient().auth.getSession().then(({ data }) => {
        const ok = !!data.session?.user;
        ok ? sessionStorage.setItem("geo-authed", "1") : sessionStorage.removeItem("geo-authed");
        setAuthed(ok);
      }).catch(() => {});
    }).catch(() => {});
  }, []);
  if (!authed) return (
    <a href="/auth/login" style={{ fontSize: "13px", fontWeight: 600, color: "#fff", background: "#b45309", borderRadius: "8px", padding: "6px 14px", textDecoration: "none" }}>Sign in</a>
  );
  return (
    <button onClick={async () => {
      const { createClient } = await import("@/lib/supabase/client");
      await createClient().auth.signOut();
      sessionStorage.removeItem("geo-authed");
      Object.keys(localStorage).filter(k => k.startsWith("sb-")).forEach(k => localStorage.removeItem(k));
      setAuthed(false);
      window.location.href = "/auth/login";
    }} style={{ fontSize: "13px", fontWeight: 600, color: "#78716c", background: "none", border: "1px solid rgba(0,0,0,0.07)", borderRadius: "8px", padding: "6px 14px", cursor: "pointer", fontFamily: "inherit" }}>
      Sign out
    </button>
  );
}

function scoreColor(score: number): string {
  if (score >= 80) return GREEN;
  if (score >= 50) return AMBER;
  return RED;
}

function scoreBand(score: number): string {
  if (score >= 91) return "Excellent";
  if (score >= 71) return "Good";
  if (score >= 51) return "Fair";
  if (score >= 31) return "Weak";
  return "Poor";
}

function effortLabel(effort: string): string {
  if (effort === "quick") return "5 min";
  if (effort === "medium") return "30 min";
  return "1–2 hrs";
}

function impactLabel(impact: string): string {
  if (impact === "high") return "HIGH IMPACT";
  if (impact === "medium") return "MED IMPACT";
  return "LOW IMPACT";
}

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      style={{
        background: copied ? GREEN : CARD_ALT,
        color: copied ? "#fff" : TEXT_2,
        border: `1px solid ${BORDER}`,
        borderRadius: "6px", padding: "6px 14px",
        fontSize: "12px", cursor: "pointer", fontWeight: 600,
      }}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function SectionCard({ children, style, className }: { children: React.ReactNode; style?: React.CSSProperties; className?: string }) {
  return (
    <div className={className} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: "12px", padding: "24px", ...style }}>
      {children}
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      background: color + "18", color,
      border: `1px solid ${color}40`,
      borderRadius: "100px", padding: "2px 10px",
      fontSize: "11px", fontWeight: 700,
      textTransform: "uppercase" as const, letterSpacing: "0.05em",
    }}>
      {label}
    </span>
  );
}

function ScoreBandLegend() {
  const bands: { range: string; label: string; color: string }[] = [
    { range: "0–30",   label: "Poor",      color: RED   },
    { range: "31–50",  label: "Weak",      color: RED   },
    { range: "51–70",  label: "Fair",      color: AMBER },
    { range: "71–90",  label: "Good",      color: GREEN },
    { range: "91–100", label: "Excellent", color: GREEN },
  ];
  return (
    <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" as const, marginTop: "10px" }}>
      {bands.map(b => (
        <span key={b.label} style={{ fontSize: "11px", color: TEXT_2 }}>
          <span style={{ color: b.color, fontWeight: 700 }}>{b.range}</span> {b.label}
        </span>
      ))}
    </div>
  );
}

function ScanSummaryBar({ crawlCount, lastCrawlAt, pillarCount, criticalCount }: {
  crawlCount: number | null;
  lastCrawlAt: string | null;
  pillarCount: number;
  criticalCount: number;
}) {
  const dateStr = fmtDate(lastCrawlAt);
  const items = [
    crawlCount != null ? `${crawlCount} pages crawled` : null,
    `${pillarCount} pillars`,
    criticalCount > 0 ? `${criticalCount} critical issues` : null,
    dateStr ? `Last scanned ${dateStr}` : null,
  ].filter(Boolean) as string[];

  return (
    <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" as const, paddingTop: "16px", marginTop: "16px", borderTop: `1px solid ${BORDER}` }}>
      {items.map((item, i) => (
        <span key={i} style={{ fontSize: "12px", color: TEXT_2 }}>
          {i > 0 && <span style={{ color: TEXT_3, marginRight: "20px" }}>·</span>}
          {item}
        </span>
      ))}
    </div>
  );
}

// Trajectory SVG: baseline → current (solid) + current → projected (dashed)
function TrajectoryChart({ baselineScore, currentScore, projectedScore }: {
  baselineScore: number | null;
  currentScore: number;
  projectedScore: number;
}) {
  const W = 260, H = 110;
  const PAD = { top: 22, right: 44, bottom: 18, left: 44 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  type Pt = { score: number; label: string; isPast?: boolean; isCurrent?: boolean; isProjected?: boolean };
  const pts: Pt[] = [
    ...(baselineScore != null ? [{ score: baselineScore, label: `Baseline ${baselineScore}`, isPast: true }] : []),
    { score: currentScore, label: `Now ${currentScore}`, isCurrent: true },
    { score: projectedScore, label: `After fixes ${projectedScore}`, isProjected: true },
  ];

  const scores = pts.map(p => p.score);
  const lo = Math.max(0, Math.min(...scores) - 12);
  const hi = Math.min(100, Math.max(...scores) + 12);
  const n = pts.length;

  const xOf = (i: number) => PAD.left + (n <= 1 ? cW / 2 : (i / (n - 1)) * cW);
  const yOf = (s: number) => PAD.top + cH - ((s - lo) / (hi - lo || 1)) * cH;

  const currIdx = pts.findIndex(p => p.isCurrent);
  const projIdx = n - 1;

  const solidPts = pts.slice(0, currIdx + 1);
  const solidPath = solidPts.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(p.score).toFixed(1)}`).join(" ");
  const dashedPath = `M${xOf(currIdx).toFixed(1)},${yOf(pts[currIdx].score).toFixed(1)} L${xOf(projIdx).toFixed(1)},${yOf(pts[projIdx].score).toFixed(1)}`;

  const roundTo5 = (v: number) => Math.round(v / 5) * 5;
  const tickMid = roundTo5((lo + hi) / 2);
  const tickLo = roundTo5(lo);
  const tickHi = roundTo5(hi);
  const ticks = Array.from(new Set([tickLo, tickMid, tickHi]));

  return (
    <svg width={W} height={H} style={{ overflow: "visible", display: "block", maxWidth: "100%" }}>
      {ticks.map(tick => {
        const y = yOf(tick);
        return (
          <g key={tick}>
            <line x1={PAD.left} y1={y} x2={PAD.left + cW} y2={y} stroke="rgba(0,0,0,0.07)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y + 3} textAnchor="end"
              fill={TEXT_3} fontSize={8} fontFamily="system-ui,-apple-system,sans-serif">
              {tick}
            </text>
          </g>
        );
      })}
      {solidPath && (
        <path d={solidPath} fill="none" stroke={scoreColor(currentScore)} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      )}
      <path d={dashedPath} fill="none" stroke={GREEN} strokeWidth={2} strokeLinecap="round" strokeDasharray="5,4" />
      {pts.map((p, i) => {
        const x = xOf(i); const y = yOf(p.score);
        const clr = p.isProjected ? GREEN : scoreColor(p.score);
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={p.isCurrent ? 5 : 4}
              fill={clr} stroke={CARD} strokeWidth={2} />
            <text x={x} y={y - 10} textAnchor="middle"
              fill={clr} fontSize={9} fontWeight={p.isCurrent ? 700 : 500} fontFamily="system-ui,-apple-system,sans-serif">
              {p.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Score history chart (warm palette, current score labelled)
function ScoreChart({ entries, currentScore }: { entries: ChangeLogEntry[]; currentScore: number }) {
  const points = entries.length === 0
    ? [{ runAt: new Date().toISOString(), overallScore: currentScore }]
    : entries;

  const W = 500, H = 130;
  const PAD = { top: 16, right: 24, bottom: 30, left: 36 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  const scores = points.map(p => p.overallScore);
  const lo = Math.max(0, Math.min(...scores) - 10);
  const hi = Math.min(100, Math.max(...scores) + 10);

  const xOf = (i: number) => PAD.left + (points.length <= 1 ? cW / 2 : (i / (points.length - 1)) * cW);
  const yOf = (s: number) => PAD.top + cH - ((s - lo) / (hi - lo || 1)) * cH;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(p.overallScore).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${xOf(points.length - 1).toFixed(1)},${(PAD.top + cH).toFixed(1)} L${xOf(0).toFixed(1)},${(PAD.top + cH).toFixed(1)} Z`;

  const latest = points[points.length - 1];
  const prev = points.length >= 2 ? points[points.length - 2] : null;
  const delta = prev ? Math.round(latest.overallScore - prev.overallScore) : null;

  return (
    <div>
      {entries.length >= 2 && (
        <div style={{ display: "flex", alignItems: "baseline", gap: "12px", marginBottom: "16px" }}>
          <span style={{ fontSize: "36px", fontWeight: 800, color: scoreColor(currentScore) }}>{currentScore}</span>
          {delta !== null && (
            <span style={{ fontSize: "16px", fontWeight: 700, color: delta >= 0 ? GREEN : RED }}>
              {delta >= 0 ? "+" : ""}{delta} pts
            </span>
          )}
          {prev && (
            <span style={{ fontSize: "12px", color: TEXT_2 }}>
              vs {new Date(prev.runAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          )}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block", overflow: "hidden" }}>
        <defs>
          <linearGradient id="scoreGradWarm" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={scoreColor(currentScore)} stopOpacity="0.10" />
            <stop offset="100%" stopColor={scoreColor(currentScore)} stopOpacity="0" />
          </linearGradient>
        </defs>
        {(() => {
          const roundLo = Math.max(0, Math.floor(lo / 10) * 10);
          const roundHi = Math.min(100, Math.ceil(hi / 10) * 10);
          const midRaw = Math.round((roundLo + roundHi) / 2);
          const midRound = Math.round(midRaw / 5) * 5;
          const ticks = Array.from(new Set([roundLo, midRound, roundHi]));
          return ticks.map(v => (
            <g key={v}>
              <line x1={PAD.left} y1={yOf(v)} x2={PAD.left + cW} y2={yOf(v)} stroke={BORDER} strokeWidth={1} />
              <text x={PAD.left - 6} y={yOf(v) + 4} textAnchor="end" fill={TEXT_3} fontSize={10}>{v}</text>
            </g>
          ));
        })()}
        <path d={areaPath} fill="url(#scoreGradWarm)" />
        <path d={linePath} fill="none" stroke={scoreColor(currentScore)} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => {
          const isLast = i === points.length - 1;
          return (
            <g key={i}>
              <circle cx={xOf(i)} cy={yOf(p.overallScore)} r={isLast ? 6 : 3}
                fill={isLast ? scoreColor(p.overallScore) : scoreColor(p.overallScore) + "cc"}
                stroke={CARD} strokeWidth={isLast ? 2 : 1.5} />
              {isLast && (
                <text x={xOf(i)} y={yOf(p.overallScore) - 12} textAnchor="middle"
                  fill={scoreColor(currentScore)} fontSize={11} fontWeight={700} fontFamily="system-ui,-apple-system,sans-serif">
                  {p.overallScore}
                </text>
              )}
              <text x={xOf(i)} y={PAD.top + cH + 16} textAnchor="middle"
                fill={TEXT_3} fontSize={9} fontFamily="system-ui,-apple-system,sans-serif">
                {new Date(p.runAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </text>
            </g>
          );
        })}
      </svg>
      {entries.length > 0 && !entries[entries.length - 1].crawlQuality.usable && (
        <div style={{ marginTop: "10px", fontSize: "11px", color: AMBER }}>
          Warning: last crawl had quality issues — score may not reflect full site
        </div>
      )}
      {entries.length > 0 && entries[entries.length - 1].crawlQuality.blockedByAntiBot && (
        <div style={{ marginTop: "4px", fontSize: "11px", color: RED }}>
          Anti-bot protection blocked last crawl
        </div>
      )}
    </div>
  );
}

function PaywallOverlay({ onUpgrade, compact }: { onUpgrade: () => void; compact?: boolean }) {
  return (
    <div className="geo-paywall-overlay" style={{
      position: "absolute", inset: 0,
      backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
      background: "rgba(250,248,245,0.72)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 10, borderRadius: 12,
    }}>
      <div style={{ textAlign: "center", padding: 24 }}>
        {!compact && (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: TEXT, marginBottom: 8 }}>
              Upgrade to unlock full report
            </div>
            <p style={{ fontSize: 13, color: TEXT_2, marginBottom: 16 }}>
              100 credits for $10 — detailed findings, all recommendations, and generated files
            </p>
          </>
        )}
        <button onClick={onUpgrade} style={{
          padding: "10px 24px", background: ACCENT, color: "#fff",
          border: "none", borderRadius: 8, fontWeight: 600, cursor: "pointer", fontSize: 14,
        }}>
          Upgrade Now
        </button>
      </div>
    </div>
  );
}

// Gradient fade overlay — reveals text then fades to a color
function GradFade({ children, bgColor = BG, height = 64 }: { children: React.ReactNode; bgColor?: string; height?: number }) {
  return (
    <div style={{ position: "relative", overflow: "hidden" }}>
      {children}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height,
        background: `linear-gradient(to bottom, transparent, ${bgColor})`,
        pointerEvents: "none",
      }} />
    </div>
  );
}

// ─── Schema Blocks Card (Setup tab, paid-only) ─────────────────────────────

function SchemaBlocksCard({ schemas }: { schemas: SchemaBlock[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const sitewide: SchemaBlock[] = [];
  const homepage: SchemaBlock[] = [];
  const pages: Record<string, SchemaBlock[]> = {};
  const SITEWIDE_TYPES_SET = new Set(["Organization", "WebSite", "BreadcrumbList", "DefinedTerm", "SpeakableSpecification"]);

  for (const block of schemas) {
    if (block.type === "RobotsTxt") continue;
    const target = block.pageTarget?.trim().toLowerCase() ?? "";
    if (SITEWIDE_TYPES_SET.has(block.type) || target === "all pages") {
      sitewide.push(block);
    } else if (target === "homepage") {
      homepage.push(block);
    } else {
      const key = block.pageTarget ?? "unknown";
      if (!pages[key]) pages[key] = [];
      pages[key].push(block);
    }
  }

  const uniquePages = new Set([...Object.keys(pages), ...(homepage.length > 0 ? ["homepage"] : [])]);
  const totalNonSitewide = schemas.filter(b => b.type !== "RobotsTxt").length;

  let globalIdx = 0;

  const renderBlock = (block: SchemaBlock) => {
    const idx = globalIdx++;
    const isExpanded = expandedIdx === idx;
    return (
      <div key={idx} style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span style={{
            background: ACCENT + "18", color: ACCENT,
            padding: "2px 8px", borderRadius: "4px",
            fontSize: "10px", fontWeight: 600,
          }}>{block.type}</span>
          <span style={{ fontSize: "13px", color: TEXT }}>{block.name}</span>
          <button
            onClick={() => setExpandedIdx(isExpanded ? null : idx)}
            style={{
              background: "transparent", border: "none", color: TEXT_3,
              fontSize: "11px", cursor: "pointer", padding: "2px 6px",
            }}
          >{isExpanded ? "▼ collapse" : "▶ expand"}</button>
          <CopyButton text={JSON.stringify(block.jsonLd, null, 2)} />
        </div>
        {isExpanded && (
          <pre style={{
            background: CARD, border: `1px solid ${BORDER}`, borderRadius: "6px",
            padding: "12px", fontSize: "11px", color: TEXT_2,
            overflow: "auto", maxHeight: "300px", margin: "4px 0 0",
          }}>{JSON.stringify(block.jsonLd, null, 2)}</pre>
        )}
      </div>
    );
  };

  return (
    <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: "24px" }}>
      <h3 style={{ fontSize: "15px", fontWeight: 700, margin: "0 0 6px", color: TEXT }}>Schema Blocks</h3>
      <p style={{ fontSize: "13px", color: TEXT_2, margin: "0 0 16px" }}>
        {totalNonSitewide} blocks across {uniquePages.size} pages
      </p>

      {sitewide.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", color: TEXT_3, textTransform: "uppercase" as const, fontWeight: 600, marginBottom: "8px" }}>Sitewide</div>
          {sitewide.map(renderBlock)}
        </div>
      )}

      {homepage.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", color: TEXT_3, textTransform: "uppercase" as const, fontWeight: 600, marginBottom: "8px" }}>Homepage</div>
          {homepage.map(renderBlock)}
        </div>
      )}

      {Object.entries(pages).map(([pageUrl, blocks]) => (
        <div key={pageUrl} style={{ marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
            <div style={{ fontSize: "11px", color: TEXT_3, textTransform: "uppercase" as const, fontWeight: 600 }}>{pageUrl}</div>
            <CopyButton text={`<script type="application/ld+json">${(blocks.length === 1 ? JSON.stringify(blocks[0].jsonLd) : JSON.stringify(blocks.map(b => b.jsonLd))).replace(/<\//g, "<\\/")}</script>`} />
            <span style={{ fontSize: "10px", color: TEXT_3 }}>Copy all for this page</span>
          </div>
          {blocks.map(renderBlock)}
        </div>
      ))}
    </div>
  );
}

// ─── Page-by-Page Analysis Section ──────────────────────────────────────────

interface PerPageFixUI {
  url: string;
  pageType: string;
  currentTitle: string;
  suggestedTitle: string | null;
  suggestedMetaDescription: string | null;
  h1Fix: string | null;
  headingFixes: string | null;
  pillarFixes: Array<{ pillar: string; pillarName: string; fix: string; fixScope: string }>;
  matchedSchemaBlocks: string[];
}

interface ImplStatusUI {
  url: string;
  fixes: Array<{ fixType: string; suggested: string; implemented: boolean; currentValue: string | null }>;
  implementedCount: number;
  totalFixes: number;
}

function PageByPageSection({ site, schemas }: { site: SiteData; schemas: SchemaBlock[] }) {
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [healthFilter, setHealthFilter] = useState<"all" | "good" | "needs-work" | "poor">("all");
  const ppIsFirstAudit = (site.freeRunNumber ?? 1) === 1;
  const ppIsSubscriber = (site.subscriptionTier ?? "free") !== "free";
  const ppIsGated = site.tier === "free" && !ppIsFirstAudit && !ppIsSubscriber;

  const perPageFixes = (site.perPageFixes as PerPageFixUI[] | null | undefined) ?? [];
  const implStatus = (site.implementationStatus as ImplStatusUI[] | null | undefined) ?? [];
  const implByUrl = new Map(implStatus.map((s) => [s.url, s]));
  const healthByUrl = new Map((site.perPageResults as Array<{ url: string; overallPageHealth: string }> | null ?? []).map((r) => [r.url, r.overallPageHealth]));

  const COLORS = { good: "#22c55e", "needs-work": "#f59e0b", poor: "#ef4444" };
  const PAGE_SIZE = 20;

  // Filter and sort
  const filtered = perPageFixes.filter((f) => {
    if (healthFilter === "all") return true;
    // Derive health from fix count as a heuristic
    const count = [f.suggestedTitle, f.h1Fix, f.suggestedMetaDescription].filter(Boolean).length + f.pillarFixes.length;
    if (healthFilter === "good") return count === 0;
    if (healthFilter === "needs-work") return count >= 1 && count <= 2;
    if (healthFilter === "poor") return count >= 3;
    return true;
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (site.pipelineStatus !== "complete") return null;

  return (
    <section id="section-pages" style={{ marginBottom: "40px" }}>
      <h2 style={{ fontSize: "17px", fontWeight: 700, marginBottom: "14px", color: "#f5f5f5" }}>Page-by-Page Analysis</h2>

      {ppIsGated ? (
        /* Free tier: show health distribution counts but gate fix details */
        <SectionCard style={{ padding: "24px" }}>
          <div style={{ display: "flex", gap: "24px", marginBottom: "16px" }}>
            {(["good", "needs-work", "poor"] as const).map((h) => {
              const count = (site.perPageResults as Array<{ overallPageHealth: string }> | null ?? []).filter((r) => r.overallPageHealth === h).length;
              return (
                <div key={h} style={{ textAlign: "center" as const }}>
                  <div style={{ fontSize: "28px", fontWeight: 700, color: COLORS[h] }}>{count}</div>
                  <div style={{ fontSize: "12px", color: "#a3a3a3", textTransform: "capitalize" as const }}>{h.replace("-", " ")}</div>
                </div>
              );
            })}
          </div>
          <div style={{ position: "relative" as const, padding: "24px", background: "#171717", borderRadius: "8px", filter: "blur(4px)", userSelect: "none" as const }}>
            <div style={{ fontSize: "13px", color: "#d4d4d4" }}>Suggested title fix: Add location keywords and service type…</div>
          </div>
          <div style={{ marginTop: "12px", textAlign: "center" as const }}>
            <span style={{ fontSize: "13px", color: "#a3a3a3" }}>Upgrade to Pro to see fix details and suggested copy</span>
          </div>
        </SectionCard>
      ) : perPageFixes.length === 0 ? (
        <SectionCard style={{ padding: "24px" }}>
          <p style={{ color: "#a3a3a3", fontSize: "13px" }}>Per-page fix data will be available after your next audit run.</p>
        </SectionCard>
      ) : (
        <SectionCard style={{ padding: "0", overflow: "hidden" }}>
          {/* Filter bar */}
          <div style={{ display: "flex", gap: "8px", padding: "14px 20px", borderBottom: "1px solid #262626", flexWrap: "wrap" as const }}>
            {(["all", "good", "needs-work", "poor"] as const).map((h) => (
              <button key={h} onClick={() => { setHealthFilter(h); setPage(0); }}
                style={{ padding: "4px 12px", borderRadius: "100px", border: `1px solid ${healthFilter === h ? "#a3a3a3" : "#333"}`, background: healthFilter === h ? "#262626" : "transparent", color: healthFilter === h ? "#f5f5f5" : "#a3a3a3", fontSize: "12px", cursor: "pointer", fontWeight: 500 }}>
                {h === "all" ? "All" : h.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
              </button>
            ))}
            <span style={{ marginLeft: "auto", fontSize: "12px", color: "#737373", alignSelf: "center" }}>{filtered.length} pages</span>
          </div>

          {/* Card list */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "14px 20px 20px" }}>
            {visible.map((fix) => {
              const schemaCount = schemas.filter((block) => {
                const target = block.pageTarget ?? "all pages";
                try { return matchesPageTarget(target, new URL(fix.url).pathname); } catch { return matchesPageTarget(target, fix.url); }
              }).length;
              const fixCount = [fix.suggestedTitle, fix.h1Fix, fix.suggestedMetaDescription].filter(Boolean).length + fix.pillarFixes.length + schemaCount;
              const impl = implByUrl.get(fix.url);
              const isExpanded = expandedUrl === fix.url;
              const health = healthByUrl.get(fix.url);
              const healthColor = health ? COLORS[health as keyof typeof COLORS] : null;
              return (
                <div key={fix.url} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: "10px", overflow: "hidden" }}>
                  <div
                    onClick={() => setExpandedUrl(isExpanded ? null : fix.url)}
                    style={{ display: "flex", alignItems: "center", gap: "12px", padding: "14px 18px", cursor: "pointer", background: isExpanded ? CARD_ALT : CARD }}
                    onMouseOver={(e) => !isExpanded && (e.currentTarget.style.background = CARD_ALT + "88")}
                    onMouseOut={(e) => !isExpanded && (e.currentTarget.style.background = CARD)}
                  >
                    <a href={fix.url} target="_blank" rel="noopener noreferrer"
                      style={{ flex: 1, color: "#60a5fa", fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, minWidth: 0 }}
                      onClick={(e) => e.stopPropagation()}>
                      {fix.url.replace(/^https?:\/\//, "")}
                    </a>
                    <span style={{ background: fixCount === 0 ? "#14532d" : fixCount <= 2 ? "#854d0e" : "#991b1b", color: fixCount === 0 ? "#86efac" : fixCount <= 2 ? "#fde047" : "#fca5a5", padding: "2px 8px", borderRadius: "100px", fontSize: "10px", fontWeight: 700, whiteSpace: "nowrap" as const }}>
                      {fixCount} {fixCount === 1 ? "fix" : "fixes"}
                    </span>
                    {healthColor && (
                      <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "100px", background: healthColor + "20", color: healthColor, border: `1px solid ${healthColor}40`, whiteSpace: "nowrap" as const }}>
                        {health!.replace("-", " ")}
                      </span>
                    )}
                    {impl && <span style={{ fontSize: "11px", color: TEXT_3, whiteSpace: "nowrap" as const }}>{impl.implementedCount}/{impl.totalFixes} done</span>}
                    <span style={{ color: TEXT_3, fontSize: "12px", flexShrink: 0 }}>{isExpanded ? "▲" : "▼"}</span>
                  </div>
                  {isExpanded && (
                    <div style={{ padding: "16px 18px 18px", borderTop: `1px solid ${BORDER}` }}>
                      {fix.suggestedTitle && (
                        <div style={{ marginBottom: "12px" }}>
                          <div style={{ fontSize: "11px", color: TEXT_3, textTransform: "uppercase" as const, fontWeight: 600, marginBottom: "4px" }}>Title</div>
                          <div style={{ fontSize: "12px", color: TEXT_2 }}>Current: {fix.currentTitle || "(none)"}</div>
                          <div style={{ fontSize: "13px", color: TEXT, marginTop: "2px" }}>→ {fix.suggestedTitle}
                            {impl?.fixes.find(f => f.fixType === "title")?.implemented && <span style={{ marginLeft: "8px", background: "#14532d", color: "#86efac", padding: "1px 6px", borderRadius: "4px", fontSize: "10px" }}>✓ Done</span>}
                          </div>
                        </div>
                      )}
                      {fix.suggestedMetaDescription && (
                        <div style={{ marginBottom: "12px" }}>
                          <div style={{ fontSize: "11px", color: TEXT_3, textTransform: "uppercase" as const, fontWeight: 600, marginBottom: "4px" }}>Meta Description</div>
                          <div style={{ fontSize: "13px", color: TEXT }}>{fix.suggestedMetaDescription}</div>
                        </div>
                      )}
                      {fix.h1Fix && (
                        <div style={{ marginBottom: "12px" }}>
                          <div style={{ fontSize: "11px", color: TEXT_3, textTransform: "uppercase" as const, fontWeight: 600, marginBottom: "4px" }}>H1</div>
                          <div style={{ fontSize: "13px", color: TEXT }}>{fix.h1Fix}
                            {impl?.fixes.find(f => f.fixType === "h1")?.implemented && <span style={{ marginLeft: "8px", background: "#14532d", color: "#86efac", padding: "1px 6px", borderRadius: "4px", fontSize: "10px" }}>✓ Done</span>}
                          </div>
                        </div>
                      )}
                      {fix.headingFixes && (
                        <div style={{ marginBottom: "12px" }}>
                          <div style={{ fontSize: "11px", color: TEXT_3, textTransform: "uppercase" as const, fontWeight: 600, marginBottom: "4px" }}>Heading Structure</div>
                          <div style={{ fontSize: "13px", color: TEXT }}>{fix.headingFixes}</div>
                        </div>
                      )}
                      {fix.pillarFixes.map((pf, pi) => (
                        <div key={pi} style={{ marginBottom: "8px" }}>
                          <span style={{ background: "#854d0e", color: "#fde047", padding: "2px 6px", borderRadius: "4px", fontSize: "10px", fontWeight: 600, marginRight: "6px" }}>{pf.pillarName}</span>
                          <span style={{ fontSize: "10px", color: TEXT_3, marginRight: "8px" }}>Site-side change</span>
                          <span style={{ fontSize: "13px", color: TEXT }}>{pf.fix}</span>
                        </div>
                      ))}
                      {(() => {
                        const matchedBlocks = schemas.filter((block) => {
                          const target = block.pageTarget ?? "all pages";
                          try {
                            const urlPath = new URL(fix.url).pathname;
                            return matchesPageTarget(target, urlPath);
                          } catch {
                            return matchesPageTarget(target, fix.url);
                          }
                        });
                        if (matchedBlocks.length === 0) return null;
                        return (
                          <div style={{ marginTop: "8px" }}>
                            <div style={{ fontSize: "11px", color: TEXT_3, textTransform: "uppercase" as const, fontWeight: 600, marginBottom: "6px" }}>Recommended Schema</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                              {matchedBlocks.map((block, bi) => (
                                <div key={bi} style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                  <span style={{
                                    background: ACCENT + "18", color: ACCENT,
                                    padding: "2px 8px", borderRadius: "4px",
                                    fontSize: "10px", fontWeight: 600,
                                  }}>{block.type}</span>
                                  <span style={{ fontSize: "13px", color: TEXT }}>{block.name}</span>
                                  <CopyButton text={JSON.stringify(block.jsonLd, null, 2)} />
                                </div>
                              ))}
                            </div>
                            <div style={{ marginTop: "8px" }}>
                              <CopyButton text={`<script type="application/ld+json">${(matchedBlocks.length === 1 ? JSON.stringify(matchedBlocks[0].jsonLd) : JSON.stringify(matchedBlocks.map(b => b.jsonLd))).replace(/<\//g, "<\\/")}</script>`} />
                              <span style={{ fontSize: "11px", color: TEXT_3, marginLeft: "8px" }}>Copy all for this page</span>
                            </div>
                            {impl?.fixes.find(f => f.fixType === "schema")?.implemented && <span style={{ marginLeft: "8px", background: "#14532d", color: "#86efac", padding: "1px 6px", borderRadius: "4px", fontSize: "10px" }}>✓ Done</span>}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "center" as const, gap: "8px", padding: "14px 20px", borderTop: "1px solid #262626" }}>
              <button disabled={page === 0} onClick={() => setPage(p => p - 1)} style={{ padding: "4px 12px", border: "1px solid #333", borderRadius: "6px", background: "transparent", color: page === 0 ? "#737373" : "#d4d4d4", cursor: page === 0 ? "not-allowed" : "pointer", fontSize: "12px" }}>← Prev</button>
              <span style={{ fontSize: "12px", color: "#737373", alignSelf: "center" }}>Page {page + 1} of {totalPages}</span>
              <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} style={{ padding: "4px 12px", border: "1px solid #333", borderRadius: "6px", background: "transparent", color: page >= totalPages - 1 ? "#737373" : "#d4d4d4", cursor: page >= totalPages - 1 ? "not-allowed" : "pointer", fontSize: "12px" }}>Next →</button>
            </div>
          )}
        </SectionCard>
      )}
    </section>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ResultsDashboard({ site: initialSite, onRegenerate }: { site: SiteData; onRegenerate?: () => void }) {
  const router = useRouter();
  const [site, setSite] = useState(initialSite);
  const [pillarFilter, setPillarFilter] = useState<"all" | "critical">("all");
  const [expandedPillar, setExpandedPillar] = useState<string | null>(null);
  const [expandedRec, setExpandedRec] = useState<number | null>(null);
  const [integrationTab, setIntegrationTab] = useState<"vercel" | "netlify" | "cloudflare" | "nginx" | "wordpress" | "apache" | "other">("vercel");
  const [otherPlatform, setOtherPlatform] = useState("");
  const [otherConfig, setOtherConfig] = useState<string | null>(null);
  const [otherLoading, setOtherLoading] = useState(false);
  const [otherError, setOtherError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [verifyingDomain, setVerifyingDomain] = useState(false);
  const [domainVerifyResult, setDomainVerifyResult] = useState<{ verified: boolean; found: string[] } | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{ connected: boolean; detail: string } | null>(null);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [retryResult, setRetryResult] = useState<{ siteId: string; accessToken: string; urlCount: number } | null>(null);

  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const handleUpgrade = () => setShowUpgradeModal(true);

  // Subscription-aware gating: first audit (freeRunNumber === 1) is always ungated
  const isFirstAudit = (site.freeRunNumber ?? 1) === 1;
  const subscriptionTier = site.subscriptionTier ?? "free";
  const isSubscriber = subscriptionTier !== "free";
  // Effective gating: ungated if first audit, subscriber, or paid (legacy credits)
  const isGated = site.tier === "free" && !isFirstAudit && !isSubscriber;

  // Crawl controls state
  const [crawlFreq, setCrawlFreq] = useState(site.crawlFrequency ?? "manual");
  const [selectedPagesList, setSelectedPagesList] = useState<string[]>(site.selectedPages ?? []);
  const [savingCrawlSettings, setSavingCrawlSettings] = useState(false);
  const [showPageSelector, setShowPageSelector] = useState(false);

  const isComplete = site.pipelineStatus === "complete";
  const isStoppedStatus = isComplete || site.pipelineStatus === "failed" || site.pipelineStatus === "pending";
  const hasPerPageResults = Array.isArray(site.perPageResults) && (site.perPageResults as unknown[]).length > 0;

  const poll = useCallback(async () => {
    if (isStoppedStatus) return;
    try {
      const res = await fetch("/api/sites/" + site.id + "?token=" + site.token);
      if (res.ok) {
        const data = await res.json() as SiteData;
        setSite((prev) => ({ ...data, token: prev.token }));
      }
    } catch { /* ignore */ }
  }, [site.id, site.token, isStoppedStatus]);

  useEffect(() => {
    if (isStoppedStatus) return;
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [poll, isStoppedStatus]);

  // Credits: refresh when CitationMonitor dispatches "geo:credits-changed"
  useEffect(() => {
    function handleCreditsChanged() {
      if (!site.token) return;
      fetch(`/api/sites/${site.id}?token=${site.token}`)
        .then(r => r.ok ? r.json() as Promise<SiteData> : null)
        .then(data => { if (data?.credits !== undefined) setSite(prev => ({ ...prev, credits: data.credits })); })
        .catch(() => {});
    }
    window.addEventListener("geo:credits-changed", handleCreditsChanged);
    return () => window.removeEventListener("geo:credits-changed", handleCreditsChanged);
  }, [site.id, site.token]);

  // Show toast if returning from Stripe with payment=success
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") === "success") {
      toast.success("Payment successful — credits added!");
      // Clean the URL without reload
      params.delete("payment");
      const clean = params.toString();
      const newUrl = window.location.pathname + (clean ? `?${clean}` : "");
      window.history.replaceState({}, "", newUrl);
      // Re-fetch site data to update credits display
      fetch("/api/sites/" + initialSite.id + "?token=" + initialSite.token)
        .then(r => r.ok ? r.json() as Promise<SiteData> : null)
        .then(data => { if (data) setSite(prev => ({ ...data, token: prev.token })); })
        .catch(() => {});
    }
  }, []);

  // Payment polling: after pipeline complete, poll for tier upgrade (free → paid)
  useEffect(() => {
    if (site.tier !== "free" || site.pipelineStatus !== "complete") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/sites/${site.id}?token=${site.token}`);
        if (res.ok) {
          const data = await res.json() as SiteData;
          if (data.tier === "paid") {
            setSite((prev) => ({ ...data, token: prev.token }));
            toast.success("Upgrade complete! Full report unlocked.");
            clearInterval(interval);
          }
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [site.tier, site.pipelineStatus, site.id, site.token]);

  const scorecard    = site.geoScorecard as GeoScorecard | null;
  const rankedRecs   = site.rankedRecommendations ?? [];
  const schemas      = (site.generatedSchemaBlocks as SchemaBlock[] | null) ?? [];
  const manualRunsLeft = isGated ? 0 : 4 - (site.manualRunsThisMonth ?? 0);
  const overallScore = Math.round(scorecard?.overallScore ?? 0);
  const projectedScore = Math.round(site.projectedScore ?? overallScore);
  const changeLog    = site.changeLog ?? [];
  const prevEntry    = changeLog.length >= 2 ? changeLog[changeLog.length - 2] : null;
  const scoreDelta   = prevEntry ? Math.round(overallScore - prevEntry.overallScore) : null;

  const sortedPillars  = [...(scorecard?.pillars ?? [])].sort((a, b) => a.score - b.score);
  const criticalPillars = sortedPillars.filter(p => p.score < 50);
  const filteredPillars = pillarFilter === "critical" ? criticalPillars : sortedPillars;

  // Shared filter also applies to recs: "critical" = effort quick OR pillar score < 50
  const criticalPillarNames = new Set(criticalPillars.map(p => p.pillar));
  const filteredRecs = pillarFilter === "critical"
    ? rankedRecs.filter(r => r.effort === "quick" || criticalPillarNames.has(r.pillar))
    : rankedRecs;

  async function handleRegenerate() {
    if (manualRunsLeft <= 0) return;
    setRegenerating(true);
    try {
      const res = await fetch("/api/sites/" + site.id + "/regenerate", {
        method: "POST", headers: { Authorization: "Bearer " + site.token },
      });
      if (res.ok) {
        // ES-B10 AC-B10-11: in-place rerun — server UPDATEd the same site
        // row. Trigger optimistic state refresh + server-prop reload.
        onRegenerate?.();
        router.refresh();
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast.error(body.error ?? "Failed to start regeneration");
      }
    } catch { /* ignore */ } finally { setRegenerating(false); }
  }

  async function handleVerifyDomain() {
    setVerifyingDomain(true);
    setDomainVerifyResult(null);
    try {
      const res = await fetch("/api/sites/" + site.id + "/verify-domain", {
        method: "POST", headers: { Authorization: "Bearer " + site.token },
      });
      const data = await res.json() as { verified: boolean; found: string[] };
      setDomainVerifyResult(data);
      if (data.verified) setSite((prev) => ({ ...prev, domainVerified: true }));
    } catch {
      setDomainVerifyResult({ verified: false, found: [] });
    } finally { setVerifyingDomain(false); }
  }

  async function handleTestConnection() {
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      const res = await fetch("/api/sites/" + site.id + "/verify-connection", {
        method: "POST", headers: { Authorization: "Bearer " + site.token },
      });
      const data = await res.json() as { connected: boolean; detail: string };
      setConnectionResult(data);
    } catch {
      setConnectionResult({ connected: false, detail: "Network error" });
    } finally { setTestingConnection(false); }
  }

  async function handleOtherPlatform() {
    if (!otherPlatform.trim()) return;
    setOtherLoading(true);
    setOtherConfig(null);
    setOtherError(null);
    try {
      const res = await fetch("/api/integration-instructions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + site.token },
        body: JSON.stringify({ platform: otherPlatform, siteId: site.id }),
      });
      const data = await res.json() as { instructions?: string; error?: string };
      if (data.instructions) setOtherConfig(data.instructions);
      else setOtherError(data.error ?? "Failed to generate instructions");
    } catch {
      setOtherError("Network error");
    } finally { setOtherLoading(false); }
  }

  async function handleRetryFailed(urls?: string[]) {
    setRetryingFailed(true);
    try {
      const res = await fetch(`/api/sites/${site.id}/retry-failed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + site.token },
        body: urls ? JSON.stringify({ urls }) : "{}",
      });
      const data = await res.json() as { siteId?: string; accessToken?: string; urlCount?: number; error?: string };
      if (res.ok && data.siteId) {
        setRetryResult({ siteId: data.siteId, accessToken: data.accessToken!, urlCount: data.urlCount! });
      } else {
        toast.error(data.error ?? "Failed to start retry.");
      }
    } catch { toast.error("Network error — retry failed."); }
    finally { setRetryingFailed(false); }
  }

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }

  const slug    = site.slug ?? site.id;
  const geoBase = `https://geo.flowblinq.com/api/serve/${slug}`;

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

  const pixelTag = `<img src="https://geo.flowblinq.com/api/t/${site.slug}" width="1" height="1" alt="" style="position:absolute;opacity:0" />`;
  const scriptTag = `<script src="https://geo.flowblinq.com/api/t/${site.slug}" async></script>`;
  const cspNote = `// NOTE: If you have a Content-Security-Policy, add https://geo.flowblinq.com to img-src, script-src, and connect-src`;

  // Platform-specific server-side referrer capture snippets.
  // LinkedIn and Twitter strip document.referrer via rel="noreferrer".
  // Reading the HTTP Referer header server-side and storing it in a first-party
  // cookie (_geo_ref) lets the GEO beacon attribute traffic correctly.
  const referrerSteps: Record<string, string> = {
    vercel: `// Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
// Add to middleware.ts (or create it at the root of your project)
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export function middleware(request: NextRequest) {
  const response = NextResponse.next()
  const ref = request.headers.get("referer") ?? ""
  if (!request.cookies.has("_geo_ref") && ref) {
    response.cookies.set("_geo_ref", ref, {
      maxAge: 1800, sameSite: "strict", secure: true, httpOnly: false, path: "/",
    })
  }
  return response
}
export const config = { matcher: ["/((?!api|_next|.*\\..*).*)"] }`,

    netlify: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Create netlify/edge-functions/geo-ref.ts
export default async (request: Request, context: any) => {
  const response = await context.next()
  const ref = request.headers.get("referer") ?? ""
  const cookies = request.headers.get("cookie") ?? ""
  if (!cookies.includes("_geo_ref=") && ref) {
    response.headers.append(
      "Set-Cookie",
      \`_geo_ref=\${encodeURIComponent(ref)}; Max-Age=1800; SameSite=Strict; Secure; Path=/\`
    )
  }
  return response
}
export const config = { path: "/*" }`,

    cloudflare: `// Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
// Add to your Cloudflare Worker fetch handler
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const response = await fetch(request)
  const ref = request.headers.get('Referer') || ''
  const cookies = request.headers.get('Cookie') || ''
  if (ref && !cookies.includes('_geo_ref=')) {
    const modified = new Response(response.body, response)
    modified.headers.append(
      'Set-Cookie',
      \`_geo_ref=\${encodeURIComponent(ref)}; Max-Age=1800; SameSite=Strict; Secure; Path=/\`
    )
    return modified
  }
  return response
}`,

    nginx: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Add inside your server {} block in nginx.conf
# Sets _geo_ref cookie when HTTP Referer is present and cookie not yet set
map $http_referer $geo_ref_cookie {
    default "_geo_ref=$http_referer; Max-Age=1800; SameSite=Strict; Secure; Path=/";
    ""      "";
}
# In location / block:
add_header Set-Cookie $geo_ref_cookie always;`,

    wordpress: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Add to functions.php
add_action('init', function() {
    if (!isset($_COOKIE['_geo_ref']) && !empty($_SERVER['HTTP_REFERER'])) {
        setcookie('_geo_ref', $_SERVER['HTTP_REFERER'], [
            'expires'  => time() + 1800,
            'path'     => '/',
            'secure'   => true,
            'httponly' => false,
            'samesite' => 'Strict',
        ]);
    }
});`,

    apache: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Add to a PHP file loaded on every request (e.g. wp-config.php or a mu-plugin)
<?php
if (!isset($_COOKIE['_geo_ref']) && !empty($_SERVER['HTTP_REFERER'])) {
    setcookie('_geo_ref', $_SERVER['HTTP_REFERER'], [
        'expires'  => time() + 1800,
        'path'     => '/',
        'secure'   => true,
        'httponly' => false,
        'samesite' => 'Strict',
    ]);
}`,
  };

  const integrationConfigs: Record<string, string> = {
    vercel: `// Step 1 — vercel.json (rewrites for AI-facing files)
{
  "rewrites": [
    { "source": "/llms.txt", "destination": "${geoBase}/llms.txt" },
    { "source": "/llms-full.txt", "destination": "${geoBase}/llms-full.txt" },
    { "source": "/.well-known/ucp.json", "destination": "${geoBase}/business.json" }
  ]
}

// Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
${pixelTag}

// Step 3 — (Optional) Add schema injection for AI bots
${cspNote}
${scriptTag}

${referrerSteps.vercel}

${robotsBlock}`,

    netlify: `# Step 1 — netlify.toml (rewrites for AI-facing files)
[[redirects]]
  from = "/llms.txt"
  to = "${geoBase}/llms.txt"
  status = 200

[[redirects]]
  from = "/llms-full.txt"
  to = "${geoBase}/llms-full.txt"
  status = 200

[[redirects]]
  from = "/.well-known/ucp.json"
  to = "${geoBase}/business.json"
  status = 200

# Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
# ${pixelTag}

# Step 3 — (Optional) Add schema injection for AI bots
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to script-src and connect-src
# ${scriptTag}

${referrerSteps.netlify}

${robotsBlock}`,

    cloudflare: `// Step 1 — Cloudflare Worker routes (rewrites for AI-facing files)
addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const routes = {
    '/llms.txt': '${geoBase}/llms.txt',
    '/llms-full.txt': '${geoBase}/llms-full.txt',
    '/.well-known/ucp.json': '${geoBase}/business.json',
  };
  const dest = routes[url.pathname];
  if (dest) event.respondWith(fetch(dest));
});

// Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
// ${pixelTag}

// Step 3 — (Optional) Add schema injection for AI bots
${cspNote}
// ${scriptTag}

${referrerSteps.cloudflare}

${robotsBlock}`,

    nginx: `# Step 1 — nginx.conf proxy rules (rewrites for AI-facing files)
location = /llms.txt {
    proxy_pass ${geoBase}/llms.txt;
    proxy_set_header Host geo.flowblinq.com;
}
location = /llms-full.txt {
    proxy_pass ${geoBase}/llms-full.txt;
    proxy_set_header Host geo.flowblinq.com;
}
location = /.well-known/ucp.json {
    proxy_pass ${geoBase}/business.json;
    proxy_set_header Host geo.flowblinq.com;
}

# Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
# ${pixelTag}

# Step 3 — (Optional) Add schema injection for AI bots
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to script-src and connect-src
# ${scriptTag}

${referrerSteps.nginx}

${robotsBlock}`,

    wordpress: `# ── .htaccess ──
RewriteEngine On
RewriteRule ^llms\\.txt$ ${geoBase}/llms.txt [P,L]
RewriteRule ^llms-full\\.txt$ ${geoBase}/llms-full.txt [P,L]
RewriteRule ^\\.well-known/ucp\\.json$ ${geoBase}/business.json [P,L]
# ── END .htaccess ──

# ── functions.php ──
# Step 2 — Add tracking pixel (works everywhere, no config needed)
# add_action('wp_footer', function() {
#   echo '${pixelTag}' . "\\n";
# });

# Step 3 — (Optional) Add schema injection for AI bots
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to img-src, script-src, and connect-src
# add_action('wp_head', function() {
#   echo '${scriptTag}' . "\\n";
# });

${referrerSteps.wordpress}
# ── END functions.php ──

${robotsBlock}`,

    apache: `# Step 1 — .htaccess proxy rules (rewrites for AI-facing files)
RewriteEngine On
RewriteRule ^llms\\.txt$ ${geoBase}/llms.txt [P,L]
RewriteRule ^llms-full\\.txt$ ${geoBase}/llms-full.txt [P,L]
RewriteRule ^\\.well-known/ucp\\.json$ ${geoBase}/business.json [P,L]

# Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
# ${pixelTag}

# Step 3 — (Optional) Add schema injection for AI bots
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to script-src and connect-src
# ${scriptTag}

${referrerSteps.apache}

${robotsBlock}`,
  };

  // ─── Crawl metadata ───
  const crawlDateStr = fmtDate(site.lastCrawlAt);
  const crawlMeta = [
    site.crawlCount != null ? `${site.crawlCount} pages` : null,
    crawlDateStr,
  ].filter(Boolean).join(" · ");

  return (
    <main style={{
      minHeight: "100vh",
      background: BG,
      color: TEXT,
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      {showUpgradeModal && (
        <UpgradeModal
          credits={site.credits}
          domain={site.domain}
          sitePages={(() => {
            const d = site.discoveryData as { totalPages?: number; urls?: unknown[] } | null;
            return d?.totalPages ?? d?.urls?.length ?? 0;
          })()}
          returnTo={`/sites/${site.id}${site.token ? `?token=${encodeURIComponent(site.token)}` : ""}`}
          onClose={() => setShowUpgradeModal(false)}
        />
      )}
      <style>{`
        @media print {
          .geo-paywall-overlay {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
            background: #faf8f5 !important;
          }
          .geo-paywall-blur {
            visibility: hidden !important;
          }
        }
        @media (max-width: 768px) {
          .rd-header { padding: 10px 16px !important; flex-direction: column !important; align-items: stretch !important; gap: 6px !important; }
          /* Row 1 wraps: domain on line 1, action buttons wrap to line 2 */
          .rd-header-row1 { display: flex !important; align-items: center !important; gap: 8px; flex-wrap: wrap !important; }
          /* Left group takes full first line */
          .rd-header-row1 > div:first-child { flex: 1 1 100% !important; min-width: 0; }
          /* Actions drop to second line, left-aligned */
          .rd-header-actions { flex: 0 0 100% !important; justify-content: flex-start !important; flex-wrap: wrap !important; gap: 6px !important; }
          /* Nav pills row */
          .rd-header-row2 { display: flex !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch; gap: 6px; padding-bottom: 2px; }
          .rd-header-row2 button { white-space: nowrap; flex-shrink: 0; }
          .rd-domain { max-width: 180px !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
          .rd-crawl-meta { display: none !important; }
          .rd-action-label-long { display: none !important; }
          .rd-action-label-short { display: inline !important; }
        }
        @media (min-width: 769px) {
          .rd-header-row2 { display: contents; }
          .rd-action-label-long { display: inline !important; }
          .rd-action-label-short { display: none !important; }
        }
        @media (max-width: 640px) {
          .rd-pillar-preview { display: none !important; }
          .rd-rec-preview { display: none !important; }
          .rd-pillar-name { min-width: 80px !important; max-width: 120px !important; font-size: 12px !important; flex: 0 1 auto !important; }
          .rd-outer { padding: 16px 12px !important; }
          .rd-hero-card { padding: 16px !important; }
          .rd-hero-grid { grid-template-columns: 1fr !important; gap: 20px !important; }
          .rd-upgrade-banner { flex-direction: column !important; align-items: flex-start !important; padding: 14px 16px !important; }
          .rd-upgrade-banner button { align-self: stretch !important; }
          .rd-whats-costing { min-width: 0 !important; }
          /* Section headings */
          .rd-section-h2 { font-size: 15px !important; }
          /* Scorecard filter toggle */
          .rd-filter-toggle { flex-direction: column !important; align-items: flex-start !important; gap: 10px !important; }
          .rd-filter-toggle h2 { margin-bottom: 0 !important; }
          /* Pillar row — badge hidden to save space */
          .rd-pillar-badge { display: none !important; }
          /* Rec row — impact chip hidden, effort pill kept */
          .rd-rec-impact { display: none !important; }
          /* What's costing you — minWidth items */
          .rd-costing-name { min-width: 0 !important; width: 100px !important; font-size: 12px !important; flex-shrink: 0 !important; }
          .rd-costing-potential { display: none !important; }
          /* Improvement banner big score */
          .rd-improvement-banner { flex-direction: column !important; gap: 8px !important; }
          /* Score history chart container */
          .rd-score-chart { overflow-x: hidden !important; }
          /* Setup AI files grid */
          .rd-ai-files-grid { grid-template-columns: 1fr !important; }
          /* Integration tabs — scrollable */
          .rd-integration-tabs { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; flex-wrap: nowrap !important; }
          .rd-integration-tabs button { flex-shrink: 0 !important; }
          /* Setup section padding */
          .rd-setup-section { padding: 16px !important; }
          /* Credits footer */
          .rd-credits-footer { flex-direction: column !important; align-items: center !important; gap: 8px !important; text-align: center !important; }
          /* Upgrade banner text */
          .rd-upgrade-banner-title { font-size: 13px !important; }
          .rd-upgrade-banner-sub { font-size: 12px !important; margin-top: 2px !important; }
          /* Hero score number */
          .rd-hero-score { font-size: 52px !important; letter-spacing: -1px !important; }
          /* Improvement banner score numbers */
          .rd-improvement-score-before { font-size: 22px !important; }
          .rd-improvement-score-after { font-size: 18px !important; }
          /* Score History chart — remove extra padding */
          .rd-score-chart { padding: 14px !important; }
          /* Domain verify TXT record box */
          .rd-verify-txt { word-break: break-all !important; font-size: 11px !important; }
          /* SectionCard default padding fix */
          .rd-section-card-mobile { padding: 14px !important; }
        }
      `}</style>

      {/* ═══════════════════════════════════════════════════════════════════
          HEADER — sticky
      ═══════════════════════════════════════════════════════════════════ */}
      <header className="rd-header" style={{
        borderBottom: `1px solid ${BORDER}`,
        padding: "12px 32px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0,
        background: BG,
        zIndex: 100,
        gap: "8px",
      }}>
        {/* Row 1 (desktop: left group; mobile: full-width row) */}
        <div className="rd-header-row1" style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0, flex: 1 }}>
          {/* Left: back + domain + badge */}
          <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0, flex: 1 }}>
            <a href="/dashboard" style={{ fontSize: "12px", color: TEXT_2, textDecoration: "none", whiteSpace: "nowrap" as const, flexShrink: 0 }}>
              ← Dashboard
            </a>
            <span style={{ color: BORDER, flexShrink: 0 }}>|</span>
            <span className="rd-domain" style={{ fontSize: "15px", fontWeight: 600, color: TEXT, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>
              {site.domain}
            </span>
            <span title={site.pipelineStatus === "complete" ? "GEO scan complete" : undefined} style={{ flexShrink: 0 }}>
              <Badge
                label={site.pipelineStatus === "complete" ? "Complete" : site.pipelineStatus ?? "pending"}
                color={site.pipelineStatus === "complete" ? GREEN : site.pipelineStatus === "failed" ? RED : AMBER}
              />
            </span>
            {crawlMeta && (
              <span className="rd-crawl-meta" style={{ fontSize: "12px", color: TEXT_2, whiteSpace: "nowrap" as const }}>{crawlMeta}</span>
            )}
          </div>

          {/* Right actions — always visible */}
          <div className="rd-header-actions" style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
            {/* Credits pill */}
            <button onClick={handleUpgrade} title="Buy more credits" style={{
              background: "#fef3c7", color: "#b45309", border: "1px solid #fde68a",
              borderRadius: "100px", padding: "4px 12px",
              fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const,
            }}>
              {site.credits} credits
            </button>

            {site.auditMode !== "bulk" && (
              isGated ? (
                <button onClick={handleUpgrade} style={{
                  background: ACCENT, color: "#fff", border: "none",
                  borderRadius: "8px", padding: "6px 14px", fontSize: "13px",
                  cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" as const,
                }}>
                  <span className="rd-action-label-long">Upgrade to Re-run Audit</span>
                  <span className="rd-action-label-short">Upgrade</span>
                </button>
              ) : (
                <button onClick={handleRegenerate} disabled={regenerating || manualRunsLeft <= 0} title={`Re-run your GEO audit. You have ${manualRunsLeft} of 4 re-runs remaining this month.`} style={{
                  background: CARD_ALT, color: manualRunsLeft > 0 ? TEXT : TEXT_3,
                  border: `1px solid ${BORDER}`, borderRadius: "8px",
                  padding: "6px 14px", fontSize: "13px",
                  cursor: manualRunsLeft > 0 ? "pointer" : "not-allowed", fontWeight: 600, whiteSpace: "nowrap" as const,
                }}>
                  <span className="rd-action-label-long">{regenerating ? "Scanning…" : `Refresh My Score (${String(manualRunsLeft)}/4)`}</span>
                  <span className="rd-action-label-short">{regenerating ? "…" : "Refresh"}</span>
                </button>
              )
            )}
            {/* ZIP download — paid/ungated tier, audit complete, all modes */}
            {!isGated && site.pipelineStatus === "complete" && (
              <button
                onClick={hasPerPageResults ? () => { window.location.href = `/api/sites/${site.id}/download-report?token=${site.token}`; } : undefined}
                disabled={!hasPerPageResults}
                title={!hasPerPageResults ? "Rerun audit to generate per-page results" : "Download full audit report as ZIP"}
                style={{ padding: "6px 14px", background: hasPerPageResults ? "#14532d" : "#a1a1aa", color: hasPerPageResults ? "#86efac" : "#e4e4e7", border: hasPerPageResults ? "1px solid #166534" : "1px solid #d4d4d8", borderRadius: "8px", cursor: hasPerPageResults ? "pointer" : "not-allowed", fontWeight: 600, fontSize: "12px", whiteSpace: "nowrap" as const, opacity: hasPerPageResults ? 1 : 0.6 }}>
                Download ZIP
              </button>
            )}
            <AuthNavButton />
          </div>
        </div>

        {/* Row 2: nav pills — below on mobile, inline on desktop */}
        <div className="rd-header-row2" style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
          {["Summary", "Scorecard", "Recs", "Pages", "History", "Setup"].map((label, i) => {
            const ids = ["section-summary", "section-scorecard", "section-recommendations", "section-pages", "section-history", "section-setup"];
            return (
              <button key={label} onClick={() => scrollTo(ids[i])} style={{
                background: "transparent", border: `1px solid ${BORDER}`,
                borderRadius: "100px", padding: "4px 12px",
                fontSize: "11px", color: TEXT_2, cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap" as const,
              }}>
                {label}
              </button>
            );
          })}
        </div>
      </header>

      <div className="rd-outer" style={{ maxWidth: "1120px", margin: "0 auto", padding: "32px 24px" }}>

        {/* ═══════════════════════════════════════════════════════════════════
            HERO — three columns
        ═══════════════════════════════════════════════════════════════════ */}
        {overallScore > 0 && (
          <SectionCard className="rd-hero-card" style={{ marginBottom: "24px", padding: "28px 32px" }}>
            <div className="rd-hero-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: "32px", alignItems: "start" }}>

              {/* ── Left: score ── */}
              <div>
                <div className="rd-hero-score" style={{ fontSize: "72px", fontWeight: 800, lineHeight: 1, color: scoreColor(overallScore), letterSpacing: "-2px" }}>
                  {overallScore}
                </div>
                <div style={{ fontSize: "16px", fontWeight: 600, color: scoreColor(overallScore), marginTop: "4px" }}>
                  {scoreBand(overallScore)}
                </div>
                <div style={{ fontSize: "12px", color: TEXT_2, marginTop: "2px" }}>AI Visibility Score</div>

                {scoreDelta !== null && (
                  <div style={{
                    display: "inline-flex", alignItems: "center", gap: "4px",
                    marginTop: "10px", padding: "3px 10px",
                    background: (scoreDelta >= 0 ? GREEN : RED) + "12",
                    border: `1px solid ${(scoreDelta >= 0 ? GREEN : RED)}30`,
                    borderRadius: "100px",
                    fontSize: "12px", fontWeight: 700,
                    color: scoreDelta >= 0 ? GREEN : RED,
                  }}>
                    {scoreDelta >= 0 ? "▲" : "▼"} {scoreDelta >= 0 ? "+" : ""}{scoreDelta} from last scan
                  </div>
                )}

                {crawlMeta && (
                  <div style={{ marginTop: "10px", fontSize: "12px", color: TEXT_2 }}>
                    {crawlMeta}
                  </div>
                )}

                <ScoreBandLegend />
              </div>

              {/* ── Center: trajectory chart ── */}
              <div>
                <div style={{ fontSize: "12px", fontWeight: 600, color: TEXT_2, marginBottom: "12px", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>
                  Score Trajectory
                </div>
                <TrajectoryChart
                  baselineScore={site.baselineScore}
                  currentScore={overallScore}
                  projectedScore={projectedScore}
                />
                <div style={{ marginTop: "10px", fontSize: "12px", color: TEXT_2 }}>
                  You&apos;re{" "}
                  <span style={{ color: GREEN, fontWeight: 700 }}>{projectedScore - overallScore} pts</span>
                  {" "}away from a score of{" "}
                  <span style={{ color: GREEN, fontWeight: 700 }}>{projectedScore}</span>
                </div>
              </div>

              {/* ── Right: start here ── */}
              <div>
                <div style={{ fontSize: "12px", fontWeight: 600, color: TEXT_2, marginBottom: "12px", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>
                  Start Here
                </div>
                {rankedRecs.slice(0, 3).length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {rankedRecs.slice(0, 3).map((rec) => (
                      <div key={rec.rank}
                        onClick={() => scrollTo("section-recommendations")}
                        style={{
                          display: "flex", alignItems: "center", gap: "10px",
                          padding: "10px 14px",
                          background: CARD_ALT, border: `1px solid ${BORDER}`,
                          borderRadius: "8px", cursor: "pointer",
                        }}
                        onMouseOver={(e) => (e.currentTarget.style.background = "#ede8e3")}
                        onMouseOut={(e) => (e.currentTarget.style.background = CARD_ALT)}
                      >
                        <span style={{ fontSize: "12px", fontWeight: 700, color: TEXT_2, minWidth: "20px" }}>
                          #{rec.rank}
                        </span>
                        <span style={{ flex: 1, fontSize: "13px", fontWeight: 600, color: TEXT, lineHeight: 1.3 }}>
                          {rec.title}
                        </span>
                        {!isGated ? (
                          <span style={{
                            background: ACCENT + "18", color: ACCENT,
                            border: `1px solid ${ACCENT}30`, borderRadius: "100px",
                            padding: "2px 8px", fontSize: "10px", fontWeight: 700,
                            whiteSpace: "nowrap" as const,
                          }}>
                            {effortLabel(rec.effort)}
                          </span>
                        ) : (
                          <span className="geo-paywall-blur" style={{
                            background: BORDER, color: TEXT_3,
                            border: `1px solid ${BORDER}`, borderRadius: "100px",
                            padding: "2px 8px", fontSize: "10px", fontWeight: 700,
                            filter: "blur(3px)", userSelect: "none" as const,
                          }}>
                            0 min
                          </span>
                        )}
                      </div>
                    ))}
                    {rankedRecs.length > 3 && (
                      <button
                        onClick={() => scrollTo("section-recommendations")}
                        style={{ marginTop: "2px", fontSize: "12px", color: ACCENT, background: "transparent", border: "none", cursor: "pointer", padding: 0, fontWeight: 600, textAlign: "left" as const }}
                      >
                        + {rankedRecs.length - 3} more recommendations →
                      </button>
                    )}
                    {isGated && (
                      <button onClick={handleUpgrade} style={{
                        marginTop: "4px", padding: "8px",
                        background: "transparent", border: `1px solid ${ACCENT}`,
                        borderRadius: "8px", color: ACCENT, fontSize: "12px",
                        fontWeight: 600, cursor: "pointer", width: "100%",
                      }}>
                        Unlock to act →
                      </button>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: "13px", color: TEXT_3 }}>
                    {isComplete ? "No recommendations available" : "Analysing your site…"}
                  </div>
                )}
              </div>
            </div>

            {/* Scan summary bar */}
            <ScanSummaryBar
              crawlCount={site.crawlCount}
              lastCrawlAt={site.lastCrawlAt}
              pillarCount={scorecard?.pillars?.length ?? 0}
              criticalCount={criticalPillars.length}
            />
          </SectionCard>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            FREE TIER: "What's costing you" block
        ═══════════════════════════════════════════════════════════════════ */}
        {isGated && sortedPillars.length > 0 && (
          <div style={{ marginBottom: "24px" }}>
            <SectionCard style={{ padding: "24px" }}>
              <div className="rd-section-h2" style={{ fontWeight: 700, fontSize: "15px", color: TEXT, marginBottom: "4px" }}>
                What&apos;s costing you points
              </div>
              <div style={{ fontSize: "13px", color: TEXT_2, marginBottom: "20px" }}>
                Your 3 lowest-scoring areas — upgrade to see the exact fix for each
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                {sortedPillars.slice(0, 3).map((p) => {
                  const clr = scoreColor(p.score);
                  return (
                    <div key={p.pillar}>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "6px" }}>
                        <span className="rd-costing-name" style={{ minWidth: "160px", fontSize: "13px", fontWeight: 600, color: TEXT }}>
                          {p.pillarName}
                        </span>
                        <div style={{ flex: 1, background: CARD_ALT, borderRadius: "4px", height: "6px", minWidth: 0 }}>
                          <div style={{ background: clr, width: `${p.score}%`, height: "100%", borderRadius: "4px" }} />
                        </div>
                        <span style={{ minWidth: "30px", textAlign: "right" as const, fontSize: "14px", fontWeight: 700, color: clr, flexShrink: 0 }}>
                          {p.score}
                        </span>
                        <span className="rd-costing-potential geo-paywall-blur" style={{
                          minWidth: "90px", textAlign: "right" as const,
                          fontSize: "12px", color: TEXT_3,
                          filter: "blur(4px)", userSelect: "none" as const,
                          flexShrink: 0,
                        }}>
                          → +{Math.min(40, 100 - p.score)} pts potential
                        </span>
                      </div>
                      {p.findings && (
                        <GradFade bgColor={CARD} height={28}>
                          <p style={{ fontSize: "12px", color: TEXT_2, margin: 0, lineHeight: 1.5, maxHeight: "38px", overflow: "hidden" }}>
                            {p.findings}
                          </p>
                        </GradFade>
                      )}
                    </div>
                  );
                })}
              </div>
              <button onClick={handleUpgrade} style={{
                marginTop: "20px", padding: "10px 20px",
                background: ACCENT, color: "#fff",
                border: "none", borderRadius: "8px",
                fontSize: "13px", fontWeight: 600, cursor: "pointer",
              }}>
                Unlock the exact fix for each issue →
              </button>
            </SectionCard>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            FREE TIER UPGRADE BANNER
        ═══════════════════════════════════════════════════════════════════ */}
        {isGated && (
          <div className="rd-upgrade-banner" style={{
            background: ACCENT + "0f",
            border: `1px solid ${ACCENT}30`,
            borderRadius: "12px",
            padding: "18px 24px",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: "24px", gap: "16px",
          }}>
            <div>
              <div style={{ color: TEXT_2, fontSize: "12px", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: "4px" }}>
                You&apos;re on the Free plan
              </div>
              <div className="rd-upgrade-banner-title" style={{ color: TEXT, fontWeight: 600, fontSize: "15px" }}>
                Your score is{" "}
                <span style={{ color: scoreColor(overallScore), fontWeight: 800 }}>{overallScore}</span>.
                {" "}Fixing your critical issues could bring it to{" "}
                <span style={{ color: GREEN, fontWeight: 800 }}>{projectedScore}</span>.
              </div>
              <div className="rd-upgrade-banner-sub" style={{ color: TEXT_2, fontSize: "13px", marginTop: "4px" }}>
                See exactly what to do — full findings, recommendations, and generated AI files.
              </div>
            </div>
            <button onClick={handleUpgrade} style={{
              padding: "10px 24px", background: ACCENT, color: "#fff",
              border: "none", borderRadius: "8px", fontWeight: 600,
              cursor: "pointer", fontSize: "14px", whiteSpace: "nowrap" as const, flexShrink: 0,
            }}>
              Upgrade Now
            </button>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            BULK RESULTS — crawl summary, failed URLs, retry
        ═══════════════════════════════════════════════════════════════════ */}
        {/* ES-B9 AC-B9-8: replaced isComplete-only gate with the shared
            canRetryBulk predicate so status='failed' bulks (pre-merge-crawl
            failures) ALSO surface the retry affordance. */}
        {canRetryBulk(site, isGated) && (() => {
          const failedUrls = site.failedUrls ?? [];
          const creditLimitedUrls = site.creditLimitedUrls ?? [];
          const successCount = (site.bulkUrlCount ?? 0) - failedUrls.length - creditLimitedUrls.length;
          const hasIssues = failedUrls.length > 0 || creditLimitedUrls.length > 0;
          return (
            <SectionCard style={{ marginBottom: "24px", padding: "20px 24px" }}>
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" as const, marginBottom: hasIssues ? "16px" : 0 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: "15px", color: TEXT, marginBottom: "4px" }}>Bulk Crawl Results</div>
                  <div style={{ fontSize: "13px", color: TEXT_2 }}>
                    <span style={{ color: GREEN, fontWeight: 600 }}>{successCount} crawled</span>
                    {failedUrls.length > 0 && (
                      <span> · <span style={{ color: RED, fontWeight: 600 }}>{failedUrls.length} blocked</span> (unreachable)</span>
                    )}
                    {creditLimitedUrls.length > 0 && (
                      <span> · <span style={{ color: AMBER, fontWeight: 600 }}>{creditLimitedUrls.length} skipped</span> (credits ran out)</span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" as const }}>
                  <button
                    onClick={hasPerPageResults ? () => { window.location.href = `/api/sites/${site.id}/download-report?token=${site.token}`; } : undefined}
                    disabled={!hasPerPageResults}
                    title={!hasPerPageResults ? "Rerun audit to generate per-page results" : "Download full audit report as ZIP"}
                    style={{ padding: "8px 14px", background: hasPerPageResults ? GREEN : "#a1a1aa", color: hasPerPageResults ? "#fff" : "#e4e4e7", border: "none", borderRadius: "8px", cursor: hasPerPageResults ? "pointer" : "not-allowed", fontWeight: 600, fontSize: "12px", opacity: hasPerPageResults ? 1 : 0.6 }}>
                    Download ZIP
                  </button>
                  {failedUrls.length > 0 && !retryResult && (
                    <button
                      onClick={() => handleRetryFailed()}
                      disabled={retryingFailed}
                      style={{ padding: "8px 14px", background: CARD_ALT, color: retryingFailed ? TEXT_3 : TEXT, border: `1px solid ${BORDER}`, borderRadius: "8px", cursor: retryingFailed ? "not-allowed" : "pointer", fontWeight: 600, fontSize: "12px" }}>
                      {retryingFailed ? "Starting…" : `Retry Blocked (${failedUrls.length})`}
                    </button>
                  )}
                </div>
              </div>

              {/* Credit limit banner */}
              {creditLimitedUrls.length > 0 && (
                <div style={{ padding: "12px 16px", background: AMBER + "12", border: `1px solid ${AMBER}40`, borderRadius: "8px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" as const }}>
                  <span style={{ fontSize: "13px", color: TEXT }}>
                    We crawled <strong>{successCount}</strong> of <strong>{site.bulkUrlCount}</strong> URLs.{" "}
                    <strong>{creditLimitedUrls.length}</strong> {creditLimitedUrls.length === 1 ? "URL was" : "URLs were"} not crawled because you ran out of credits.
                  </span>
                  <a
                    href={`/sites/${site.id}?token=${site.token}#checkout`}
                    style={{ color: ACCENT, fontWeight: 600, fontSize: "13px", textDecoration: "underline", whiteSpace: "nowrap" as const }}>
                    Buy credits to crawl the rest →
                  </a>
                </div>
              )}

              {/* Retry success banner */}
              {retryResult && (
                <div style={{ padding: "12px 16px", background: GREEN + "0c", border: `1px solid ${GREEN}30`, borderRadius: "8px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" as const }}>
                  <span style={{ color: GREEN, fontWeight: 600, fontSize: "13px" }}>
                    Retry started for {retryResult.urlCount} URLs
                  </span>
                  <a
                    href={`/sites/${retryResult.siteId}?token=${retryResult.accessToken}`}
                    style={{ color: GREEN, fontWeight: 600, fontSize: "13px", textDecoration: "underline" }}>
                    View retry audit →
                  </a>
                </div>
              )}

              {/* Blocked URL list */}
              {failedUrls.length > 0 && (
                <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: "14px", marginBottom: creditLimitedUrls.length > 0 ? "14px" : 0 }}>
                  <div style={{ fontSize: "12px", color: TEXT_2, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: "8px" }}>
                    Blocked or unreachable ({failedUrls.length})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column" as const, gap: "6px", maxHeight: "200px", overflowY: "auto" as const }}>
                    {failedUrls.map((url) => (
                      <div key={url} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "8px 12px", background: CARD_ALT, borderRadius: "8px", fontSize: "13px" }}>
                        <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: TEXT_2, wordBreak: "break-all" as const, flex: 1 }}>
                          {url}
                        </a>
                        {!retryResult && (
                          <button
                            onClick={() => handleRetryFailed([url])}
                            disabled={retryingFailed}
                            style={{ padding: "4px 10px", background: CARD, border: `1px solid ${BORDER}`, borderRadius: "6px", cursor: retryingFailed ? "not-allowed" : "pointer", fontWeight: 600, fontSize: "11px", color: TEXT_2, flexShrink: 0, whiteSpace: "nowrap" as const }}>
                            Retry
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Credit-limited URL list */}
              {creditLimitedUrls.length > 0 && (
                <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: "14px" }}>
                  <div style={{ fontSize: "12px", color: AMBER, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: "8px" }}>
                    Not crawled — ran out of credits ({creditLimitedUrls.length})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column" as const, gap: "6px", maxHeight: "200px", overflowY: "auto" as const }}>
                    {creditLimitedUrls.map((url) => (
                      <div key={url} style={{ padding: "8px 12px", background: "#fffbeb", border: `1px solid ${AMBER}30`, borderRadius: "8px", fontSize: "13px" }}>
                        <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: TEXT_2, wordBreak: "break-all" as const }}>
                          {url}
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </SectionCard>
          );
        })()}

        {/* ═══════════════════════════════════════════════════════════════════
            IMPROVEMENT BANNER (when delta > 0)
        ═══════════════════════════════════════════════════════════════════ */}
        {site.improvementDelta != null && site.improvementDelta > 0 && (
          <div style={{
            background: GREEN + "0c",
            border: `1px solid ${GREEN}30`,
            borderRadius: "12px",
            padding: "20px 24px",
            marginBottom: "24px",
          }}>
            <div style={{ color: GREEN, fontSize: "18px", fontWeight: 700, marginBottom: "8px" }}>
              Your GEO Score Improved!
            </div>
            <div className="rd-improvement-banner" style={{ display: "flex", alignItems: "center", gap: "16px" }}>
              <span className="rd-improvement-score-before" style={{ color: TEXT_2, fontSize: "28px", fontWeight: 700 }}>{site.baselineScore}</span>
              <span style={{ color: TEXT_3, fontSize: "20px" }}>→</span>
              <span style={{
                color: GREEN, fontSize: "14px", fontWeight: 700,
                background: GREEN + "15", padding: "4px 12px", borderRadius: "100px",
                border: `1px solid ${GREEN}30`,
              }}>
                +{Math.round(site.improvementDelta * 10) / 10} pts
              </span>
            </div>
            {!isGated && site.pillarDeltas && (
              <div style={{ marginTop: "16px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: "8px" }}>
                {site.pillarDeltas
                  .filter((d) => d.delta != null && d.delta > 0)
                  .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
                  .slice(0, 6)
                  .map((d) => (
                    <div key={d.pillar} style={{ color: TEXT_2, fontSize: "13px" }}>
                      {d.pillar}: {d.before} → {d.after}{" "}
                      <span style={{ color: GREEN, fontWeight: 700 }}>+{Math.round((d.delta ?? 0) * 10) / 10}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            CRAWL CONTROLS — frequency + page selection (paid tiers only)
        ═══════════════════════════════════════════════════════════════════ */}
        {!isGated && isComplete && (
          <SectionCard style={{ marginBottom: "24px", padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
              {/* Crawl frequency */}
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <label style={{ fontSize: "13px", fontWeight: 600, color: TEXT_2 }}>Crawl frequency</label>
                <select
                  value={crawlFreq}
                  onChange={async (e) => {
                    const newFreq = e.target.value;
                    setCrawlFreq(newFreq);
                    setSavingCrawlSettings(true);
                    try {
                      const r = await fetch("/api/subscription", {
                        method: "PATCH",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ siteId: site.id, crawlFrequency: newFreq }),
                      });
                      if (!r.ok) {
                        const d = await r.json().catch(() => ({})) as { error?: string };
                        toast.error(d.error ?? "Failed to update frequency");
                        setCrawlFreq(site.crawlFrequency ?? "manual");
                      } else {
                        toast.success("Crawl frequency updated");
                      }
                    } catch {
                      toast.error("Network error");
                      setCrawlFreq(site.crawlFrequency ?? "manual");
                    } finally {
                      setSavingCrawlSettings(false);
                    }
                  }}
                  disabled={savingCrawlSettings}
                  style={{
                    padding: "6px 12px", borderRadius: "8px", border: `1px solid ${BORDER}`,
                    fontSize: "13px", color: TEXT, background: "#fff", cursor: "pointer",
                  }}
                >
                  {/* Options derived from the tier's maxFrequency ceiling (single
                      source of truth in lib/config) so client + server agree. */}
                  {allowedFrequenciesForTier(
                    (subscriptionTier in SUBSCRIPTION_TIERS ? subscriptionTier : "free") as SubscriptionTier,
                  ).map((f) => (
                    <option key={f} value={f}>
                      {f.charAt(0).toUpperCase() + f.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Page selection toggle */}
              {isSubscriber && (
                <button
                  onClick={() => setShowPageSelector(!showPageSelector)}
                  style={{
                    background: "#f5f2ee", color: TEXT_2, border: `1px solid ${BORDER}`,
                    borderRadius: "8px", padding: "6px 14px", fontSize: "13px",
                    fontWeight: 600, cursor: "pointer",
                  }}
                >
                  {showPageSelector ? "Hide Page Selector" : `Select Pages (${selectedPagesList.length || "all"})`}
                </button>
              )}
            </div>

            {/* Page selection checklist */}
            {showPageSelector && (() => {
              const discoveredUrls = site.discoveredUrls ?? (
                (site.discoveryData as { urls?: string[] } | null)?.urls ?? []
              );
              if (discoveredUrls.length === 0) return null;

              return (
                <div style={{ marginTop: "16px", borderTop: `1px solid ${BORDER}`, paddingTop: "16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px" }}>
                    <span style={{ fontSize: "13px", fontWeight: 600, color: TEXT_2 }}>
                      Select pages to crawl ({selectedPagesList.length}/{discoveredUrls.length})
                    </span>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        onClick={() => setSelectedPagesList([...discoveredUrls])}
                        style={{ fontSize: "12px", color: ACCENT, background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
                      >
                        Select All
                      </button>
                      <button
                        onClick={() => setSelectedPagesList([])}
                        style={{ fontSize: "12px", color: TEXT_3, background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div style={{
                    maxHeight: "200px", overflowY: "auto" as const,
                    border: `1px solid ${BORDER}`, borderRadius: "8px", padding: "8px",
                  }}>
                    {discoveredUrls.map((url: string) => (
                      <label key={url} style={{
                        display: "flex", alignItems: "center", gap: "8px",
                        padding: "4px 8px", fontSize: "12px", color: TEXT_2, cursor: "pointer",
                      }}>
                        <input
                          type="checkbox"
                          checked={selectedPagesList.includes(url)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedPagesList((prev) => [...prev, url]);
                            } else {
                              setSelectedPagesList((prev) => prev.filter((u) => u !== url));
                            }
                          }}
                        />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{url}</span>
                      </label>
                    ))}
                  </div>
                  <button
                    onClick={async () => {
                      setSavingCrawlSettings(true);
                      try {
                        const r = await fetch("/api/subscription", {
                          method: "PATCH",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ siteId: site.id, selectedPages: selectedPagesList }),
                        });
                        if (!r.ok) {
                          toast.error("Failed to save page selection");
                        } else {
                          toast.success("Page selection saved");
                        }
                      } catch {
                        toast.error("Network error");
                      } finally {
                        setSavingCrawlSettings(false);
                      }
                    }}
                    disabled={savingCrawlSettings}
                    style={{
                      marginTop: "10px", padding: "8px 16px", borderRadius: "8px", border: "none",
                      background: savingCrawlSettings ? "#d4d4d4" : ACCENT, color: "#fff",
                      fontSize: "13px", fontWeight: 600, cursor: savingCrawlSettings ? "not-allowed" : "pointer",
                    }}
                  >
                    {savingCrawlSettings ? "Saving..." : "Save Selection"}
                  </button>
                </div>
              );
            })()}
          </SectionCard>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            EXECUTIVE SUMMARY
        ═══════════════════════════════════════════════════════════════════ */}
        {site.executiveSummary && (
          <section id="section-summary" style={{ marginBottom: "40px", position: "relative" }}>
            <h2 className="rd-section-h2" style={{ fontSize: "17px", fontWeight: 700, marginBottom: "14px", color: TEXT }}>
              Executive Summary
            </h2>
            {isGated && <PaywallOverlay onUpgrade={handleUpgrade} />}
            <div style={isGated ? { pointerEvents: "none", userSelect: "none" } : {}}>
              <SectionCard>
                {site.executiveSummary.split("\n").filter(Boolean).map((para, i) => (
                  <p key={i} style={{ color: TEXT_2, lineHeight: 1.75, margin: i > 0 ? "12px 0 0" : 0 }}>
                    {para.split(/\*\*(.+?)\*\*/g).map((chunk, j) =>
                      j % 2 === 1
                        ? <span key={j} style={{ color: ACCENT, fontWeight: 700 }}>{chunk}</span>
                        : chunk
                    )}
                  </p>
                ))}
              </SectionCard>
            </div>
          </section>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            GEO SCORECARD
        ═══════════════════════════════════════════════════════════════════ */}
        {(scorecard?.pillars?.length ?? 0) > 0 && (
          <section id="section-scorecard" style={{ marginBottom: "40px" }}>
            <div className="rd-filter-toggle" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <h2 className="rd-section-h2" style={{ fontSize: "17px", fontWeight: 700, margin: 0, color: TEXT }}>GEO Scorecard</h2>
              <div style={{ display: "flex", background: CARD_ALT, borderRadius: "8px", border: `1px solid ${BORDER}`, padding: "3px", gap: "2px" }}>
                {(["all", "critical"] as const).map((f) => (
                  <button key={f} onClick={() => { setPillarFilter(f); setExpandedPillar(null); }} style={{
                    background: pillarFilter === f ? CARD : "transparent",
                    color: pillarFilter === f ? TEXT : TEXT_2,
                    border: pillarFilter === f ? `1px solid ${BORDER}` : "1px solid transparent",
                    borderRadius: "6px", padding: "5px 14px",
                    fontSize: "12px", cursor: "pointer", fontWeight: pillarFilter === f ? 700 : 500,
                    boxShadow: pillarFilter === f ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                    transition: "all 0.15s",
                  }}>
                    {f === "all" ? "All 16 Pillars" : "Critical Only"}
                  </button>
                ))}
              </div>
            </div>

            <SectionCard style={{ padding: "16px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                {filteredPillars.map((p) => {
                  const isExpanded = expandedPillar === p.pillar;
                  const clr = scoreColor(p.score);
                  const canExpand = !isGated;
                  return (
                    <div key={p.pillar}>
                      {/* Collapsed row */}
                      <div
                        onClick={() => canExpand && setExpandedPillar(isExpanded ? null : p.pillar)}
                        style={{
                          display: "flex", alignItems: "center", gap: "12px",
                          padding: "10px 12px", borderRadius: "8px",
                          cursor: canExpand ? "pointer" : "default",
                          background: isExpanded ? CARD_ALT : "transparent",
                        }}
                        onMouseOver={(e) => canExpand && !isExpanded && (e.currentTarget.style.background = CARD_ALT + "88")}
                        onMouseOut={(e) => !isExpanded && (e.currentTarget.style.background = "transparent")}
                      >
                        <div className="rd-pillar-name" style={{ minWidth: "180px", fontSize: "13px", fontWeight: 600, color: TEXT, flexShrink: 0 }}>{p.pillarName}</div>
                        <div style={{ flex: 1, background: CARD_ALT, borderRadius: "4px", height: "6px" }}>
                          <div style={{ background: clr, width: `${p.score}%`, height: "100%", borderRadius: "4px" }} />
                        </div>
                        <div style={{ minWidth: "32px", textAlign: "right" as const, fontSize: "14px", fontWeight: 700, color: clr, flexShrink: 0 }}>{p.score}</div>
                        <div className="rd-pillar-badge" style={{ minWidth: "72px", flexShrink: 0 }}>
                          <Badge label={scoreBand(p.score)} color={clr} />
                        </div>
                        {/* One-line finding preview */}
                        {!isExpanded && p.findings && (
                          <div className="rd-pillar-preview" style={{
                            flex: 2, fontSize: "12px", color: TEXT_2,
                            overflow: "hidden", whiteSpace: "nowrap" as const, textOverflow: "ellipsis",
                            maxWidth: "240px",
                          }}>
                            {isGated
                              ? <GradFade bgColor={CARD} height={20}><span>{p.findings}</span></GradFade>
                              : p.findings.slice(0, 80) + (p.findings.length > 80 ? "…" : "")
                            }
                          </div>
                        )}
                        {canExpand ? (
                          <div style={{
                            color: TEXT_3, fontSize: "11px", flexShrink: 0,
                            background: CARD_ALT, border: `1px solid ${BORDER}`,
                            borderRadius: "4px", padding: "2px 7px", lineHeight: 1,
                          }}>
                            {isExpanded ? "▲ less" : "▼ more"}
                          </div>
                        ) : (
                          <div style={{ color: ACCENT, fontSize: "10px", fontWeight: 700, flexShrink: 0 }}>PRO</div>
                        )}
                      </div>

                      {/* Expanded detail */}
                      {isExpanded && canExpand && (
                        <div style={{
                          margin: "4px 12px 8px",
                          padding: "18px 20px",
                          background: CARD_ALT, borderRadius: "8px",
                          border: `1px solid ${BORDER}`,
                        }}>
                          <p style={{ color: TEXT, fontSize: "13px", margin: "0 0 12px", lineHeight: 1.65 }}>
                            <strong style={{ color: ACCENT }}>Finding: </strong>{p.findings}
                          </p>
                          <div style={{
                            background: AMBER + "0c",
                            border: `1px solid ${AMBER}25`,
                            borderRadius: "8px", padding: "12px 16px", marginBottom: "12px",
                          }}>
                            <p style={{ color: TEXT, fontSize: "13px", margin: 0, lineHeight: 1.65 }}>
                              <strong style={{ color: AMBER }}>Fix: </strong>{p.recommendation}
                            </p>
                          </div>
                          {p.impactedPages?.length > 0 && (
                            <div>
                              <div style={{ fontSize: "11px", color: TEXT_2, fontWeight: 700, marginBottom: "8px", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>
                                Impacted pages
                              </div>
                              <div style={{ display: "flex", flexWrap: "wrap" as const, gap: "6px" }}>
                                {p.impactedPages.map((pg, idx) => (
                                  <a key={idx} href={pg} target="_blank" rel="noopener noreferrer" style={{
                                    background: CARD, color: ACCENT,
                                    border: `1px solid ${BORDER}`,
                                    borderRadius: "4px", padding: "2px 10px",
                                    fontSize: "11px", textDecoration: "none",
                                    wordBreak: "break-all", overflowWrap: "break-word",
                                  }}
                                    onMouseOver={(e) => (e.currentTarget.style.textDecoration = "underline")}
                                    onMouseOut={(e) => (e.currentTarget.style.textDecoration = "none")}
                                  >
                                    {pg}
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          </section>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            ALL RECOMMENDATIONS
        ═══════════════════════════════════════════════════════════════════ */}
        {rankedRecs.length > 0 && (
          <section id="section-recommendations" style={{ marginBottom: "40px", position: "relative" }}>
            <div className="rd-filter-toggle" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
              <h2 className="rd-section-h2" style={{ fontSize: "17px", fontWeight: 700, margin: 0, color: TEXT }}>
                All Recommendations
                {pillarFilter === "critical" && (
                  <span style={{ fontSize: "13px", color: TEXT_2, fontWeight: 400, marginLeft: "8px" }}>— critical only</span>
                )}
              </h2>
              <span style={{ fontSize: "12px", color: TEXT_2 }}>
                {filteredRecs.length} of {rankedRecs.length} shown
              </span>
            </div>

            {isGated && <PaywallOverlay onUpgrade={handleUpgrade} compact />}
            <div style={isGated ? { pointerEvents: "none", userSelect: "none" } : {}}>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {filteredRecs.map((rec) => {
                  const isExpanded = expandedRec === rec.rank;
                  const canExpand = !isGated;
                  return (
                    <div key={rec.rank} style={{
                      background: CARD, border: `1px solid ${BORDER}`,
                      borderRadius: "10px", overflow: "hidden",
                    }}>
                      <div
                        onClick={() => canExpand && setExpandedRec(isExpanded ? null : rec.rank)}
                        style={{
                          display: "flex", alignItems: "center", gap: "12px",
                          padding: "14px 18px",
                          cursor: canExpand ? "pointer" : "default",
                          background: isExpanded ? CARD_ALT : CARD,
                        }}
                        onMouseOver={(e) => canExpand && !isExpanded && (e.currentTarget.style.background = CARD_ALT + "88")}
                        onMouseOut={(e) => !isExpanded && (e.currentTarget.style.background = CARD)}
                      >
                        <span style={{ color: TEXT_3, fontWeight: 700, fontSize: "13px", minWidth: "28px" }}>#{rec.rank}</span>
                        <span style={{ flex: 1, fontWeight: 600, fontSize: "14px", color: TEXT }}>{rec.title}</span>

                        {/* Impact chip */}
                        <span className="rd-rec-impact" style={{
                          fontSize: "10px", fontWeight: 700, padding: "2px 8px",
                          borderRadius: "100px",
                          background: (rec.impact === "high" ? GREEN : rec.impact === "medium" ? AMBER : TEXT_3) + "15",
                          color: rec.impact === "high" ? GREEN : rec.impact === "medium" ? AMBER : TEXT_3,
                          border: `1px solid ${(rec.impact === "high" ? GREEN : rec.impact === "medium" ? AMBER : TEXT_3)}30`,
                          whiteSpace: "nowrap" as const,
                        }}>
                          {impactLabel(rec.impact)}
                        </span>

                        {/* Effort pill */}
                        <span style={{
                          background: ACCENT + "12", color: ACCENT,
                          border: `1px solid ${ACCENT}25`,
                          borderRadius: "100px", padding: "2px 10px",
                          fontSize: "11px", fontWeight: 600,
                          whiteSpace: "nowrap" as const,
                        }}>
                          {effortLabel(rec.effort)}
                        </span>

                        {/* One-line specificAction preview */}
                        {!isExpanded && rec.specificAction && (
                          <span className="rd-rec-preview" style={{
                            flex: 1, fontSize: "12px", color: TEXT_2,
                            overflow: "hidden", whiteSpace: "nowrap" as const, textOverflow: "ellipsis",
                            maxWidth: "200px",
                          }}>
                            {rec.specificAction.slice(0, 70) + (rec.specificAction.length > 70 ? "…" : "")}
                          </span>
                        )}

                        {canExpand ? (
                          <span style={{ color: TEXT_3, fontSize: "12px", flexShrink: 0 }}>{isExpanded ? "▲" : "▼"}</span>
                        ) : (
                          <span style={{ color: ACCENT, fontSize: "10px", fontWeight: 700, flexShrink: 0 }}>PRO</span>
                        )}
                      </div>

                      {isExpanded && canExpand && (
                        <div style={{ padding: "16px 18px 18px", borderTop: `1px solid ${BORDER}` }}>
                          <p style={{ color: TEXT_2, fontSize: "13px", margin: "0 0 12px", lineHeight: 1.65 }}>
                            {rec.description}
                          </p>
                          <div style={{
                            background: AMBER + "0c", border: `1px solid ${AMBER}25`,
                            borderRadius: "8px", padding: "12px 16px", marginBottom: "12px",
                          }}>
                            <p style={{ color: TEXT, fontSize: "13px", margin: 0, lineHeight: 1.65 }}>
                              <strong style={{ color: AMBER }}>Action: </strong>{rec.specificAction}
                            </p>
                          </div>
                          <Badge label={`Boost: +${rec.estimatedBoost} pts`} color={GREEN} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            PAGE-BY-PAGE ANALYSIS
        ═══════════════════════════════════════════════════════════════════ */}
        <PageByPageSection site={site} schemas={schemas} />

        {/* ═══════════════════════════════════════════════════════════════════
            SCORE HISTORY
        ═══════════════════════════════════════════════════════════════════ */}
        <section id="section-history" style={{ marginBottom: "40px" }}>
          <h2 className="rd-section-h2" style={{ fontSize: "17px", fontWeight: 700, marginBottom: "14px", color: TEXT }}>Score History</h2>
          <SectionCard className="rd-score-chart" style={{ overflow: "hidden" }}>
            {(site.changeLog?.length ?? 0) <= 1 ? (
              <div>
                <div style={{ fontSize: "13px", color: TEXT_2 }}>
                  First scan recorded. History will build with future runs.
                </div>
              </div>
            ) : (
              <ScoreChart entries={site.changeLog ?? []} currentScore={overallScore} />
            )}
          </SectionCard>
        </section>

        {/* ═══════════════════════════════════════════════════════════════════
            SETUP (AI Files + Domain Integration)
        ═══════════════════════════════════════════════════════════════════ */}
        {isComplete && (
          <section id="section-setup" style={{ marginBottom: "40px" }}>
            <div style={{ marginBottom: "14px" }}>
              <h2 className="rd-section-h2" style={{ fontSize: "17px", fontWeight: 700, margin: "0 0 4px", color: TEXT }}>Setup</h2>
              <p style={{ fontSize: "13px", color: TEXT_2, margin: 0 }}>
                Connect your domain to serve generated files at your own URLs
              </p>
            </div>

            {/* Setup section has a slightly different background tint */}
            <div className="rd-setup-section" style={{
              background: CARD_ALT, border: `1px solid ${BORDER}`,
              borderRadius: "12px", padding: "24px",
            }}>

              {/* AI Files */}
              <div style={{ position: "relative" }}>
                {isGated && <PaywallOverlay onUpgrade={handleUpgrade} compact />}
                <div style={isGated ? { pointerEvents: "none", userSelect: "none" } : {}}>
                  <h3 style={{ fontSize: "15px", fontWeight: 700, margin: "0 0 14px", color: TEXT }}>
                    Your AI Files
                  </h3>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
                    <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: GREEN, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: "14px", color: TEXT }}>All files generated and live</span>
                  </div>
                  <p style={{ color: TEXT_2, fontSize: "13px", margin: "0 0 16px", lineHeight: 1.6 }}>
                    Your AI context document, business profile, and structured data are ready.
                    Connect your domain below to serve them from your own URLs.
                  </p>
                  <div className="rd-ai-files-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "10px", marginBottom: "24px" }}>
                    {[
                      { label: "AI context", desc: "Served at /llms.txt" },
                      { label: "Extended context", desc: "Served at /llms-full.txt" },
                      { label: "Business profile", desc: "Served at /.well-known/ucp.json" },
                      { label: "Structured data", desc: `${schemas.length} block(s) · /geo-schema.json` },
                      { label: "URL manifest", desc: "All 4 files · /urls.txt" },
                    ].map((f) => (
                      <div key={f.label} style={{
                        background: CARD, border: `1px solid ${GREEN}20`,
                        borderRadius: "8px", padding: "12px 14px",
                      }}>
                        <div style={{ fontWeight: 600, fontSize: "13px", color: GREEN, marginBottom: "4px" }}>{f.label}</div>
                        <div style={{ fontSize: "12px", color: TEXT_2 }}>{f.desc}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Schema Blocks — paid only */}
              {site.tier === "paid" && schemas.length > 0 && (
                <SchemaBlocksCard schemas={schemas} />
              )}

              {/* Domain Integration — paid only */}
              {site.tier === "paid" && (
                <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: "24px" }}>
                  <h3 style={{ fontSize: "15px", fontWeight: 700, margin: "0 0 20px", color: TEXT }}>
                    Domain Integration
                  </h3>

                  {/* Verify step */}
                  {!site.domainVerified && (
                    <div style={{ marginBottom: "24px" }}>
                      <h3 style={{ fontSize: "15px", fontWeight: 700, margin: "0 0 16px", color: TEXT }}>
                        Step 1 — Verify Domain Ownership
                      </h3>
                      <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "16px" }}>
                        {[
                          "Log into your DNS provider (Cloudflare, Route53, GoDaddy, etc.)",
                          `Add a TXT record — Host: @ or _flowblinq-verify — Value: flowblinq-verify-${site.id}`,
                          "DNS changes can take up to 24 hours to propagate",
                          "Click the button below once you have added the record",
                        ].map((step, i) => (
                          <div key={i} style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                            <span style={{
                              width: "22px", height: "22px", borderRadius: "50%",
                              background: CARD, border: `1px solid ${BORDER}`,
                              color: TEXT_2, display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: "11px", fontWeight: 700, flexShrink: 0, marginTop: "1px",
                            }}>{i + 1}</span>
                            <span style={{ color: TEXT_2, fontSize: "14px", lineHeight: 1.6 }}>{step}</span>
                          </div>
                        ))}
                      </div>
                      <div className="rd-verify-txt" style={{
                        background: CARD, border: `1px solid ${BORDER}`,
                        borderRadius: "8px", padding: "12px 16px", marginBottom: "16px",
                        fontFamily: "monospace", fontSize: "13px", wordBreak: "break-all",
                      }}>
                        <span style={{ color: TEXT_2 }}>TXT record value: </span>
                        <span style={{ color: ACCENT, fontWeight: 600 }}>flowblinq-verify-{site.id}</span>
                      </div>
                      <button onClick={handleVerifyDomain} disabled={verifyingDomain} style={{
                        background: verifyingDomain ? CARD_ALT : TEXT,
                        color: verifyingDomain ? TEXT_2 : "#fff",
                        border: "none", borderRadius: "8px",
                        padding: "12px 24px", fontSize: "14px", fontWeight: 700,
                        cursor: verifyingDomain ? "not-allowed" : "pointer",
                      }}>
                        {verifyingDomain ? "Checking DNS…" : "Verify Domain Ownership"}
                      </button>
                      {domainVerifyResult && (
                        <div style={{
                          marginTop: "16px", padding: "14px 16px", borderRadius: "8px",
                          background: domainVerifyResult.verified ? GREEN + "0c" : RED + "0c",
                          border: `1px solid ${domainVerifyResult.verified ? GREEN + "30" : RED + "30"}`,
                        }}>
                          {domainVerifyResult.verified ? (
                            <p style={{ color: GREEN, margin: 0, fontWeight: 600 }}>Domain verified successfully.</p>
                          ) : (
                            <>
                              <p style={{ color: RED, margin: "0 0 8px", fontWeight: 600 }}>TXT record not found yet.</p>
                              {domainVerifyResult.found.length > 0 && (
                                <div style={{ fontFamily: "monospace", fontSize: "12px", color: TEXT_2 }}>
                                  {domainVerifyResult.found.map((r, i) => <div key={i}>{r}</div>)}
                                </div>
                              )}
                              <p style={{ color: TEXT_3, fontSize: "12px", margin: "8px 0 0" }}>
                                DNS propagation can take up to 24 hours. Try again later.
                              </p>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Connect instructions */}
                  {site.domainVerified && (
                    <div>
                      <h3 style={{ fontSize: "15px", fontWeight: 700, margin: "0 0 12px", color: TEXT }}>
                        Step 2 — Connect Your Domain
                      </h3>
                      <div style={{
                        padding: "10px 14px", borderRadius: "8px",
                        background: GREEN + "0c", border: `1px solid ${GREEN}30`, marginBottom: "20px",
                      }}>
                        <p style={{ color: GREEN, margin: 0, fontWeight: 600 }}>
                          Domain verified. Add the config below to serve your llms.txt via FlowBlinq GEO.
                        </p>
                      </div>

                      <div className="rd-integration-tabs" style={{ display: "flex", gap: "4px", flexWrap: "wrap" as const, marginBottom: "16px", borderBottom: `1px solid ${BORDER}`, paddingBottom: "8px" }}>
                        {(["vercel", "netlify", "cloudflare", "nginx", "wordpress", "apache", "other"] as const).map((tab) => (
                          <button key={tab} onClick={() => setIntegrationTab(tab)} style={{
                            background: integrationTab === tab ? TEXT : "transparent",
                            color: integrationTab === tab ? "#fff" : TEXT_2,
                            border: "none", borderRadius: "6px", padding: "5px 12px",
                            fontSize: "12px", cursor: "pointer", fontWeight: 600,
                            textTransform: "capitalize" as const,
                          }}>
                            {tab === "other" ? "Other ✦" : tab}
                          </button>
                        ))}
                      </div>

                      {integrationTab === "other" ? (
                        <div>
                          <p style={{ color: TEXT_2, fontSize: "13px", marginBottom: "12px" }}>
                            Tell us your platform and we&apos;ll generate the exact integration instructions.
                          </p>
                          <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
                            <input
                              type="text" value={otherPlatform}
                              onChange={(e) => setOtherPlatform(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && handleOtherPlatform()}
                              placeholder="e.g. Shopify, Caddy, Render, Heroku, Fastly…"
                              style={{
                                flex: 1, background: CARD,
                                border: `1px solid ${BORDER}`, borderRadius: "8px",
                                padding: "10px 14px", color: TEXT, fontSize: "13px", outline: "none",
                              }}
                            />
                            <button onClick={handleOtherPlatform} disabled={otherLoading || !otherPlatform.trim()} style={{
                              background: TEXT, color: "#fff", border: "none",
                              borderRadius: "8px", padding: "10px 20px",
                              fontSize: "13px", fontWeight: 700,
                              cursor: otherLoading || !otherPlatform.trim() ? "not-allowed" : "pointer",
                              opacity: otherLoading || !otherPlatform.trim() ? 0.5 : 1,
                            }}>
                              {otherLoading ? "Generating…" : "Generate"}
                            </button>
                          </div>
                          {otherError && (
                            <div style={{ padding: "12px", borderRadius: "8px", background: RED + "0c", border: `1px solid ${RED}30`, color: RED, fontSize: "13px" }}>
                              {otherError}
                            </div>
                          )}
                          {otherConfig && (
                            <div style={{ position: "relative" }}>
                              <div style={{ position: "absolute", top: "12px", right: "12px", zIndex: 1 }}>
                                <CopyButton text={otherConfig} />
                              </div>
                              <pre style={{
                                color: TEXT_2, fontSize: "12px",
                                background: CARD, border: `1px solid ${BORDER}`,
                                borderRadius: "8px", padding: "14px",
                                maxHeight: "400px", overflow: "auto", margin: 0,
                                whiteSpace: "pre-wrap", fontFamily: "monospace",
                              }}>
                                {otherConfig}
                              </pre>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div>
                          <div style={{ display: "flex", gap: "6px", marginBottom: "12px", flexWrap: "wrap" as const }}>
                            {["1. Add rewrites config", "2. Inject schema in layout", "3. Update robots.txt"].map((step, i) => (
                              <span key={i} style={{
                                fontSize: "11px", fontWeight: 600, color: TEXT_2,
                                background: CARD_ALT, border: `1px solid ${BORDER}`,
                                borderRadius: "100px", padding: "3px 10px",
                              }}>
                                {step}
                              </span>
                            ))}
                          </div>
                          <div style={{ position: "relative" }}>
                            <div style={{ position: "absolute", top: "12px", right: "12px", zIndex: 1 }}>
                              <CopyButton text={integrationConfigs[integrationTab]} />
                            </div>
                            <pre style={{
                              color: TEXT_2, fontSize: "12px",
                              background: CARD, border: `1px solid ${BORDER}`,
                              borderRadius: "8px", padding: "14px",
                              maxHeight: "340px", overflow: "auto", margin: 0,
                              whiteSpace: "pre-wrap", fontFamily: "monospace",
                            }}>
                              {integrationConfigs[integrationTab]}
                            </pre>
                          </div>
                        </div>
                      )}

                      <div style={{ marginTop: "20px" }}>
                        <button onClick={handleTestConnection} disabled={testingConnection} style={{
                          background: CARD, color: testingConnection ? TEXT_2 : TEXT,
                          border: `1px solid ${BORDER}`, borderRadius: "8px",
                          padding: "10px 20px", fontSize: "13px", fontWeight: 600,
                          cursor: testingConnection ? "not-allowed" : "pointer",
                        }}>
                          {testingConnection ? "Testing…" : "Test Connection"}
                        </button>
                        {connectionResult && (
                          <div style={{
                            marginTop: "12px", padding: "12px 16px", borderRadius: "8px",
                            background: connectionResult.connected ? GREEN + "0c" : RED + "0c",
                            border: `1px solid ${connectionResult.connected ? GREEN + "30" : RED + "30"}`,
                          }}>
                            <p style={{ margin: 0, color: connectionResult.connected ? GREEN : RED, fontWeight: 600 }}>
                              {connectionResult.connected ? "Connected" : "Not connected yet"}
                            </p>
                            <p style={{ margin: "4px 0 0", color: TEXT_2, fontSize: "12px" }}>{connectionResult.detail}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Credits footer */}
        <div className="rd-credits-footer" style={{
          marginTop: "48px", borderTop: `1px solid ${BORDER}`,
          padding: "20px 0", display: "flex",
          alignItems: "center", justifyContent: "center", gap: "12px",
        }}>
          <span style={{ fontSize: "13px", color: TEXT_2 }}>
            {site.credits} credits remaining
          </span>
          <button onClick={handleUpgrade} style={{
            background: "#fef3c7", color: "#b45309", border: "1px solid #fde68a",
            borderRadius: "8px", padding: "6px 14px",
            fontSize: "13px", fontWeight: 600, cursor: "pointer",
          }}>
            Buy more credits
          </button>
        </div>

      </div>
    </main>
  );
}
