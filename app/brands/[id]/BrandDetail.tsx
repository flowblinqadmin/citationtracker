"use client";

// Brand detail: prompt management (library + custom), run frequency, run
// history with stored metrics, and the credit-gated "Run now".
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { apiUrl } from "@/lib/api-url";
import { GEO_ORIGIN } from "@/lib/config";
import { citationRunCredits } from "@/lib/pricing";
import { PROMPT_LIBRARY, PROMPT_CATEGORIES, fillTemplate } from "@/lib/prompt-library";
import type { TrackerRunMetrics, TrackerPromptCategory, TrackerRunFrequency } from "@/lib/types/tracker";

interface Brand {
  id: string;
  name: string;
  domain: string | null;
  runFrequency: TrackerRunFrequency;
}

interface Prompt {
  promptId: string;
  name: string;
  category: TrackerPromptCategory;
  version: number;
  text: string;
}

interface Run {
  id: string;
  kind: "scheduled" | "manual";
  status: "pending" | "running" | "complete" | "failed";
  period: string;
  promptsTotal: number | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  metrics: TrackerRunMetrics | null;
}

const CARD = "#ffffff";
const BORDER = "1px solid rgba(0,0,0,0.08)";
const MUTED = "#78716c";
const ACCENT = "#b45309";
const GREEN = "#16a34a";
const RED = "#dc2626";

const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function BrandDetail({ clientId }: { clientId: string }) {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [tab, setTab] = useState<"prompts" | "runs">("prompts");
  const [showLibrary, setShowLibrary] = useState(false);
  const [customText, setCustomText] = useState("");
  const [running, setRunning] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    const [brandRes, promptsRes, runsRes, teamRes] = await Promise.all([
      fetch(apiUrl(`/api/brands/${clientId}`)),
      fetch(apiUrl(`/api/brands/${clientId}/prompts`)),
      fetch(apiUrl(`/api/brands/${clientId}/runs`)),
      fetch(apiUrl("/api/teams/me")),
    ]);
    if (brandRes.status === 404) {
      setNotFound(true);
      return;
    }
    if (brandRes.ok) setBrand((await brandRes.json()).brand);
    if (promptsRes.ok) setPrompts((await promptsRes.json()).prompts);
    if (runsRes.ok) setRuns((await runsRes.json()).runs);
    if (teamRes.ok) setBalance((await teamRes.json()).creditBalance);
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while a run is in flight so status + metrics appear without a reload.
  const hasActiveRun = runs.some((r) => r.status === "pending" || r.status === "running");
  useEffect(() => {
    if (!hasActiveRun) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [hasActiveRun, load]);

  const runCost = prompts.length > 0 ? citationRunCredits(prompts.length) : 0;
  const inLibrary = new Set(prompts.map((p) => p.name));

  async function addPrompt(name: string, category: TrackerPromptCategory, text: string) {
    const res = await fetch(apiUrl(`/api/brands/${clientId}/prompts`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, category, text }),
    });
    if (!res.ok) {
      toast.error((await res.json()).error ?? "Could not add prompt");
      return;
    }
    await load();
  }

  async function archivePrompt(promptId: string) {
    await fetch(apiUrl(`/api/brands/${clientId}/prompts/${promptId}`), { method: "DELETE" });
    await load();
  }

  async function editPrompt(p: Prompt) {
    const text = window.prompt("Edit prompt text (a new version is kept for comparability):", p.text);
    if (!text || text === p.text) return;
    const res = await fetch(apiUrl(`/api/brands/${clientId}/prompts/${p.promptId}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) toast.error((await res.json()).error ?? "Could not update prompt");
    await load();
  }

  async function setFrequency(runFrequency: TrackerRunFrequency) {
    const res = await fetch(apiUrl(`/api/brands/${clientId}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runFrequency }),
    });
    if (res.ok) {
      setBrand((await res.json()).brand);
      if (runFrequency !== "manual") {
        toast.info(`Scheduled runs bill ~${runCost || citationRunCredits(1)} credits each, automatically.`);
      }
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const res = await fetch(apiUrl(`/api/brands/${clientId}/run`), { method: "POST" });
      const body = await res.json();
      if (res.status === 402) {
        toast.error(
          `Not enough credits: this run needs ${body.required}, you have ${body.balance}.`,
          { action: { label: "Buy credits", onClick: () => window.open(body.buyCreditsUrl, "_blank") } },
        );
        return;
      }
      if (!res.ok) {
        toast.error(body.error ?? "Could not start the run");
        return;
      }
      if (body.alreadyRunning) {
        toast.info("A run is already in progress for this brand.");
      } else {
        toast.success(`Run started — ${body.credits} credits`);
        setTab("runs");
      }
      await load();
    } finally {
      setRunning(false);
    }
  }

  if (notFound) {
    return (
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "40px 24px" }}>
        <p>Brand not found. <Link href="/" style={{ color: ACCENT }}>Back to brands</Link></p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "40px 24px" }}>
      <Link href="/" style={{ color: MUTED, fontSize: 13, textDecoration: "none" }}>← Brands</Link>

      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0 8px" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>{brand?.name ?? "…"}</h1>
          {brand?.domain && <span style={{ color: MUTED, fontSize: 13 }}>{brand.domain}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <label style={{ fontSize: 13, color: MUTED }}>
            Frequency{" "}
            <select
              value={brand?.runFrequency ?? "monthly"}
              onChange={(e) => void setFrequency(e.target.value as TrackerRunFrequency)}
              style={{ padding: "6px 8px", border: BORDER, borderRadius: 6 }}
            >
              <option value="manual">Manual only</option>
              <option value="weekly">Weekly (~{runCost || "?"} credits/run)</option>
              <option value="monthly">Monthly (~{runCost || "?"} credits/run)</option>
            </select>
          </label>
          <button
            onClick={() => void runNow()}
            disabled={running || prompts.length === 0 || hasActiveRun}
            title={prompts.length === 0 ? "Add prompts first" : undefined}
            style={{ padding: "10px 18px", background: ACCENT, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, cursor: "pointer", opacity: running || prompts.length === 0 || hasActiveRun ? 0.5 : 1 }}
          >
            {hasActiveRun ? "Run in progress…" : `Run now · ${runCost} credits`}
          </button>
        </div>
      </header>

      {balance !== null && balance < 0 && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: RED, borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 12 }}>
          Your balance is {balance} credits (scheduled runs billed past zero). Manual runs are blocked until you{" "}
          <a href={`${GEO_ORIGIN}/dashboard`} style={{ color: RED, fontWeight: 600 }}>top up</a>.
        </div>
      )}

      <nav style={{ display: "flex", gap: 16, borderBottom: BORDER, margin: "16px 0" }}>
        {(["prompts", "runs"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ padding: "8px 2px", background: "none", border: "none", borderBottom: tab === t ? `2px solid ${ACCENT}` : "2px solid transparent", fontSize: 14, cursor: "pointer", color: tab === t ? "inherit" : MUTED }}
          >
            {t === "prompts" ? `Prompts (${prompts.length}/30)` : `Runs (${runs.length})`}
          </button>
        ))}
      </nav>

      {tab === "prompts" && (
        <section>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <button
              onClick={() => setShowLibrary((v) => !v)}
              style={{ padding: "8px 14px", background: CARD, border: BORDER, borderRadius: 8, fontSize: 13, cursor: "pointer" }}
            >
              {showLibrary ? "Hide library" : "+ Add from library"}
            </button>
          </div>

          {showLibrary && brand && (
            <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: 16, marginBottom: 16 }}>
              {PROMPT_CATEGORIES.map((cat) => (
                <div key={cat} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, textTransform: "uppercase", color: MUTED, marginBottom: 6 }}>{cat}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {PROMPT_LIBRARY.filter((t) => t.category === cat).map((t) => (
                      <button
                        key={t.id}
                        disabled={inLibrary.has(t.name)}
                        onClick={() => void addPrompt(t.name, t.category, fillTemplate(t.template, brand.name))}
                        title={fillTemplate(t.template, brand.name)}
                        style={{ padding: "6px 10px", background: inLibrary.has(t.name) ? "#f5f5f4" : "#fff7ed", border: BORDER, borderRadius: 999, fontSize: 12, cursor: inLibrary.has(t.name) ? "default" : "pointer", color: inLibrary.has(t.name) ? MUTED : "inherit" }}
                      >
                        {inLibrary.has(t.name) ? `✓ ${t.name}` : t.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!customText.trim()) return;
              void addPrompt(customText.trim().slice(0, 60), "topic", customText.trim()).then(() => setCustomText(""));
            }}
            style={{ display: "flex", gap: 8, marginBottom: 20 }}
          >
            <input
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="Or write your own prompt (max 500 chars)…"
              maxLength={500}
              style={{ flex: 1, padding: "10px 12px", border: BORDER, borderRadius: 8, fontSize: 14 }}
            />
            <button
              type="submit"
              disabled={!customText.trim()}
              style={{ padding: "10px 16px", background: CARD, border: BORDER, borderRadius: 8, fontSize: 13, cursor: "pointer", opacity: customText.trim() ? 1 : 0.5 }}
            >
              Add custom
            </button>
          </form>

          <div style={{ display: "grid", gap: 8 }}>
            {prompts.map((p) => (
              <div key={p.promptId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: CARD, border: BORDER, borderRadius: 10, padding: "12px 16px" }}>
                <div style={{ flex: 1, marginRight: 12 }}>
                  <div style={{ fontSize: 14 }}>{p.text}</div>
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                    {p.category} · v{p.version}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
                  <button onClick={() => void editPrompt(p)} style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer" }}>Edit</button>
                  <button onClick={() => void archivePrompt(p.promptId)} style={{ background: "none", border: "none", color: MUTED, cursor: "pointer" }}>Remove</button>
                </div>
              </div>
            ))}
            {prompts.length === 0 && (
              <p style={{ color: MUTED, fontSize: 14 }}>No prompts yet — add a few from the library to get started.</p>
            )}
          </div>
        </section>
      )}

      {tab === "runs" && (
        <section style={{ display: "grid", gap: 10 }}>
          {runs.length === 0 && <p style={{ color: MUTED, fontSize: 14 }}>No runs yet.</p>}
          {runs.map((r) => (
            <div key={r.id} style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontSize: 14 }}>
                  <strong>{r.period}</strong>
                  <span style={{ color: MUTED, marginLeft: 8, fontSize: 12 }}>{r.kind} · {r.promptsTotal ?? "?"} prompts</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: r.status === "complete" ? GREEN : r.status === "failed" ? RED : ACCENT }}>
                  {r.status}
                </span>
              </div>
              {r.metrics && (
                <div style={{ display: "flex", gap: 24, marginTop: 10, fontSize: 13 }}>
                  <span>Citation rate <strong>{pct(r.metrics.citationRate)}</strong></span>
                  <span>Brand mentions <strong>{pct(r.metrics.brandMentionRate)}</strong></span>
                  <span>Share of AI voice <strong>{r.metrics.shareOfAiVoice != null ? pct(r.metrics.shareOfAiVoice) : "—"}</strong></span>
                  <span>Citations <strong>{r.metrics.totalCitations}</strong></span>
                </div>
              )}
              {r.error && <div style={{ marginTop: 8, fontSize: 12, color: RED }}>{r.error}</div>}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
