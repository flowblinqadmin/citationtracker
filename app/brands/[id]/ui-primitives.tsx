"use client";

// Shared presentational primitives for the brand-detail tabs. Extracted so the
// Overview and Runs tabs render stats through ONE stat treatment (a single
// MetricCard) instead of the old divergent "flat text pairs on Runs / cards on
// Overview" split. Pure, client-safe, matching BrandDetail's inline-style idiom
// and app/ui.ts tokens (no new colour literals).
import type { ReactNode, CSSProperties } from "react";
import { UI } from "@/app/ui";

const CARD = UI.CARD;
const BORDER = UI.BORDER_CSS;
const MUTED = UI.T2; // Mid Grey — labels
const FAINT = UI.T3; // Steel — sub-captions, section headers

/**
 * An inline ⓘ affordance carrying a native-title tooltip. No dependency, no
 * portal — just a hoverable glyph so a metric's denominator/definition is one
 * hover away without cluttering the tile. Reused wherever a stat label needs
 * disambiguation.
 */
export function InfoDot({ text }: { text: string }) {
  return (
    <span
      title={text}
      role="img"
      aria-label={text}
      style={{ marginLeft: 4, color: FAINT, cursor: "help", fontSize: 11 }}
    >
      ⓘ
    </span>
  );
}

/**
 * A labeled stat tile — the single stat presentation shared by Overview + Runs.
 * `sub` carries the denominator/explanation so a percentage is never ambiguous.
 * `inset` swaps the white fill for the subtle grey inset used when a tile nests
 * inside a white card (a run card), so it still reads as a distinct tile.
 */
export function MetricCard({
  label,
  value,
  sub,
  inset,
  info,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  inset?: boolean;
  /** Optional disambiguation note shown as a native-title ⓘ glyph beside the label. */
  info?: string;
}) {
  return (
    <div
      style={{
        background: inset ? UI.REPLY_BG : CARD,
        border: BORDER,
        borderRadius: 12,
        padding: "14px 16px",
        flex: "1 1 150px",
      }}
    >
      <div style={{ fontSize: 12, color: MUTED }}>
        {label}
        {info && <InfoDot text={info} />}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, margin: "4px 0" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: FAINT }}>{sub}</div>}
    </div>
  );
}

/**
 * A titled white content card. Consolidates the repeated card + muted-heading
 * pattern the Overview panels all shared, so spacing stays consistent.
 */
export function Panel({
  title,
  children,
  style,
}: {
  title?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "16px 18px", ...style }}>
      {title != null && <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>{title}</div>}
      {children}
    </div>
  );
}

/**
 * A quiet uppercase group heading. Segments a long stack of panels into a few
 * scannable sections (Apple-style grouping) so data doesn't require hunting.
 */
export function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: FAINT,
        margin: "10px 0 -2px",
      }}
    >
      {children}
    </div>
  );
}
