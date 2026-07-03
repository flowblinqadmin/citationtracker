"use client";

const STYLES = {
  hero: {
    padding: "clamp(40px, 8vw, 80px) 0 clamp(30px, 6vw, 60px)",
    position: "relative" as const,
    overflow: "hidden",
  } as React.CSSProperties,
  glow: {
    position: "absolute" as const,
    top: "-200px",
    right: "-200px",
    width: "600px",
    height: "600px",
    background: "radial-gradient(circle, rgba(249,115,22,0.06) 0%, transparent 70%)",
    pointerEvents: "none" as const,
  } as React.CSSProperties,
  eyebrow: {
    fontFamily: "var(--cr-font-mono)",
    fontSize: "11px",
    letterSpacing: "3px",
    textTransform: "uppercase" as const,
    color: "var(--cr-accent-orange)",
    marginBottom: "16px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  } as React.CSSProperties,
  eyebrowLine: {
    width: "24px",
    height: "1px",
    background: "var(--cr-accent-orange)",
  } as React.CSSProperties,
  brand: {
    fontFamily: "var(--cr-font-serif)",
    fontSize: "clamp(32px, 7vw, 56px)",
    fontWeight: 400,
    lineHeight: 1.1,
    marginBottom: "8px",
    color: "var(--cr-text-primary)",
  } as React.CSSProperties,
  brandEm: {
    fontStyle: "italic" as const,
    color: "var(--cr-accent-orange)",
  } as React.CSSProperties,
  subtitle: {
    fontSize: "18px",
    color: "var(--cr-text-secondary)",
    marginBottom: "48px",
    maxWidth: "min(560px, 100%)",
  } as React.CSSProperties,
};

const SCENARIO_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  competitor_live: { bg: "rgba(239,68,68,0.15)", color: "#ef4444", label: "Competitor Live" },
  competitor_building: { bg: "rgba(249,115,22,0.15)", color: "#f97316", label: "Competitors Building" },
  competitor_in_sov: { bg: "rgba(234,179,8,0.15)", color: "#eab308", label: "Competitors in SoV" },
  no_competitors: { bg: "rgba(34,197,94,0.15)", color: "#22c55e", label: "First Mover Window" },
  site_blocked: { bg: "rgba(100,116,139,0.15)", color: "#94a3b8", label: "Site Blocked" },
};

export function CommerceHero({
  brandName,
  vertical,
  subtitle,
  scenario,
  alertBanner,
}: {
  brandName: string;
  vertical: string;
  subtitle: string;
  scenario?: string;
  alertBanner?: React.ReactNode;
}) {
  return (
    <section style={STYLES.hero}>
      <div style={STYLES.glow} />
      <div style={STYLES.eyebrow}>
        <div style={STYLES.eyebrowLine} />
        AI Commerce Readiness Audit
      </div>
      <h1 style={STYLES.brand}>
        {brandName} <em style={STYLES.brandEm}>{vertical}</em>
      </h1>

      {alertBanner ? (
        <div
          className="cr-hero-split"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "32px",
            alignItems: "start",
            marginTop: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <p
              style={{
                fontSize: "17px",
                color: "var(--cr-text-primary)",
                lineHeight: 1.5,
                fontWeight: 400,
                margin: 0,
              }}
              dangerouslySetInnerHTML={{ __html: subtitle }}
            />
          </div>
          <div>{alertBanner}</div>
        </div>
      ) : (
        <p style={STYLES.subtitle}>{subtitle}</p>
      )}
    </section>
  );
}
