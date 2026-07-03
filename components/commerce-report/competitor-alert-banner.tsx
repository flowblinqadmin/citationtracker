"use client";

import { AlertTriangle, AlertCircle, CheckCircle } from "lucide-react";
import type { L2Competitors } from "@/lib/types/commerce-report";

const ALERT_CONFIG: Record<string, {
  icon: typeof AlertTriangle;
  headline: string;
  color: string;
  bg: string;
  border: string;
}> = {
  competitor_live: {
    icon: AlertCircle,
    headline: "A Competitor Already Has a Live AI Store",
    color: "#ef4444",
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.4)",
  },
  competitor_building: {
    icon: AlertTriangle,
    headline: "Your Competitors Are Building AI Stores Right Now",
    color: "#f97316",
    bg: "rgba(249,115,22,0.08)",
    border: "rgba(249,115,22,0.4)",
  },
  none_live: {
    icon: CheckCircle,
    headline: "No One in Your Category Has an AI Store — Yet",
    color: "#22c55e",
    bg: "rgba(34,197,94,0.08)",
    border: "rgba(34,197,94,0.4)",
  },
};

export function CompetitorAlertBanner({ data }: { data: L2Competitors }) {
  const config = ALERT_CONFIG[data.alertType];
  if (!config) return null;

  const Icon = config.icon;

  return (
    <div
      style={{
        background: config.bg,
        border: `2px solid ${config.border}`,
        borderRadius: "12px",
        padding: "24px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <Icon size={28} color={config.color} strokeWidth={2} />
        <div
          style={{
            fontFamily: "var(--cr-font-serif)",
            fontSize: "20px",
            fontWeight: 400,
            color: config.color,
            lineHeight: 1.2,
          }}
        >
          {config.headline}
        </div>
      </div>
      <div
        style={{
          fontSize: "14px",
          color: "var(--cr-text-secondary)",
          lineHeight: 1.7,
        }}
      >
        {data.alertHtml}
      </div>
    </div>
  );
}
