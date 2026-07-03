"use client";

/**
 * FreeTierSetupUpsell
 *
 * Shown inside the Setup tab for free-tier teams. Explains why they should
 * upgrade to a subscription using ANONYMIZED FlowBlinq case-study evidence.
 *
 * IMPORTANT: customer-facing — use ONLY anonymized, client-approved proof.
 * Never surface a real customer name here (NDA / confidentiality). The named
 * case studies that previously lived here (Dennis Kirk / Swiss Beauty / PCG)
 * were removed for that reason.
 *
 * Sources (anonymized, "client name withheld by mutual agreement"):
 *   - Hospital network: docs/Case Studies/GEO_CaseStudy_Anonymised.docx
 *   - Consumer brand:    docs/Case Studies/GEO_CaseStudy_ConsumerBrand.docx
 *   - Local business:    docs/Case Studies/GEO_CaseStudy_LocalBusiness.docx
 *   - FlowBlinq self-audit: FlowBlinq's own data (safe to name).
 */

import React from "react";

// ── Design tokens (copper system — matches SitePageClient ES-061) ─────────────
const COPPER    = "#c2652a";
const COPPER_BG = "#fff7ed";
const BG        = "#f5f5f7";
const CARD      = "#fff";
const BORDER    = "#e5e5ea";
const TEXT      = "#1d1d1f";
const T2        = "#86868b";
const T3        = "#aeaeb2";
const GREEN     = "#34c759";
const FONT_STACK = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

interface FreeTierSetupUpsellProps {
  domain: string;
  onUpgradeClick: () => void;
}

// ── Benefit cards ────────────────────────────────────────────────────────────
const BENEFITS: { title: string; body: string }[] = [
  {
    title: "Your fixes get shipped, not handed off",
    body: "PDF reports tell you what to do. Integration does it. We push your llms.txt, business.json, and schema markup directly via CDN — no copy-paste, no dev tickets.",
  },
  {
    title: "Continuous monitoring catches drift",
    body: "Across 9 self-audit cycles, our own structured data score fluctuated between 10 and 92. Schema deployments break silently. A single audit is a snapshot — integration is the strategy.",
  },
  {
    title: "AI agents follow signals, not promises",
    body: "Princeton GEO research shows expert attribution boosts AI citations by 41%. Schema markup produces 2× more AI mentions. We deploy both, automatically, on every re-audit.",
  },
];

// ── Customer proof cards ─────────────────────────────────────────────────────
const PROOFS: {
  id: string;
  name: string;
  tag: string;
  badge: string;
  headline: string;
  detail: string;
  metrics?: { label: string; value: string }[];
}[] = [
  {
    id: "hospital-network",
    name: "Hospital Network",
    tag: "Healthcare · India",
    badge: "245,945 views · <10 days",
    headline: "245,945 views, 5.5× daily uplift — in under 10 days.",
    detail:
      "A 25+ facility hospital network deployed a machine-readable AI layer across 225 high-intent pages. Zero ad spend — AI traffic reached 17% share across 172 countries.",
    metrics: [
      { label: "Daily uplift", value: "5.5×" },
      { label: "AI traffic share", value: "17%" },
      { label: "Countries reached", value: "172" },
    ],
  },
  {
    id: "consumer-brand",
    name: "Global Consumer Brand",
    tag: "Consumer · Global",
    badge: "Still compounding",
    headline: "24,670 views, 3× daily uplift — still growing at day 22.",
    detail:
      "A global consumer brand switched on AI visibility across 500 high-intent pages. 22 days later it's the brand AI recommends — at zero incremental cost.",
    metrics: [
      { label: "Total views", value: "24,670" },
      { label: "Daily uplift", value: "3×" },
      { label: "Pages live", value: "500" },
    ],
  },
  {
    id: "local-business",
    name: "Local Service Business",
    tag: "Local · Australia",
    badge: "Live in 24 hours",
    headline: "From invisible to AI-recommended in 24 hours.",
    detail:
      "A single-location repair business with no SEO or backlinks. Day 1, AI assistants began citing it by name — 655 AI-driven visits and growing.",
    metrics: [
      { label: "AI-driven visits", value: "655" },
      { label: "Time to first citation", value: "24h" },
    ],
  },
  {
    id: "flowblinq-self",
    name: "FlowBlinq",
    tag: "Self-audit",
    badge: "Eat our own cooking",
    headline: "We run FlowBlinq on FlowBlinq.",
    detail:
      "40 pages, 9 cycles. Monitoring caught a schema deployment that would have gone undetected. Single audits don't; continuous integration does.",
    metrics: [
      { label: "Entity Definitions", value: "48 → 72" },
      { label: "Internal Linking", value: "70 → 87" },
      { label: "Metadata Freshness", value: "55 → 68" },
    ],
  },
];

// Reusable customer-proof grid — used on the Setup upsell AND the Overview tab
// (founder directive 2026-06-10: surface proof at the decision point, not only
// on the last tab). Pass heading={false} to omit the "Customer proof" label.
export function CustomerProofCards({ heading = true, testIds = true }: { heading?: boolean; testIds?: boolean }) {
  return (
    <div>
      {heading && (
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase" as const, color: T2, marginBottom: 12 }}>
          Customer proof
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {PROOFS.map((p) => (
          <div
            key={p.id}
            data-testid={testIds ? `proof-card-${p.id}` : undefined}
            style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "18px 20px", display: "flex", flexDirection: "column" as const, gap: 8 }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" as const }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
              <span style={{ fontSize: 11, color: T3 }}>·</span>
              <span style={{ fontSize: 11, color: T2 }}>{p.tag}</span>
            </div>
            <div>
              <span style={{ display: "inline-block", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as const, background: COPPER_BG, color: COPPER, border: "1px solid rgba(194,101,42,0.25)", borderRadius: 6, padding: "3px 8px" }}>
                {p.badge}
              </span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>{p.headline}</div>
            <div style={{ fontSize: 12, color: T2, lineHeight: 1.6 }}>{p.detail}</div>
            {p.metrics && (
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4, marginTop: 4 }}>
                {p.metrics.map(({ label, value }) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", borderBottom: `1px solid ${BG}` }}>
                    <span style={{ color: T2 }}>{label}</span>
                    <span style={{ fontWeight: 600, color: GREEN }}>{value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FreeTierSetupUpsell({ domain, onUpgradeClick }: FreeTierSetupUpsellProps) {
  return (
    <div data-testid="free-tier-setup-upsell" style={{ fontFamily: FONT_STACK, color: TEXT }}>

      {/* ── CTA bar (top) ─────────────────────────────────────────────────── */}
      <div
        style={{
          background: CARD,
          border: `1px solid ${BORDER}`,
          borderRadius: 12,
          padding: "20px 24px",
          marginBottom: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap" as const,
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            Ready to install your fixes?
          </div>
          <div style={{ fontSize: 13, color: T2 }}>
            Plans start at $99/month. Cancel anytime.
          </div>
        </div>
        <button
          type="button"
          onClick={onUpgradeClick}
          data-testid="upgrade-cta"
          style={{
            display: "inline-block",
            background: COPPER,
            color: "#fff",
            fontFamily: FONT_STACK,
            fontSize: 14,
            fontWeight: 600,
            padding: "10px 22px",
            borderRadius: 8,
            border: "none",
            cursor: "pointer",
            whiteSpace: "nowrap" as const,
          }}
        >
          Upgrade to Pro to install fixes →
        </button>
      </div>

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <div
        style={{
          background: COPPER_BG,
          border: "1px solid rgba(194,101,42,0.2)",
          borderRadius: 12,
          padding: "22px 24px",
          marginBottom: 24,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase" as const,
            color: COPPER,
            marginBottom: 8,
          }}
        >
          Setup · Integration required
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 10px", lineHeight: 1.3 }}>
          Your audit found what&apos;s broken.
          <br />
          Integration deploys the fixes.
        </h2>
        <p style={{ fontSize: 14, color: T2, margin: 0, lineHeight: 1.65, maxWidth: 560 }}>
          The {domain} audit identified specific AI-visibility gaps.
          The Setup tab connects FlowBlinq to your stack so those fixes — llms.txt,
          business.json, schema markup — are deployed and re-deployed automatically as
          your site, schema, and content evolve. One-time audits decay. Integration holds.
        </p>
      </div>

      {/* ── Benefit cards ─────────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          marginBottom: 28,
        }}
      >
        {BENEFITS.map((b) => (
          <div
            key={b.title}
            style={{
              background: CARD,
              border: `1px solid ${BORDER}`,
              borderRadius: 10,
              padding: "18px 20px",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{b.title}</div>
            <div style={{ fontSize: 13, color: T2, lineHeight: 1.6 }}>{b.body}</div>
          </div>
        ))}
      </div>

      {/* ── Customer proof (shared component — also rendered on Overview) ──── */}
      <div style={{ marginBottom: 28 }}>
        <CustomerProofCards />
      </div>

    </div>
  );
}
