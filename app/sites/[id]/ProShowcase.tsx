"use client";

/**
 * ProShowcase — reusable "this is what Pro shows here" panels for FREE-TIER tabs.
 *
 * Conversion audit 2026-06-10 + founder directive: every free-audit tab should
 * SHOWCASE what the paid product looks like (not sit empty / "run a scan"). Each
 * panel renders a realistic, clearly-labelled PREVIEW of the paid view plus an
 * unlock CTA, so the sale happens on every page — not only the Setup tab.
 *
 * FREE TIER ONLY. Callers gate on isFreeTier; paid users see the real data.
 */

import React from "react";

const COPPER = "#c2652a";
const COPPER_BG = "#fff7ed";
const TEXT = "#1d1d1f";
const T2 = "#6b6b70";
const T3 = "#a8a29e";
const GREEN = "#16a34a";
const BORDER = "#e5e5ea";
const CARD = "#fff";

export function ProShowcasePanel({
  eyebrow = "Preview · what Pro shows here",
  title,
  body,
  ctaLabel = "Get cited by AI →",
  onUpgrade,
  children,
}: {
  eyebrow?: string;
  title: string;
  body: string;
  ctaLabel?: string;
  onUpgrade: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 14, overflow: "hidden", background: CARD }}>
      {/* Header */}
      <div style={{ padding: "18px 22px 16px", borderBottom: `1px solid ${BORDER}` }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: COPPER, marginBottom: 8 }}>
          {eyebrow}
        </div>
        <div style={{ fontSize: 17, fontWeight: 700, color: TEXT, lineHeight: 1.3, marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 13, color: T2, lineHeight: 1.55, maxWidth: 620 }}>{body}</div>
      </div>

      {/* Preview body — real-looking sample with a soft "preview" wash + lock overlay */}
      <div style={{ position: "relative", padding: "20px 22px" }}>
        <div style={{ filter: "saturate(0.9)", opacity: 0.96 }}>{children}</div>
        {/* Lock chip */}
        <div style={{ position: "absolute", top: 14, right: 16, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, color: COPPER, background: COPPER_BG, border: "1px solid rgba(194,101,42,0.3)", borderRadius: 6, padding: "3px 8px" }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={COPPER} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          Sample
        </div>
      </div>

      {/* CTA */}
      <div style={{ padding: "14px 22px 18px", borderTop: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", background: COPPER_BG }}>
        <div style={{ fontSize: 12.5, color: T2 }}>This is illustrative — Pro runs it on <b style={{ color: TEXT }}>your</b> site. From $99/mo · cancel anytime.</div>
        <button
          type="button"
          onClick={onUpgrade}
          style={{ background: COPPER, color: "#fff", fontFamily: "inherit", fontSize: 13.5, fontWeight: 600, padding: "10px 20px", borderRadius: 8, border: "none", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
        >
          {ctaLabel}
        </button>
      </div>
    </div>
  );
}

/** Sample score-history chart — an upward trend, so free users see the payoff of continuous monitoring. */
export function SampleHistoryChart() {
  const pts = [42, 48, 51, 58, 64, 71, 78];
  const W = 560, H = 120, PAD = 24;
  const cw = W - PAD * 2, ch = H - PAD * 2;
  const x = (i: number) => PAD + (i / (pts.length - 1)) * cw;
  const y = (s: number) => PAD + ch - (s / 100) * ch;
  const line = pts.map((s, i) => `${x(i)},${y(s)}`).join(" ");
  const area = `M ${x(0)},${PAD + ch} L ${pts.map((s, i) => `${x(i)},${y(s)}`).join(" L ")} L ${x(pts.length - 1)},${PAD + ch} Z`;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 28, fontWeight: 800, color: GREEN }}>+36</span>
        <span style={{ fontSize: 13, color: T2 }}>points over 7 weekly re-audits</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
        {[25, 50, 75].map(v => <line key={v} x1={PAD} y1={y(v)} x2={W - PAD} y2={y(v)} stroke={BORDER} strokeWidth="1" />)}
        <path d={area} fill="rgba(22,163,74,0.10)" />
        <polyline points={line} fill="none" stroke={GREEN} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((s, i) => <circle key={i} cx={x(i)} cy={y(s)} r="3.5" fill="#fff" stroke={GREEN} strokeWidth="2" />)}
      </svg>
    </div>
  );
}

/** Sample citation log — the gut-punch: AI naming competitors, not you. */
export function SampleCitationLog({ domain }: { domain: string }) {
  const rows = [
    { q: "best options near me", you: false, comp: "competitor-a.com" },
    { q: "who do you recommend for…", you: false, comp: "competitor-b.com" },
    { q: `is ${domain || "this brand"} any good?`, you: true, comp: null },
  ];
  const providers = ["ChatGPT", "Perplexity", "Gemini"];
  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {providers.map(p => (
          <span key={p} style={{ fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 5, background: "#fef2f2", color: "#b91c1c" }}>{p} · 1/4 cited</span>
        ))}
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${BORDER}` }}>
          <span style={{ fontSize: 13, flex: 1, color: TEXT }}>&ldquo;{r.q}&rdquo;</span>
          {r.you
            ? <span style={{ fontSize: 12, fontWeight: 700, color: GREEN, whiteSpace: "nowrap" }}>✓ You cited</span>
            : <span style={{ fontSize: 12, fontWeight: 700, color: "#b91c1c", whiteSpace: "nowrap" }}>✗ {r.comp} cited, not you</span>}
        </div>
      ))}
    </div>
  );
}
