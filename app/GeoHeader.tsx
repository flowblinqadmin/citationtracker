"use client";

// Global product header — visually identical to geo's dashboard header
// (app/dashboard/page.tsx in the geo repo) so the transition between geo pages
// and /citations is seamless. Rendered at the layout level → appears on the
// brand list and every brand detail page.
//
// Nav semantics under the multi-zone rewrite (basePath /citations):
//   "Audits"    → plain <a href="/dashboard">  — geo's dashboard, a DIFFERENT
//                 zone. next/link would prefix /citations and client-route into
//                 a 404, so this MUST be a plain anchor.
//   "Citations" → plain <a href="/citations">  — this app's home (active item).
// Both use plain anchors for the same basePath reason.

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api-url";
import { createClient } from "@/lib/supabase/client";

// ── geo design-system constants (copied 1:1 from geo dashboard) ──────────────
const COPPER = "#c2652a";
const HEADER_BG = "#FAF9F5";
const HEADER_BORDER = "rgba(0,0,0,0.06)";
const TEXT = "#1d1d1f";
const T2 = "#86868b";
const FONT_STACK = "var(--font-inter), system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

interface TeamInfo {
  email: string | null;
  creditBalance: number;
}

async function handleSignOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
  // Clear geo's client-side auth breadcrumbs too (same Supabase project).
  try {
    sessionStorage.removeItem("geo-authed");
    Object.keys(localStorage)
      .filter((k) => k.startsWith("sb-"))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* storage may be unavailable; the signOut cookie clear is what matters */
  }
  // Plain path escapes the /citations basePath → geo's origin/home.
  window.location.href = "/";
}

// geoOrigin comes from the SERVER layout: GEO_ORIGIN reads a non-NEXT_PUBLIC
// env var, so evaluating it inside this client component gives the server the
// real value and the browser bundle only the fallback — a hydration mismatch
// wherever they differ (e2e, staging). A serialized prop is identical on both.
export default function GeoHeader({ geoOrigin }: { geoOrigin: string }) {
  const [team, setTeam] = useState<TeamInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(apiUrl("/api/teams/me"));
      if (!cancelled && res.ok) {
        const data = await res.json();
        setTeam({ email: data.email ?? null, creditBalance: data.creditBalance ?? 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 32px",
        height: 54,
        background: HEADER_BG,
        borderBottom: `1px solid ${HEADER_BORDER}`,
        position: "sticky",
        top: 0,
        zIndex: 100,
        fontFamily: FONT_STACK,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: COPPER, letterSpacing: "2.5px" }}>
          FLOWBLINQ GEO
        </div>
        <nav style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Audits lives on geo (other zone) — plain anchor, no basePath prefix. */}
          <a href="/dashboard" style={{ fontSize: 13, fontWeight: 600, color: T2, textDecoration: "none" }}>
            Audits
          </a>
          {/* Active item — mirror of geo's header (where Audits is active). */}
          <a href="/citations" style={{ fontSize: 13, fontWeight: 600, color: TEXT, textDecoration: "none" }}>
            Citations
          </a>
        </nav>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {/* Empty placeholder while /api/teams/me is in flight — no layout shift. */}
        <span style={{ fontSize: 13, color: T2 }}>{team?.email ?? ""}</span>
        {/* Credits chip → geo's buy-credits flow (same target the old page header used). */}
        <a
          href={`${geoOrigin}/dashboard`}
          style={{
            background: COPPER,
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "6px 14px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            textDecoration: "none",
            transition: "opacity 0.2s",
          }}
        >
          {team ? `${team.creditBalance} credits` : "… credits"}
        </a>
        <button
          onClick={() => void handleSignOut()}
          style={{
            background: "transparent",
            border: "1px solid rgba(194, 101, 42, 0.25)",
            borderRadius: 8,
            padding: "6px 14px",
            color: COPPER,
            fontSize: 13,
            fontFamily: "inherit",
            cursor: "pointer",
            transition: "background 0.2s",
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
