"use client";

// Brand list — the app home. Create brands, see credit balance, drill in.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
const ACCENT = UI.COPPER;

export default function BrandListPage() {
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[] | null>(null);

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
          style={{ padding: "10px 18px", background: ACCENT, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, cursor: "pointer", textDecoration: "none", display: "inline-flex", alignItems: "center" }}
        >
          Add brand
        </Link>
      </div>

      {brands === null ? (
        <p style={{ color: MUTED }}>Loading…</p>
      ) : brands.length === 0 ? (
        <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: 32, textAlign: "center", color: MUTED }}>
          No brands yet. Add one above, pick prompts from the library, and run your first citation check.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {brands.map((b) => (
            <Link
              key={b.id}
              href={`/brands/${b.id}`}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: CARD, border: BORDER, borderRadius: 12, padding: "16px 20px", textDecoration: "none" }}
            >
              <div>
                <strong>{b.name}</strong>
                {b.domain && <span style={{ color: MUTED, marginLeft: 10, fontSize: 13 }}>{b.domain}</span>}
              </div>
              <span style={{ color: MUTED, fontSize: 13 }}>
                {b.runFrequency === "manual" ? "manual runs" : `runs ${b.runFrequency}`} →
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
