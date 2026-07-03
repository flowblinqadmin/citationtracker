import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      background: "#faf8f5",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "40px 20px",
      textAlign: "center",
    }}>
      <h1 style={{ fontSize: "72px", fontWeight: 700, color: "#1a1a1a", margin: 0 }}>404</h1>
      <p style={{ fontSize: "18px", color: "#666", marginTop: "12px", marginBottom: "32px" }}>
        This page doesn&apos;t exist.
      </p>
      <Link
        href="/"
        style={{
          display: "inline-block",
          background: "#1a1a1a",
          color: "#fff",
          fontWeight: 600,
          fontSize: "16px",
          padding: "12px 24px",
          borderRadius: "8px",
          textDecoration: "none",
        }}
      >
        Back to home
      </Link>
    </div>
  );
}
