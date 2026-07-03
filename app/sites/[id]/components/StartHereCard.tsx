"use client";
import { CARD, BORDER, COPPER, COPPER_BG, TEXT, T2 } from "../design-tokens";
import type { RankedRec } from "../types";

interface StartHereCardProps {
  topRec: RankedRec;
  onViewDetails: () => void;
}

export default function StartHereCard({ topRec, onViewDetails }: StartHereCardProps) {
  return (
    <div style={{ background: COPPER_BG, border: `1px solid rgba(194,101,42,0.15)`, borderRadius: 12, padding: "16px 20px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: COPPER, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Start here</div>
        <div style={{ fontSize: 14, fontWeight: 500, color: TEXT }}>{topRec.title}</div>
        {topRec.description && <div style={{ fontSize: 12, color: T2, marginTop: 4 }}>{topRec.description}</div>}
      </div>
      <button onClick={onViewDetails} style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${COPPER}`, background: "transparent", color: COPPER, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
        View details →
      </button>
    </div>
  );
}
