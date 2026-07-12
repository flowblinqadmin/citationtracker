"use client";
// Tracked publicity URLs. Teams add the exact press/blog/launch URLs they're
// doing PR on; the product shows, per URL, whether it's showing up in AI
// citations — cited or not, how many times, on which platforms, last seen.
//
// Stats are computed live by matching tracker.citations against each URL's
// normalized key, so a URL added after a run lights up retroactively (same
// pattern as competitors). The editor full-replaces via PUT.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiUrl } from "@/lib/api-url";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "./platforms";

const CARD = "#ffffff";
const BORDER = "1px solid rgba(0,0,0,0.08)";
const MUTED = "#78716c";
const ACCENT = "#b45309";
const GREEN = "#16a34a";
const RED = "#dc2626";

const MAX_TRACKED_URLS = 50;

interface TrackedUrlStats {
  exactCount: number;
  domainCount: number;
  platforms: string[];
  lastCitedAt: string | null;
}

interface TrackedUrl {
  id: string;
  url: string;
  normalizedUrl: string;
  createdAt: string | null;
  stats: TrackedUrlStats;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The headline: unmistakable per-URL citation status. */
function StatusBadge({ stats }: { stats: TrackedUrlStats }) {
  if (stats.exactCount > 0) {
    const chips = [...stats.platforms].sort((a, b) => PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b));
    return (
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12 }}>
        <span style={{ background: "#f0fdf4", color: GREEN, border: `1px solid ${GREEN}`, borderRadius: 999, padding: "2px 10px", fontWeight: 700 }}>
          Cited {stats.exactCount}×
        </span>
        {chips.map((p) => (
          <span key={p} style={{ background: "#fff7ed", color: ACCENT, border: BORDER, borderRadius: 999, padding: "1px 8px", fontWeight: 600 }}>
            {PLATFORM_LABEL[p] ?? p}
          </span>
        ))}
        {stats.lastCitedAt && <span style={{ color: MUTED }}>last seen {fmtDate(stats.lastCitedAt)}</span>}
      </div>
    );
  }
  if (stats.domainCount > 0) {
    return (
      <span style={{ fontSize: 12, color: MUTED }}>
        Outlet cited {stats.domainCount}× <span style={{ color: "#a8a29e" }}>(different page)</span>
      </span>
    );
  }
  return <span style={{ fontSize: 12, color: "#a8a29e" }}>Not cited yet</span>;
}

export default function TrackedUrlsEditor({ clientId }: { clientId: string }) {
  const [urls, setUrls] = useState<TrackedUrl[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // A fast save() can complete before the mount GET's .then resolves; without a
  // guard that stale GET would setUrls/setDraft back to the pre-save snapshot,
  // silently discarding the just-saved edit. `superseded` flips true when a save
  // succeeds, so the GET stands down permanently.
  const supersededRef = useRef(false);

  useEffect(() => {
    // A network failure or a non-JSON body must not leave the card blank
    // forever: always flip `loaded`, and surface an inline error so the user
    // knows the widget didn't load rather than staring at an empty card.
    let active = true; // false after unmount / clientId change
    void fetch(apiUrl(`/api/brands/${clientId}/tracked-urls`))
      .then(async (res) => {
        if (!res.ok) throw new Error(`tracked-urls GET ${res.status}`);
        const body = (await res.json()) as { urls: TrackedUrl[] };
        // Never clobber a completed save (superseded) or a stale mount (inactive).
        if (!active || supersededRef.current) return;
        setUrls(body.urls);
        setDraft(body.urls.map((u) => u.url));
      })
      .catch(() => {
        if (active && !supersededRef.current) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [clientId]);

  function update(i: number, value: string) {
    setDraft((cur) => cur.map((v, idx) => (idx === i ? value : v)));
    setDirty(true);
  }

  function remove(i: number) {
    setDraft((cur) => cur.filter((_, idx) => idx !== i));
    setDirty(true);
  }

  async function save() {
    const cleaned = draft.map((u) => u.trim()).filter(Boolean);
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/api/brands/${clientId}/tracked-urls`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: cleaned }),
      });
      // Parse defensively: a 500 with an HTML/text body makes res.json() throw,
      // which would otherwise swallow the error and fail silently.
      const body = (await res.json().catch(() => null)) as
        | { urls: TrackedUrl[]; rejected: string[]; error?: string }
        | null;
      if (!res.ok || !body) {
        toast.error(body?.error ?? "Could not save tracked URLs");
        return;
      }
      // Mark the mount GET as superseded so an in-flight one can't overwrite this.
      supersededRef.current = true;
      setUrls(body.urls);
      setDraft(body.urls.map((u) => u.url));
      setDirty(false);
      if (body.rejected.length > 0) {
        toast.error(`Skipped ${body.rejected.length} unparseable URL${body.rejected.length === 1 ? "" : "s"}: ${body.rejected.slice(0, 3).join(", ")}`);
      } else {
        toast.success("Tracked URLs saved — citation status updates as runs complete");
      }
    } catch {
      // A fetch rejection (network down / aborted) never reaches the block above.
      toast.error("Could not save tracked URLs");
    } finally {
      setSaving(false);
    }
  }

  const statsById = new Map(urls.map((u) => [u.url, u.stats]));

  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px", marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: MUTED }}>
          Tracked URLs ({draft.length}/{MAX_TRACKED_URLS}) — press/blog/launch pages you want cited by AI. Each shows whether it&apos;s showing up.
        </div>
        {dirty && (
          <button
            onClick={() => void save()}
            disabled={saving}
            style={{ padding: "6px 14px", background: ACCENT, color: "#fff", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer", opacity: saving ? 0.5 : 1 }}
          >
            {saving ? "Saving…" : "Save URLs"}
          </button>
        )}
      </div>

      {loaded && loadError && (
        <p style={{ color: RED, fontSize: 13, margin: "0 0 8px" }}>
          Couldn&apos;t load tracked URLs — refresh to try again.
        </p>
      )}

      {loaded && !loadError && draft.length === 0 && (
        <p style={{ color: MUTED, fontSize: 13, margin: "0 0 8px" }}>
          No tracked URLs yet — add the pages you&apos;re pitching to press and we&apos;ll flag when AI cites them.
        </p>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        {draft.map((value, i) => {
          const stats = statsById.get(value.trim());
          return (
            <div key={i} style={{ display: "grid", gap: 4 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  value={value}
                  onChange={(e) => update(i, e.target.value)}
                  placeholder="https://outlet.com/your-article"
                  style={{ flex: 1, padding: "7px 10px", border: BORDER, borderRadius: 6, fontSize: 13 }}
                />
                <button
                  onClick={() => remove(i)}
                  title="Remove URL"
                  style={{ background: "none", border: "none", color: RED, fontSize: 14, cursor: "pointer", padding: 4 }}
                >
                  ✕
                </button>
              </div>
              {stats && (
                <div style={{ paddingLeft: 2 }}>
                  <StatusBadge stats={stats} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {draft.length < MAX_TRACKED_URLS && (
        <button
          onClick={() => {
            setDraft((cur) => [...cur, ""]);
            setDirty(true);
          }}
          style={{ marginTop: 8, background: "none", border: "none", color: ACCENT, fontSize: 13, cursor: "pointer", padding: 0 }}
        >
          + Add URL
        </button>
      )}
    </div>
  );
}
