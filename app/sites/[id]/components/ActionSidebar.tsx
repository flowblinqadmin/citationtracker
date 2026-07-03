"use client";

import React, { useState } from "react";
import {
  CARD,
  BORDER,
  GREEN,
  COPPER,
  TEXT,
  T2,
  RED,
} from "../design-tokens";
import type { SiteActions } from "../hooks/useSiteActions";
import type { SiteDerivedData } from "../hooks/useSiteData";
import type { SiteData } from "../types";
import type { CitationCheckScore } from "@/lib/db/schema";
import { ACTION_CREDITS, PAGES_PER_CREDIT } from "@/lib/config";
import ConfirmCreditModal from "./ConfirmCreditModal";

interface PendingAction {
  action: string;
  description: string;
  cost: number;
  handler: () => void;
}

interface ActionSidebarProps {
  actions: SiteActions;
  site: SiteData | null;
  data: SiteDerivedData;
  isMobile: boolean;
  credits: number;
  slotsRemaining: number;
  siteId: string;
  token: string | null;
  poll: () => Promise<void>;
  lastCitationCheck: unknown;
}

export default function ActionSidebar({
  actions,
  site,
  data,
  isMobile,
  credits,
  slotsRemaining,
  siteId,
  token,
  poll,
  lastCitationCheck,
}: ActionSidebarProps): React.ReactElement {
  const [hoveredRail, setHoveredRail] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const auditCost = Math.max(1, Math.ceil((data.pageCount || 10) / PAGES_PER_CREDIT));

  // If "don't ask again" is set, skip the modal and call handler directly
  function confirmOrRun(action: PendingAction) {
    if (typeof window !== "undefined" && sessionStorage.getItem("skip-credit-confirm") === "1") {
      action.handler();
    } else {
      setPendingAction(action);
    }
  }

  const {
    handleRefreshScore,
    retrying,
    refreshError,
    handleScanCitations,
    citationScanActive,
    handleMapCompetitors,
    competitorScanActive,
    handleDownloadZip,
    downloadError,
  } = actions;

  const lc = lastCitationCheck as CitationCheckScore | null;

  return (
    /* ── Action Rail (left sidebar on desktop, bottom bar on mobile) ──────── */
    <div style={{
      position: "fixed",
      ...(isMobile ? {
        bottom: 0, left: 0, right: 0, top: "auto",
        transform: "none", width: "100%", zIndex: 80,
        display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-around",
        gap: 0, padding: "8px 4px",
        background: CARD, borderRadius: "14px 14px 0 0",
        boxShadow: "0 -4px 20px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.04)",
      } : {
        top: "50%", left: 0,
        transform: "translateY(-50%)", width: 78, zIndex: 80,
        display: "flex", flexDirection: "column", alignItems: "center",
        gap: 4, padding: "12px 6px",
        background: CARD, borderRadius: "0 14px 14px 0",
        boxShadow: "0 4px 20px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.04)",
      }),
    }}>
      {/* Refresh Score */}
      <div style={{ position: "relative" }}>
        <button
          onClick={() => confirmOrRun({
            action: "Refresh Score",
            description: "Re-run your GEO audit to update scores and recommendations",
            cost: auditCost,
            handler: handleRefreshScore,
          })}
          disabled={retrying}
          title="Re-run your GEO audit to update scores and recommendations"
          onMouseEnter={() => setHoveredRail("refresh")}
          onMouseLeave={() => setHoveredRail(null)}
          style={{ background: hoveredRail === "refresh" ? "#f0f0f2" : "none", border: "none", cursor: retrying ? "not-allowed" : "pointer", padding: isMobile ? "6px 2px" : "8px 4px", width: isMobile ? "auto" : 66, textAlign: "center", borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s" }}
        >
          <div style={{ width: 32, height: 32, borderRadius: 8, background: hoveredRail === "refresh" ? "#c8e6c9" : "#e8f5e9", color: GREEN, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", opacity: retrying ? 0.4 : 1, transition: "background 0.15s" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </div>
          <div style={{ fontWeight: 600, color: hoveredRail === "refresh" ? TEXT : T2, marginTop: 4, lineHeight: 1.2, textAlign: "center", letterSpacing: "0.1px", transition: "color 0.15s", display: "block", fontSize: isMobile ? 7 : 9 }}>Refresh Score</div>
          <div style={{ fontSize: 8, fontWeight: 500, background: "rgba(194, 101, 42, 0.08)", color: COPPER, borderRadius: 4, padding: "1px 5px", marginTop: 2, display: isMobile ? "none" : "inline-block", letterSpacing: "0.3px" }}>{auditCost}cr</div>
        </button>
        {refreshError && (
          <div style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
            background: "#1d1d1f", color: "#fff", fontSize: 11, padding: "4px 8px",
            borderRadius: 4, whiteSpace: "nowrap", pointerEvents: "none", zIndex: 10,
          }}>
            {refreshError}
          </div>
        )}
      </div>

      {/* Scan Citations */}
      <button
        onClick={site?.tier === "free" ? undefined : () => confirmOrRun({
          action: "Scan Citations",
          description: "Check 4 AI providers for mentions of your site",
          cost: ACTION_CREDITS.shareOfVoice,
          handler: handleScanCitations,
        })}
        disabled={site?.tier === "free" || citationScanActive}
        title={site?.tier === "free" ? "Upgrade to Pro to check AI citations" : "Check 4 AI providers for mentions of your site"}
        onMouseEnter={() => setHoveredRail("cite")}
        onMouseLeave={() => setHoveredRail(null)}
        style={{ background: hoveredRail === "cite" ? "#f0f0f2" : "none", border: "none", cursor: citationScanActive ? "not-allowed" : "pointer", padding: isMobile ? "6px 2px" : "8px 4px", width: isMobile ? "auto" : 66, textAlign: "center", borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s" }}
      >
        <div style={{ width: 32, height: 32, borderRadius: 8, background: hoveredRail === "cite" ? "#d1c4e9" : "#ede7f6", color: "#5856d6", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", opacity: citationScanActive ? 0.4 : 1, transition: "background 0.15s" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="3" />
            <path d="M18 11a7 7 0 1 0-2.8 5.6" />
            <path d="M14 11v2.5c0 .8.7 1.5 1.5 1.5" />
            <path d="M15.2 16.6 L 22 16.6" />
            <polyline points="19.5 14.3 22 16.6 19.5 18.9" />
          </svg>
        </div>
        <div style={{ fontWeight: 600, color: hoveredRail === "cite" ? TEXT : T2, marginTop: 4, lineHeight: 1.2, textAlign: "center", letterSpacing: "0.1px", transition: "color 0.15s", display: "block", fontSize: isMobile ? 7 : 9 }}>Scan Citations</div>
        <div style={{ fontSize: 8, fontWeight: 500, background: "rgba(194, 101, 42, 0.08)", color: COPPER, borderRadius: 4, padding: "1px 5px", marginTop: 2, display: isMobile ? "none" : "inline-block", letterSpacing: "0.3px" }}>{ACTION_CREDITS.shareOfVoice}cr</div>
      </button>

      {/* Map Competitors */}
      <button
        onClick={site?.tier === "free" ? undefined : slotsRemaining === 0 ? undefined : () => confirmOrRun({
          action: "Map Competitors",
          description: "Discover and map competitors in your space",
          cost: ACTION_CREDITS.competitorMapping,
          handler: handleMapCompetitors,
        })}
        disabled={site?.tier === "free" || competitorScanActive || slotsRemaining === 0}
        title={site?.tier === "free" ? "Upgrade to Pro to map competitors" : slotsRemaining === 0 ? "Competitor slots full" : "Discover and map competitors in your space"}
        onMouseEnter={() => setHoveredRail("compete")}
        onMouseLeave={() => setHoveredRail(null)}
        style={{ background: hoveredRail === "compete" ? "#f0f0f2" : "none", border: "none", cursor: (competitorScanActive || slotsRemaining === 0) ? "not-allowed" : "pointer", padding: isMobile ? "6px 2px" : "8px 4px", width: isMobile ? "auto" : 66, textAlign: "center", borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s", opacity: slotsRemaining === 0 ? 0.5 : 1 }}
      >
        <div style={{ width: 32, height: 32, borderRadius: 8, background: hoveredRail === "compete" ? "#ffe0b2" : "#fff3e0", color: "#e65100", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", opacity: competitorScanActive ? 0.4 : 1, transition: "background 0.15s" }}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="8" cy="8" r="3" />
            <path d="M8 2v2 M8 12v2 M2 8h2 M12 8h2" />
          </svg>
        </div>
        <div style={{ fontWeight: 600, color: hoveredRail === "compete" ? TEXT : T2, marginTop: 4, lineHeight: 1.2, textAlign: "center", letterSpacing: "0.1px", transition: "color 0.15s", display: "block", fontSize: isMobile ? 7 : 9 }}>Map Competitors</div>
        <div style={{ display: "flex", gap: 3, justifyContent: "center", marginTop: 2 }}>
          <span style={{ fontSize: 8, fontWeight: 500, background: "rgba(194, 101, 42, 0.08)", color: COPPER, borderRadius: 4, padding: "1px 5px", display: isMobile ? "none" : "inline-block", letterSpacing: "0.3px" }}>{ACTION_CREDITS.competitorMapping}cr</span>
          <span style={{ fontSize: 8, fontWeight: 500, background: "rgba(0,0,0,0.04)", color: T2, borderRadius: 4, padding: "1px 5px", display: isMobile ? "none" : "inline-block" }}>{slotsRemaining}/6</span>
        </div>
      </button>

      {/* Separator */}
      {!isMobile && <div style={{ width: 40, height: 1, background: BORDER }} />}

      {/* Download ZIP */}
      <button
        onClick={() => confirmOrRun({
          action: "Download ZIP",
          description: "Download full audit report as ZIP file",
          cost: ACTION_CREDITS.zipDownload,
          handler: handleDownloadZip,
        })}
        title={downloadError ?? "Download full audit report as ZIP file"}
        onMouseEnter={() => setHoveredRail("download")}
        onMouseLeave={() => setHoveredRail(null)}
        style={{ background: "none", border: "none", cursor: "pointer", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: isMobile ? 0 : 4, padding: isMobile ? "6px 2px" : "8px 4px", width: isMobile ? "auto" : 66, borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s", ...(hoveredRail === "download" ? { background: "#f0f0f2" } : {}) }}
      >
        <div style={{ width: 32, height: 32, borderRadius: 8, background: hoveredRail === "download" ? "#bbdefb" : "#e3f2fd", color: downloadError ? RED : "#1565c0", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", transition: "background 0.15s" }}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M8 3v9 M5 9l3 3 3-3 M3 16h10" />
          </svg>
        </div>
        <div style={{ fontWeight: 600, color: downloadError ? RED : hoveredRail === "download" ? TEXT : T2, marginTop: 4, lineHeight: 1.2, textAlign: "center", letterSpacing: "0.1px", transition: "color 0.15s", display: "block", fontSize: isMobile ? 7 : 9 }}>{downloadError ?? "Download ZIP"}</div>
        <div style={{ fontSize: 8, fontWeight: 500, background: "rgba(194, 101, 42, 0.08)", color: COPPER, borderRadius: 4, padding: "1px 5px", marginTop: 2, display: isMobile ? "none" : "inline-block", letterSpacing: "0.3px" }}>{ACTION_CREDITS.zipDownload}cr</div>
      </button>

      {/* Download PDF Report — only if citation check has been run */}
      <button
        disabled={!lc}
        onClick={() => {
          if (!lc) return;
          confirmOrRun({
            action: "PDF Report",
            description: "Generate and download PDF report",
            cost: ACTION_CREDITS.pdfDownload,
            handler: async () => {
              if (!token) return;
              setHoveredRail("report-loading");
              try {
                const res = await fetch(`/api/sites/${siteId}/pdf-report?token=${token}`);
                if (!res.ok) {
                  const body = await res.text();
                  console.error("PDF error:", res.status, body);
                  setHoveredRail(null);
                  return;
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${site?.domain ?? "report"}-geo-audit-report.pdf`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                await poll();
              } catch (err) { console.error("PDF fetch error:", err); } finally { setHoveredRail(null); }
            },
          });
        }}
        title={lc ? "Generate and download PDF report" : "Run citation check first"}
        onMouseEnter={() => hoveredRail !== "report-loading" && setHoveredRail("report")}
        onMouseLeave={() => hoveredRail !== "report-loading" && setHoveredRail(null)}
        style={{ background: hoveredRail === "report" || hoveredRail === "report-loading" ? "#f0f0f2" : "none", border: "none", cursor: !lc ? "not-allowed" : hoveredRail === "report-loading" ? "wait" : "pointer", padding: isMobile ? "6px 2px" : "8px 4px", width: isMobile ? "auto" : 66, textAlign: "center", borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s", opacity: !lc ? 0.35 : 1 }}
      >
        <div style={{ width: 32, height: 32, borderRadius: 8, background: hoveredRail === "report" || hoveredRail === "report-loading" ? "#e8d5f5" : "#f3e8ff", color: "#7c3aed", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", transition: "background 0.15s", opacity: hoveredRail === "report-loading" ? 0.4 : 1 }}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M6 2h8a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5l3-3z M6 2v3H3" />
          </svg>
        </div>
        <div style={{ fontWeight: 600, color: hoveredRail === "report" || hoveredRail === "report-loading" ? TEXT : T2, marginTop: 4, lineHeight: 1.2, textAlign: "center", letterSpacing: "0.1px", transition: "color 0.15s", display: "block", fontSize: isMobile ? 7 : 9 }}>{hoveredRail === "report-loading" ? "Generating…" : "PDF Report"}</div>
        <div style={{ fontSize: 8, fontWeight: 500, background: "rgba(194, 101, 42, 0.08)", color: COPPER, borderRadius: 4, padding: "1px 5px", marginTop: 2, display: isMobile ? "none" : "inline-block", letterSpacing: "0.3px" }}>{ACTION_CREDITS.pdfDownload}cr</div>
      </button>
      {/* Credit confirmation modal */}
      {pendingAction && (
        <ConfirmCreditModal
          action={pendingAction.action}
          description={pendingAction.description}
          cost={pendingAction.cost}
          balance={credits}
          onConfirm={() => {
            pendingAction.handler();
            setPendingAction(null);
          }}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </div>
  );
}
