"use client";

const URGENCY_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  critical: { bg: "rgba(239,68,68,0.15)", color: "#ef4444", label: "CRITICAL" },
  high: { bg: "rgba(249,115,22,0.15)", color: "#f97316", label: "HIGH" },
  moderate: { bg: "rgba(234,179,8,0.15)", color: "#eab308", label: "MODERATE" },
};

export function CommerceVerdict({
  verdict,
}: {
  verdict: { html: string; urgencyLevel: string } | string;
}) {
  // Support both old (string) and new (object) format
  const html = typeof verdict === "string" ? verdict : verdict.html;
  const urgency = typeof verdict === "string" ? null : verdict.urgencyLevel;
  const urgencyStyle = urgency ? URGENCY_STYLES[urgency] : null;

  return (
    <div
      style={{
        background: "var(--cr-bg-card)",
        border: "1px solid var(--cr-border)",
        borderLeft: "3px solid var(--cr-accent-orange)",
        borderRadius: "8px",
        padding: "24px 28px",
        marginBottom: "64px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: "8px",
        }}
      >
        <span
          style={{
            fontFamily: "var(--cr-font-mono)",
            fontSize: "11px",
            letterSpacing: "2px",
            textTransform: "uppercase",
            color: "var(--cr-accent-orange)",
          }}
        >
          Executive Verdict
        </span>
        {urgencyStyle && (
          <span
            style={{
              fontFamily: "var(--cr-font-mono)",
              fontSize: "9px",
              letterSpacing: "1px",
              fontWeight: 700,
              color: urgencyStyle.color,
              background: urgencyStyle.bg,
              padding: "2px 8px",
              borderRadius: "3px",
              border: `1px solid ${urgencyStyle.color}44`,
            }}
          >
            {urgencyStyle.label}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: "16px",
          color: "var(--cr-text-primary)",
          lineHeight: 1.7,
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
