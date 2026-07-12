"use client";
// Post-onboarding getting-started checklist. A dismissible card at the top of
// the brand Overview tab that teaches the next actions: add competitors, track
// publicity URLs, run the first report, set a schedule. Auto-hides once every
// item is complete, and can be dismissed per-brand (persisted in localStorage).
//
// The derivation is a pure fn (lib/onboarding-checklist.ts, unit-tested); this
// component only wires state + navigation. Tracked-URL presence isn't in
// BrandDetail's scope, so we fetch it here once.
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiUrl } from "@/lib/api-url";
import type { TrackerRunFrequency } from "@/lib/types/tracker";
import { checklistItems, dismissKey } from "@/lib/onboarding-checklist";

const CARD = "#ffffff";
const BORDER = "1px solid rgba(0,0,0,0.08)";
const MUTED = "#78716c";
const ACCENT = "#b45309";
const GREEN = "#16a34a";
const HIGHLIGHT = "#fff7ed";

export default function GettingStarted({
  brandId,
  hasCompetitors,
  hasRuns,
  runFrequency,
  onNavigateTab,
}: {
  brandId: string;
  hasCompetitors: boolean;
  hasRuns: boolean;
  runFrequency: TrackerRunFrequency;
  // Overview/Prompts links inside BrandDetail are tab switches, not routes —
  // let the parent flip the tab instead of a full navigation.
  onNavigateTab?: (tab: "overview" | "prompts") => void;
}) {
  const [hasTrackedUrls, setHasTrackedUrls] = useState(false);
  const [dismissed, setDismissed] = useState(true); // hidden until localStorage read

  useEffect(() => {
    try {
      // localStorage is client-only: state must be set after mount (SSR renders
      // hidden), so the sync setState here is the intended reveal, not a cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(window.localStorage.getItem(dismissKey(brandId)) === "1");
    } catch {
      setDismissed(false);
    }
  }, [brandId]);

  useEffect(() => {
    let active = true;
    void fetch(apiUrl(`/api/brands/${brandId}/tracked-urls`))
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { urls?: unknown[] };
        if (active) setHasTrackedUrls((body.urls?.length ?? 0) > 0);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [brandId]);

  const items = checklistItems({ brandId, hasCompetitors, hasTrackedUrls, hasRuns, runFrequency });
  if (items.length === 0 || dismissed) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(dismissKey(brandId), "1");
    } catch {
      /* private mode — just hide for the session */
    }
    setDismissed(true);
  }

  const doneCount = items.filter((i) => i.done).length;

  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "16px 18px", marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Getting started</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            {doneCount} of {items.length} done — finish setup to get the most out of citation tracking.
          </div>
        </div>
        <button
          onClick={dismiss}
          title="Dismiss"
          aria-label="Dismiss getting started"
          style={{ background: "none", border: "none", color: MUTED, fontSize: 16, cursor: "pointer", padding: 4, lineHeight: 1 }}
        >
          ✕
        </button>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        {items.map((item) => {
          const mark = (
            <span style={{ color: item.done ? GREEN : MUTED, fontWeight: 700, width: 16, display: "inline-block" }}>
              {item.done ? "✓" : "○"}
            </span>
          );
          const label = (
            <span style={{ fontSize: 13, color: item.done ? MUTED : "inherit", textDecoration: item.done ? "line-through" : "none" }}>
              {item.label}
            </span>
          );
          const row = (
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {mark}
              {label}
            </span>
          );

          if (item.done || !item.href) {
            return (
              <div key={item.key} style={{ padding: "6px 8px" }}>
                {row}
              </div>
            );
          }

          // Tab-switch targets stay in-page; /onboarding is a real route.
          const tab = item.key === "first-run" ? "prompts" : item.key === "schedule" ? null : "overview";
          if (tab && onNavigateTab) {
            return (
              <button
                key={item.key}
                onClick={() => onNavigateTab(tab)}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: HIGHLIGHT, border: BORDER, borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 13, color: "inherit" }}
              >
                {mark}
                <span style={{ fontSize: 13 }}>{item.label}</span>
                <span style={{ marginLeft: "auto", color: ACCENT, fontSize: 12 }}>→</span>
              </button>
            );
          }

          return (
            <Link
              key={item.key}
              href={item.href}
              style={{ display: "flex", alignItems: "center", gap: 8, background: HIGHLIGHT, border: BORDER, borderRadius: 8, padding: "6px 8px", textDecoration: "none", color: "inherit" }}
            >
              {mark}
              <span style={{ fontSize: 13 }}>{item.label}</span>
              <span style={{ marginLeft: "auto", color: ACCENT, fontSize: 12 }}>→</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
