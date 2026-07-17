"use client";

// Brand list — the app home. Create brands, see credit balance, drill in.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiUrl } from "@/lib/api-url";
import { UI } from "./ui";

interface Brand {
  id: string;
  name: string;
  domain: string | null;
  runFrequency: "manual" | "weekly" | "monthly";
  createdAt: string;
}

const CARD = UI.CARD;
const BORDER = UI.BORDER_CSS;
const MUTED = UI.T2;
const FAINT = UI.T3; // Steel — the bin icon's resting colour
const ACCENT = UI.COPPER;
const ON_ACCENT = UI.ON_ACCENT;
const RED = UI.RED;

// Quiet secondary button — matches the Cancel treatment in BrandDetail's
// delete confirm (CARD bg, hairline border, Mid Grey text).
const SECONDARY_BTN: React.CSSProperties = {
  padding: "6px 14px",
  background: CARD,
  color: MUTED,
  border: BORDER,
  borderRadius: 8,
  fontSize: 13,
  cursor: "pointer",
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
};

/** Trash icon button — Steel at rest, Error Red on hover. No new deps. */
function BinButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label="Delete brand"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        padding: 6,
        cursor: "pointer",
        color: hover ? RED : FAINT,
      }}
    >
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      </svg>
    </button>
  );
}

export default function BrandListPage() {
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[] | null>(null);
  // Delete flow: a modal confirms intent, then the row is optimistically hidden
  // for a 7s Undo window before the API call actually fires. `confirming` holds
  // the brand awaiting modal confirmation; `deferredIds` are hidden-pending-delete
  // rows; timers fire the real DELETE (or are cancelled by Undo).
  const [confirming, setConfirming] = useState<Brand | null>(null);
  const [deferredIds, setDeferredIds] = useState<string[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    const brandsRes = await fetch(apiUrl("/api/brands"));
    if (brandsRes.ok) setBrands((await brandsRes.json()).brands);
  }, []);

  useEffect(() => {
    // Canonical fetch-on-mount; load() sets state only after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // First-run: a team with no brands lands in the onboarding wizard — unless
  // they explicitly skipped it this session (flag set by the wizard's Skip
  // button), otherwise Skip would just bounce them straight back in.
  useEffect(() => {
    if (brands === null || brands.length > 0) return;
    let skipped = false;
    try {
      skipped = sessionStorage.getItem("cite-onboarding-skipped") === "1";
    } catch {
      /* ignore — SSR / storage disabled */
    }
    if (!skipped) router.replace("/onboarding");
  }, [brands, router]);

  // Fire the real DELETE once the Undo window elapses. On failure, the hidden
  // row is restored so nothing silently vanishes.
  const commitDelete = useCallback(async (id: string) => {
    delete timers.current[id];
    try {
      const res = await fetch(apiUrl(`/api/brands/${id}`), { method: "DELETE" });
      if (!res.ok) {
        toast.error((await res.json().catch(() => ({}))).error ?? "Could not delete this brand");
        setDeferredIds((cur) => cur.filter((x) => x !== id)); // un-hide
        return;
      }
      setBrands((cur) => (cur ? cur.filter((b) => b.id !== id) : cur));
      setDeferredIds((cur) => cur.filter((x) => x !== id));
    } catch {
      toast.error("Could not delete this brand");
      setDeferredIds((cur) => cur.filter((x) => x !== id));
    }
  }, []);

  // Confirmed in the modal → hide the row, open a 7s Undo toast, then commit.
  function startDeferredDelete(brand: Brand) {
    setConfirming(null);
    setDeferredIds((cur) => (cur.includes(brand.id) ? cur : [...cur, brand.id]));
    timers.current[brand.id] = setTimeout(() => void commitDelete(brand.id), 7000);
    toast(`Deleted ${brand.name}`, {
      duration: 7000,
      action: {
        label: "Undo",
        onClick: () => {
          const t = timers.current[brand.id];
          if (t) {
            clearTimeout(t);
            delete timers.current[brand.id];
          }
          setDeferredIds((cur) => cur.filter((x) => x !== brand.id)); // row reappears in place
        },
      },
    });
  }

  // On unmount (navigation away), flush any still-pending deletes — the user
  // already confirmed them, so commit rather than lose the intent, and clear
  // timers so nothing fires against an unmounted component.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const [id, t] of Object.entries(pending)) {
        clearTimeout(t);
        void fetch(apiUrl(`/api/brands/${id}`), { method: "DELETE" });
      }
    };
  }, []);

  // Escape closes the confirmation modal (blur-to-cancel safety).
  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirming(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  // Rows hidden during their Undo window are dropped from the visible list.
  const visibleBrands = (brands ?? []).filter((b) => !deferredIds.includes(b.id));

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "40px 24px" }}>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>Citations</h1>
        <p style={{ margin: "6px 0 0", color: MUTED, fontSize: 14 }}>
          Track how ChatGPT, Perplexity, and Gemini cite your brands.
        </p>
      </header>

      <div style={{ marginBottom: 28 }}>
        <Link
          href="/onboarding"
          style={{ padding: "10px 18px", background: ACCENT, color: ON_ACCENT, border: "none", borderRadius: 8, fontSize: 14, cursor: "pointer", textDecoration: "none", display: "inline-flex", alignItems: "center" }}
        >
          Add brand
        </Link>
      </div>

      {brands === null ? (
        <p style={{ color: MUTED }}>Loading…</p>
      ) : visibleBrands.length === 0 ? (
        <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: 32, textAlign: "center", color: MUTED }}>
          No brands yet. Add one above, pick prompts from the library, and run your first citation check.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {visibleBrands.map((b) => (
            <div
              key={b.id}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, background: CARD, border: BORDER, borderRadius: 12, padding: "16px 20px", color: UI.TEXT }}
            >
              <Link
                href={`/brands/${b.id}`}
                style={{ minWidth: 0, textDecoration: "none", color: UI.TEXT }}
              >
                <strong>{b.name}</strong>
                {b.domain && <span style={{ color: MUTED, marginLeft: 10, fontSize: 13 }}>{b.domain}</span>}
              </Link>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <Link href={`/brands/${b.id}`} style={SECONDARY_BTN}>
                  Details
                </Link>
                <BinButton onClick={() => setConfirming(b)} />
              </div>
            </div>
          ))}
        </div>
      )}

      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Delete ${confirming.name}`}
          onClick={() => setConfirming(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, zIndex: 50 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: CARD, border: BORDER, borderRadius: 12, padding: 24, maxWidth: 420, width: "100%", color: UI.TEXT }}
          >
            <h2 style={{ margin: 0, fontSize: 18 }}>Delete {confirming.name}?</h2>
            <p style={{ margin: "8px 0 20px", color: MUTED, fontSize: 14, lineHeight: 1.5 }}>
              This removes the brand and all its prompts and citation checks. You&apos;ll have a few seconds to undo.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setConfirming(null)} style={SECONDARY_BTN}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => startDeferredDelete(confirming)}
                style={{ padding: "6px 14px", background: RED, color: ON_ACCENT, border: `1px solid ${UI.RED_BORDER}`, borderRadius: 8, fontSize: 13, cursor: "pointer" }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
