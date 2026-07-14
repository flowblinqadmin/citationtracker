"use client";

// Step 5 — the pre-commit summary + CTA, the commit progress, the processing
// view (Otterly 4-beat), the live provider ticker, and the ready modal with the
// punch list. Owns DemoReport + PunchList. All fetches via apiUrl(); the header
// is at layout level — never rendered here.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiUrl } from "@/lib/api-url";
import type { TrackerRunFrequency } from "@/lib/types/tracker";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "@/app/brands/[id]/platforms";
import DemoReport from "./DemoReport";
import PunchList from "./PunchList";
import { UI } from "@/app/ui";

const BORDER = UI.BORDER_CSS;
const MUTED = UI.T2;
const ACCENT = UI.COPPER;
const ON_ACCENT = UI.ON_ACCENT;
const RED = UI.RED;

const STAGE_COPY: Record<string, string> = {
  brand: "Creating brand…",
  prompts: "Adding prompts…",
  "tracked-urls": "Saving publicity URLs…",
  run: "Starting your report…",
  done: "Starting your report…",
};

type RunStatus = "pending" | "running" | "complete" | "failed";

export interface Step5Props {
  brandId: string | null;
  runId: string | null;
  commit: () => Promise<void>;
  commitStage: string;
  commitError: string | null;
  cost: number;
  brandName: string;
  brandDomain: string;
  promptCount: number;
  competitorCount: number;
  trackedUrlCount: number;
  frequency: TrackerRunFrequency;
}

const FREQUENCY_LABEL: Record<TrackerRunFrequency, string> = {
  manual: "Manual only",
  weekly: "Weekly",
  monthly: "Monthly",
};

export default function Step5(props: Step5Props) {
  const {
    brandId,
    runId,
    commit,
    commitStage,
    commitError,
    cost,
    brandName,
    brandDomain,
    promptCount,
    competitorCount,
    trackedUrlCount,
    frequency,
  } = props;

  const committing = commitStage !== "" && commitStage !== "done";
  const started = brandId !== null || committing;

  // ── Live run status polling (starts once we have a runId) ──────────────────
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    if (!brandId || !runId) return;
    try {
      const res = await fetch(apiUrl(`/api/brands/${brandId}/runs`));
      if (!res.ok) return;
      const body = (await res.json()) as { runs: Array<{ id: string; status: RunStatus }> };
      const run = body.runs.find((r) => r.id === runId);
      if (run) setRunStatus(run.status);
    } catch {
      /* transient — keep polling */
    }
  }, [brandId, runId]);

  useEffect(() => {
    if (!runId) return;
    // poll() only sets state after its fetch resolves — async, not a sync
    // cascade; the rule can't see past the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void poll(); // immediate first read
    pollRef.current = setInterval(() => void poll(), 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [runId, poll]);

  // Stop polling once the run settles.
  useEffect(() => {
    if ((runStatus === "complete" || runStatus === "failed") && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [runStatus]);

  const [showDemo, setShowDemo] = useState(false);

  // ── 1. Pre-commit: summary + CTA ───────────────────────────────────────────
  if (!started && !commitError) {
    return (
      <div>
        <h2 style={{ margin: 0, fontSize: 20 }}>Ready to launch</h2>
        <p style={{ color: MUTED, fontSize: 14, marginTop: 6, marginBottom: 16 }}>
          Review your setup, then run your first Brand Report.
        </p>
        <div style={{ background: UI.COPPER_BG, border: BORDER, borderRadius: 12, padding: "16px 18px", marginBottom: 20 }}>
          <SummaryRow label="Brand" value={brandName || "—"} />
          <SummaryRow label="Prompts" value={`${promptCount}`} />
          <SummaryRow label="Competitors" value={`${competitorCount}`} />
          <SummaryRow label="Tracked URLs" value={`${trackedUrlCount}`} />
          <SummaryRow label="Frequency" value={FREQUENCY_LABEL[frequency]} last />
        </div>
        <button
          onClick={() => void commit()}
          style={{ padding: "10px 18px", background: ACCENT, color: ON_ACCENT, border: "none", borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer" }}
        >
          Run my first report ({cost} credits)
        </button>
      </div>
    );
  }

  // ── Error state (commit failed) ────────────────────────────────────────────
  if (commitError) {
    return (
      <div>
        <h2 style={{ margin: 0, fontSize: 20 }}>Something went wrong</h2>
        <p style={{ color: RED, fontSize: 14, marginTop: 8 }}>{commitError}</p>
        <button
          onClick={() => void commit()}
          style={{ marginTop: 12, padding: "10px 18px", background: ACCENT, color: ON_ACCENT, border: "none", borderRadius: 8, fontSize: 14, cursor: "pointer" }}
        >
          Retry
        </button>
      </div>
    );
  }

  // ── 2. Committing: per-stage progress ──────────────────────────────────────
  if (committing || (started && !runId)) {
    return (
      <div>
        <h2 style={{ margin: 0, fontSize: 20 }}>Launching {brandName || "your brand"}</h2>
        <p style={{ color: MUTED, fontSize: 14, marginTop: 8 }}>
          {STAGE_COPY[commitStage] ?? "Preparing…"}
        </p>
      </div>
    );
  }

  // ── 4. Run failed — honest error state ─────────────────────────────────────
  if (runStatus === "failed") {
    return (
      <div>
        <h2 style={{ margin: 0, fontSize: 20 }}>The run failed</h2>
        <p style={{ color: MUTED, fontSize: 14, marginTop: 8 }}>
          The run failed — your credits were refunded automatically. Try again.
        </p>
        {brandId && (
          <Link
            href={`/brands/${brandId}`}
            style={{ display: "inline-block", marginTop: 12, padding: "10px 18px", background: ACCENT, color: ON_ACCENT, borderRadius: 8, fontSize: 14, textDecoration: "none" }}
          >
            Go to your brand
          </Link>
        )}
      </div>
    );
  }

  // ── 5. Ready modal (run complete) ──────────────────────────────────────────
  if (runStatus === "complete") {
    return (
      <div style={{ textAlign: "center" }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Your brand report is ready!</h2>
        <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.6, margin: "12px auto 20px", maxWidth: 560 }}>
          We analyzed how AI engines reference {brandName || "your brand"}, mapped your citation gaps, and
          generated actionable insights.
        </p>
        {brandId && runId && (
          <PunchList brandId={brandId} runId={runId} brandName={brandName || "your brand"} brandDomain={brandDomain} />
        )}
        {brandId && (
          <Link
            href={`/brands/${brandId}`}
            style={{ display: "inline-block", padding: "10px 18px", background: ACCENT, color: ON_ACCENT, borderRadius: 8, fontSize: 15, fontWeight: 600, textDecoration: "none" }}
          >
            View my brand report
          </Link>
        )}
      </div>
    );
  }

  // ── 3. Processing view (Otterly 4-beat) + live provider ticker ─────────────
  return (
    <div>
      <style>{`@keyframes citePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }`}</style>
      <h2 style={{ margin: 0, fontSize: 22 }}>Welcome aboard!</h2>
      <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.6, marginTop: 12 }}>
        We&apos;re processing live AI answers and building your first Brand Report in the background.
      </p>
      <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.6, marginTop: 8 }}>
        While that runs, we&apos;ve prepared something interactive for you.
      </p>
      <button
        onClick={() => setShowDemo((v) => !v)}
        style={{ marginTop: 16, padding: "10px 18px", background: ACCENT, color: ON_ACCENT, border: "none", borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer" }}
      >
        {showDemo ? "Hide the demo report" : "Explore the demo report"}
      </button>

      {/* Live provider ticker — pulses while pending/running. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 24 }}>
        {PLATFORM_ORDER.map((p) => (
          <span
            key={p}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 12,
              border: `1px solid ${ACCENT}`,
              background: UI.COPPER_BG,
              color: ACCENT,
              animation: "citePulse 1.6s ease-in-out infinite",
            }}
          >
            Querying {PLATFORM_LABEL[p]}…
          </span>
        ))}
      </div>

      {showDemo && <DemoReport />}
    </div>
  );
}

function SummaryRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: last ? "none" : BORDER, fontSize: 14 }}>
      <span style={{ color: MUTED }}>{label}</span>
      <span style={{ fontWeight: 600, overflowWrap: "anywhere", textAlign: "right", marginLeft: 12 }}>{value}</span>
    </div>
  );
}
