"use client";

import { useState, useEffect, useCallback, use } from "react";
import type { CommerceReportData } from "@/lib/types/commerce-report";
import { CommerceHeader } from "@/components/commerce-report/commerce-header";
import { CommerceHero } from "@/components/commerce-report/commerce-hero";
import { CommerceScoreRing } from "@/components/commerce-report/commerce-score-ring";
import { CommerceVerdict } from "@/components/commerce-report/commerce-verdict";
import { CatalogSnapshotSection } from "@/components/commerce-report/catalog-snapshot";
import { EnrichmentPreviewSection } from "@/components/commerce-report/enrichment-preview";
import { AgentSimulationSection } from "@/components/commerce-report/agent-simulation";
import { CompetitiveLandscape } from "@/components/commerce-report/competitive-landscape";
import { RevenueImpactSection } from "@/components/commerce-report/revenue-impact";
import { AgenticPulse } from "@/components/commerce-report/agentic-pulse";
import { TheGap } from "@/components/commerce-report/the-gap";
import { CommerceCta } from "@/components/commerce-report/commerce-cta";
import { CommerceFooter } from "@/components/commerce-report/commerce-footer";
import { SovGapSection } from "@/components/commerce-report/sov-gap";
import { CompetitorAlertBanner } from "@/components/commerce-report/competitor-alert-banner";
import "./responsive.css";

const CSS_VARS = {
  "--cr-bg-primary": "#0a0e1a",
  "--cr-bg-secondary": "#111827",
  "--cr-bg-card": "#151d2e",
  "--cr-border": "#1e293b",
  "--cr-border-accent": "#2a3a52",
  "--cr-text-primary": "#f1f5f9",
  "--cr-text-secondary": "#94a3b8",
  "--cr-text-muted": "#64748b",
  "--cr-accent-orange": "#f97316",
  "--cr-accent-teal": "#14b8a6",
  "--cr-accent-red": "#ef4444",
  "--cr-accent-yellow": "#eab308",
  "--cr-accent-green": "#22c55e",
  "--cr-font-mono": "'JetBrains Mono', monospace",
  "--cr-font-sans": "'DM Sans', sans-serif",
  "--cr-font-serif": "'Instrument Serif', serif",
} as Record<string, string>;

type PageStatus = "loading" | "generating" | "complete" | "error";

export default function CommerceReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [status, setStatus] = useState<PageStatus>("loading");
  const [data, setData] = useState<CommerceReportData | null>(null);
  const [error, setError] = useState<string>("");
  const [progress, setProgress] = useState<string>(
    "Crawling your catalog with Firecrawl..."
  );

  // Poll GET until report is complete or errored
  const pollForCompletion = useCallback(async () => {
    const steps = [
      "Crawling your catalog with Firecrawl...",
      "Analyzing product attribute density...",
      "Running AI agent simulations...",
      "Scoring competitors...",
      "Generating revenue model...",
      "Writing executive verdict...",
    ];

    let stepIndex = 0;
    const interval = setInterval(() => {
      stepIndex = (stepIndex + 1) % steps.length;
      setProgress(steps[stepIndex]);
    }, 5000);

    const poll = async () => {
      try {
        const res = await fetch(`/api/audit/${id}/commerce-report`);
        const result = await res.json();

        if (result.status === "complete" && result.data) {
          clearInterval(interval);
          setData(result.data);
          setStatus("complete");
          return;
        }

        if (result.status === "error") {
          clearInterval(interval);
          setError(result.error || "Report generation failed.");
          setStatus("error");
          return;
        }

        // Still processing — poll again in 5s
        setTimeout(poll, 5000);
      } catch {
        clearInterval(interval);
        setError("Failed to check report status. Please refresh the page.");
        setStatus("error");
      }
    };

    // Start polling
    setTimeout(poll, 5000);
  }, [id]);

  const generate = useCallback(async () => {
    setStatus("generating");

    try {
      const res = await fetch(`/api/audit/${id}/commerce-report`, {
        method: "POST",
      });
      const result = await res.json();

      if (result.status === "complete" && result.data) {
        setData(result.data);
        setStatus("complete");
        return;
      }

      if (result.error) {
        setError(result.error);
        setStatus("error");
        return;
      }

      // POST returned "processing" — poll GET until done
      pollForCompletion();
    } catch {
      setError("Failed to generate the commerce report. Please try again.");
      setStatus("error");
    }
  }, [id, pollForCompletion]);

  // Initial load: check if report already exists or is processing
  useEffect(() => {
    async function checkExisting() {
      try {
        const res = await fetch(`/api/audit/${id}/commerce-report`);
        const result = await res.json();

        if (result.status === "complete" && result.data) {
          setData(result.data);
          setStatus("complete");
        } else if (result.status === "processing") {
          // Already generating in background — poll for completion
          setStatus("generating");
          pollForCompletion();
        } else if (result.status === "error") {
          setError(result.error || "Report generation failed.");
          setStatus("error");
        } else {
          // Not generated yet — kick it off
          generate();
        }
      } catch {
        generate();
      }
    }
    checkExisting();
  }, [id, generate, pollForCompletion]);

  const dateStr = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

  const reportId = `FBQ-${id.slice(0, 3).toUpperCase()}-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}${String(new Date().getDate()).padStart(2, "0")}`;

  // Loading state
  if (status === "loading") {
    return (
      <div
        style={{
          ...CSS_VARS,
          background: "#0a0e1a",
          color: "#f1f5f9",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <div style={{ textAlign: "center", color: "#64748b" }}>Loading...</div>
      </div>
    );
  }

  // Generating state
  if (status === "generating") {
    return (
      <div
        style={{
          ...CSS_VARS,
          background: "#0a0e1a",
          color: "#f1f5f9",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: "480px" }}>
          <div
            style={{
              fontFamily: "'Instrument Serif', serif",
              fontSize: "28px",
              marginBottom: "16px",
            }}
          >
            Generating Your Commerce Report
          </div>
          <div
            style={{
              fontSize: "14px",
              color: "#94a3b8",
              marginBottom: "32px",
            }}
          >
            This takes 60-90 seconds. We&apos;re crawling your catalog and running
            AI simulations.
          </div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "12px",
              color: "#f97316",
              padding: "12px 20px",
              background: "rgba(249, 115, 22, 0.1)",
              borderRadius: "6px",
              border: "1px solid rgba(249, 115, 22, 0.2)",
            }}
          >
            {progress}
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (status === "error") {
    return (
      <div
        style={{
          ...CSS_VARS,
          background: "#0a0e1a",
          color: "#f1f5f9",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: "480px" }}>
          <div
            style={{
              fontFamily: "'Instrument Serif', serif",
              fontSize: "28px",
              marginBottom: "16px",
            }}
          >
            Report Generation Failed
          </div>
          <div
            style={{
              fontSize: "14px",
              color: "#ef4444",
              marginBottom: "24px",
              padding: "16px",
              background: "rgba(239, 68, 68, 0.1)",
              borderRadius: "6px",
              border: "1px solid rgba(239, 68, 68, 0.2)",
            }}
          >
            {error}
          </div>
          <button
            onClick={() => generate()}
            style={{
              background: "#f97316",
              color: "#0a0e1a",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "13px",
              fontWeight: 700,
              padding: "12px 32px",
              borderRadius: "6px",
              border: "none",
              cursor: "pointer",
            }}
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // Report render
  if (!data) return null;

  return (
    <>
      {/* Google Fonts */}
      <link
        href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap"
        rel="stylesheet"
      />
      <div
        style={{
          ...CSS_VARS,
          background: "var(--cr-bg-primary)",
          color: "var(--cr-text-primary)",
          fontFamily: "var(--cr-font-sans)",
          lineHeight: 1.6,
          minHeight: "100vh",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <div
          className="cr-container"
          style={{
            maxWidth: "1080px",
            margin: "0 auto",
            padding: "0 24px",
            position: "relative",
            zIndex: 1,
          }}
        >
          <CommerceHeader reportId={reportId} date={dateStr} />
          <CommerceHero
            brandName={data.hero.brandName}
            vertical={data.hero.vertical}
            subtitle={data.hero.subtitle}
            scenario={data.hero.scenario}
            alertBanner={
              data.competitors && !Array.isArray(data.competitors) && "alertType" in data.competitors && data.competitors.alertType !== "none_live"
                ? <CompetitorAlertBanner data={data.competitors} />
                : undefined
            }
          />
          <CommerceScoreRing score={data.score} />
          <CommerceVerdict verdict={data.verdict} />
          <CatalogSnapshotSection data={data.catalog} />
          {data.sovGap && (
            <SovGapSection data={data.sovGap} brandName={data.hero.brandName} />
          )}
          {data.enrichment && <EnrichmentPreviewSection data={data.enrichment} />}
          {(data.simulation || (data.simulations && data.simulations.length > 0)) && (
            <AgentSimulationSection
              simulation={data.simulation}
              simulations={data.simulations}
            />
          )}
          <CompetitiveLandscape
            competitors={data.competitors}
            insight={data.competitiveInsight}
          />
          <RevenueImpactSection data={data.revenue} merchantCurrency={data.merchantCurrency} />
          <AgenticPulse stats={data.pulse} />
          <TheGap data={data.gap} />
          <CommerceCta
            brandName={data.hero.brandName}
            vertical={data.hero.vertical}
          />
          <CommerceFooter brandName={data.hero.brandName} date={dateStr} />
        </div>
      </div>
    </>
  );
}
