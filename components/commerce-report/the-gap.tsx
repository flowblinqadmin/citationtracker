"use client";

import type { GapSection as GapSectionType } from "@/lib/types/commerce-report";

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

export function TheGap({ data }: { data: GapSectionType }) {
  return (
    <section style={{ marginBottom: "64px" }}>
      <SectionHeader number="07" title="The Gap: What's Missing" />

      {/* Three red zero cards */}
      <div
        className="cr-grid-3"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "16px",
          marginBottom: "32px",
        }}
      >
        {data.items.map((item) => (
          <div
            key={item.label}
            style={{
              background: "var(--cr-bg-card)",
              border: "1px solid var(--cr-accent-red)",
              borderLeft: "3px solid var(--cr-accent-red)",
              borderRadius: "8px",
              padding: "20px",
            }}
          >
            <div
              style={{
                fontFamily: "var(--cr-font-mono)",
                fontSize: "32px",
                fontWeight: 700,
                color: "var(--cr-accent-red)",
                lineHeight: 1,
                marginBottom: "4px",
              }}
            >
              {item.value}
            </div>
            <div
              style={{
                fontSize: "12px",
                color: "var(--cr-text-muted)",
                fontFamily: "var(--cr-font-mono)",
                letterSpacing: "0.5px",
              }}
            >
              {item.label}
            </div>
            <div
              style={{
                fontSize: "12px",
                color: "var(--cr-text-muted)",
                marginTop: "8px",
              }}
            >
              {item.description}
            </div>
          </div>
        ))}
      </div>

      {/* Timeline */}
      <div
        style={{
          border: "1px solid var(--cr-border)",
          borderRadius: "8px",
          overflow: "hidden",
          background: "var(--cr-bg-card)",
        }}
      >
        <div
          style={{
            padding: "28px",
          }}
        >
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "10px",
              letterSpacing: "2px",
              textTransform: "uppercase",
              color: "var(--cr-accent-orange)",
              marginBottom: "16px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "var(--cr-accent-orange)",
              }}
            />
            Implementation Path — Estimated Timeline
          </div>
          <div
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "12px",
              lineHeight: 2.4,
              color: "var(--cr-text-secondary)",
            }}
          >
            {data.timeline.map((step) => (
              <div key={step.period}>
                <span style={{ color: "var(--cr-text-muted)" }}>{step.period}:</span>{" "}
                <span style={{ color: "var(--cr-text-primary)" }}>{step.description}</span>
              </div>
            ))}
            <div style={{ marginTop: "8px" }}>
              <span style={{ color: "var(--cr-text-muted)" }}>Your dev team commitment:</span>{" "}
              <span style={{ color: "var(--cr-text-primary)" }}>~8 hours total (API credentials + UAT review)</span>
            </div>
            <div>
              <span style={{ color: "var(--cr-text-muted)" }}>Flowblinq handles:</span>{" "}
              <span style={{ color: "var(--cr-text-primary)" }}>Everything else. Zero re-platforming. Zero disruption to existing store.</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
