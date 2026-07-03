"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { normalizeUrl } from "@/lib/utils";
import { PAGES_PER_CREDIT } from "@/lib/config";

const BULK_MAX_URLS = 501;
const BULK_CREDIT_PRICE_INR = 20;

const BG      = "#faf8f5";
const CARD    = "#ffffff";
const BORDER  = "rgba(0,0,0,0.07)";
const TEXT    = "#1c1917";
const TEXT_2  = "#78716c";
const TEXT_3  = "#a8a29e";
const ACCENT  = "#b45309";
const GREEN   = "#16a34a";
const RED     = "#dc2626";

export default function HomePage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  // Auth + credits state
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [teamDomains, setTeamDomains] = useState<Array<{ domain: string; siteId: string; pipelineStatus: string }>>([]);

  // CSV state
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvUrls, setCsvUrls] = useState<string[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);
  // Bulk CSV is hidden behind a disclosure by default (conversion audit 2026-06-10):
  // dangling a Pro/enterprise feature in the cold entry form muddied the
  // "Free. No credit card." promise and made the offer feel salesy up front.
  const [showBulk, setShowBulk] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Fast-path: restore UI from sessionStorage before async Supabase check
    if (sessionStorage.getItem("geo-authed") === "1") {
      setIsAuthenticated(true);
    }
    // Check auth — do NOT redirect
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user ?? null;
      if (user) {
        sessionStorage.setItem("geo-authed", "1");
        setIsAuthenticated(true);
        setEmail(user.email ?? "");
        fetch("/api/teams/me").then((r) => r.json()).then((d) => {
          setCreditBalance(d.team?.creditBalance ?? 0);
        }).catch(() => {});
        fetch("/api/teams/domains").then((r) => r.json()).then((d) => {
          setTeamDomains(d.domains ?? []);
        }).catch(() => {});
      } else {
        sessionStorage.removeItem("geo-authed");
        setIsAuthenticated(false);
      }
    }).catch(() => {});
  }, []);

  const handleCsvUpload = (file: File) => {
    setCsvError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split(/\r?\n/).filter(Boolean);
      const urls: string[] = [];

      for (const line of lines) {
        const firstCol = line.split(",")[0].trim().replace(/^["']|["']$/g, "");
        const normalized = normalizeUrl(firstCol);
        if (normalized) urls.push(normalized);
      }

      const unique = [...new Set(urls)];
      if (unique.length === 0) {
        setCsvError("No valid URLs found in CSV. Ensure URLs are in the first column.");
        return;
      }
      if (unique.length > BULK_MAX_URLS) {
        setCsvError(`CSV contains ${unique.length} URLs — max ${BULK_MAX_URLS} per audit.`);
        return;
      }

      setCsvUrls(unique);
      setCsvFile(file);
    };
    reader.readAsText(file);
  };

  const handleCsvDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleCsvUpload(file);
  };

  const csvPricingMessage = (() => {
    if (csvUrls.length === 0) return null;
    const urlCount = csvUrls.length;
    const creditsNeeded = Math.ceil(urlCount / PAGES_PER_CREDIT);
    const costInr = creditsNeeded * BULK_CREDIT_PRICE_INR;

    if (isAuthenticated && creditBalance !== null) {
      const crawlLimit = Math.min(urlCount, creditBalance * PAGES_PER_CREDIT, 500);
      if (crawlLimit >= urlCount) {
        return `${urlCount} URLs detected — ${creditsNeeded} credits required (₹${costInr.toLocaleString()}). All URLs will be processed.`;
      } else if (crawlLimit > 0) {
        return `${urlCount} URLs detected but your account has ${creditBalance} credits (${creditBalance * PAGES_PER_CREDIT} pages). ${crawlLimit} of ${urlCount} URLs will be processed.`;
      } else {
        return `${urlCount} URLs detected — you need ${creditsNeeded} credits. Your balance is 0.`;
      }
    }

    return `${urlCount} URLs detected → ${creditsNeeded} credits (₹${costInr.toLocaleString()}). Sign in to see your credit limit.`;
  })();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      toast.error("Please enter your email");
      return;
    }
    if (csvUrls.length === 0 && !url.trim()) {
      toast.error("Please enter a website URL or upload a CSV");
      return;
    }

    // Fast path: authenticated user with a cached token for an existing complete site
    if (isAuthenticated && csvUrls.length === 0 && url.trim()) {
      const normalizedInput = new URL(normalizeUrl(url.trim()) ?? "https://x").hostname.replace(/^www\./, "");
      if (normalizedInput && normalizedInput !== "x") {
        const existing = teamDomains.find(
          (d) => d.domain === normalizedInput && d.pipelineStatus === "complete"
        );
        if (existing) {
          const cachedToken = sessionStorage.getItem(`geo-token-${existing.siteId}`);
          if (cachedToken) {
            router.replace(`/sites/${existing.siteId}?token=${cachedToken}`);
            return;
          }
        }
      }
    }

    setLoading(true);
    try {
      let body: { email: string; bulkUrls?: string[]; url?: string };
      if (csvUrls.length > 0) {
        body = { email: email.trim(), bulkUrls: csvUrls };
      } else {
        const normalizedSingleUrl = normalizeUrl(url.trim());
        if (!normalizedSingleUrl) {
          toast.error("Please enter a valid website URL (e.g. example.com)");
          setLoading(false);
          return;
        }
        body = { url: normalizedSingleUrl, email: email.trim() };
      }

      const res = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json() as { id?: string; message?: string; error?: string; skipVerify?: boolean; accessToken?: string };

      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Try again.");
        return;
      }

      if (data.id) {
        if (data.skipVerify && data.accessToken) {
          // Pro user — pipeline started, go straight to results
          sessionStorage.setItem(`geo-token-${data.id}`, data.accessToken);
          router.replace(`/sites/${data.id}`);
        } else {
          router.replace(`/verify/${data.id}`);
        }
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: BG, color: TEXT, fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* Navigation */}
      <nav style={{ borderBottom: `1px solid ${BORDER}`, padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", background: CARD }}>
        <div style={{ fontWeight: 700, fontSize: "18px", color: TEXT }}>FlowBlinq GEO</div>
        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          {isAuthenticated && (
            <a href="/dashboard" style={{ color: TEXT, fontSize: "14px", textDecoration: "none", background: CARD, border: `1px solid ${BORDER}`, borderRadius: "8px", padding: "6px 14px" }}>
              Dashboard {creditBalance !== null ? `(${creditBalance} credits)` : ""}
            </a>
          )}
          {isAuthenticated ? (
            <button onClick={async () => {
              const supabase = createClient();
              await supabase.auth.signOut();
              sessionStorage.removeItem("geo-authed");
              Object.keys(localStorage).filter(k => k.startsWith("sb-")).forEach(k => localStorage.removeItem(k));
              setIsAuthenticated(false);
              setCreditBalance(null);
              window.location.href = "/auth/login";
            }} style={{ color: TEXT_2, fontSize: "14px", background: "none", border: "none", cursor: "pointer", padding: "6px 0", fontFamily: "inherit" }}>
              Sign out
            </button>
          ) : (
            <a href="/auth/login" style={{ color: "#fff", fontSize: "14px", textDecoration: "none", background: ACCENT, border: "none", borderRadius: "8px", padding: "6px 14px", fontWeight: 600 }}>Sign in</a>
          )}
        </div>
      </nav>

      {/* Hero */}
      <section style={{ maxWidth: "720px", margin: "0 auto", padding: "80px 24px 40px" }}>
        <div style={{ display: "inline-block", background: "#fef3c7", border: "1px solid #fde68a", borderRadius: "100px", padding: "4px 14px", fontSize: "12px", color: ACCENT, marginBottom: "24px", fontWeight: 600 }}>
          AI Commerce Infrastructure
        </div>

        <h1 style={{ fontSize: "clamp(32px, 5vw, 56px)", fontWeight: 800, lineHeight: 1.1, margin: "0 0 20px", color: TEXT }}>
          Make your website<br />
          <span style={{ color: TEXT_2 }}>visible to AI agents</span>
        </h1>

        <p style={{ fontSize: "18px", color: TEXT_2, lineHeight: 1.6, margin: "0 0 24px", maxWidth: "560px" }}>
          AI agents like ChatGPT, Perplexity, and Gemini are changing how people find businesses.
          Is yours discoverable?
        </p>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "520px" }}>
          {/* URL field — disabled when CSV active */}
          <input
            type="text"
            placeholder={csvUrls.length > 0 ? "URL disabled — using CSV upload" : "e.g. example.com or www.example.com"}
            value={csvUrls.length > 0 ? "" : url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={csvUrls.length > 0}
            required={csvUrls.length === 0}
            style={{
              background: csvUrls.length > 0 ? "#f5f2ee" : CARD,
              border: `1px solid ${BORDER}`,
              borderRadius: "10px",
              padding: "14px 18px",
              color: csvUrls.length > 0 ? TEXT_3 : TEXT,
              fontSize: "16px",
              outline: "none",
              cursor: csvUrls.length > 0 ? "not-allowed" : "text",
            }}
          />

          {/* Bulk CSV — hidden behind a disclosure link so the cold entry form stays
              clean (domain + email + free CTA). Revealed on demand for the rare
              multi-site user. */}
          {!showBulk && (
            <button
              type="button"
              onClick={() => setShowBulk(true)}
              style={{ alignSelf: "flex-start", background: "none", border: "none", color: TEXT_2, fontSize: "13px", cursor: "pointer", textDecoration: "underline", padding: "2px 0" }}
            >
              Auditing multiple sites? Bulk-upload a CSV →
            </button>
          )}
          {showBulk && (<>
          {/* CSV Upload Zone */}
          <div
            onDrop={handleCsvDrop}
            onDragOver={(e) => e.preventDefault()}
            style={{
              border: `2px dashed ${csvFile ? GREEN : BORDER}`,
              borderRadius: "10px",
              padding: "16px 18px",
              background: "#f5f2ee",
              cursor: "pointer",
              transition: "border-color 0.2s",
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleCsvUpload(file);
              }}
            />
            {csvFile ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ color: GREEN, fontSize: "14px", fontWeight: 600 }}>{csvFile.name}</div>
                  <div style={{ color: TEXT_2, fontSize: "12px", marginTop: "2px" }}>{csvUrls.length} URLs loaded</div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setCsvFile(null); setCsvUrls([]); setCsvError(null); }}
                  style={{ background: "none", border: "none", color: TEXT_3, cursor: "pointer", fontSize: "18px", padding: "4px" }}
                >
                  ×
                </button>
              </div>
            ) : (
              <div style={{ textAlign: "center" }}>
                <div style={{ color: TEXT_2, fontSize: "14px" }}>
                  <span style={{ color: TEXT, fontWeight: 600 }}>Pro: Bulk URL Audit</span> — Upload CSV with up to 501 URLs
                </div>
                <div style={{ color: TEXT_3, fontSize: "12px", marginTop: "4px" }}>Click or drag & drop • First column = URLs</div>
              </div>
            )}
          </div>

          <a
            href="/sample-bulk-audit.csv"
            download
            style={{ fontSize: "12px", color: TEXT_2, textDecoration: "underline" }}
          >
            Download sample CSV
          </a>

          {csvError && (
            <div style={{ color: RED, fontSize: "13px", paddingLeft: "4px" }}>{csvError}</div>
          )}

          {csvPricingMessage && (
            <div style={{ color: TEXT_2, fontSize: "13px", background: CARD, border: `1px solid ${BORDER}`, borderRadius: "8px", padding: "10px 14px" }}>
              {csvPricingMessage}
            </div>
          )}
          </>)}

          <input
            type="email"
            placeholder="you@yourcompany.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{
              background: CARD,
              border: `1px solid ${BORDER}`,
              borderRadius: "10px",
              padding: "14px 18px",
              color: TEXT,
              fontSize: "16px",
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              background: loading ? TEXT_3 : ACCENT,
              color: "#fff",
              fontWeight: 700,
              fontSize: "16px",
              padding: "14px 28px",
              borderRadius: "10px",
              border: "none",
              cursor: loading ? "not-allowed" : "pointer",
              transition: "background 0.2s",
            }}
          >
            {loading
              ? (isAuthenticated ? "Starting audit..." : "Sending verification...")
              : csvUrls.length > 0
                ? `Audit ${csvUrls.length} URLs`
                : "Get My AI Profile"}
          </button>
        </form>

        <p style={{ fontSize: "13px", color: TEXT_3, marginTop: "12px" }}>
          {csvUrls.length > 0 ? "Pro feature — credits required." : "Free. No credit card. Results in ~3 minutes."}
        </p>
      </section>

      {/* Stats */}
      <section style={{ maxWidth: "720px", margin: "0 auto", padding: "0 24px 60px" }}>
        <div style={{
          background: CARD,
          border: `1px solid ${BORDER}`,
          borderRadius: "16px",
          padding: "32px",
          borderLeft: `3px solid ${ACCENT}`,
        }}>
          <p style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 8px", color: TEXT }}>
            Only 12.4% of websites
          </p>
          <p style={{ color: TEXT_2, margin: 0, lineHeight: 1.6 }}>
            have schema.org markup. The other 87.6% are effectively invisible to AI agents —
            even if they rank well on Google.
          </p>
        </div>
      </section>

      {/* Features */}
      <section style={{ maxWidth: "720px", margin: "0 auto", padding: "0 24px 80px" }}>
        <h2 style={{ fontSize: "22px", fontWeight: 700, marginBottom: "24px", color: TEXT }}>
          What you get
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
          {[
            { title: "See where AI ignores you", desc: "We score your site across 16 AI-discoverability signals and show which buyer questions name competitors instead of you." },
            { title: "We deploy your AI files for you", desc: "llms.txt, business.json and schema markup written and pushed live via CDN — no copy-paste, no dev tickets." },
            { title: "Get cited by ChatGPT, Perplexity & Gemini", desc: "The machine-readable layer AI assistants read before they recommend a business — built and tuned for all three." },
            { title: "Stay cited as things change", desc: "AI re-indexes constantly and competitors update. We re-check and re-deploy every cycle so you don't drift out of the answers." },
            { title: "Beat competitors in AI answers", desc: "See who AI recommends in your category today, and track the competitors winning your buyers." },
            { title: "Live in minutes, not dev sprints", desc: "No replatforming, no engineering work — connect once and FlowBlinq handles deployment and monitoring." },
          ].map((f) => (
            <div key={f.title} style={{
              background: CARD,
              border: `1px solid ${BORDER}`,
              borderRadius: "12px",
              padding: "24px",
            }}>
              <h3 style={{ fontSize: "15px", fontWeight: 600, margin: "0 0 8px", color: TEXT }}>{f.title}</h3>
              <p style={{ color: TEXT_2, fontSize: "14px", lineHeight: 1.6, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      {/* Legitimacy footer (conversion audit 2026-06-10): a first-time buyer about
          to enter a card had no way to answer "is this a real company?" — add legal
          links, contact, and the (true) corporate status. */}
      <footer style={{ borderTop: `1px solid ${BORDER}`, padding: "28px 24px", textAlign: "center", color: TEXT_3, fontSize: "13px", background: CARD }}>
        <div style={{ display: "flex", justifyContent: "center", gap: "18px", flexWrap: "wrap", marginBottom: "8px" }}>
          <a href="https://www.flowblinq.com/terms" target="_blank" rel="noopener noreferrer" style={{ color: TEXT_2, textDecoration: "none" }}>Terms</a>
          <a href="https://www.flowblinq.com/eula" target="_blank" rel="noopener noreferrer" style={{ color: TEXT_2, textDecoration: "none" }}>Privacy</a>
          <a href="mailto:hello@flowblinq.com" style={{ color: TEXT_2, textDecoration: "none" }}>Contact</a>
        </div>
        <div>FlowBlinq Inc. — a Canadian federal corporation · AI Commerce Infrastructure</div>
      </footer>
    </main>
  );
}
