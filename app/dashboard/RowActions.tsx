"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const T3 = "#aeaeb2";

interface RowActionsProps {
  siteId: string;
  accessToken: string | null;
  domain: string;
  initialPipelineStatus: string | null;
  citationRate: number | null;
  tier?: "free" | "paid";
  /** ES-B9.1 AC-B9.1-4: bulk rows route Rerun Audit through /retry-failed. */
  auditMode?: "single" | "bulk" | null;
  onScanStart?: () => void;
  onCitationStart?: () => void;
  onCitationEnd?: () => void;
}

const baseBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "#c2652a",
  transition: "all 0.15s ease",
  padding: 0,
};

const HOVER = {
  audit:  { bg: "#fff3e0", color: "#c2652a" },
  cite:   { bg: "#fef7ed", color: "#a85520" },
  zip:    { bg: "#fef7ed", color: "#c2652a" },
  report: { bg: "#fef7ed", color: "#a85520" },
} as const;

export default function RowActions({ siteId, accessToken, domain: _domain, initialPipelineStatus, citationRate, tier, auditMode, onScanStart, onCitationStart, onCitationEnd }: RowActionsProps) {
  const hasCitations = citationRate !== null;
  const router = useRouter();
  const [rerunTooltip, setRerunTooltip] = useState<string | null>(null);
  const [citationTooltip, setCitationTooltip] = useState<string | null>(null);
  const [citationRunning, setCitationRunning] = useState(false);
  const [downloadTooltip, setDownloadTooltip] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const canDownload = initialPipelineStatus === "complete" || initialPipelineStatus === "failed";

  async function handleRerunAudit() {
    if (!accessToken) return;
    // B10.0.2: "Rerun Audit" semantically means redo the whole thing.
    // Always hit /regenerate (which is bulk-aware post-B10 — uses bulkUrls
    // for full re-audit; in-place mutation). The "Failed — click to retry"
    // affordance in DomainTableRow remains the explicit subset path that
    // routes to /retry-failed. Reverts B9.1 AC-B9.1-4's over-eager merge
    // of two distinct user affordances into one route.
    try {
      const res = await fetch(`/api/sites/${siteId}/regenerate?token=${accessToken}`, { method: "POST" });

      if (res.status === 202) {
        onScanStart?.();
        router.refresh();
        return;
      }
      // ES-B9.1 AC-B9.1-2: surface every non-2xx with a visible tooltip.
      if (res.status === 409) {
        setRerunTooltip("Scan already in progress");
      } else if (res.status === 402) {
        setRerunTooltip("Not enough credits");
      } else if (res.status >= 500) {
        setRerunTooltip("Server error — try again");
      } else if (res.status >= 400) {
        // Display the server's error verbatim, truncated to 80 chars so it
        // surfaces accurate info (e.g. "Bulk audits cannot be regenerated…")
        // without overflowing the dashboard row.
        let msg = `Error ${res.status}`;
        try {
          const data = (await res.json()) as { error?: string };
          if (typeof data.error === "string" && data.error.length > 0) {
            msg = data.error.length > 80 ? data.error.slice(0, 77) + "…" : data.error;
          }
        } catch {
          // non-JSON body — fall back to status code.
        }
        setRerunTooltip(msg);
      }
      setTimeout(() => setRerunTooltip(null), 3000);
    } catch {
      setRerunTooltip("Request failed");
      setTimeout(() => setRerunTooltip(null), 3000);
    }
  }

  async function handleRerunCitations() {
    if (!accessToken || citationRunning) return;
    setCitationRunning(true);
    setCitationTooltip("Running…");
    onCitationStart?.();
    try {
      const res = await fetch(`/api/sites/${siteId}/citation-check?token=${accessToken}`, { method: "POST" });
      if (!res.ok || !res.body) {
        setCitationTooltip("Citation scan failed");
        setTimeout(() => setCitationTooltip(null), 3000);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
      }
      setCitationTooltip("Done ✓");
      setTimeout(() => setCitationTooltip(null), 2000);
      router.refresh();
    } catch {
      setCitationTooltip("Request failed");
      setTimeout(() => setCitationTooltip(null), 3000);
    } finally {
      setCitationRunning(false);
      onCitationEnd?.();
    }
  }

  async function handleDownloadZip() {
    try {
      const res = await fetch(`/api/sites/${siteId}/download-report?token=${accessToken ?? ""}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Download failed" }));
        setDownloadTooltip(data.error ?? "Download failed");
        setTimeout(() => setDownloadTooltip(null), 3000);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${siteId}-report.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadTooltip("Download failed");
      setTimeout(() => setDownloadTooltip(null), 3000);
    }
  }

  async function handleDownloadPdf() {
    try {
      const res = await fetch(`/api/sites/${siteId}/pdf-report?token=${accessToken ?? ""}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Download failed" }));
        setDownloadTooltip(data.error ?? "Download failed");
        setTimeout(() => setDownloadTooltip(null), 3000);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${siteId}-report.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadTooltip("Download failed");
      setTimeout(() => setDownloadTooltip(null), 3000);
    }
  }

  // B10.0.3: tooltip CSS — fix vertical-stacking bug from B9.1 AC-B9.1-5.
  //   wordBreak: "break-word" is deprecated; modern browsers interpret it
  //   close to break-all, so when the parent column is narrow each character
  //   wrapped to its own line. Replace with the standards-compliant pair:
  //     wordBreak: "normal"        — break only at word boundaries
  //     overflowWrap: "anywhere"   — allow opportunistic mid-word break (long URL)
  //   plus width: max-content so the bubble sizes to its content (capped by maxWidth)
  //   instead of inheriting the narrow parent column.
  const tooltip = (text: string) => (
    <div
      role="tooltip"
      data-testid="row-action-tooltip"
      style={{
        position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
        background: "#1d1d1f", color: "#fff", fontSize: 10, fontWeight: 500, padding: "3px 8px",
        borderRadius: 4, pointerEvents: "none", zIndex: 10,
        width: "max-content",
        maxWidth: "min(80vw, 480px)",
        wordBreak: "normal",
        overflowWrap: "anywhere",
        whiteSpace: "normal",
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );

  function btnStyle(key: keyof typeof HOVER): React.CSSProperties {
    const h = hovered === key ? HOVER[key] : null;
    return { ...baseBtn, color: h?.color ?? T3, background: h?.bg ?? "transparent" };
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      {/* Rerun Audit */}
      <div style={{ position: "relative" }}>
        <button
          onClick={handleRerunAudit}
          title="Rerun Audit · 10cr"
          style={btnStyle("audit")}
          onMouseEnter={() => setHovered("audit")}
          onMouseLeave={() => setHovered(null)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        {rerunTooltip && tooltip(rerunTooltip)}
      </div>

      {/* Rerun Citations */}
      <div style={{ position: "relative" }}>
        <button
          onClick={tier === "free" ? undefined : handleRerunCitations}
          disabled={tier === "free" || citationRunning}
          title={tier === "free" ? "Upgrade to Pro" : "Rerun Citations · 5cr"}
          style={{ ...btnStyle("cite"), opacity: (tier === "free" || citationRunning) ? 0.4 : 1, cursor: (tier === "free" || citationRunning) ? "not-allowed" : "pointer" }}
          onMouseEnter={() => setHovered("cite")}
          onMouseLeave={() => setHovered(null)}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="3" />
            <path d="M18 11a7 7 0 1 0-2.8 5.6" />
            <path d="M14 11v2.5c0 .8.7 1.5 1.5 1.5" />
            <path d="M15.2 16.6 L 22 16.6" />
            <polyline points="19.5 14.3 22 16.6 19.5 18.9" />
          </svg>
        </button>
        {citationTooltip && tooltip(citationTooltip)}
      </div>

      {/* Separator */}
      <div style={{ width: 1, height: 16, background: "#e5e5ea", margin: "0 1px", flexShrink: 0 }} />

      {/* Download ZIP */}
      <div style={{ position: "relative" }}>
        <button
          onClick={canDownload ? handleDownloadZip : undefined}
          disabled={!canDownload}
          title={canDownload ? "Download ZIP · 5cr" : "Audit in progress"}
          style={{
            ...btnStyle("zip"),
            opacity: canDownload ? 1 : 0.35,
            cursor: canDownload ? "pointer" : "not-allowed",
          }}
          onMouseEnter={() => setHovered("zip")}
          onMouseLeave={() => setHovered(null)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        {downloadTooltip && tooltip(downloadTooltip)}
      </div>

      {/* Download PDF Report */}
      <div style={{ position: "relative" }}>
        <button
          onClick={hasCitations && canDownload ? handleDownloadPdf : undefined}
          disabled={!hasCitations || !canDownload}
          title={!hasCitations ? "Run citation check first" : !canDownload ? "Audit in progress" : "Download PDF Report · 5cr"}
          style={{
            ...btnStyle("report"),
            opacity: hasCitations && canDownload ? 1 : 0.35,
            cursor: hasCitations && canDownload ? "pointer" : "not-allowed",
          }}
          onMouseEnter={() => setHovered("report")}
          onMouseLeave={() => setHovered(null)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        </button>
      </div>
    </div>
  );
}
