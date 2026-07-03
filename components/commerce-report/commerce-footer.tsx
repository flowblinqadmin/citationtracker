"use client";

export function CommerceFooter({
  brandName,
  date,
}: {
  brandName: string;
  date: string;
}) {
  return (
    <footer
      style={{
        padding: "24px 0",
        borderTop: "1px solid var(--cr-border)",
        textAlign: "center",
        fontFamily: "var(--cr-font-mono)",
        fontSize: "11px",
        color: "var(--cr-text-muted)",
      }}
    >
      Flowblinq AI Commerce Infrastructure · Confidential · Prepared for{" "}
      {brandName} · {date}
    </footer>
  );
}
