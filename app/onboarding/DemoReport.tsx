"use client";

// A client-only render of the fictional demo dataset — no fetches. Shown while
// the user's real first run processes so they can explore a realistic report.
// A persistent "Sample data" watermark keeps it honest.
import { PLATFORM_LABEL, PLATFORM_ORDER } from "@/app/brands/[id]/platforms";
import {
  DEMO_VOICE,
  DEMO_COVERAGE,
  DEMO_SOURCES,
  DEMO_TRACKED_HIT,
  DEMO_BRAND,
  DEMO_BRAND_MENTION_RATE,
  DEMO_SOAV,
  DEMO_TOTAL_CITATIONS,
} from "./demo-data";

const CARD = "#ffffff";
const BORDER = "1px solid rgba(0,0,0,0.08)";
const MUTED = "#78716c";
const ACCENT = "#b45309";
const GREEN = "#16a34a";

const pct = (v: number) => `${Math.round(v * 100)}%`;

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px", flex: "1 1 150px" }}>
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, margin: "4px 0" }}>{value}</div>
      <div style={{ fontSize: 12, color: MUTED }}>{sub}</div>
    </div>
  );
}

export default function DemoReport() {
  return (
    <div style={{ position: "relative", marginTop: 20 }}>
      {/* Persistent diagonal watermark — non-interactive, low opacity. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
          opacity: 0.08,
          transform: "rotate(-20deg)",
          fontSize: 64,
          fontWeight: 800,
          color: "#000",
          zIndex: 2,
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        Sample data · Sample data
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ fontSize: 12, color: MUTED }}>
          A sample Brand Report for <strong>{DEMO_BRAND}</strong> (fictional) — this is what yours will look like.
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <Metric label="Brand mentions" value={pct(DEMO_BRAND_MENTION_RATE)} sub="replies naming the brand" />
          <Metric label="Share of AI voice" value={pct(DEMO_SOAV)} sub="brand vs competitor citations" />
          <Metric label="Citations" value={String(DEMO_TOTAL_CITATIONS)} sub="verified sources" />
        </div>

        {/* Share of AI voice — bar list */}
        <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>Share of AI voice</div>
          <div style={{ display: "grid", gap: 8 }}>
            {DEMO_VOICE.map((v) => (
              <div key={v.name} style={{ display: "grid", gridTemplateColumns: "160px 1fr 44px", gap: 10, alignItems: "center", fontSize: 13 }}>
                <span style={{ fontWeight: v.isBrand ? 700 : 400, color: v.isBrand ? GREEN : "inherit", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v.name}{v.isBrand ? " · you" : ""}
                </span>
                <span style={{ background: "#f5f5f4", borderRadius: 999, height: 10, overflow: "hidden" }}>
                  <span style={{ display: "block", height: "100%", width: pct(v.share), background: v.isBrand ? GREEN : ACCENT, borderRadius: 999 }} />
                </span>
                <span style={{ color: MUTED, textAlign: "right" }}>{pct(v.share)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Per-platform coverage grid */}
        <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>Coverage by AI engine</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {PLATFORM_ORDER.map((p) => {
              const row = DEMO_COVERAGE.find((c) => c.platform === p);
              const mentioned = row?.mentioned ?? false;
              return (
                <div key={p} style={{ border: BORDER, borderRadius: 8, padding: "10px 12px", textAlign: "center", background: mentioned ? "#f0fdf4" : "#fafaf9" }}>
                  <div style={{ fontSize: 12, color: MUTED }}>{PLATFORM_LABEL[p] ?? p}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: mentioned ? GREEN : MUTED, margin: "2px 0" }}>
                    {mentioned ? "✓ mentioned" : "— absent"}
                  </div>
                  <div style={{ fontSize: 11, color: MUTED }}>{pct(row?.mentionRate ?? 0)} of prompts</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Top cited sources table */}
        <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Top cited sources</div>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: MUTED, textAlign: "left" }}>
                <th style={{ fontWeight: 400, paddingBottom: 6 }}>Page</th>
                <th style={{ fontWeight: 400 }}>Cited by</th>
                <th style={{ fontWeight: 400, textAlign: "right" }}>Count</th>
              </tr>
            </thead>
            <tbody>
              {DEMO_SOURCES.map((s) => (
                <tr key={s.page} style={{ borderTop: BORDER }}>
                  <td style={{ padding: "6px 0", overflowWrap: "anywhere" }}>
                    <span style={{ fontWeight: s.isBrand ? 700 : 400, color: s.isBrand ? GREEN : "inherit" }}>{s.page}</span>
                    {s.isBrand ? <span style={{ color: GREEN }}> · you</span> : null}
                    {s.isTracked ? (
                      <span style={{ marginLeft: 6, padding: "1px 6px", background: "#fff7ed", border: BORDER, borderRadius: 999, fontSize: 11, color: ACCENT }}>tracked</span>
                    ) : null}
                  </td>
                  <td style={{ color: MUTED }}>{s.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(" + ")}</td>
                  <td style={{ textAlign: "right" }}>{s.count}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* One tracked-URL "cited" win */}
        <div style={{ background: "#fff7ed", border: BORDER, borderRadius: 12, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Tracked publicity URL — cited</div>
          <div style={{ fontSize: 14 }}>
            <span style={{ color: ACCENT, fontWeight: 600, overflowWrap: "anywhere" }}>{DEMO_TRACKED_HIT.page}</span>
            {" "}was cited <strong>{DEMO_TRACKED_HIT.count}×</strong> by{" "}
            {DEMO_TRACKED_HIT.citedBy.map((p) => PLATFORM_LABEL[p] ?? p).join(", ")}.
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
            When AI engines cite your earned coverage, that shows up here.
          </div>
        </div>
      </div>
    </div>
  );
}
