"use client";

export function CommerceCta({
  brandName,
  vertical,
}: {
  brandName: string;
  vertical: string;
}) {
  const websiteUrl = process.env.NEXT_PUBLIC_WEBSITE_URL || "https://flowblinq.com";

  return (
    <section
      style={{
        textAlign: "center",
        padding: "64px 0 80px",
        borderTop: "1px solid var(--cr-border)",
      }}
    >
      <h2
        style={{
          fontFamily: "var(--cr-font-serif)",
          fontSize: "clamp(24px, 5vw, 36px)",
          marginBottom: "12px",
          color: "var(--cr-text-primary)",
        }}
      >
        Your data is ready.
        <br />
        Your infrastructure isn&apos;t.{" "}
        <em style={{ color: "var(--cr-accent-orange)" }}>Yet.</em>
      </h2>
      <p
        style={{
          color: "var(--cr-text-secondary)",
          fontSize: "16px",
          marginBottom: "32px",
          maxWidth: "480px",
          marginLeft: "auto",
          marginRight: "auto",
        }}
      >
        {brandName} can be the first {vertical} brand live on AI commerce. The
        window is open. Your competitors are months behind.
      </p>
      <a
        href={`${websiteUrl}/contact`}
        style={{
          display: "inline-block",
          background: "var(--cr-accent-orange)",
          color: "var(--cr-bg-primary)",
          fontFamily: "var(--cr-font-mono)",
          fontSize: "13px",
          fontWeight: 700,
          letterSpacing: "1px",
          textTransform: "uppercase",
          padding: "16px 40px",
          borderRadius: "6px",
          textDecoration: "none",
        }}
      >
        Start Your Integration →
      </a>
      <div
        style={{
          fontFamily: "var(--cr-font-mono)",
          fontSize: "11px",
          color: "var(--cr-text-muted)",
          marginTop: "16px",
        }}
      >
        4-week deployment · No re-platforming · Cancel anytime
      </div>
    </section>
  );
}
