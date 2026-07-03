"use client";
import { CARD, BORDER, TEXT, T2, COPPER } from "../design-tokens";

interface EmptyStateProps {
  title: string;
  description: string;
  ctaLabel?: string;
  onCtaClick?: () => void;
}

export default function EmptyState({ title, description, ctaLabel, onCtaClick }: EmptyStateProps) {
  return (
    <div style={{ textAlign: "center", padding: "48px 24px", background: CARD, borderRadius: 12, border: `1px solid ${BORDER}` }}>
      <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.3 }}>📊</div>
      <h3 style={{ fontSize: 16, fontWeight: 600, color: TEXT, margin: "0 0 8px" }}>{title}</h3>
      <p style={{ fontSize: 13, color: T2, margin: "0 0 20px", maxWidth: 360, marginLeft: "auto", marginRight: "auto", lineHeight: 1.5 }}>{description}</p>
      {ctaLabel && onCtaClick && (
        <button onClick={onCtaClick} style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: COPPER, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
