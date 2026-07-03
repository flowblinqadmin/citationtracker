"use client";

import type { AgenticPulseStat } from "@/lib/types/commerce-report";

export function AgenticPulse({ stats }: { stats: AgenticPulseStat[] }) {
  return (
    <div
      className="cr-grid-4"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "16px",
        marginBottom: "64px",
      }}
    >
      {stats.map((stat) => (
        <div
          key={stat.label}
          style={{
            background: "var(--cr-bg-card)",
            border: "1px solid var(--cr-border)",
            borderRadius: "8px",
            padding: "20px",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "28px",
              fontWeight: 700,
              color: "var(--cr-accent-orange)",
              lineHeight: 1,
              marginBottom: "8px",
            }}
          >
            {stat.value}
          </div>
          <div
            style={{
              fontSize: "13px",
              color: "var(--cr-text-primary)",
              marginBottom: "4px",
              lineHeight: 1.4,
            }}
          >
            {stat.label}
          </div>
          <div
            style={{
              fontSize: "10px",
              fontFamily: "var(--cr-font-mono)",
              color: "var(--cr-text-muted)",
            }}
          >
            {stat.source}
          </div>
        </div>
      ))}
    </div>
  );
}
