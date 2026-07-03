"use client";

import { useState, useEffect, useRef } from "react";
import { type CitationCheckResult, type CitationCheckScore, type DiscoveredCompetitor, type CompetitorCitationData, type PillarQA, type PillarQASample, type GeoVisibility, type CategoryVisibility, type TierVisibility, type VisibilityGapEntry, type LocationCompetitor, type CategoryCompetitor, type DominanceMap, type RealPromptDiscovery } from "@/lib/types/citation";
import { CitationHistory } from "@/app/components/citation-history";
import { CitationAnalytics } from "@/app/components/citation-analytics";
import { DimensionalIntelligence } from "@/app/components/dimensional-intelligence";

// ── Inline markdown renderer — converts LLM answer text to safe HTML ──────
function renderMd(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") // escape HTML first
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")                   // **bold**
    .replace(/\*(.+?)\*/g, "<em>$1</em>")                               // *italic*
    .replace(/^#{1,6}\s+(.+)$/gm, "<strong>$1</strong>")               // ## heading → bold
    .replace(/\n/g, " ");                                                // collapse newlines inline
}

// ── Design tokens ──────────────────────────────────────────────────────────
const TEXT   = "#1c1917";
const TEXT_2 = "#78716c";
const TEXT_3 = "#a8a29e";
const BORDER = "rgba(0,0,0,0.1)";
const TRACK  = "#e8e5e0";
const ACCENT = "#b45309";
const AMBER  = "#d97706";
const GREEN  = "#16a34a";
const RED    = "#dc2626";

// ── Pillar labels ──────────────────────────────────────────────────────────
const PILLAR_LABELS: Record<string, string> = {
  author_authority:        "Authority",
  competitive_positioning: "Positioning",
  offering_clarity:        "Clarity",
  faq_coverage:            "FAQ",
  evidence_statistics:     "Evidence",
  contact_trust:           "Trust",
  content_freshness:       "Freshness",
  structured_data:         "Structured",
  entity_definitions:      "Entities",
  metadata_freshness:      "Meta",
  semantic_html:           "Semantic",
  multi_format:            "Formats",
  licensing_signals:       "Licensing",
  internal_linking:        "Linking",
  content_structure:       "Structure",
  cta_structure:           "CTA",
};

// ── Helpers ────────────────────────────────────────────────────────────────

function scoreTier(score: number): { label: string; color: string; bg: string } {
  if (score >= 60) return { label: "Strong AI Visibility",    color: GREEN, bg: GREEN + "14" };
  if (score >= 30) return { label: "Moderate AI Visibility",  color: AMBER, bg: AMBER + "14" };
  return              { label: "Low AI Visibility",           color: RED,   bg: RED   + "12" };
}


function pillarColor(score: number) {
  if (score === 0) return TEXT_3;
  if (score < 30) return RED;
  if (score < 60) return AMBER;
  return GREEN;
}

const SECTION_HEADING: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: TEXT_3,
  textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 12px",
};

// ── Provider name map ──────────────────────────────────────────────────────
const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI", chatgpt: "ChatGPT", anthropic: "Anthropic",
  claude: "Claude", google: "Google", perplexity: "Perplexity", gemini: "Gemini",
};

// ── Platform Card ──────────────────────────────────────────────────────────

interface PlatformCardProps {
  provider: string;
  visibilityScore: number;
  mentionCount: number;
  totalQueries: number;
  sentiment: "positive" | "neutral" | "negative";
  samples?: PillarQASample[];
}

function PlatformCard({ provider, visibilityScore, mentionCount, totalQueries, sentiment, samples = [] }: PlatformCardProps) {
  const [expanded, setExpanded] = useState(false);
  const name = PROVIDER_NAMES[provider.toLowerCase()] ?? (provider.charAt(0).toUpperCase() + provider.slice(1));
  const color = pillarColor(visibilityScore);
  const sentimentColor = sentiment === "positive" ? GREEN : sentiment === "negative" ? RED : AMBER;
  const sentimentBg    = sentiment === "positive" ? "#dcfce7" : sentiment === "negative" ? "#fee2e2" : "#fef3c7";
  const hasSamples = samples.length > 0;

  return (
    <div className="ca-interactive" style={{
      background: "#fff",
      border: `1px solid ${expanded ? BORDER : BORDER}`,
      borderRadius: 10,
      overflow: "hidden",
    }}>
      {/* Card header — always visible, clickable if samples exist */}
      <button
        onClick={() => hasSamples && setExpanded(e => !e)}
        style={{
          display: "flex", flexDirection: "column", gap: 10,
          width: "100%", textAlign: "left",
          background: "none", border: "none",
          cursor: hasSamples ? "pointer" : "default",
          padding: "16px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: TEXT }}>{name}</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{
              fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 100,
              background: sentimentBg, color: sentimentColor, textTransform: "capitalize",
            }}>
              {sentiment}
            </span>
            {hasSamples && (
              <span style={{ fontSize: 9, color: TEXT_3 }}>{expanded ? "▲" : "▼"}</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 32, fontWeight: 800, color, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
            {visibilityScore}%
          </span>
        </div>
        <div style={{ height: 4, background: TRACK, borderRadius: 2 }}>
          <div style={{ height: "100%", width: `${visibilityScore}%`, background: color, borderRadius: 2, transition: "width 0.4s" }} />
        </div>
        <span style={{ fontSize: 11, color: TEXT_3 }}>{mentionCount}/{totalQueries} queries</span>
      </button>

      {/* Expandable Q&A list */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${BORDER}`, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          {samples.map((s, i) => (
            <div key={i} style={{
              background: s.mentioned ? GREEN + "08" : "#fafaf9",
              border: `1px solid ${s.mentioned ? GREEN + "25" : BORDER}`,
              borderRadius: 6, padding: "8px 10px",
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: s.answer ? 6 : 0 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: TEXT_3, marginTop: 1, flexShrink: 0 }}>Q</span>
                <p style={{ margin: 0, fontSize: 12, color: TEXT, fontWeight: 500, lineHeight: 1.5 }}>{s.question}</p>
              </div>
              {s.answer && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: TEXT_3, marginTop: 1, flexShrink: 0 }}>A</span>
                  <p style={{ margin: 0, fontSize: 11, color: TEXT_2, lineHeight: 1.6 }}
                     dangerouslySetInnerHTML={{ __html: renderMd(s.answer.length > 280 ? s.answer.slice(0, 280) + "…" : s.answer) }}
                  />
                </div>
              )}
              <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{
                  fontSize: 9, fontWeight: 700,
                  color: s.mentioned ? GREEN : TEXT_3,
                  background: (s.mentioned ? GREEN : TRACK) + (s.mentioned ? "15" : ""),
                  border: `1px solid ${(s.mentioned ? GREEN : BORDER) + (s.mentioned ? "30" : "")}`,
                  borderRadius: 4, padding: "1px 5px",
                }}>
                  {s.mentioned ? "✓ Cited" : "✗ Not cited"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Full Research Panel ────────────────────────────────────────────────────

function FullResearchToggle({ result, domain }: { result: CitationCheckResult | CitationCheckScore; domain: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: "none", border: `1px solid ${BORDER}`, borderRadius: 8,
          padding: "9px 16px", fontSize: 12, fontWeight: 600, color: TEXT_2,
          cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
          width: "100%", justifyContent: "center",
        }}
        onMouseOver={e => (e.currentTarget.style.background = "#f5f2ee")}
        onMouseOut={e => (e.currentTarget.style.background = "none")}
      >
        <span>{open ? "▲" : "▼"}</span>
        {open ? "Hide full research" : "View full research"}
      </button>
      {open && <FullResearchPanel result={result} domain={domain} />}
    </div>
  );
}

function FullResearchPanel({ result, domain }: { result: CitationCheckResult | CitationCheckScore; domain: string }) {
  const isResult = (r: CitationCheckResult | CitationCheckScore): r is CitationCheckResult =>
    "scores" in r && typeof (r as CitationCheckResult).scores === "object";

  const promptsUsed: string[] = isResult(result)
    ? result.promptsUsed
    : (result as CitationCheckScore).promptsUsed ?? [];

  const pillarQA: Record<string, PillarQA> = isResult(result)
    ? (result.scores.pillarQA ?? {})
    : ((result as CitationCheckScore).pillarQA ?? {}) as Record<string, PillarQA>;

  const providerResults = isResult(result)
    ? result.providerResults
    : (result as CitationCheckScore).providerResults ?? [];

  const [activeView, setActiveView] = useState<"prompts" | "responses">("prompts");

  const indirectPrompts = promptsUsed.filter(p => !p.toLowerCase().startsWith("what is") && !domain.toLowerCase().split(".")[0].split("").some(c => p.toLowerCase().includes(c.repeat(3))));
  const allPillarEntries = Object.entries(pillarQA).filter(([k]) => k !== "__direct__");
  const directEntry = pillarQA["__direct__"];

  return (
    <div style={{ marginTop: 24, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
      {/* Panel header */}
      <div className="cm-panel-header" style={{ padding: "14px 20px", background: "#fafaf9", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: TEXT }}>Full Research</span>
        <div style={{ display: "flex", gap: 6 }}>
          {(["prompts", "responses"] as const).map(v => (
            <button key={v} onClick={() => setActiveView(v)} style={{
              fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 6,
              background: activeView === v ? TEXT : "transparent",
              color: activeView === v ? "#fff" : TEXT_2,
              border: `1px solid ${activeView === v ? TEXT : BORDER}`,
              cursor: "pointer",
            }}>
              {v === "prompts" ? `Prompts (${promptsUsed.length})` : "Responses"}
            </button>
          ))}
        </div>
      </div>

      {/* Prompts view */}
      {activeView === "prompts" && (
        <div className="cm-full-research-panel" style={{ padding: "16px 20px", maxHeight: 480, overflowY: "auto" }}>
          {promptsUsed.length === 0
            ? <p style={{ color: TEXT_3, fontSize: 13 }}>No prompts recorded for this scan.</p>
            : promptsUsed.map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", paddingBottom: 10, marginBottom: 10, borderBottom: i < promptsUsed.length - 1 ? `1px solid ${BORDER}` : "none" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: TEXT_3, minWidth: 22, paddingTop: 1, fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>
                  <span style={{ fontSize: 12, color: TEXT, lineHeight: 1.5 }}>{p}</span>
                </div>
              ))
          }
        </div>
      )}

      {/* Responses view */}
      {activeView === "responses" && (
        <div className="cm-full-research-panel" style={{ padding: "16px 20px", maxHeight: 480, overflowY: "auto", display: "flex", flexDirection: "column", gap: 24 }}>

          {/* Per-provider responses */}
          {providerResults.filter(p => (p.samples?.length ?? 0) > 0).map(p => (
            <div key={p.provider}>
              <div style={{ fontSize: 11, fontWeight: 700, color: TEXT_3, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                {PROVIDER_NAMES[p.provider.toLowerCase()] ?? p.provider} — {p.visibilityScore}% visibility
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(p.samples ?? []).map((s, i) => (
                  <div key={i} style={{
                    background: s.mentioned ? GREEN + "07" : "#fafaf9",
                    border: `1px solid ${s.mentioned ? GREEN + "22" : BORDER}`,
                    borderRadius: 6, padding: "10px 12px",
                  }}>
                    <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600, color: TEXT, lineHeight: 1.4 }}>{s.question}</p>
                    {s.answer && <p style={{ margin: "0 0 6px", fontSize: 11, color: TEXT_2, lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: renderMd(s.answer) }} />}
                    <span style={{
                      fontSize: 9, fontWeight: 700,
                      color: s.mentioned ? GREEN : TEXT_3,
                      background: s.mentioned ? GREEN + "15" : TRACK,
                      border: `1px solid ${s.mentioned ? GREEN + "30" : BORDER}`,
                      borderRadius: 4, padding: "1px 6px",
                    }}>
                      {s.mentioned ? "✓ Cited" : "✗ Not cited"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Pillar Q&A samples */}
          {allPillarEntries.filter(([, qa]) => qa.samples.length > 0).map(([pillar, qa]) => (
            <div key={pillar}>
              <div style={{ fontSize: 11, fontWeight: 700, color: TEXT_3, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                Theme: {PILLAR_LABELS[pillar] ?? pillar}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {qa.samples.map((s, i) => (
                  <div key={i} style={{
                    background: s.mentioned ? GREEN + "07" : "#fafaf9",
                    border: `1px solid ${s.mentioned ? GREEN + "22" : BORDER}`,
                    borderRadius: 6, padding: "10px 12px",
                  }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: TEXT_3, marginBottom: 4, textTransform: "capitalize" }}>via {s.provider}</div>
                    <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600, color: TEXT, lineHeight: 1.4 }}>{s.question}</p>
                    {s.answer && <p style={{ margin: "0 0 6px", fontSize: 11, color: TEXT_2, lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: renderMd(s.answer) }} />}
                    <span style={{
                      fontSize: 9, fontWeight: 700,
                      color: s.mentioned ? GREEN : TEXT_3,
                      background: s.mentioned ? GREEN + "15" : TRACK,
                      border: `1px solid ${s.mentioned ? GREEN + "30" : BORDER}`,
                      borderRadius: 4, padding: "1px 6px",
                    }}>
                      {s.mentioned ? "✓ Cited" : "✗ Not cited"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Direct Q&A */}
          {directEntry && directEntry.samples.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: TEXT_3, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                Direct Brand Questions
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {directEntry.samples.map((s, i) => (
                  <div key={i} style={{
                    background: s.mentioned ? GREEN + "07" : "#fafaf9",
                    border: `1px solid ${s.mentioned ? GREEN + "22" : BORDER}`,
                    borderRadius: 6, padding: "10px 12px",
                  }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: TEXT_3, marginBottom: 4, textTransform: "capitalize" }}>via {s.provider}</div>
                    <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600, color: TEXT, lineHeight: 1.4 }}>{s.question}</p>
                    {s.answer && <p style={{ margin: "0 0 6px", fontSize: 11, color: TEXT_2, lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: renderMd(s.answer) }} />}
                    <span style={{
                      fontSize: 9, fontWeight: 700,
                      color: s.mentioned ? GREEN : TEXT_3,
                      background: s.mentioned ? GREEN + "15" : TRACK,
                      border: `1px solid ${s.mentioned ? GREEN + "30" : BORDER}`,
                      borderRadius: 4, padding: "1px 6px",
                    }}>
                      {s.mentioned ? "✓ Cited" : "✗ Not cited"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {allPillarEntries.length === 0 && providerResults.every(p => (p.samples?.length ?? 0) === 0) && (
            <p style={{ color: TEXT_3, fontSize: 13 }}>No response samples stored for this scan.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────

type Status = "idle" | "running" | "complete" | "error";

interface CheckState {
  status:           Status;
  progress:         number;
  message:          string;
  prompts:          string[];
  providerProgress: Record<string, { done: number; total: number; mentioned: number }>;
  result:           CitationCheckResult | null;
  error:            string | null;
}

interface DiscoveryState {
  status:      Status;
  progress:    number;
  message:     string;
  competitors: DiscoveredCompetitor[];
  error:       string | null;
}

const INITIAL_CHECK: CheckState = {
  status: "idle", progress: 0, message: "", prompts: [],
  providerProgress: {}, result: null, error: null,
};

const INITIAL_DISCOVERY: DiscoveryState = {
  status: "idle", progress: 0, message: "",
  competitors: [], error: null,
};

interface CitationMonitorProps {
  siteId:               string;
  accessToken:          string;
  domain:               string;
  lastCheck:            CitationCheckScore | null;
  history:              CitationCheckScore[];
  discoveredCompetitors?: DiscoveredCompetitor[];
  citationNarrative?:   string | null;
  onScanStart?:         (triggerFn: () => void) => void;
}

// ── C7: Narrative loading skeleton ────────────────────────────────────────────
export function NarrativeSkeleton() {
  return (
    <>
      <style>{`
        @keyframes shimmer {
          0%   { background-position: -200% 0; }
          100% { background-position:  200% 0; }
        }
        .skeleton-bar {
          background: linear-gradient(90deg, ${TRACK} 25%, rgba(0,0,0,0.04) 50%, ${TRACK} 75%) !important;
          background-size: 200% 100% !important;
          animation: shimmer 1.5s infinite !important;
        }
      `}</style>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="skeleton-bar" style={{ width: "90%", height: 12, borderRadius: 6, background: TRACK }} />
        <div className="skeleton-bar" style={{ width: "75%", height: 12, borderRadius: 6, background: TRACK }} />
        <div className="skeleton-bar" style={{ width: "60%", height: 12, borderRadius: 6, background: TRACK }} />
      </div>
    </>
  );
}

export function CitationMonitor({ siteId, accessToken, domain, lastCheck, history, discoveredCompetitors, citationNarrative, onScanStart }: CitationMonitorProps) {
  const [check, setCheck]             = useState<CheckState>(INITIAL_CHECK);
  const [discovery, setDiscovery]     = useState<DiscoveryState>(INITIAL_DISCOVERY);
  const [activeTab, setActiveTab]     = useState<"run" | "history">("run");
  const [localHistory, setLocalHistory]         = useState<CitationCheckScore[]>(history);
  const [localCompetitors, setLocalCompetitors] = useState<DiscoveredCompetitor[]>(discoveredCompetitors ?? []);
  const [narrativeText, setNarrativeText]       = useState<string | null>(citationNarrative ?? null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);

  async function fetchNarrative(scores: {
    overallScore: number; indirectVisibility: number; brandKnowledge: number;
    citationQualityScore: number; bestProvider: string | null; worstProvider: string | null;
    pillarVisibility: Record<string, number>; previousScore?: number | null;
  }) {
    setNarrativeLoading(true);
    try {
      const res = await fetch(`/api/sites/${siteId}/citation-narrative`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(scores),
      });
      if (res.ok) {
        const data = await res.json() as { narrative?: string };
        if (data.narrative) setNarrativeText(data.narrative);
      }
    } catch { /* silently fail — fallback to tier label */ }
    finally { setNarrativeLoading(false); }
  }

  // Generate narrative for existing lastCheck on mount (once) — skip if already loaded from DB
  useEffect(() => {
    if (lastCheck && !citationNarrative && !narrativeText) {
      const previousScore = history.length > 1 ? history[1]?.overallVisibility ?? null : null;
      void fetchNarrative({
        overallScore:         lastCheck.overallVisibility,
        indirectVisibility:   lastCheck.indirectVisibility,
        brandKnowledge:       lastCheck.brandKnowledge,
        citationQualityScore: lastCheck.citationQualityScore,
        bestProvider:         lastCheck.bestProvider ?? null,
        worstProvider:        lastCheck.worstProvider ?? null,
        pillarVisibility:     (lastCheck.pillarVisibility ?? {}) as Record<string, number>,
        previousScore,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── onScanStart callback registration ────────────────────────────────
  // Use a ref so the registered callback always invokes the latest runCheck
  // (avoids stale closure when accessToken arrives after mount).
  const runCheckRef = useRef<() => void>(() => {});
  runCheckRef.current = runCheck;

  useEffect(() => {
    onScanStart?.(() => runCheckRef.current());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Citation check ─────────────────────────────────────────────────────

  async function runCheck() {
    setCheck({ ...INITIAL_CHECK, status: "running", message: "Starting…" });

    try {
      const res = await fetch(`/api/sites/${siteId}/citation-check?token=${encodeURIComponent(accessToken)}`, { method: "POST" });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setCheck(s => ({ ...s, status: "error", error: body.error ?? `HTTP ${res.status}` }));
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json) continue;
          try { handleCheckSSE(JSON.parse(json) as Record<string, unknown>); } catch { /* skip */ }
        }
      }
    } catch (err) {
      setCheck(s => ({ ...s, status: "error", error: err instanceof Error ? err.message : "Unknown error" }));
    }
  }

  function handleCheckSSE(event: Record<string, unknown>) {
    const type = event.type as string;
    if (type === "start" || type === "stage" || type === "progress") {
      setCheck(s => ({
        ...s,
        progress: (event.progress as number | undefined) ?? s.progress,
        message:  (event.message as string | undefined) ?? s.message,
      }));
    } else if (type === "prompt-generated") {
      setCheck(s => ({ ...s, prompts: [...s.prompts, event.prompt as string] }));
    } else if (type === "analysis-start") {
      const provider = event.provider as string;
      const total    = event.totalPrompts as number;
      setCheck(s => ({
        ...s,
        providerProgress: { ...s.providerProgress, [provider]: s.providerProgress[provider] ?? { done: 0, total, mentioned: 0 } },
      }));
    } else if (type === "partial-result") {
      const provider  = event.provider as string;
      const mentioned = (event.mentioned as boolean | undefined) ?? false;
      setCheck(s => {
        const prev = s.providerProgress[provider] ?? { done: 0, total: 0, mentioned: 0 };
        return { ...s, providerProgress: { ...s.providerProgress, [provider]: { ...prev, mentioned: prev.mentioned + (mentioned ? 1 : 0) } } };
      });
    } else if (type === "analysis-complete") {
      const provider = event.provider as string;
      setCheck(s => {
        const prev = s.providerProgress[provider] ?? { done: 0, total: 0, mentioned: 0 };
        return { ...s, providerProgress: { ...s.providerProgress, [provider]: { ...prev, done: prev.done + 1 } } };
      });
    } else if (type === "complete") {
      const data = event as unknown as CitationCheckResult & { type: string };
      const { type: _t, ...result } = data;
      setCheck(s => ({ ...s, status: "complete", result: result as CitationCheckResult, progress: 100, message: "Done" }));
      setNarrativeText(null); // reset so fresh narrative is fetched
      void fetchNarrative({
        overallScore:         data.scores.overallVisibility,
        indirectVisibility:   data.scores.indirectVisibility,
        brandKnowledge:       data.scores.brandKnowledge,
        citationQualityScore: data.scores.citationQualityScore,
        bestProvider:         data.scores.bestProvider ?? null,
        worstProvider:        data.scores.worstProvider ?? null,
        pillarVisibility:     data.scores.pillarVisibility ?? {},
        previousScore:        lastCheck?.overallVisibility ?? null,
      });
      const newScore: CitationCheckScore = {
        checkId:              data.checkId,
        siteId,
        teamId:               "",
        domain,
        overallVisibility:    data.scores.overallVisibility,
        bestProvider:         data.scores.bestProvider ?? null,
        worstProvider:        data.scores.worstProvider ?? null,
        avgPosition:          data.scores.avgPosition ?? null,
        sentimentScore:       data.scores.sentimentScore,
        providerResults:      data.providerResults,
        competitorVisibility: {},
        competitorData:       (data.scores.competitorData ?? []) as CompetitorCitationData[],
        pillarVisibility:     data.scores.pillarVisibility,
        pillarQA:             (data.scores.pillarQA ?? {}) as Record<string, PillarQA>,
        indirectVisibility:   data.scores.indirectVisibility,
        brandKnowledge:       data.scores.brandKnowledge,
        citationQualityScore: data.scores.citationQualityScore,
        creditsUsed:          data.creditsUsed,
        promptsUsed:          data.promptsUsed,
        promptMetadata:       null,
        geoVisibility:        (data.scores.geoVisibility        ?? []) as GeoVisibility[],
        categoryVisibility:   (data.scores.categoryVisibility   ?? []) as CategoryVisibility[],
        tierVisibility:       (data.scores.tierVisibility       ?? []) as TierVisibility[],
        avgImpressionShare:   data.scores.avgImpressionShare    ?? null,
        visibilityGapAnalysis: (data.scores.visibilityGapAnalysis ?? []) as VisibilityGapEntry[],
        locationCompetitors:  (data.scores.locationCompetitors  ?? []) as LocationCompetitor[],
        categoryCompetitors:  (data.scores.categoryCompetitors  ?? []) as CategoryCompetitor[],
        dominanceMap:         (data.scores.dominanceMap         ?? null) as DominanceMap | null,
        realPromptDiscovery:  (data.scores.realPromptDiscovery  ?? null) as RealPromptDiscovery[] | null,
        promptArchitectureVersion: data.promptArchitectureVersion ?? 1,
        createdAt:            new Date(),
      };
      setLocalHistory(prev => [newScore, ...prev]);
    } else if (type === "error") {
      setCheck(s => ({ ...s, status: "error", error: event.message as string }));
    }
  }

  // ── Competitor discovery ───────────────────────────────────────────────

  async function runDiscovery() {
    setDiscovery({ ...INITIAL_DISCOVERY, status: "running", message: "Starting…" });

    try {
      const res = await fetch(`/api/sites/${siteId}/competitor-discovery?token=${encodeURIComponent(accessToken)}`, { method: "POST" });

      if (!res.ok) {
        let errorMsg = `HTTP ${res.status}`;
        try {
          const text = await res.text();
          if (text) {
            const parsed = JSON.parse(text) as { error?: string };
            errorMsg = parsed.error ?? errorMsg;
          }
        } catch { /* body not parseable — keep status code fallback */ }
        setDiscovery(s => ({ ...s, status: "error", error: errorMsg }));
        return;
      }

      if (!res.body) {
        setDiscovery(s => ({ ...s, status: "error", error: "No response body" }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json) continue;
          try { handleDiscoverySSE(JSON.parse(json) as Record<string, unknown>); } catch { /* skip */ }
        }
      }
    } catch (err) {
      setDiscovery(s => ({ ...s, status: "error", error: err instanceof Error ? err.message : "Unknown error" }));
    }
  }

  function handleDiscoverySSE(event: Record<string, unknown>) {
    const type = event.type as string;
    if (type === "start" || type === "stage" || type === "prompt-complete") {
      setDiscovery(s => ({
        ...s,
        progress: (event.progress as number | undefined) ?? s.progress,
        message:  (event.message as string | undefined) ?? s.message,
      }));
    } else if (type === "complete") {
      const competitors = (event.competitors ?? []) as DiscoveredCompetitor[];
      setDiscovery(s => ({ ...s, status: "complete", competitors, progress: 100, message: "Done" }));
      // Only overwrite existing competitors if discovery returned results — don't blank a
      // previously mapped list just because a re-run failed or a provider quota was exceeded
      if (competitors.length > 0) setLocalCompetitors(competitors);
    } else if (type === "error") {
      setDiscovery(s => ({ ...s, status: "error", error: event.message as string }));
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────

  const { status, progress, message, providerProgress, result, error } = check;
  const analyticsResult = result ?? (lastCheck ?? null);
  const isRunning = status === "running";
  const isDiscovering = discovery.status === "running";

  // Determine the score to display in hero (from fresh result or last check)
  const displayScore: number | null = result
    ? result.scores.overallVisibility
    : lastCheck
    ? lastCheck.overallVisibility
    : null;

  const displayIndirect: number = result
    ? result.scores.indirectVisibility
    : lastCheck?.indirectVisibility ?? 0;

  const displayDirect: number = result
    ? result.scores.brandKnowledge
    : lastCheck?.brandKnowledge ?? 0;

  const displayQuality: number = result
    ? result.scores.citationQualityScore
    : lastCheck?.citationQualityScore ?? 0;

  const displayProviders = result
    ? result.providerResults
    : lastCheck?.providerResults ?? [];

  const tier = displayScore !== null ? scoreTier(displayScore) : null;

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", padding: "24px 0", color: TEXT }}>
      <style>{`
        .ca-interactive { transition: background-color 0.15s ease; cursor: pointer; }
        .ca-interactive:hover { background-color: #e8e5e0 !important; }
        .ca-interactive:active { background-color: rgba(0,0,0,0.06) !important; }
        .cm-platform-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .cm-hero-pills { display: flex; gap: 8px; flex-wrap: wrap; }
        .cm-hero-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
        .cm-action-buttons { display: flex; gap: 10px; flex-shrink: 0; }
        @media (max-width: 640px) {
          .cm-platform-cards { grid-template-columns: 1fr !important; }
          .cm-hero-row { flex-direction: column !important; align-items: flex-start !important; gap: 14px !important; }
          .cm-hero-score { font-size: 42px !important; }
          .cm-hero-section { padding: 16px !important; }
          .cm-action-buttons { flex-direction: column !important; width: 100% !important; }
          .cm-action-buttons button { width: 100% !important; text-align: center !important; }
          .cm-hero-pills { gap: 6px !important; }
          .cm-hero-pills > div { min-width: 64px !important; padding: 6px 10px !important; }
          .cm-hero-pills > div > div:first-child { font-size: 15px !important; }
          .cm-full-research-panel { padding: 12px 14px !important; }
          .cm-panel-header { padding: 10px 14px !important; }
        }
        @media (min-width: 641px) and (max-width: 768px) {
          .cm-platform-cards { grid-template-columns: repeat(2, 1fr) !important; }
          .cm-hero-row { flex-direction: column !important; align-items: flex-start !important; }
          .cm-action-buttons { flex-wrap: wrap !important; }
          .cm-action-buttons button { flex: 1 1 auto !important; }
        }
        @media (min-width: 769px) and (max-width: 1024px) {
          .cm-platform-cards { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>

      {/* ── Hero Bar ──────────────────────────────────────────────────────── */}
      {(displayScore !== null || isRunning) && tier && (
        <div className="cm-hero-section" style={{
          background: "#fafaf9",
          border: `1px solid ${BORDER}`,
          borderRadius: 14,
          padding: "22px 24px",
          marginBottom: 24,
        }}>
          <div className="cm-hero-row">
            {/* Left: big score */}
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, minWidth: 0 }}>
              <span className="cm-hero-score" style={{ fontSize: 60, fontWeight: 800, lineHeight: 1, color: TEXT, fontVariantNumeric: "tabular-nums" }}>
                {displayScore}%
              </span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: TEXT_2, marginBottom: 4 }}>AI Visibility Score</div>
                <span style={{
                  fontSize: 12, fontWeight: 700,
                  color: tier.color,
                  background: tier.bg,
                  padding: "3px 10px",
                  borderRadius: 100,
                  display: "inline-block",
                }}>
                  {tier.label}
                </span>
              </div>
            </div>

            {/* Center: sub-score pills */}
            <div className="cm-hero-pills">
              {[
                { label: "Indirect", value: displayIndirect },
                { label: "Direct",   value: displayDirect   },
                { label: "Quality",  value: displayQuality  },
              ].map(({ label, value }) => (
                <div key={label} style={{
                  background: "#fff",
                  border: `1px solid ${BORDER}`,
                  borderRadius: 8,
                  padding: "8px 14px",
                  textAlign: "center",
                  minWidth: 80,
                }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: pillarColor(value), fontVariantNumeric: "tabular-nums" }}>
                    {value}%
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: TEXT_3, marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Right: action buttons */}
            <div className="cm-action-buttons">
              <button
                onClick={runDiscovery}
                disabled={isDiscovering || isRunning}
                style={{
                  background: isDiscovering ? TRACK : "transparent",
                  color:      isDiscovering ? TEXT_2 : ACCENT,
                  border:     `1px solid ${isDiscovering ? BORDER : ACCENT}`,
                  borderRadius: 6, padding: "7px 14px",
                  cursor: (isDiscovering || isRunning) ? "not-allowed" : "pointer",
                  fontSize: 13, fontWeight: 600,
                }}
              >
                {isDiscovering ? "Mapping…" : "Map Competitors (2 credits)"}
              </button>
              <button
                onClick={runCheck}
                disabled={isRunning || isDiscovering}
                style={{
                  background: isRunning ? TRACK : ACCENT,
                  color:      isRunning ? TEXT_2 : "#fff",
                  border:     "none", borderRadius: 6, padding: "7px 16px",
                  cursor: (isRunning || isDiscovering) ? "not-allowed" : "pointer",
                  fontSize: 13, fontWeight: 600,
                }}
              >
                {isRunning ? "Scanning…" : "Scan AI Citations (5 credits)"}
              </button>
            </div>
          </div>

          {/* Competitor chips row */}
          {localCompetitors.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: TEXT_3, textTransform: "uppercase", letterSpacing: "0.06em" }}>vs.</span>
              {localCompetitors.slice(0, 8).map(c => (
                <span key={c.name} style={{
                  fontSize: 12, background: "#f0f0ef", border: `1px solid ${BORDER}`,
                  borderRadius: 100, padding: "2px 10px", color: TEXT_2,
                }}>
                  {c.name}
                </span>
              ))}
            </div>
          )}

          {/* Narrative body — LLM-generated, personalized to this brand */}
          {(narrativeText || narrativeLoading) && (
            <p style={{ margin: "14px 0 0", fontSize: 13, color: TEXT_2, lineHeight: 1.6 }}>
              {narrativeLoading && !narrativeText
                ? <NarrativeSkeleton />
                : narrativeText
              }
            </p>
          )}
        </div>
      )}

      {/* ── Header row (no hero yet) ───────────────────────────────────────── */}
      {displayScore === null && !isRunning && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: TEXT }}>AI Visibility</h2>
          <div className="cm-action-buttons">
            <button
              onClick={runDiscovery}
              disabled={isDiscovering || isRunning}
              style={{
                background: isDiscovering ? TRACK : "transparent",
                color:      isDiscovering ? TEXT_2 : ACCENT,
                border:     `1px solid ${isDiscovering ? BORDER : ACCENT}`,
                borderRadius: 6, padding: "7px 14px",
                cursor: (isDiscovering || isRunning) ? "not-allowed" : "pointer",
                fontSize: 13, fontWeight: 600,
              }}
            >
              {isDiscovering ? "Mapping…" : "Map Competitors (2 credits)"}
            </button>
            <button
              onClick={runCheck}
              disabled={isRunning || isDiscovering}
              style={{
                background: isRunning ? TRACK : ACCENT,
                color:      isRunning ? TEXT_2 : "#fff",
                border:     "none", borderRadius: 6, padding: "7px 16px",
                cursor: (isRunning || isDiscovering) ? "not-allowed" : "pointer",
                fontSize: 13, fontWeight: 600,
              }}
            >
              {isRunning ? "Scanning…" : "Scan AI Citations (5 credits)"}
            </button>
          </div>
        </div>
      )}

      {/* Discovery progress */}
      {isDiscovering && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ height: 4, background: TRACK, borderRadius: 2, marginBottom: 8 }}>
            <div style={{ height: "100%", width: `${discovery.progress}%`, background: ACCENT, borderRadius: 2, transition: "width 0.3s" }} />
          </div>
          <p style={{ color: TEXT_2, fontSize: 13, margin: 0 }}>{discovery.message}</p>
        </div>
      )}
      {discovery.status === "error" && discovery.error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", color: RED, marginBottom: 16, fontSize: 13 }}>
          Discovery error: {discovery.error}
        </div>
      )}

      {/* No competitors mapped yet */}
      {localCompetitors.length === 0 && !isDiscovering && displayScore === null && (
        <div style={{ marginBottom: 20, padding: "10px 14px", background: "#fffbf5", border: `1px solid rgba(180,83,9,0.2)`, borderRadius: 8, fontSize: 13, color: TEXT_2 }}>
          No competitors mapped yet. Click <strong style={{ color: ACCENT }}>Map Competitors</strong> to let AI identify your competitive landscape.
        </div>
      )}

      {/* Post-discovery CTA (only when no scan yet) */}
      {discovery.status === "complete" && localCompetitors.length > 0 && displayScore === null && (
        <div style={{ marginBottom: 20, padding: "12px 16px", background: "#f0fdf4", border: `1px solid rgba(22,163,74,0.25)`, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 700, color: "#166534" }}>
              Your competitive benchmark is ready
            </p>
            <p style={{ margin: 0, fontSize: 12, color: "#16a34a" }}>
              vs. {localCompetitors.map(c => c.name).join(", ")} — run a scan to see how you rank.
            </p>
          </div>
          <button
            onClick={runCheck}
            disabled={isRunning}
            style={{
              background: isRunning ? TRACK : "#16a34a",
              color: isRunning ? TEXT_2 : "#fff",
              border: "none", borderRadius: 6, padding: "8px 16px",
              cursor: isRunning ? "not-allowed" : "pointer",
              fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0,
            }}
          >
            {isRunning ? "Scanning…" : "→ Scan vs Competitors (5 credits)"}
          </button>
        </div>
      )}

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {(["run", "history"] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            background:   activeTab === tab ? TEXT : "transparent",
            color:        activeTab === tab ? "#fff" : TEXT_2,
            border:       `1px solid ${BORDER}`,
            borderRadius: 6, padding: "6px 14px",
            fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>
            {tab === "run" ? "Latest Scan" : `History${localHistory.length > 0 ? ` (${localHistory.length})` : ""}`}
          </button>
        ))}
      </div>

      {activeTab === "history" && <CitationHistory history={localHistory} domain={domain} />}

      {activeTab === "run" && (
        <div>
          {/* Running progress */}
          {isRunning && (
            <div style={{ marginBottom: 24 }}>
              <p style={{ color: TEXT_2, margin: "0 0 12px", fontSize: 14 }}>{message}</p>
              <div style={{ height: 6, background: TRACK, borderRadius: 3, marginBottom: 16 }}>
                <div style={{ height: "100%", width: `${progress}%`, background: ACCENT, borderRadius: 3, transition: "width 0.3s" }} />
              </div>
              {Object.entries(providerProgress).map(([provider, p]) => (
                <div key={provider} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                    <span style={{ textTransform: "capitalize", color: TEXT }}>{provider}</span>
                    <span style={{ color: TEXT_3 }}>{p.done}/{p.total}</span>
                  </div>
                  <div style={{ height: 4, background: TRACK, borderRadius: 2 }}>
                    <div style={{ height: "100%", width: p.total ? `${(p.done / p.total) * 100}%` : "0%", background: GREEN, borderRadius: 2, transition: "width 0.3s" }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {status === "error" && error && (
            <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: 16, color: RED, marginBottom: 16, fontSize: 14 }}>
              {error}
            </div>
          )}

          {/* ── Platform Cards ─────────────────────────────────────────────── */}
          {displayProviders.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <h3 style={SECTION_HEADING}>By AI Platform</h3>
              <div className="cm-platform-cards">
                {displayProviders.map(p => (
                  <PlatformCard
                    key={p.provider}
                    provider={p.provider}
                    visibilityScore={p.visibilityScore}
                    mentionCount={p.mentionCount}
                    totalQueries={p.totalQueries}
                    sentiment={p.sentiment}
                    samples={p.samples}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Analytics (theme visibility + competitors) ─────────────────── */}
          {analyticsResult && (
            <CitationAnalytics result={analyticsResult} domain={domain} />
          )}

          {/* ── Dimensional Intelligence (Tier 2-4) ────────────────────────── */}
          {analyticsResult && (
            <DimensionalIntelligence result={analyticsResult} domain={domain} />
          )}

          {/* ── Full Research toggle ────────────────────────────────────────── */}
          {analyticsResult && <FullResearchToggle result={analyticsResult} domain={domain} />}

          {/* Idle: no data yet */}
          {status === "idle" && !lastCheck && (
            <p style={{ color: TEXT_2, fontSize: 14 }}>No scans run yet. Click &quot;Scan AI Citations&quot; to see how {domain} appears across ChatGPT, Perplexity, and Google AI.</p>
          )}
        </div>
      )}
    </div>
  );
}
