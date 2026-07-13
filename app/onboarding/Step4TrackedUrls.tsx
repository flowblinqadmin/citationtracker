"use client";

// Step 4 — publicity URLs (optional). Paste up to 50 URLs, one per line; we
// show exactly when AI engines cite those pages.
import { MAX_TRACKED_URLS } from "@/lib/onboarding";
import { UI } from "@/app/ui";

const BORDER = UI.BORDER_CSS;
const MUTED = UI.T2;

export default function Step4TrackedUrls({
  trackedUrls,
  onTrackedUrls,
  onSkip,
}: {
  trackedUrls: string[];
  onTrackedUrls: (urls: string[]) => void;
  onSkip: () => void;
}) {
  const value = trackedUrls.join("\n");

  function handleChange(raw: string) {
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, MAX_TRACKED_URLS);
    // Preserve trailing newline the user is typing: store from split, not lines,
    // so editing feels natural. We keep the parsed list as state of record.
    onTrackedUrls(raw.trim() === "" ? [] : lines);
  }

  const over = trackedUrls.length >= MAX_TRACKED_URLS;

  return (
    <div>
      <h2 style={{ margin: 0, fontSize: 22 }}>Where are you doing publicity?</h2>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 6 }}>
        Doing PR or placing articles? Paste the URLs and we&apos;ll show you exactly when AI engines
        cite those pages.
      </p>

      <textarea
        defaultValue={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={"https://outlet.com/your-feature\nhttps://blog.com/mention"}
        rows={8}
        style={{ width: "100%", boxSizing: "border-box", marginTop: 16, padding: "10px 12px", border: BORDER, borderRadius: 8, fontSize: 14, fontFamily: "inherit" }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <span style={{ color: MUTED, fontSize: 12 }}>
          {trackedUrls.length}/{MAX_TRACKED_URLS} URLs{over ? " (max)" : ""}
        </span>
        <button
          onClick={onSkip}
          style={{ padding: "8px 14px", background: "transparent", border: "none", color: MUTED, fontSize: 14, cursor: "pointer", textDecoration: "underline" }}
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
