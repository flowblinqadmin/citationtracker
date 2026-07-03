"use client";

import { useEffect, useState } from "react";

// ── Design Tokens ──────────────────────────────────────────────────────────────
//
// Warm-light report aesthetic. Think: quality printed audit on cream paper,
// sitting on a desk. Depth comes from surface shifts, not shadows.
//
// Surfaces (same hue, shifting lightness):
//   parchment → sheet → sheet-alt → hover
//
// Text hierarchy:
//   ink → ink-2 → ink-3
//
// Borders (rgba blends, not solid hex):
//   line (faintest) → crease (standard) → fold (emphasis)

const C = {
  // Surfaces
  parchment:  "#faf8f5",   // page background
  sheet:      "#ffffff",   // card surface
  sheetAlt:   "#f5f2ee",   // alt rows, code blocks, elevated
  hover:      "#f0ebe4",   // card hover

  // Borders
  line:   "rgba(0,0,0,0.04)",   // hairline separator
  crease: "rgba(0,0,0,0.07)",   // card border (standard)
  fold:   "rgba(0,0,0,0.13)",   // emphasis border

  // Text
  ink:  "#1c1917",   // primary
  ink2: "#78716c",   // secondary
  ink3: "#a8a29e",   // muted

  // Brand
  accent: "#b45309",   // amber — existing brand color, kept

  // Semantic (score)
  green: "#16a34a",
  amber: "#d97706",
  red:   "#dc2626",
} as const;

function scoreColor(s: number) {
  return s >= 80 ? C.green : s >= 50 ? C.amber : C.red;
}

function scoreBand(s: number) {
  if (s >= 91) return "Excellent";
  if (s >= 71) return "Good";
  if (s >= 51) return "Fair";
  if (s >= 31) return "Weak";
  return "Poor";
}

// ── Score Ring ─────────────────────────────────────────────────────────────────
// Animates from 0 → score via ease-out cubic over ~1.1s.
// Count-up number is synchronized to the sweep.
function ScoreRing({
  score,
  size = 80,
  delay = 0,
}: {
  score: number;
  size?: number;
  delay?: number;
}) {
  const [val, setVal] = useState(0);
  const r      = size * 0.37;
  const circ   = 2 * Math.PI * r;
  const color  = scoreColor(score);
  const offset = circ * (1 - val / 100);

  useEffect(() => {
    let raf: number;
    let start: number | null = null;
    const dur  = 1100;
    const ease = (t: number) => 1 - (1 - t) ** 3;

    const tick = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      setVal(Math.round(score * ease(p)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };

    const timer = setTimeout(() => { raf = requestAnimationFrame(tick); }, delay);
    return () => { clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [score, delay]);

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg
        width={size}
        height={size}
        style={{ transform: "rotate(-90deg)", display: "block" }}
      >
        {/* Track */}
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none"
          stroke="rgba(0,0,0,0.07)"
          strokeWidth={size * 0.06}
        />
        {/* Arc */}
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none"
          stroke={color}
          strokeWidth={size * 0.06}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.04s linear, stroke 0.4s" }}
        />
      </svg>
      {/* Centered label */}
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        pointerEvents: "none",
      }}>
        <span style={{
          fontSize: size * 0.3,
          fontWeight: 800,
          lineHeight: 1,
          color,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.02em",
        }}>
          {val}
        </span>
        <span style={{
          fontSize: size * 0.095,
          color: C.ink3,
          marginTop: 3,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}>
          score
        </span>
      </div>
    </div>
  );
}

// ── Pillar Bar ──────────────────────────────────────────────────────────────────
function PillarBar({ name, score, delay }: { name: string; score: number; delay: number }) {
  const [width, setWidth] = useState(0);
  const color = scoreColor(score);

  useEffect(() => {
    const t = setTimeout(() => setWidth(score), delay);
    return () => clearTimeout(t);
  }, [score, delay]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 12 }}>
      <div className="preview-pillar-label" style={{ color: C.ink2, flexShrink: 0, textAlign: "right" }}>
        {name}
      </div>
      <div style={{ flex: 1, height: 4, background: "rgba(0,0,0,0.06)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{
          height: "100%",
          borderRadius: 2,
          background: color,
          width: `${width}%`,
          transition: "width 0.85s cubic-bezier(0.25, 1, 0.5, 1)",
        }} />
      </div>
      <div style={{
        width: 28,
        fontSize: 12,
        fontWeight: 600,
        color,
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
      }}>
        {score}
      </div>
    </div>
  );
}

// ── Status Badge ────────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; color: string; border: string; label: string }> = {
    complete:  { bg: "#f0fdf4", color: "#16a34a", border: "#bbf7d0", label: "Complete"  },
    failed:    { bg: "#fef2f2", color: "#dc2626", border: "#fecaca", label: "Failed"    },
    crawling:  { bg: "#fffbeb", color: "#d97706", border: "#fde68a", label: "Crawling"  },
    analyzing: { bg: "#fffbeb", color: "#d97706", border: "#fde68a", label: "Analyzing" },
    queued:    { bg: "#f5f5f4", color: "#78716c", border: "#e5e5e4", label: "Queued"    },
  };
  const s = styles[status] ?? { bg: "#f5f5f4", color: C.ink2, border: "#e5e5e4", label: status };
  return (
    <span style={{
      display: "inline-block",
      background: s.bg,
      color: s.color,
      border: `1px solid ${s.border}`,
      borderRadius: 100,
      padding: "2px 10px",
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: "0.03em",
    }}>
      {s.label}
    </span>
  );
}

// ── Audit Card ──────────────────────────────────────────────────────────────────
function AuditCard({
  domain,
  score,
  status,
  lastCrawl,
  delay,
}: {
  domain: string;
  score: number | null;
  status: string;
  lastCrawl: string;
  delay: number;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? C.hover : C.sheet,
        border: `1px solid ${hovered ? C.fold : C.crease}`,
        borderRadius: 14,
        padding: "20px 20px 20px 20px",
        cursor: "pointer",
        transition: "background 0.15s, border-color 0.15s",
      }}
    >
      {/* Header: domain + status */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: 20,
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 3 }}>
            {domain}
          </div>
          <div style={{ fontSize: 11, color: C.ink3 }}>{lastCrawl}</div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Score */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {score !== null ? (
          <>
            <ScoreRing score={score} size={72} delay={delay} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: scoreColor(score) }}>
                {scoreBand(score)}
              </div>
              <div style={{ fontSize: 11, color: C.ink2, marginTop: 2 }}>
                AI Discoverability
              </div>
            </div>
          </>
        ) : (
          <div style={{ height: 72, display: "flex", alignItems: "center" }}>
            <div style={{ fontSize: 13, color: C.ink3 }}>
              {status === "complete" ? "Score unavailable" : "Running analysis…"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Nav ─────────────────────────────────────────────────────────────────────────
function Nav({ credits }: { credits: number }) {
  return (
    <nav style={{
      borderBottom: `1px solid ${C.crease}`,
      padding: "0 32px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      height: 52,
      background: C.parchment,
      position: "sticky",
      top: 0,
      zIndex: 10,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>
        FlowBlinq GEO
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 13, color: C.ink2 }}>ar@flowblinq.com</span>
        <span style={{
          background: "#fef3c7",
          color: C.accent,
          border: "1px solid #fde68a",
          borderRadius: 100,
          padding: "3px 10px",
          fontSize: 11,
          fontWeight: 600,
        }}>
          {credits} credits
        </span>
        <button style={{
          background: "transparent",
          border: `1px solid ${C.crease}`,
          borderRadius: 6,
          padding: "5px 12px",
          fontSize: 12,
          color: C.ink2,
          cursor: "pointer",
        }}>
          Sign out
        </button>
      </div>
    </nav>
  );
}

// ── Empty State ─────────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <div style={{
      background: C.sheet,
      border: `1px solid ${C.crease}`,
      borderRadius: 16,
      padding: "64px 32px",
      textAlign: "center",
      maxWidth: 480,
      margin: "0 auto",
    }}>
      {/* Score ring at 0 — suggests what's coming */}
      <div style={{ display: "inline-block", marginBottom: 24, opacity: 0.35 }}>
        <svg width={64} height={64} style={{ transform: "rotate(-90deg)", display: "block" }}>
          <circle cx={32} cy={32} r={24} fill="none" stroke={C.crease} strokeWidth={5} />
          <circle
            cx={32} cy={32} r={24}
            fill="none" stroke={C.ink3} strokeWidth={5}
            strokeDasharray={`${2 * Math.PI * 24 * 0.15} ${2 * Math.PI * 24 * 0.85}`}
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
        No audits yet
      </div>
      <div style={{
        fontSize: 13,
        color: C.ink2,
        lineHeight: 1.7,
        maxWidth: 320,
        margin: "0 auto 28px",
      }}>
        Run your first AI discoverability audit and see how visible your site
        is to ChatGPT, Perplexity, and Gemini.
      </div>
      <a
        href="/?new=1"
        style={{
          display: "inline-block",
          background: C.accent,
          color: "#fff",
          fontWeight: 700,
          fontSize: 14,
          padding: "10px 24px",
          borderRadius: 8,
          textDecoration: "none",
        }}
      >
        Run your first audit →
      </a>
    </div>
  );
}

// ── Results Hero ────────────────────────────────────────────────────────────────
const PILLARS = [
  { name: "Schema markup",  score: 82 },
  { name: "Content depth",  score: 67 },
  { name: "Trust signals",  score: 54 },
  { name: "AI citations",   score: 71 },
  { name: "Technical GEO", score: 48 },
];

function ResultsHero({ score }: { score: number }) {
  return (
    <div style={{ background: C.sheet, border: `1px solid ${C.crease}`, borderRadius: 16, overflow: "hidden" }}>
      <style>{`
        .preview-hero-body {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 36px;
          padding: 24px 28px;
          align-items: start;
        }
        .preview-pillar-row { display: flex; align-items: center; gap: 10px; padding-bottom: 12px; }
        .preview-pillar-label { width: 100px; font-size: 12px; flex-shrink: 0; text-align: right; }
        @media (max-width: 580px) {
          .preview-hero-body {
            grid-template-columns: 1fr;
            gap: 24px;
            padding: 20px 16px;
          }
          .preview-ring-col { flex-direction: row !important; align-items: center !important; gap: 16px !important; }
          .preview-ring-meta { text-align: left !important; }
          .preview-pillar-label { width: 80px; font-size: 11px; }
        }
      `}</style>

      {/* Top strip */}
      <div style={{
        padding: "13px 20px", borderBottom: `1px solid ${C.crease}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: C.sheetAlt,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>acme.com</div>
        <StatusBadge status="complete" />
      </div>

      {/* Body */}
      <div className="preview-hero-body">
        {/* Ring */}
        <div className="preview-ring-col" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <ScoreRing score={score} size={140} delay={100} />
          <div className="preview-ring-meta" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <span style={{
              background: `${scoreColor(score)}12`, color: scoreColor(score),
              border: `1px solid ${scoreColor(score)}30`,
              borderRadius: 100, padding: "3px 10px",
              fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
            }}>
              {scoreBand(score)}
            </span>
            <div style={{ fontSize: 11, color: C.ink3, textAlign: "center" }}>
              Baseline 62 · ↑ +12 from first run
            </div>
          </div>
        </div>

        {/* Pillars + stats */}
        <div>
          <div style={{ fontSize: 10, color: C.ink3, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 14 }}>
            Pillar Breakdown
          </div>
          {PILLARS.map((p, i) => (
            <PillarBar key={p.name} name={p.name} score={p.score} delay={200 + i * 80} />
          ))}
          <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 16, marginTop: 4 }}>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              {[
                { label: "Pages crawled", val: "94"    },
                { label: "Issues found",  val: "7"     },
                { label: "Last scan",     val: "Mar 1" },
              ].map((s) => (
                <div key={s.label}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, fontVariantNumeric: "tabular-nums" }}>{s.val}</div>
                  <div style={{ fontSize: 11, color: C.ink3, marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Preview Page ────────────────────────────────────────────────────────────────
const SAMPLE_AUDITS = [
  { domain: "acme.com",        score: 74,   status: "complete",  lastCrawl: "Last scanned Mar 1, 2026",   delay: 100 },
  { domain: "beta-example.co", score: 31,   status: "complete",  lastCrawl: "Last scanned Feb 22, 2026",  delay: 280 },
  { domain: "newsite.io",      score: null, status: "crawling",  lastCrawl: "Running now…",               delay: 0   },
];

export default function PreviewPage() {
  return (
    <div style={{
      minHeight: "100vh",
      background: C.parchment,
      color: C.ink,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <Nav credits={12} />

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "48px 24px 80px" }}>

        {/* ── 1. Dashboard ── */}
        <Label>Dashboard — Audit list</Label>

        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: C.ink, margin: "0 0 6px" }}>
            Your Audits
          </h1>
          <p style={{ fontSize: 14, color: C.ink2, margin: 0 }}>
            AI discoverability reports for your domains.
          </p>
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(272px, 1fr))",
          gap: 12,
        }}>
          {SAMPLE_AUDITS.map((a) => (
            <AuditCard key={a.domain} {...a} />
          ))}
        </div>

        <div style={{ marginTop: 24, textAlign: "center" }}>
          <a href="/" style={{
            fontSize: 13,
            color: C.accent,
            textDecoration: "none",
            borderBottom: "1px solid rgba(180,83,9,0.25)",
            paddingBottom: 1,
          }}>
            + Run another audit
          </a>
        </div>

        <Divider />

        {/* ── 2. Empty State ── */}
        <Label>Empty state</Label>
        <EmptyState />

        <Divider />

        {/* ── 3. Results Hero ── */}
        <Label>Results page — Score hero</Label>
        <ResultsHero score={74} />

      </div>
    </div>
  );
}

// ── Layout helpers ───────────────────────────────────────────────────────────────
function Divider() {
  return <div style={{ borderTop: `1px solid ${C.crease}`, margin: "56px 0 48px" }} />;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10,
      color: C.ink3,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      marginBottom: 24,
      paddingBottom: 12,
      borderBottom: `1px solid ${C.line}`,
    }}>
      {children}
    </div>
  );
}
