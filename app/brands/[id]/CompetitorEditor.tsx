"use client";
// Competitor list editor. The API has supported competitors since day one
// (brandInputSchema.competitors → updateBrand → SoAV/competitor stats) but no
// UI ever exposed adding them. Stats are computed live by domain over stored
// citations, so past runs light up retroactively the moment competitors save.
import { useState } from "react";
import { toast } from "sonner";
import { apiUrl } from "@/lib/api-url";
import { normalizeDomain } from "@/lib/domain";
import type { TrackerCompetitor } from "@/lib/types/tracker";
import { UI } from "@/app/ui";

const CARD = UI.CARD;
const BORDER = UI.BORDER_CSS;
const MUTED = UI.T2; // Mid Grey — body copy
const FAINT = UI.T3; // Steel — counter
const ACCENT = UI.COPPER;
const ON_ACCENT = UI.ON_ACCENT;
const RED = UI.RED;

const MAX_COMPETITORS = 10;

function rowError(row: TrackerCompetitor): string | null {
  if (!row.name.trim()) return "name required";
  if (row.name.length > 100) return "name too long";
  if (!row.domain.trim()) return "domain required";
  if (!normalizeDomain(row.domain)) return "invalid domain";
  return null;
}

export default function CompetitorEditor({
  clientId,
  competitors,
  onSaved,
}: {
  clientId: string;
  competitors: TrackerCompetitor[];
  onSaved: () => Promise<void> | void;
}) {
  const [rows, setRows] = useState<TrackerCompetitor[]>(competitors);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  function update(i: number, patch: Partial<TrackerCompetitor>) {
    setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setDirty(true);
  }

  function remove(i: number) {
    setRows((cur) => cur.filter((_, idx) => idx !== i));
    setDirty(true);
  }

  async function save() {
    const bad = rows.map(rowError).find(Boolean);
    if (bad) {
      toast.error(`Competitor ${bad}`);
      return;
    }
    // Canonicalize each domain to a bare hostname (matches the server schema).
    const cleaned = rows.map((r) => ({ name: r.name.trim(), domain: normalizeDomain(r.domain)! }));
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/api/brands/${clientId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ competitors: cleaned }),
      });
      if (!res.ok) {
        toast.error((await res.json()).error ?? "Could not save competitors");
        return;
      }
      setDirty(false);
      toast.success("Competitors saved — Share of AI voice now compares against them");
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px", marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div>
          <span style={{ fontSize: 13, fontWeight: 600, color: UI.TEXT }}>Competitors</span>{" "}
          <span style={{ fontSize: 12, color: FAINT }}>({rows.length}/{MAX_COMPETITORS})</span>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            Drive Share of AI voice and the competitor citation table
          </div>
        </div>
        {dirty && (
          <button
            onClick={() => void save()}
            disabled={saving}
            style={{ padding: "6px 14px", background: ACCENT, color: ON_ACCENT, border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", opacity: saving ? 0.5 : 1 }}
          >
            {saving ? "Saving…" : "Save competitors"}
          </button>
        )}
      </div>

      {rows.length === 0 && (
        <p style={{ color: MUTED, fontSize: 13, margin: "0 0 8px" }}>
          No competitors yet. Add the brands you compete with — their citations in past and future runs are
          counted by domain.
        </p>
      )}

      <div style={{ display: "grid", gap: 6 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={row.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="Competitor name (e.g. Apollo)"
              style={{ flex: "1 1 40%", padding: "7px 10px", border: BORDER, borderRadius: 6, fontSize: 13 }}
            />
            <input
              value={row.domain}
              onChange={(e) => update(i, { domain: e.target.value })}
              placeholder="Domain (e.g. apollo.com)"
              style={{ flex: "1 1 40%", padding: "7px 10px", border: BORDER, borderRadius: 6, fontSize: 13 }}
            />
            <button
              onClick={() => remove(i)}
              title="Remove competitor"
              style={{ background: "none", border: "none", color: RED, fontSize: 14, cursor: "pointer", padding: 4 }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {rows.length < MAX_COMPETITORS && (
        <button
          onClick={() => {
            setRows((cur) => [...cur, { name: "", domain: "" }]);
            setDirty(true);
          }}
          style={{ marginTop: 8, background: "none", border: "none", color: ACCENT, fontSize: 13, cursor: "pointer", padding: 0 }}
        >
          + Add competitor
        </button>
      )}
    </div>
  );
}
