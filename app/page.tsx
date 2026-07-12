"use client";

// Brand list — the app home. Create brands, see credit balance, drill in.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { apiUrl } from "@/lib/api-url";
import { normalizeDomain } from "@/lib/domain";

interface Brand {
  id: string;
  name: string;
  domain: string | null;
  runFrequency: "manual" | "weekly" | "monthly";
  createdAt: string;
}

const CARD = "#ffffff";
const BORDER = "1px solid rgba(0,0,0,0.08)";
const MUTED = "#78716c";
const ACCENT = "#b45309";

export default function BrandListPage() {
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const brandsRes = await fetch(apiUrl("/api/brands"));
    if (brandsRes.ok) setBrands((await brandsRes.json()).brands);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createBrand(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !domain.trim()) return;
    // Canonicalize what they typed (URL, www., trailing slash all welcome) so
    // the field shows the clean hostname and we never bounce a paste-able URL.
    const cleanDomain = normalizeDomain(domain);
    if (!cleanDomain) {
      toast.error("Enter a valid domain, e.g. acme.com");
      return;
    }
    setDomain(cleanDomain);
    setCreating(true);
    try {
      const res = await fetch(apiUrl("/api/brands"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), domain: cleanDomain }),
      });
      if (!res.ok) {
        toast.error((await res.json()).error ?? "Could not create brand");
        return;
      }
      setName("");
      setDomain("");
      await load();
      toast.success("Brand created — add prompts next");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "40px 24px" }}>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>Citations</h1>
        <p style={{ margin: "6px 0 0", color: MUTED, fontSize: 14 }}>
          Track how ChatGPT, Perplexity, and Gemini cite your brands.
        </p>
      </header>

      <form onSubmit={createBrand} style={{ display: "flex", gap: 8, marginBottom: 28 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Brand name (e.g. Acme)"
          maxLength={100}
          style={{ flex: 2, padding: "10px 12px", border: BORDER, borderRadius: 8, fontSize: 14 }}
        />
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="Domain (e.g. acme.com)"
          maxLength={253}
          style={{ flex: 1, padding: "10px 12px", border: BORDER, borderRadius: 8, fontSize: 14 }}
        />
        <button
          type="submit"
          disabled={creating || !name.trim() || !domain.trim()}
          style={{ padding: "10px 18px", background: ACCENT, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, cursor: "pointer", opacity: creating || !name.trim() || !domain.trim() ? 0.5 : 1 }}
        >
          Add brand
        </button>
      </form>

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
