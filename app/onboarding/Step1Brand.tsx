"use client";

// Step 1 — brand identity. Website first; brand name auto-fills on domain blur
// and a favicon chip confirms "we found your brand".
import { useState } from "react";
import { normalizeDomain } from "@/lib/domain";
import { brandFromDomain } from "@/lib/onboarding";
import { UI } from "@/app/ui";

const BORDER = UI.BORDER_CSS;
const MUTED = UI.T2;
const ACCENT = UI.COPPER;

export default function Step1Brand({
  domain,
  brandName,
  onDomain,
  onBrandName,
}: {
  domain: string;
  brandName: string;
  onDomain: (v: string) => void;
  onBrandName: (v: string) => void;
}) {
  const [faviconOk, setFaviconOk] = useState(true);
  const cleanDomain = normalizeDomain(domain);

  function handleBlur() {
    const clean = normalizeDomain(domain);
    if (clean) {
      onDomain(clean);
      if (!brandName.trim()) onBrandName(brandFromDomain(clean));
      setFaviconOk(true);
    }
  }

  return (
    <div>
      <h2 style={{ margin: 0, fontSize: 22 }}>Welcome — let&apos;s set up your brand</h2>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 6 }}>
        Tell us about the brand you want to monitor.
      </p>

      <label style={{ display: "block", marginTop: 24, fontSize: 13, color: MUTED }}>
        Brand website
      </label>
      <input
        value={domain}
        onChange={(e) => onDomain(e.target.value)}
        onBlur={handleBlur}
        placeholder="acme.com"
        maxLength={253}
        style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: BORDER, borderRadius: 8, fontSize: 14, marginTop: 6 }}
      />

      <label style={{ display: "block", marginTop: 20, fontSize: 13, color: MUTED }}>
        Brand name
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
        {cleanDomain &&
          (faviconOk ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://www.google.com/s2/favicons?domain=${cleanDomain}&sz=64`}
              alt=""
              width={28}
              height={28}
              onError={() => setFaviconOk(false)}
              style={{ borderRadius: 6, flexShrink: 0 }}
            />
          ) : (
            <span
              aria-hidden
              style={{ width: 28, height: 28, flexShrink: 0, borderRadius: "50%", background: UI.COPPER_BG, color: ACCENT, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600 }}
            >
              {(brandName || cleanDomain).charAt(0).toUpperCase()}
            </span>
          ))}
        <input
          value={brandName}
          onChange={(e) => onBrandName(e.target.value)}
          placeholder="Acme"
          maxLength={100}
          style={{ flex: 1, padding: "10px 12px", border: BORDER, borderRadius: 8, fontSize: 14 }}
        />
      </div>
      {cleanDomain && (
        <p style={{ color: MUTED, fontSize: 12, marginTop: 8 }}>We found your brand — edit the name if it&apos;s off.</p>
      )}
    </div>
  );
}
