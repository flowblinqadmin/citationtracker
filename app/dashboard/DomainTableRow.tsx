"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import RowActions from "./RowActions";
import { domainMonogramColor, formatDashDate } from "./utils";

// ── Design tokens (pixel-matched to GEOPortfolioDashboardMockup-FINAL.html) ──
const COPPER     = "#c2652a";
const GREEN      = "#34c759";
const ORANGE     = "#ff9500"; // eslint-disable-line @typescript-eslint/no-unused-vars
const RED        = "#ff3b30";
const TEXT       = "#1d1d1f";
const T2         = "#86868b";
const T3         = "#aeaeb2";
const TD_BORDER  = "#f0f0f2"; // td border (lighter than #e5e5ea th border)

const TIER_COLORS = {
  GOOD: { bg: "#e3f2fd", color: "#1565c0" },
  FAIR: { bg: "#e8f5e9", color: "#2e7d32" },
  WEAK: { bg: "#fff8e1", color: "#e65100" },
  POOR: { bg: "#fef2f2", color: "#ff3b30" },
} as const;

const ALL_STAGES = [
  { status: "discovery",   step: 1, label: "Discovering pages" },
  { status: "crawling",    step: 2, label: "Reading your content" },
  { status: "researching", step: 3, label: "Checking the landscape" },
  { status: "analyzing",   step: 4, label: "Running your AI audit" },
  { status: "generating",  step: 5, label: "Building your profile" },
  { status: "assembling",  step: 6, label: "Final checks" },
];

function isActiveStatus(status: string | null): boolean {
  return ["queued", "pending", "discovery", "crawling", "extracting", "researching", "analyzing", "generating", "assembling"].includes(status ?? "");
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface DomainTableRowProps {
  row: {
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
  };
  accountTier?: "free" | "paid";
}

export default function DomainTableRow({ row, accountTier }: DomainTableRowProps) {
  const router = useRouter();
  const [liveStatus, setLiveStatus]   = useState(row.pipelineStatus);
  const [liveScore, setLiveScore]     = useState(row.overallScore);
  const [isOptimisticScan, setIsOptimisticScan] = useState(false);
  const [citationRunning, setCitationRunning] = useState(false);

  // isNewSite is fixed at mount time — never updated by polling
  const isNewSite = row.overallScore === null;

  const isScanning = isActiveStatus(liveStatus) || isOptimisticScan;

  // Issue UI fix: the backend emits a distinct "extracting" status between
  // crawling and researching (tree extraction stage, ~150-200s for big sites).
  // That status isn't in ALL_STAGES, so findIndex would return -1 and
  // fall back to ALL_STAGES[0] ("Discovering pages"), causing the user to see
  // a jarring backwards jump "Step 2 → Step 1 → Step 3" mid-audit. Alias
  // extracting → crawling so the indicator stays on "Reading your content"
  // through both phases. Keeps ALL_STAGES at 6 entries — no copy churn.
  const stageLookupStatus = liveStatus === "extracting" ? "crawling" : liveStatus;
  const currentStageIndex = ALL_STAGES.findIndex((s) => s.status === stageLookupStatus);
  const currentStage = currentStageIndex >= 0 ? ALL_STAGES[currentStageIndex] : ALL_STAGES[0];
  const currentStep = currentStage.step;

  // ES-wave-5 §C1 AC-C1-5 — isOptimisticScan state machine transitions:
  //   (a) false → true via onScanStart (RowActions click after 202).
  //   (b) true → false via the polling effect below observing
  //       !isActiveStatus(data.pipelineStatus) — server confirmed terminal.
  //   (c) true → false via AC-C1-4 max-30s safety timeout — covers the tight
  //       race where the regenerate succeeded but our 3s poll never observed
  //       an active status before the pipeline completed.
  //   (d) true → false via auth-failure 401 from the row poll — added after
  //       the May-2026 anomaly where an expired per-site accessToken caused
  //       the 3s interval to hammer /api/sites/[id] forever. failedTokenRef
  //       pins the bad token so this row will not re-poll until the parent
  //       re-renders with a different accessToken prop.
  // The grep guard in the wave-5 UTs pins the call-site counts (2 true / 3 false).
  // Polling when active
  const failedTokenRef = useRef<string | null>(null);
  const refreshOnceRef = useRef(false);
  useEffect(() => {
    if (!isActiveStatus(liveStatus) && !isOptimisticScan) return;
    const currentToken = row.accessToken ?? "";
    // Skip when there's no token — /api/sites/[id]?token= would 401 every
    // poll. The failedTokenRef guard only kicks in AFTER the first 401, so
    // without this short-circuit a dashboard with N tokenless active rows
    // fires N simultaneous 401s on mount (Adithya's 234-row dashboard).
    if (!currentToken) return;
    if (failedTokenRef.current === currentToken) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/sites/${row.siteId}?token=${currentToken}`);
        if (res.ok) {
          const data = await res.json() as { pipelineStatus: string; geoScorecard?: { overallScore?: number } };
          setLiveStatus(data.pipelineStatus);
          const sc = (data.geoScorecard as { overallScore?: number } | null)?.overallScore;
          if (sc !== undefined) setLiveScore(sc ?? null);
          if (!isActiveStatus(data.pipelineStatus)) {
            setIsOptimisticScan(false);
            router.refresh();
          }
          return;
        }
        if (res.status === 401) {
          failedTokenRef.current = currentToken;
          clearInterval(interval);
          const body = await res.json().catch(() => ({})) as { code?: string };
          if (body?.code === "TOKEN_EXPIRED") {
            toast.error("Audit session expired — refresh the page to continue");
          }
          setIsOptimisticScan(false);
          if (!refreshOnceRef.current) {
            refreshOnceRef.current = true;
            router.refresh();
          }
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [liveStatus, isOptimisticScan, row.siteId, row.accessToken, router]);

  // AC-C1-4 max-30s safety: if isOptimisticScan stays true for 30s without
  // liveStatus ever transitioning into an active state, force-clear it and
  // request a server re-render so the row reflects authoritative state.
  // Cleared if liveStatus becomes active OR isOptimisticScan goes false OR
  // the component unmounts.
  useEffect(() => {
    if (!isOptimisticScan) return;
    if (isActiveStatus(liveStatus)) return;
    const t = setTimeout(() => {
      setIsOptimisticScan(false);
      router.refresh();
    }, 30_000);
    return () => clearTimeout(t);
  }, [isOptimisticScan, liveStatus, router]);

  const monogram = domainMonogramColor(row.domain);

  // Shared monogram style parser
  const monoStyle = Object.fromEntries(monogram.split(";").filter(Boolean).map(s => {
    const [k, v] = s.split(":").map(x => x.trim());
    const key = k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    return [key, v];
  }));

  if (isScanning) {
    // ── Scanning row ──────────────────────────────────────────────────────
    return (
      <tr
        style={{ background: "linear-gradient(135deg, #fffbf5 0%, #fff7ed 100%)", boxShadow: "inset 3px 0 0 #c2652a", cursor: "pointer" }}
        data-domain={row.domain}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("button") || target.closest("a") || target.tagName === "BUTTON" || target.tagName === "A") return;
          router.push(`/dashboard/domains/${row.siteId}`);
        }}
      >
        {/* Domain */}
        <td style={{ padding: "12px 14px", borderBottom: "1px solid #f0e6d9" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 6, display: "flex", alignItems: "center",
              justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0,
              ...monoStyle,
            }}>
              {row.domain[0].toUpperCase()}
            </div>
            <div>
              <a href={`/dashboard/domains/${row.siteId}`} style={{ fontSize: 13, fontWeight: 600, color: TEXT, textDecoration: "none" }}>{row.domain}</a>
              <div style={{ color: COPPER, fontSize: 11, fontWeight: 500 }}>{currentStage.label}</div>
            </div>
          </div>
        </td>

        {/* Score */}
        <td style={{ padding: "12px 14px", borderBottom: "1px solid #f0e6d9" }}>
          {isNewSite ? <span style={{ color: T3, fontSize: 12 }}>—</span> : (
            <span style={{ opacity: 0.4 }}>{liveScore ?? "—"}</span>
          )}
        </td>

        {/* Tier */}
        <td style={{ padding: "12px 14px", borderBottom: "1px solid #f0e6d9" }}>
          {isNewSite ? <span style={{ color: T3, fontSize: 12 }}>—</span> : row.tier ? (
            <span style={{ opacity: 0.4, background: TIER_COLORS[row.tier].bg, color: TIER_COLORS[row.tier].color, borderRadius: 4, padding: "2px 6px", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.3px" }}>
              {row.tier}
            </span>
          ) : <span style={{ color: T3, fontSize: 12 }}>—</span>}
        </td>

        {/* Citations */}
        <td style={{ padding: "12px 14px", borderBottom: "1px solid #f0e6d9", fontSize: 13 }}>
          {isNewSite ? <span style={{ color: T3, fontSize: 12 }}>—</span> : row.citationRate !== null ? (
            <span style={{ opacity: 0.4, color: row.citationRate >= 50 ? GREEN : row.citationRate >= 25 ? ORANGE : RED }}>
              {row.citationRate}%
            </span>
          ) : <span style={{ color: T3, fontSize: 12 }}>—</span>}
        </td>

        {/* Critical */}
        <td style={{ padding: "12px 14px", borderBottom: "1px solid #f0e6d9", opacity: isNewSite ? 1 : 0.4 }}>
          {isNewSite ? <span style={{ color: T3, fontSize: 12 }}>—</span> : row.criticalIssues}
        </td>

        {/* Delta */}
        <td style={{ padding: "12px 14px", borderBottom: "1px solid #f0e6d9" }}>
          {isNewSite || row.delta === null ? <span style={{ color: T3, fontSize: 12 }}>—</span> : (
            <span style={{ opacity: 0.4, fontSize: 12, fontWeight: 600, color: row.delta > 0 ? GREEN : row.delta < 0 ? RED : T3 }}>
              {row.delta > 0 ? "+" : ""}{row.delta}
            </span>
          )}
        </td>

        {/* Last Scan */}
        <td style={{ padding: "12px 14px", borderBottom: "1px solid #f0e6d9", fontSize: 12, color: T2 }}>
          {isNewSite ? "Now" : <span style={{ opacity: 0.4 }}>Refreshing</span>}
        </td>

        {/* Actions — pipeline widget */}
        <td style={{ padding: "12px 14px", borderBottom: "1px solid #f0e6d9", minWidth: 180 }}>
          <div>
            <span style={{ color: COPPER, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.3px" }}>● Step {currentStep} of 6</span>
            <div style={{ display: "flex", gap: 1, marginTop: 4 }}>
              {ALL_STAGES.map((stage, i) => {
                const isDone   = i < currentStageIndex;
                const isActive = i === currentStageIndex;
                return (
                  <div key={stage.status} style={{
                    width: 24, height: 4, borderRadius: 2,
                    background: isDone ? GREEN : isActive ? COPPER : "#e5e5ea",
                    animation: isActive ? "pulse 1.2s ease-in-out infinite" : undefined,
                  }} />
                );
              })}
            </div>
            <div style={{ fontSize: 9, color: T2, marginTop: 1 }}>{currentStage.label}</div>
          </div>
        </td>
      </tr>
    );
  }

  // ── Normal row ─────────────────────────────────────────────────────────────
  return (
    <tr
      style={{ borderBottom: `1px solid ${TD_BORDER}`, cursor: "pointer", transition: "background .1s" }}
      data-domain={row.domain}
      onClick={(e) => {
        // Don't navigate if clicking on a button, link, or action
        const target = e.target as HTMLElement;
        if (target.closest("button") || target.closest("a") || target.tagName === "BUTTON" || target.tagName === "A") return;
        router.push(`/dashboard/domains/${row.siteId}`);
      }}
    >
      {/* Domain */}
      <td style={{ padding: "12px 14px", fontSize: 13 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6, display: "flex", alignItems: "center",
            justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0, textTransform: "uppercase",
            ...monoStyle,
          }}>
            {row.domain[0].toUpperCase()}
          </div>
          <div>
            <a href={`/dashboard/domains/${row.siteId}`} style={{ fontSize: 13, fontWeight: 600, color: TEXT, textDecoration: "none" }}>
              {row.domain}
            </a>
            {citationRunning ? (
              <div style={{ fontSize: 11, color: COPPER, fontWeight: 500 }}>Checking citations…</div>
            ) : (
              <div style={{ fontSize: 11, color: T3 }}>{row.pageCount} pages</div>
            )}
            {liveStatus === "failed" && (
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!row.accessToken) return;
                  // ES-B9.1 AC-B9.1-3: bulk rows POST /retry-failed (Bearer
                  // auth header + JSON body); single rows preserve
                  // /regenerate via query-param token.
                  const res = row.auditMode === "bulk"
                    ? await fetch(`/api/sites/${row.siteId}/retry-failed`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${row.accessToken}` },
                        body: "{}",
                      })
                    : await fetch(`/api/sites/${row.siteId}/regenerate?token=${row.accessToken}`, { method: "POST" });
                  if (res.status === 202 || res.status === 201) { setIsOptimisticScan(true); setLiveStatus("queued"); }
                }}
                title={`${row.pipelineError ?? "Audit failed"}. Credits have been refunded. Click to restart.`}
                style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11, color: RED, fontWeight: 500 }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: "50%", background: RED, flexShrink: 0,
                  animation: "pulse 1.5s ease-in-out infinite",
                }} />
                Failed — click to retry
              </button>
            )}
          </div>
        </div>
      </td>

      {/* GEO Score */}
      <td style={{ padding: "12px 14px" }}>
        {liveScore !== null ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: liveScore >= 60 ? GREEN : liveScore >= 40 ? ORANGE : RED, fontVariantNumeric: "tabular-nums", width: 28 }}>{liveScore}</span>
            {liveStatus === "failed" && liveScore !== null && (
              <span style={{ fontSize: 9, color: T2, fontWeight: 500, marginLeft: 4 }} title="Score from last successful run">last run</span>
            )}
            <div style={{ width: 60, height: 6, borderRadius: 3, background: "#f0f0f2", flexShrink: 0 }}>
              <div style={{
                width: `${liveScore}%`, height: "100%", borderRadius: 3,
                background: liveScore >= 75 ? GREEN : liveScore >= 50 ? ORANGE : RED,
              }} />
            </div>
          </div>
        ) : "—"}
      </td>

      {/* Tier */}
      <td style={{ padding: "12px 14px" }}>
        {row.tier ? (
          <span style={{
            background: TIER_COLORS[row.tier].bg,
            color: TIER_COLORS[row.tier].color,
            borderRadius: 4, padding: "2px 6px", fontSize: 9, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: "0.3px",
          }}>
            {row.tier}
          </span>
        ) : "—"}
      </td>

      {/* Citations */}
      <td style={{ padding: "12px 14px", fontSize: 13, color: row.citationRate !== null ? (row.citationRate >= 50 ? GREEN : row.citationRate >= 25 ? ORANGE : RED) : undefined }}>
        {row.citationRate !== null ? `${row.citationRate}%` : "—"}
      </td>

      {/* Critical Issues */}
      <td style={{ padding: "12px 14px", fontSize: 13, fontVariantNumeric: "tabular-nums", color: row.criticalIssues >= 5 ? RED : TEXT }}>
        {row.criticalIssues}
      </td>

      {/* Delta */}
      <td style={{ padding: "12px 14px", fontSize: 13 }}>
        {row.delta !== null ? (
          <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", color: row.delta > 0 ? GREEN : row.delta < 0 ? RED : T3 }}>
            {row.delta > 0 ? "+" : ""}{row.delta}
          </span>
        ) : "—"}
      </td>

      {/* Last Scan */}
      <td style={{ padding: "12px 14px", fontSize: 12, color: T2, whiteSpace: "nowrap" }}>
        {formatDashDate(row.lastCrawlAt)}
      </td>

      {/* Actions */}
      <td style={{ padding: "12px 14px" }}>
        <RowActions
          siteId={row.siteId}
          accessToken={row.accessToken}
          domain={row.domain}
          initialPipelineStatus={liveStatus}
          citationRate={row.citationRate}
          tier={accountTier}
          auditMode={row.auditMode}
          onScanStart={() => setIsOptimisticScan(true)}
          onCitationStart={() => setCitationRunning(true)}
          onCitationEnd={() => setCitationRunning(false)}
        />
      </td>
    </tr>
  );
}
