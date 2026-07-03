"use client";

import { motion } from "framer-motion";
import type { L2Competitors, CompetitorScore, CompetitorProbeData } from "@/lib/types/commerce-report";
import { AlertTriangle, AlertCircle, CheckCircle } from "lucide-react";

function SectionHeader({ number, title }: { number: string; title: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        marginBottom: "32px",
        paddingBottom: "16px",
        borderBottom: "1px solid var(--cr-border)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--cr-font-mono)",
          fontSize: "12px",
          color: "var(--cr-accent-orange)",
          background: "rgba(249, 115, 22, 0.15)",
          padding: "4px 10px",
          borderRadius: "4px",
          fontWeight: 600,
        }}
      >
        {number}
      </span>
      <h2
        style={{
          fontFamily: "var(--cr-font-serif)",
          fontSize: "28px",
          fontWeight: 400,
          color: "var(--cr-text-primary)",
        }}
      >
        {title}
      </h2>
    </div>
  );
}

const ALERT_STYLES: Record<string, { bg: string; border: string; color: string }> = {
  competitor_live: { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.3)", color: "#ef4444" },
  competitor_building: { bg: "rgba(249,115,22,0.12)", border: "rgba(249,115,22,0.3)", color: "#f97316" },
  none_live: { bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.3)", color: "#3b82f6" },
};

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  LIVE: { bg: "rgba(239,68,68,0.2)", color: "#ef4444" },
  BUILDING: { bg: "rgba(249,115,22,0.2)", color: "#f97316" },
  NONE: { bg: "rgba(100,116,139,0.2)", color: "#94a3b8" },
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_COLORS[status] || STATUS_COLORS.NONE;
  return (
    <span
      style={{
        fontFamily: "var(--cr-font-mono)",
        fontSize: "9px",
        fontWeight: 700,
        letterSpacing: "1px",
        textTransform: "uppercase",
        color: style.color,
        background: style.bg,
        padding: "3px 8px",
        borderRadius: "3px",
        border: `1px solid ${style.color}33`,
      }}
    >
      {status}
    </span>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  return (
    <span
      style={{
        fontFamily: "var(--cr-font-mono)",
        fontSize: "10px",
        color: "var(--cr-text-muted)",
        background: "rgba(255,255,255,0.05)",
        padding: "2px 8px",
        borderRadius: "3px",
        border: "1px solid var(--cr-border)",
      }}
    >
      {platform}
    </span>
  );
}

// Alert headline config
const ALERT_HEADLINES: Record<string, { icon: string; headline: string }> = {
  competitor_live: { icon: "🔴", headline: "A Competitor Has a Live AI Store" },
  competitor_building: { icon: "⚠️", headline: "Your Competitors Are Building AI Stores Right Now" },
  none_live: { icon: "🟢", headline: "No One in Your Category Has an AI Store — Yet" },
};

// New L2 format
function L2CompetitiveLandscape({
  data,
  insight,
}: {
  data: L2Competitors;
  insight: string;
}) {
  const alertStyle = ALERT_STYLES[data.alertType] || ALERT_STYLES.none_live;
  const alertHeadline = ALERT_HEADLINES[data.alertType] || ALERT_HEADLINES.none_live;

  return (
    <section style={{ marginBottom: "64px" }}>
      <SectionHeader
        number="05"
        title="Competitive Landscape: AI Readiness in Your Category"
      />

      {/* Alert banner now rendered at top of report via CompetitorAlertBanner */}

      {/* Competitor grid */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "8px" }}>
        {data.competitors.map((comp) => (
          <div
            key={comp.name}
            className="cr-competitor-row"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto auto",
              alignItems: "center",
              gap: "12px",
              padding: "14px 16px",
              background: "var(--cr-bg-card)",
              border: "1px solid var(--cr-border)",
              borderRadius: "6px",
            }}
          >
            <div>
              <div style={{ fontSize: "14px", fontWeight: 500, color: "var(--cr-text-primary)" }}>
                {comp.name}
              </div>
              <div style={{ fontFamily: "var(--cr-font-mono)", fontSize: "11px", color: "var(--cr-text-muted)" }}>
                {comp.domain}
              </div>
            </div>
            <PlatformBadge platform={comp.platform} />
            <StatusBadge status={comp.acpStatus} />
            <div
              style={{
                fontFamily: "var(--cr-font-mono)",
                fontSize: "12px",
                color: "var(--cr-text-secondary)",
                textAlign: "right",
                minWidth: "80px",
              }}
            >
              {comp.l1MentionCount} mention{comp.l1MentionCount !== 1 ? "s" : ""}
            </div>
          </div>
        ))}

        {/* Merchant row */}
        <div
          className="cr-competitor-row"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto auto auto",
            alignItems: "center",
            gap: "12px",
            padding: "14px 16px",
            background: "rgba(249, 115, 22, 0.1)",
            border: "1px solid var(--cr-accent-orange)",
            borderRadius: "6px",
          }}
        >
          <div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--cr-text-primary)" }}>
              {data.merchant.name}
              <span
                style={{
                  fontFamily: "var(--cr-font-mono)",
                  fontSize: "9px",
                  background: "var(--cr-accent-orange)",
                  color: "var(--cr-bg-primary)",
                  padding: "2px 6px",
                  borderRadius: "2px",
                  marginLeft: "8px",
                  verticalAlign: "middle",
                  fontWeight: 700,
                }}
              >
                YOU
              </span>
            </div>
          </div>
          <PlatformBadge platform={data.merchant.platform} />
          <StatusBadge status={data.merchant.acpStatus} />
          <div style={{ minWidth: "80px" }} />
        </div>
      </div>

      {/* Competitive insight */}
      {insight && (
        <div
          style={{
            background: "var(--cr-bg-card)",
            border: "1px solid var(--cr-border)",
            borderLeft: "3px solid var(--cr-accent-orange)",
            borderRadius: "8px",
            padding: "24px 28px",
            marginTop: "24px",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "11px",
              letterSpacing: "2px",
              textTransform: "uppercase",
              color: "var(--cr-accent-orange)",
              marginBottom: "8px",
            }}
          >
            Competitive Insight
          </div>
          <div
            style={{
              fontSize: "16px",
              color: "var(--cr-text-primary)",
              lineHeight: 1.7,
            }}
          >
            {insight}
          </div>
        </div>
      )}
    </section>
  );
}

// Legacy format
function LegacyCompetitiveLandscape({
  competitors,
  insight,
}: {
  competitors: CompetitorScore[];
  insight: string;
}) {
  function getBarColor(score: number): string {
    if (score >= 70) return "var(--cr-accent-orange)";
    if (score >= 40) return "var(--cr-accent-yellow)";
    return "var(--cr-accent-red)";
  }

  return (
    <section style={{ marginBottom: "64px" }}>
      <SectionHeader
        number="05"
        title="Competitive Landscape: AI Readiness in Your Category"
      />

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {competitors.map((comp) => (
          <div
            key={comp.name}
            className="cr-competitor-row"
            style={{
              display: "grid",
              gridTemplateColumns: "180px 60px 1fr",
              alignItems: "center",
              gap: "16px",
              padding: "12px 16px",
              background: comp.isTarget
                ? "rgba(249, 115, 22, 0.15)"
                : "var(--cr-bg-card)",
              border: comp.isTarget
                ? "1px solid var(--cr-accent-orange)"
                : "1px solid var(--cr-border)",
              borderRadius: "6px",
            }}
          >
            <span style={{ fontSize: "14px", fontWeight: 500, color: "var(--cr-text-primary)" }}>
              {comp.name}
              {comp.isTarget && (
                <span
                  style={{
                    fontFamily: "var(--cr-font-mono)",
                    fontSize: "9px",
                    background: "var(--cr-accent-orange)",
                    color: "var(--cr-bg-primary)",
                    padding: "2px 6px",
                    borderRadius: "2px",
                    marginLeft: "6px",
                    verticalAlign: "middle",
                    fontWeight: 700,
                  }}
                >
                  YOU
                </span>
              )}
            </span>
            <span
              style={{
                fontFamily: "var(--cr-font-mono)",
                fontWeight: 700,
                fontSize: "16px",
                textAlign: "center",
                color: getBarColor(comp.score),
              }}
            >
              {comp.score}
            </span>
            <div
              style={{
                height: "8px",
                background: "var(--cr-border)",
                borderRadius: "4px",
                overflow: "hidden",
              }}
            >
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${comp.score}%` }}
                transition={{ duration: 1, ease: "easeOut" }}
                style={{
                  height: "100%",
                  borderRadius: "4px",
                  background: getBarColor(comp.score),
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {insight && (
        <div
          style={{
            background: "var(--cr-bg-card)",
            border: "1px solid var(--cr-border)",
            borderLeft: "3px solid var(--cr-accent-orange)",
            borderRadius: "8px",
            padding: "24px 28px",
            marginTop: "24px",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "11px",
              letterSpacing: "2px",
              textTransform: "uppercase",
              color: "var(--cr-accent-orange)",
              marginBottom: "8px",
            }}
          >
            Competitive Insight
          </div>
          <div
            style={{ fontSize: "16px", color: "var(--cr-text-primary)", lineHeight: 1.7 }}
            dangerouslySetInnerHTML={{ __html: insight }}
          />
        </div>
      )}
    </section>
  );
}

// Main export — detects format
export function CompetitiveLandscape({
  competitors,
  insight,
}: {
  competitors: L2Competitors | CompetitorScore[];
  insight: string;
}) {
  // Detect new format: L2Competitors has alertType
  if (!Array.isArray(competitors) && "alertType" in competitors) {
    return <L2CompetitiveLandscape data={competitors} insight={insight} />;
  }

  // Legacy format
  return <LegacyCompetitiveLandscape competitors={competitors as CompetitorScore[]} insight={insight} />;
}
