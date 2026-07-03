import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
export { formatDashDate, domainMonogramColor } from "./utils";
import { eq, count, desc } from "drizzle-orm";
import { teamMembers, teams, teamDomains, geoSiteView, geoSites } from "@/lib/db/schema";
import { FREE_AUDIT_LIMIT } from "@/lib/config";
import SignOutButton from "./SignOutButton";
import PaymentToast from "./PaymentToast";
import ApiAccessSection from "./ApiAccessSection";

import BuyCreditsButton from "./BuyCreditsButton";
import DashboardTable from "./DashboardTable";
import DashboardFilter from "./DashboardFilter";
import NewAuditForm from "./NewAuditForm";

// ── Design System Constants ────────────────────────────────────────────────────
const COPPER        = "#c2652a";
const COPPER_LIGHT  = "#d4803e"; // eslint-disable-line @typescript-eslint/no-unused-vars
const COPPER_BG     = "#fff7ed"; // eslint-disable-line @typescript-eslint/no-unused-vars
const BG            = "#f5f5f7";
const CARD          = "#fff";
const BORDER        = "#e5e5ea";
const HEADER_BG     = "#FAF9F5";
const HEADER_BORDER = "rgba(0,0,0,0.06)";
const GREEN         = "#34c759";
const ORANGE        = "#ff9500"; // eslint-disable-line @typescript-eslint/no-unused-vars
const RED           = "#ff3b30";
const PINK          = "#ff2d55";   // eslint-disable-line @typescript-eslint/no-unused-vars
const TEXT          = "#1d1d1f";
const T2            = "#86868b";
const T3            = "#aeaeb2";

const FONT_STACK = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DomainRow = {
  id: string;
  domain: string;
  siteId: string;
  accessToken: string | null;
  pipelineStatus: string | null;
  overallScore: number | null;
  tier: "GOOD" | "FAIR" | "WEAK" | "POOR" | null;
  criticalIssues: number;
  delta: number | null;
  pageCount: number;
  citationRate: number | null;
  lastCrawlAt: string | null;
  pipelineError: string | null;
  createdAt: string;
  /** ES-B9.1 AC-B9.1-3/4 — bulk rows route to /retry-failed. */
  auditMode: "single" | "bulk" | null;
};

type KpiSummary = {
  totalSites: number;
  avgScore: number | null;
  totalCritical: number;
  creditBalance: number;
  scanningCount: number;
};

type TeamInfo = {
  team: { id: string; name: string; creditBalance: number };
  role: string;
};

// ── Pure Helper Functions (exported for testing) ───────────────────────────────

export function deriveTier(score: number | null): "GOOD" | "FAIR" | "WEAK" | "POOR" | null {
  if (score === null) return null;
  if (score >= 75) return "GOOD";
  if (score >= 50) return "FAIR";
  if (score >= 25) return "WEAK";
  return "POOR";
}

export function deriveCriticalIssues(
  pillars: Array<{ score?: number; priority?: string }> | undefined | null
): number {
  if (!pillars) return 0;
  return pillars.filter((p) => p.priority === "critical" || (p.score ?? 100) < 25).length;
}

export function deriveDelta(
  currentScore: number | null,
  previousRunSnapshot: { geoScorecard?: { overallScore?: number } } | null
): number | null {
  if (currentScore === null || !previousRunSnapshot?.geoScorecard?.overallScore) return null;
  return currentScore - previousRunSnapshot.geoScorecard.overallScore;
}

export function derivePageCount(crawlData: { pages?: unknown[] } | null): number {
  return (crawlData as { pages?: unknown[] } | null)?.pages?.length ?? 0;
}

export function isActiveStatus(status: string | null): boolean {
  return ["queued", "pending", "discovery", "crawling", "extracting", "researching", "analyzing", "generating", "assembling"].includes(status ?? "");
}

// ── Tier badge colors ─────────────────────────────────────────────────────────
export const TIER_COLORS = {
  GOOD: { bg: "#e3f2fd", color: "#1565c0" },
  FAIR: { bg: "#e8f5e9", color: "#2e7d32" },
  WEAK: { bg: "#fff8e1", color: "#e65100" },
  POOR: { bg: "#fef2f2", color: "#ff3b30" },
} as const;

// ── Page Component ────────────────────────────────────────────────────────────

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const t_start = Date.now();
  const supabase = await createClient();
  const t_client = Date.now();
  const { data: { user } } = await supabase.auth.getUser();
  const t_auth = Date.now();

  if (!user) {
    redirect("/auth/login?redirectTo=/dashboard");
  }

  const [membership] = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, user.id));
  const t_member = Date.now();
  console.info(`[dashboard:timing] createClient=${t_client - t_start}ms getUser=${t_auth - t_client}ms teamMember=${t_member - t_auth}ms`);

  let teamInfo: TeamInfo | null = null;
  let domains: DomainRow[] = [];

  let freeAuditsRemaining = FREE_AUDIT_LIMIT;
  let accountTier: "free" | "paid" = "free";

  if (membership) {
    const t0 = Date.now();

    // Run team lookup + domain query + audit count in parallel
    const [teamResult, rows, auditCountResult] = await Promise.all([
      db.select().from(teams).where(eq(teams.id, membership.teamId)),
      db.select({
          id: teamDomains.id,
          domain: teamDomains.domain,
          siteId: teamDomains.siteId,
          createdAt: teamDomains.createdAt,
          accessToken: geoSiteView.accessToken,
          pipelineStatus: geoSiteView.pipelineStatus,
          lastCrawlAt: geoSiteView.lastCrawlAt,
          overallScore: geoSiteView.overallScore,
          pillars: geoSiteView.pillars,
          prevScore: geoSiteView.previousScore,
          pageCount: geoSiteView.pageCount,
          citationRate: geoSiteView.citationRate,
          pipelineError: geoSiteView.pipelineError,
          // ES-B9.1 AC-B9.1-3/4: ferry auditMode through to RowActions +
          // DomainTableRow so bulk rows can route to /retry-failed.
          auditMode: geoSites.auditMode,
        })
        .from(teamDomains)
        .innerJoin(geoSiteView, eq(teamDomains.siteId, geoSiteView.siteId))
        .innerJoin(geoSites, eq(teamDomains.siteId, geoSites.id))
        .where(eq(teamDomains.teamId, membership.teamId))
        .orderBy(desc(geoSiteView.updatedAt)),
      db.select({ count: count() }).from(geoSites).where(eq(geoSites.ownerEmail, user.email!)),
    ]);

    const team = teamResult[0];
    if (team) {
      teamInfo = {
        team: { id: team.id, name: team.name, creditBalance: team.creditBalance },
        role: membership.role,
      };
    }

    accountTier = (teamInfo?.team.creditBalance ?? 0) > 0 ? "paid" : "free";
    const freeAuditsUsed = auditCountResult[0]?.count ?? 0;
    freeAuditsRemaining = Math.max(0, FREE_AUDIT_LIMIT - freeAuditsUsed);

    console.info(`[dashboard] userId=${user.id} domains=${rows.length} ms=${Date.now()-t0}`);

    // Citation rate already in geo_site_view — no separate query needed
    domains = rows.map((r) => {
      const currentScore = r.overallScore ?? null;
      const prevScore = r.prevScore ?? null;
      return {
        id: r.id,
        domain: r.domain,
        siteId: r.siteId,
        accessToken: r.accessToken ?? null,
        pipelineStatus: r.pipelineStatus,
        overallScore: currentScore,
        tier: deriveTier(currentScore),
        criticalIssues: deriveCriticalIssues(r.pillars as Array<{ score?: number; priority?: string }> | null),
        delta: currentScore !== null && prevScore !== null ? currentScore - prevScore : null,
        pageCount: r.pageCount ?? 0,
        citationRate: r.citationRate ?? null,
        lastCrawlAt: r.lastCrawlAt?.toISOString() ?? null,
        pipelineError: r.pipelineError ?? null,
        createdAt: r.createdAt?.toISOString() ?? "",
        auditMode: (r.auditMode as "single" | "bulk" | null) ?? null,
      };
    });

    domains.sort((a, b) => {
      const aTime = a.lastCrawlAt ? new Date(a.lastCrawlAt).getTime() : 0;
      const bTime = b.lastCrawlAt ? new Date(b.lastCrawlAt).getTime() : 0;
      return bTime - aTime;
    });
  } else {
    console.warn(`[dashboard] userId=${user.id} no_team`);
  }

  const kpi: KpiSummary = {
    totalSites: domains.length,
    avgScore: domains.filter(d => d.overallScore !== null).length > 0
      ? Math.round(domains.reduce((s, d) => s + (d.overallScore ?? 0), 0) / domains.filter(d => d.overallScore !== null).length)
      : null,
    totalCritical: domains.reduce((s, d) => s + d.criticalIssues, 0),
    creditBalance: teamInfo?.team.creditBalance ?? 0,
    scanningCount: domains.filter(d => isActiveStatus(d.pipelineStatus)).length,
  };

  if (domains.length === 0 && membership) {
    console.info(`[dashboard] teamId=${membership.teamId} no_domains`);
  }

  return (
    <main style={{ minHeight: "100vh", background: BG, fontFamily: FONT_STACK, overflowX: "hidden", width: "100%" }}>
      {/* Inter font */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

      <Suspense fallback={null}>
        <PaymentToast />
      </Suspense>

      {/* Mobile responsive overrides */}
      <style>{`
        @media (max-width: 768px) {
          .dash-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .dash-header { padding: 0 12px !important; }
          .dash-content { padding: 16px 12px 40px !important; max-width: 100% !important; }
          .dash-actions { flex-direction: column !important; gap: 12px !important; }
          .dash-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
          html, body { overflow-x: hidden; }
        }
      `}</style>

      {/* Header */}
      <header className="dash-header" style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 32px", height: 54, background: HEADER_BG, borderBottom: `1px solid ${HEADER_BORDER}`,
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: COPPER, letterSpacing: "2.5px" }}>
          FLOWBLINQ GEO
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 13, color: T2 }}>{user.email}</span>
          {accountTier === "free" && (
            <span style={{ fontSize: 12, color: T2 }}>
              {freeAuditsRemaining} of {FREE_AUDIT_LIMIT} free audits remaining
            </span>
          )}
          <BuyCreditsButton credits={kpi.creditBalance} />
          <SignOutButton />
        </div>
      </header>

      {/* Main content */}
      <div className="dash-content" style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 32px 60px" }}>

        {/* KPI Row */}
        <div className="dash-kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 24 }}>
          {/* Card 1: Total Sites */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "16px 18px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Total Sites</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: TEXT, letterSpacing: "-1px", lineHeight: 1.1 }}>{kpi.totalSites}</div>
            {kpi.scanningCount > 0 && (
              <div style={{ fontSize: 12, color: COPPER, fontWeight: 500, marginTop: 3 }}>
                {kpi.scanningCount} scan{kpi.scanningCount > 1 ? "s" : ""} in progress
              </div>
            )}
          </div>

          {/* Card 2: Avg GEO Score */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "16px 18px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Avg GEO Score</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: TEXT, letterSpacing: "-1px", lineHeight: 1.1 }}>{kpi.avgScore !== null ? kpi.avgScore : "—"}</div>
            <div style={{ fontSize: 12, color: T2, marginTop: 3 }}>
              across {domains.filter(d => d.overallScore !== null).length} domain{domains.filter(d => d.overallScore !== null).length !== 1 ? "s" : ""}
            </div>
          </div>

          {/* Card 3: Total Critical Issues */}
          <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "16px 18px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Total Critical Issues</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: TEXT, letterSpacing: "-1px", lineHeight: 1.1 }}>{kpi.totalCritical}</div>
            <div style={{ fontSize: 12, color: kpi.totalCritical > 0 ? RED : T2, marginTop: 3 }}>
              {kpi.totalCritical > 0 ? "Require attention" : "None found"}
            </div>
          </div>

          {/* Card 4: Credits Remaining */}
          <div style={{
            background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "16px 18px",
            boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", borderLeft: `3px solid ${COPPER}`,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Credits Remaining</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: TEXT, letterSpacing: "-1px", lineHeight: 1.1 }}>{kpi.creditBalance}</div>
            {kpi.creditBalance < 10 && (
              <form method="POST" action="/api/checkout" style={{ marginTop: 3 }}>
                <button type="submit" style={{
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  fontSize: 12, color: COPPER,
                }}>
                  Buy more →
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Actions strip */}
        <div className="dash-actions" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24 }}>
          <NewAuditForm userEmail={user.email ?? ""} creditBalance={kpi.creditBalance} />
          <div style={{ flex: 1 }} />
          <Suspense fallback={<input type="text" placeholder="Filter domains..." disabled style={{ border: "1px solid rgba(194, 101, 42, 0.2)", borderRadius: 8, padding: "8px 12px", fontSize: 13, background: "#fff", color: "#1d1d1f", outline: "none", width: 220 }} />}>
            <DashboardFilter />
          </Suspense>
        </div>

        {/* Section title */}
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 4px", color: TEXT }}>Your Audits</h2>
        <div style={{ fontSize: 13, color: T2, marginBottom: 16 }}>
          {domains.length} domain{domains.length !== 1 ? "s" : ""} · sorted by last refreshed
        </div>



        {(() => {
          const filteredDomains = q
            ? domains.filter(d => d.domain.toLowerCase().includes(q.toLowerCase()))
            : domains;
          return filteredDomains.length === 0 ? (
          /* Empty state */
          <div style={{
            background: CARD, border: `1px solid ${BORDER}`, borderRadius: 16,
            padding: "64px 32px", textAlign: "center",
          }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>◎</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8, color: TEXT }}>
              No audits yet
            </div>
            <div style={{ color: T2, fontSize: 14, lineHeight: 1.6, marginBottom: 28 }}>
              Enter a domain above and click Run audit to see how visible your site is to ChatGPT, Perplexity, and Gemini.
            </div>
          </div>
          ) : (
            /* Domain table */
            <DashboardTable domains={filteredDomains} accountTier={accountTier} />
          );
        })()}

        {/* API Access */}
        {teamInfo && <ApiAccessSection teamId={teamInfo.team.id} />}
      </div>
    </main>
  );
}
