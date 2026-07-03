"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { normalizeUrl } from "@/lib/utils";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";
import { PAGES_PER_CREDIT } from "@/lib/config";

const COPPER  = "#c2652a";
const BORDER  = "#e5e5ea";
const TEXT    = "#1d1d1f";
const T2      = "#86868b";
const T3      = "#aeaeb2";
const RED     = "#ff3b30";
const GREEN   = "#34c759";

const BULK_MAX_URLS = 501;

export default function NewAuditForm({ userEmail, creditBalance }: { userEmail: string; creditBalance?: number }) {
  const router = useRouter();
  const isMobile = useMediaQuery(768);
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bulk CSV state
  const [bulkOpen, setBulkOpen] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvUrls, setCsvUrls] = useState<string[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Single audit ─────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let raw = domain.trim().toLowerCase();
    if (!raw) return;
    if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
      raw = "https://" + raw;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: raw, email: userEmail }),
      });
      const data = await res.json() as { id?: string; accessToken?: string; error?: string; message?: string };
      if (!res.ok) {
        setError(data.error ?? data.message ?? "Failed to start audit");
        return;
      }
      if (data.accessToken && data.id) {
        sessionStorage.setItem(`geo-token-${data.id}`, data.accessToken);
      }
      setDomain("");
      router.refresh();
    } catch {
      setError("Network error — try again");
    } finally {
      setLoading(false);
    }
  }

  // ── CSV parsing ──────────────────────────────────────────────────────────
  function handleCsvUpload(file: File) {
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
        setCsvError("No valid URLs found. Ensure URLs are in the first column.");
        return;
      }
      if (unique.length > BULK_MAX_URLS) {
        setCsvError(`${unique.length} URLs found — max ${BULK_MAX_URLS} per audit.`);
        return;
      }
      setCsvUrls(unique);
      setCsvFile(file);
    };
    reader.readAsText(file);
  }

  function clearCsv() {
    setCsvFile(null);
    setCsvUrls([]);
    setCsvError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ── Bulk submit ──────────────────────────────────────────────────────────
  async function handleBulkSubmit() {
    if (csvUrls.length === 0) return;
    setBulkLoading(true);
    setCsvError(null);
    try {
      const res = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: userEmail, bulkUrls: csvUrls }),
      });
      const data = await res.json() as { id?: string; accessToken?: string; error?: string; message?: string; domains?: string[] };
      if (!res.ok) {
        setCsvError(data.error ?? data.message ?? "Bulk audit failed");
        return;
      }
      if (data.accessToken && data.id) {
        sessionStorage.setItem(`geo-token-${data.id}`, data.accessToken);
      }
      clearCsv();
      setBulkOpen(false);
      router.refresh();
    } catch {
      setCsvError("Network error — try again");
    } finally {
      setBulkLoading(false);
    }
  }

  // ── Pricing info ─────────────────────────────────────────────────────────
  const csvPricing = (() => {
    if (csvUrls.length === 0) return null;
    const creditsNeeded = Math.ceil(csvUrls.length / PAGES_PER_CREDIT);
    if (creditBalance !== undefined && creditBalance !== null) {
      const maxPages = creditBalance * PAGES_PER_CREDIT;
      const crawlLimit = Math.min(csvUrls.length, maxPages, 500);
      if (crawlLimit >= csvUrls.length) {
        return { text: `${csvUrls.length} URLs · ${creditsNeeded} credits required`, ok: true };
      } else if (crawlLimit > 0) {
        return { text: `${csvUrls.length} URLs detected · ${creditBalance} credits available · ${crawlLimit} URLs will be processed`, ok: true };
      }
      return { text: `${csvUrls.length} URLs · ${creditsNeeded} credits needed · balance is ${creditBalance}`, ok: false };
    }
    return { text: `${csvUrls.length} URLs · ${creditsNeeded} credits required`, ok: true };
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Row: single input + bulk toggle */}
      <div style={{ display: "flex", alignItems: isMobile ? "stretch" : "center", gap: 8, flexDirection: isMobile ? "column" : "row" }}>
        <form onSubmit={handleSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: isMobile ? "wrap" : "nowrap" }}>
          <input
            type="text"
            value={domain}
            onChange={e => { setDomain(e.target.value); setError(null); }}
            placeholder="example.com"
            disabled={loading}
            style={{
              fontSize: 14, padding: "8px 12px", borderRadius: 8,
              border: `1px solid ${error ? RED : "rgba(194, 101, 42, 0.2)"}`, width: isMobile ? "100%" : 220, flex: isMobile ? 1 : undefined,
              fontFamily: "inherit", outline: "none", color: TEXT,
              background: loading ? "#f5f5f7" : "#fff",
              transition: "border-color 0.2s",
            }}
          />
          <button
            type="submit"
            disabled={loading || !domain.trim()}
            style={{
              background: loading || !domain.trim() ? T3 : COPPER,
              color: "#fff", fontWeight: 600, fontSize: 14,
              padding: "8px 18px", borderRadius: 8, border: "none",
              cursor: loading || !domain.trim() ? "not-allowed" : "pointer",
              fontFamily: "inherit", transition: "background 0.2s, opacity 0.2s",
              opacity: loading || !domain.trim() ? 0.5 : 1,
            }}
          >
            {loading ? "Starting…" : "Run Audit"}
          </button>
        </form>

        <div style={{ width: 1, height: 20, background: BORDER, flexShrink: 0 }} />

        <button
          onClick={() => { setBulkOpen(!bulkOpen); if (bulkOpen) clearCsv(); }}
          style={{
            background: bulkOpen ? "#fef7ed" : "transparent",
            border: `1px solid ${bulkOpen ? COPPER : "rgba(194, 101, 42, 0.3)"}`,
            borderRadius: 8, padding: "7px 14px",
            fontSize: 13, fontWeight: 500, color: COPPER,
            cursor: "pointer", fontFamily: "inherit",
            transition: "all 0.2s",
          }}
        >
          {bulkOpen ? "Close" : "Bulk CSV"}
        </button>

        {error && <span style={{ fontSize: 12, color: RED, fontWeight: 500 }}>{error}</span>}
      </div>

      {/* Bulk CSV panel */}
      {bulkOpen && (
        <div style={{
          background: "#fff", border: "1px solid rgba(194, 101, 42, 0.15)", borderRadius: 12,
          padding: 20, maxWidth: 480,
          boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)",
        }}>
          {/* Drop zone */}
          <div
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleCsvUpload(f); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${csvFile ? GREEN : dragOver ? COPPER : BORDER}`,
              borderRadius: 10, padding: csvFile ? "14px 16px" : "24px 16px",
              background: dragOver ? "#fef7ed" : csvFile ? "#f0fdf4" : "#fafafa",
              cursor: "pointer",
              transition: "all 0.2s",
              textAlign: csvFile ? "left" : "center",
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsvUpload(f); }}
            />
            {csvFile ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: GREEN }}>{csvFile.name}</div>
                  <div style={{ fontSize: 12, color: T2, marginTop: 2 }}>{csvUrls.length} URLs loaded</div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); clearCsv(); }}
                  style={{
                    background: "none", border: "none", color: T3,
                    cursor: "pointer", fontSize: 18, padding: "4px 8px",
                    borderRadius: 6, transition: "color 0.15s",
                  }}
                >
                  ×
                </button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 14, fontWeight: 600, color: TEXT, marginBottom: 4 }}>
                  Upload CSV
                </div>
                <div style={{ fontSize: 13, color: T2, lineHeight: 1.5 }}>
                  Drop a file here or click to browse
                </div>
                <div style={{ fontSize: 12, color: T3, marginTop: 4 }}>
                  .csv or .txt · first column = URLs · max {BULK_MAX_URLS}
                </div>
              </>
            )}
          </div>

          {/* Sample download */}
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <a
              href="/sample-bulk-audit.csv"
              download
              style={{ fontSize: 12, color: COPPER, textDecoration: "none", fontWeight: 500 }}
            >
              Download sample CSV
            </a>
          </div>

          {/* Error */}
          {csvError && (
            <div style={{ fontSize: 13, color: RED, marginTop: 10, fontWeight: 500 }}>{csvError}</div>
          )}

          {/* Pricing + submit */}
          {csvPricing && (
            <div style={{
              marginTop: 12, padding: "10px 14px",
              background: csvPricing.ok ? "#fafafa" : "#fef2f2",
              border: `1px solid ${csvPricing.ok ? BORDER : "rgba(255,59,48,0.2)"}`,
              borderRadius: 8, fontSize: 13, color: csvPricing.ok ? T2 : RED,
              lineHeight: 1.5,
            }}>
              {csvPricing.text}
            </div>
          )}

          {csvUrls.length > 0 && (
            <button
              onClick={handleBulkSubmit}
              disabled={bulkLoading || (csvPricing !== null && !csvPricing.ok)}
              style={{
                marginTop: 12, width: "100%",
                background: bulkLoading || (csvPricing !== null && !csvPricing.ok) ? T3 : COPPER,
                color: "#fff", fontWeight: 600, fontSize: 14,
                padding: "10px 0", borderRadius: 8, border: "none",
                cursor: bulkLoading || (csvPricing !== null && !csvPricing.ok) ? "not-allowed" : "pointer",
                fontFamily: "inherit", transition: "background 0.2s, opacity 0.2s",
                opacity: bulkLoading || (csvPricing !== null && !csvPricing.ok) ? 0.5 : 1,
              }}
            >
              {bulkLoading ? "Starting bulk audit…" : `Run Bulk Audit · ${csvUrls.length} URLs`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
