"use client";

const STYLES = {
  header: {
    padding: "20px 0",
    borderBottom: "1px solid var(--cr-border)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  } as React.CSSProperties,
  logo: {
    fontFamily: "var(--cr-font-mono)",
    fontWeight: 700,
    fontSize: "14px",
    letterSpacing: "2px",
    textTransform: "uppercase" as const,
    color: "var(--cr-accent-orange)",
  } as React.CSSProperties,
  logoSpan: {
    color: "var(--cr-text-muted)",
    fontWeight: 400,
  } as React.CSSProperties,
  meta: {
    fontFamily: "var(--cr-font-mono)",
    fontSize: "11px",
    color: "var(--cr-text-muted)",
    textAlign: "right" as const,
    lineHeight: 1.5,
  } as React.CSSProperties,
};

export function CommerceHeader({ reportId, date }: { reportId: string; date: string }) {
  return (
    <header style={STYLES.header}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <img src="/logo.jpg" alt="FlowBlinq" style={{ height: "28px", width: "28px", borderRadius: "50%" }} />
        <div style={STYLES.logo}>
          FLOWBLINQ <span style={STYLES.logoSpan}>/ audit</span>
        </div>
      </div>
      <div className="cr-report-id" style={STYLES.meta}>
        Report ID: {reportId}
        <br />
        Generated: {date}
      </div>
    </header>
  );
}
