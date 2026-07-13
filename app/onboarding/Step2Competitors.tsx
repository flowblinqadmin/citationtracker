"use client";

// Step 2 — competitors. On entry we POST /api/brands/suggest {domain} once and
// populate rows (name+domain). Degrades silently to empty rows on failure —
// never blocks. Suggested prompts from the same response are hoisted to state.
import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api-url";
import { normalizeDomain } from "@/lib/domain";
import type { WizardCompetitor } from "@/lib/onboarding";
import { MAX_COMPETITORS } from "@/lib/onboarding";
import { UI } from "@/app/ui";

const CARD = UI.CARD;
const BORDER = UI.BORDER_CSS;
const MUTED = UI.T2;
const ACCENT = UI.COPPER;

interface SuggestResponse {
  competitors?: { name: string; domain: string }[];
  prompts?: string[];
}

export default function Step2Competitors({
  domain,
  competitors,
  onCompetitors,
  onSuggestedPrompts,
  onSuggestLoading,
}: {
  domain: string;
  competitors: WizardCompetitor[];
  onCompetitors: (rows: WizardCompetitor[]) => void;
  onSuggestedPrompts: (prompts: string[]) => void;
  onSuggestLoading?: (loading: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const fetched = useRef(false);
  // Kept in sync every render so the async resolver reads the CURRENT rows, not
  // the mount-time closure — otherwise a slow response clobbers what the user
  // typed while it was in flight.
  const competitorsRef = useRef(competitors);
  competitorsRef.current = competitors;
  // Latest onSuggestLoading without retriggering the mount effect.
  const onSuggestLoadingRef = useRef(onSuggestLoading);
  onSuggestLoadingRef.current = onSuggestLoading;

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    const clean = normalizeDomain(domain);
    if (!clean) return;
    setLoading(true);
    onSuggestLoadingRef.current?.(true);
    void (async () => {
      try {
        const res = await fetch(apiUrl("/api/brands/suggest"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain: clean }),
        });
        if (!res.ok) return; // degrade silently
        const data: SuggestResponse = await res.json();
        const rows = (data.competitors ?? [])
          .map((c) => ({ name: c.name ?? "", domain: c.domain ?? "" }))
          .slice(0, MAX_COMPETITORS);
        // Read the ref, not the closure — only fill if the user hasn't typed.
        if (rows.length && competitorsRef.current.length === 0) onCompetitors(rows);
        if (Array.isArray(data.prompts)) onSuggestedPrompts(data.prompts);
      } catch {
        // degrade silently
      } finally {
        setLoading(false);
        onSuggestLoadingRef.current?.(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(i: number, patch: Partial<WizardCompetitor>) {
    onCompetitors(competitors.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function remove(i: number) {
    onCompetitors(competitors.filter((_, idx) => idx !== i));
  }
  function add() {
    if (competitors.length >= MAX_COMPETITORS) return;
    onCompetitors([...competitors, { name: "", domain: "" }]);
  }

  const full = competitors.length >= MAX_COMPETITORS;

  return (
    <div>
      <h2 style={{ margin: 0, fontSize: 22 }}>Your brand competitors</h2>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 6 }}>
        We analyzed your site to identify top competitors so you can see how you compare in AI
        answers. Not quite right? Edit, add, or remove any of them.
      </p>

      <div style={{ display: "grid", gap: 8, marginTop: 20 }}>
        {loading && competitors.length === 0
          ? [0, 1, 2].map((i) => (
              <div key={i} style={{ height: 42, background: UI.NEUTRAL_BG, borderRadius: 8, opacity: 0.6 }} />
            ))
          : competitors.map((c, i) => {
              const bad = c.domain.length > 0 && !normalizeDomain(c.domain);
              return (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    value={c.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder="Competitor name"
                    maxLength={100}
                    style={{ flex: 2, padding: "9px 12px", border: BORDER, borderRadius: 8, fontSize: 14 }}
                  />
                  <input
                    value={c.domain}
                    onChange={(e) => update(i, { domain: e.target.value })}
                    placeholder="rival.com"
                    maxLength={253}
                    style={{ flex: 1, padding: "9px 12px", border: bad ? `1px solid ${UI.RED}` : BORDER, borderRadius: 8, fontSize: 14 }}
                  />
                  <button
                    onClick={() => remove(i)}
                    aria-label="Remove competitor"
                    style={{ padding: "8px 12px", background: CARD, border: BORDER, borderRadius: 8, cursor: "pointer", color: MUTED }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
        <button
          onClick={add}
          disabled={full}
          style={{ padding: "9px 14px", background: CARD, border: `1px solid ${ACCENT}`, color: ACCENT, borderRadius: 8, fontSize: 14, cursor: full ? "default" : "pointer", opacity: full ? 0.5 : 1 }}
        >
          + Add competitor
        </button>
        {full && <span style={{ color: MUTED, fontSize: 13 }}>10 of 10</span>}
      </div>
    </div>
  );
}
