"use client";

// Brand detail: prompt management (library + custom), run frequency, run
// history with stored metrics, and the credit-gated "Run now".
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
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
  scope: { promptVersionIds?: string[]; platforms?: string[] } | null;
  // Brand-domain stats computed by this service (geo's metrics match a PCG
  // article list we don't use — its citation figures are always 0 here).
  citationStats?: {
    totalCitations: number;
    brandCitations: number;
    competitorCitations: number;
    brandCitationRate: number | null;
    hallucinatedCitations: number;
  };
}

interface AiSearchRow {
  promptId: string;
  promptText: string;
  present: boolean;
  brandMentioned: boolean | null;
  citedUrls: Array<{ url: string; label: string }>;
  checkedAt: string | null;
}

interface TopSource {
  page: string;  // normalized host/path label
  url: string;   // resolved working link
  domain: string;
  count: number;
  brand: boolean;
  platforms: string[]; // which models cited this page
  check: CheckStatus | null; // verification verdict; null = pending
}

type CheckStatus = "verified" | "no_mention" | "dead" | "unverifiable";

/** Hallucination-guard badge: every cited page is fetched and classified. */
function CheckBadge({ check }: { check: CheckStatus | null | undefined }) {
  if (check === "verified") return <span title="Page is live and mentions the brand" style={{ color: GREEN }}>✓</span>;
  if (check === "no_mention")
    return (
      <span title="Page is live but never mentions the brand — likely a hallucinated citation" style={{ color: "#d97706", fontWeight: 600 }}>
        ⚠ no brand mention
      </span>
    );
  if (check === "dead") return <span title="Link is dead (4xx/5xx)" style={{ color: RED }}>✗ dead</span>;
  return null; // pending / unverifiable — no claim either way
}

const CARD = "#ffffff";
const BORDER = "1px solid rgba(0,0,0,0.08)";
const MUTED = "#78716c";
const ACCENT = "#b45309";
const GREEN = "#16a34a";
const RED = "#dc2626";

const pct = (v: number) => `${Math.round(v * 100)}%`;

interface ReplyRow {
  promptName: string;
  promptText: string;
  platform: string;
  model: string | null;
  attempt: number;
  responseText: string | null;
  citedUrls: string[];
  brandMentioned: boolean;
  sentiment: string | null;
}

interface HistoryRow {
  runId: string;
  period: string;
  runCreatedAt: string | null;
  version: number;
  promptText: string;
  platform: string;
  attempt: number;
  responseText: string | null;
  citedUrls: string[];
  brandMentioned: boolean;
  sentiment: string | null;
}

const PLATFORM_LABEL: Record<string, string> = { openai: "ChatGPT", perplexity: "Perplexity", google: "Gemini", anthropic: "Claude" };
const PLATFORM_ORDER = ["openai", "perplexity", "google", "anthropic"];

const SENTIMENT_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  positive: { color: GREEN, bg: "#f0fdf4", label: "positive" },
  negative: { color: RED, bg: "#fef2f2", label: "negative" },
  neutral: { color: MUTED, bg: "#f5f5f4", label: "neutral" },
};

function SentimentChip({ sentiment }: { sentiment: string | null }) {
  const s = sentiment ? SENTIMENT_STYLE[sentiment] : undefined;
  if (!s) return null;
  return (
    <span style={{ color: s.color, background: s.bg, border: BORDER, borderRadius: 999, padding: "1px 8px", fontWeight: 600 }}>
      {s.label}
    </span>
  );
}

/**
 * One prompt×platform counts once — attempt 2 (geo's re-run-once rule)
 * supersedes attempt 1 in the tallies.
 */
function finalAttempts(rows: ReplyRow[]): ReplyRow[] {
  const byKey = new Map<string, ReplyRow>();
  for (const r of rows) {
    const key = `${r.promptText}|${r.platform}`;
    const prev = byKey.get(key);
    if (!prev || r.attempt > prev.attempt) byKey.set(key, r);
  }
  return [...byKey.values()];
}

interface SentimentCounts {
  positive: number;
  neutral: number;
  negative: number;
  unclassified: number;
}

function tallySentiment(finals: ReplyRow[]): SentimentCounts {
  const counts: SentimentCounts = { positive: 0, neutral: 0, negative: 0, unclassified: 0 };
  for (const r of finals) {
    if (r.sentiment === "positive" || r.sentiment === "neutral" || r.sentiment === "negative") counts[r.sentiment]++;
    else if (r.brandMentioned) counts.unclassified++;
  }
  return counts;
}

function SentimentSplit({ counts, onSelect }: { counts: SentimentCounts; onSelect?: (s: "positive" | "neutral" | "negative") => void }) {
  return (
    <>
      {(["positive", "neutral", "negative"] as const).map((k) =>
        counts[k] > 0 ? (
          onSelect ? (
            <button
              key={k}
              onClick={() => onSelect(k)}
              title={`Show the ${k} replies`}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: SENTIMENT_STYLE[k].color, fontWeight: 600, fontSize: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}
            >
              {counts[k]} {k}
            </button>
          ) : (
            <span key={k} style={{ color: SENTIMENT_STYLE[k].color, fontWeight: 600 }}>
              {counts[k]} {k}
            </span>
          )
        ) : null,
      )}
      {counts.unclassified > 0 && <span style={{ color: MUTED }}>{counts.unclassified} unclassified</span>}
    </>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <span style={{ color: MUTED, fontSize: 12 }}>needs 2+ runs</span>;
  const w = 180;
  const h = 44;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (w - 4) + 2},${h - 2 - v * (h - 8)}`).join(" ");
  return (
    <svg width={w} height={h} role="img" aria-label="trend">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px", flex: "1 1 150px" }}>
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, margin: "4px 0" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: MUTED }}>{sub}</div>}
    </div>
  );
}

/** The run at a glance — nobody reads every reply. */
function RunDigest({ rows, onSelectSentiment }: { rows: ReplyRow[]; onSelectSentiment?: (s: "positive" | "neutral" | "negative") => void }) {
  const finals = finalAttempts(rows);
  if (finals.length === 0) return null;
  const mentioned = finals.filter((r) => r.brandMentioned).length;
  const counts = tallySentiment(finals);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, background: "#fff7ed", border: BORDER, borderRadius: 8, padding: "8px 12px", fontSize: 12, marginTop: 10 }}>
      <span>
        <strong>{mentioned}</strong> of {finals.length} replies mention the brand
      </span>
      <SentimentSplit counts={counts} onSelect={onSelectSentiment} />
    </div>
  );
}

const REPLY_PREVIEW_CHARS = 280;

// AI replies are markdown — render it (react-markdown builds React elements;
// no raw HTML, so LLM output can't inject markup). Collapsed preview +
// expand-in-place, deliberately NO inner scrollbars — a fixed-height
// scrollable box traps the wheel and hides the platforms below it.
const MD_COMPONENTS: Components = {
  p: (props) => <p style={{ margin: "0 0 8px" }} {...props} />,
  ul: (props) => <ul style={{ margin: "0 0 8px", paddingLeft: 20 }} {...props} />,
  ol: (props) => <ol style={{ margin: "0 0 8px", paddingLeft: 20 }} {...props} />,
  li: (props) => <li style={{ marginBottom: 2 }} {...props} />,
  h1: (props) => <strong style={{ display: "block", margin: "8px 0 4px" }} {...props} />,
  h2: (props) => <strong style={{ display: "block", margin: "8px 0 4px" }} {...props} />,
  h3: (props) => <strong style={{ display: "block", margin: "8px 0 4px" }} {...props} />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: ACCENT }}>
      {children}
    </a>
  ),
  code: (props) => (
    <code style={{ background: "#f5f5f4", borderRadius: 4, padding: "1px 4px", fontSize: 12 }} {...props} />
  ),
};

/** Slice markdown without leaving unclosed syntax to render literally. */
function previewSlice(text: string): string {
  let cut = text.slice(0, REPLY_PREVIEW_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > REPLY_PREVIEW_CHARS - 40) cut = cut.slice(0, lastSpace);
  cut = cut.trimEnd();
  // Drop an incomplete trailing [link](fragment
  const lastOpen = cut.lastIndexOf("[");
  if (lastOpen !== -1 && !cut.slice(lastOpen).includes(")")) cut = cut.slice(0, lastOpen).trimEnd();
  // Close a mid-cut ** so it bolds to the end instead of showing literally
  if ((cut.split("**").length - 1) % 2 === 1) cut += "**";
  return `${cut}…`;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Cited sources as links — URLs arrive redirect-resolved; dead links are dropped. */
function SourceLinks({ urls, checks }: { urls?: string[]; checks?: Record<string, CheckStatus> }) {
  if (!urls?.length) return null;
  const seen = new Set<string>();
  const sources = urls.flatMap((u) => {
    const host = hostOf(u);
    const check = checks?.[u] ?? null;
    if (!host || seen.has(host) || check === "dead" || check === "no_mention") return [];
    seen.add(host);
    return [{ host, url: u, check }];
  });
  if (!sources.length) return null;
  return (
    <span style={{ color: MUTED }}>
      Sources:{" "}
      {sources.map((s, i) => (
        <span key={s.host}>
          {i > 0 && " · "}
          <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: ACCENT }}>
            {s.host}
          </a>
          {s.check === "verified" && <span title="Page mentions the brand" style={{ color: GREEN }}>✓</span>}
        </span>
      ))}
    </span>
  );
}

function ReplyText({ text, mentioned, sentiment, citedUrls, checks }: { text: string | null; mentioned: boolean; sentiment?: string | null; citedUrls?: string[]; checks?: Record<string, CheckStatus> }) {
  const [expanded, setExpanded] = useState(false);
  const long = (text?.length ?? 0) > REPLY_PREVIEW_CHARS;
  const shown = !text ? null : expanded || !long ? text : previewSlice(text);
  return (
    <div style={{ fontSize: 13, lineHeight: 1.5, background: "#fafaf9", border: BORDER, borderRadius: 8, padding: "10px 12px" }}>
      {shown === null ? (
        <em style={{ color: MUTED }}>no response captured</em>
      ) : (
        <ReactMarkdown components={MD_COMPONENTS}>{shown}</ReactMarkdown>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 6, fontSize: 11 }}>
        {mentioned && <span style={{ color: GREEN, fontWeight: 600 }}>✓ brand mentioned</span>}
        <SentimentChip sentiment={sentiment ?? null} />
        <SourceLinks urls={citedUrls} checks={checks} />
        {long && (
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{ background: "none", border: "none", padding: 0, color: ACCENT, fontSize: 11, cursor: "pointer" }}
          >
            {expanded ? "Collapse" : "Show full reply"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function BrandDetail({ clientId }: { clientId: string }) {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  // null until the first load decides: Overview when there's a completed run
  // to show, otherwise straight to prompt setup.
  const [tab, setTab] = useState<"overview" | "prompts" | "runs" | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [customText, setCustomText] = useState("");
  const [running, setRunning] = useState(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(PLATFORM_ORDER);
  const [notFound, setNotFound] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, ReplyRow[]>>({});
  const [historyPromptId, setHistoryPromptId] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, HistoryRow[]>>({});
  const [topSources, setTopSources] = useState<Record<string, TopSource[]>>({});
  const [sourceChecks, setSourceChecks] = useState<Record<string, Record<string, CheckStatus>>>({});
  const [aiSearch, setAiSearch] = useState<AiSearchRow[] | null>(null);
  const [replyFilter, setReplyFilter] = useState<{ runId: string; sentiment: "positive" | "neutral" | "negative" } | null>(null);

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
    if (runsRes.ok) {
      const { runs: fresh } = (await runsRes.json()) as { runs: Run[] };
      setRuns(fresh);
      setTab((t) => t ?? (fresh.some((r) => r.status === "complete" && r.metrics) ? "overview" : "prompts"));
    }
    if (teamRes.ok) setBalance((await teamRes.json()).creditBalance);
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while a run is in flight so status + metrics appear without a reload.
  // Only the runs list can change mid-run — refresh everything else once when
  // the run leaves pending/running.
  const hasActiveRun = runs.some((r) => r.status === "pending" || r.status === "running");
  useEffect(() => {
    if (!hasActiveRun) return;
    const t = setInterval(async () => {
      const res = await fetch(apiUrl(`/api/brands/${clientId}/runs`));
      if (!res.ok) return;
      const { runs: fresh } = (await res.json()) as { runs: Run[] };
      setRuns(fresh);
      const stillActive = fresh.some((r) => r.status === "pending" || r.status === "running");
      if (!stillActive) void load(); // final refresh: balance, prompts, brand
    }, 5000);
    return () => clearInterval(t);
  }, [hasActiveRun, clientId, load]);

  const runCost = prompts.length > 0 ? citationRunCredits(prompts.length, selectedPlatforms.length) : 0;
  const singleCost = citationRunCredits(1, selectedPlatforms.length);
  // Geo's cron always runs scheduled runs on all 3 models — unaffected by the picker.
  const scheduledCost = prompts.length > 0 ? citationRunCredits(prompts.length) : 0;
  const inLibrary = new Set(prompts.map((p) => p.name));

  function togglePlatform(p: string) {
    setSelectedPlatforms((cur) =>
      cur.includes(p) ? (cur.length > 1 ? cur.filter((x) => x !== p) : cur) : [...cur, p],
    );
  }

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
        toast.info(`Scheduled runs bill ~${scheduledCost || citationRunCredits(1)} credits each, automatically.`);
      }
    }
  }

  // Overview also shows AI-search (Google AI Overview) visibility per prompt.
  useEffect(() => {
    if (tab !== "overview" || aiSearch !== null) return;
    void fetch(apiUrl(`/api/brands/${clientId}/ai-search`)).then(async (res) => {
      if (res.ok) setAiSearch((await res.json()).aiSearch ?? []);
    });
  }, [tab, aiSearch, clientId]);

  // Overview needs the latest complete run's replies for the sentiment split.
  const latestComplete = runs.find((r) => r.status === "complete" && r.metrics) ?? null;
  const latestCompleteId = latestComplete?.id ?? null;
  useEffect(() => {
    if (tab !== "overview" || !latestCompleteId || replies[latestCompleteId]) return;
    void fetch(apiUrl(`/api/brands/${clientId}/runs/${latestCompleteId}/responses`)).then(async (res) => {
      if (res.ok) {
        const body = await res.json();
        setReplies((m) => ({ ...m, [latestCompleteId]: body.responses }));
        setTopSources((m) => ({ ...m, [latestCompleteId]: body.topSources ?? [] }));
        setSourceChecks((m) => ({ ...m, [latestCompleteId]: body.sourceChecks ?? {} }));
      }
    });
  }, [tab, latestCompleteId, clientId, replies]);

  async function toggleReplies(runId: string) {
    if (openRunId === runId) {
      setOpenRunId(null);
      return;
    }
    setOpenRunId(runId);
    if (!replies[runId]) {
      const res = await fetch(apiUrl(`/api/brands/${clientId}/runs/${runId}/responses`));
      if (res.ok) {
        const body = await res.json();
        setReplies((m) => ({ ...m, [runId]: body.responses }));
        setTopSources((m) => ({ ...m, [runId]: body.topSources ?? [] }));
        setSourceChecks((m) => ({ ...m, [runId]: body.sourceChecks ?? {} }));
      }
    }
  }

  async function toggleHistory(promptId: string) {
    if (historyPromptId === promptId) {
      setHistoryPromptId(null);
      return;
    }
    setHistoryPromptId(promptId);
    if (!history[promptId]) {
      const res = await fetch(apiUrl(`/api/brands/${clientId}/prompts/${promptId}/history`));
      if (res.ok) {
        const body = await res.json();
        setHistory((m) => ({ ...m, [promptId]: body.history }));
      }
    }
  }

  /** Jump from a sentiment count to the matching replies of that run. */
  function showSentimentReplies(runId: string, sentiment: "positive" | "neutral" | "negative") {
    setReplyFilter({ runId, sentiment });
    setOpenRunId(runId);
    setTab("runs");
    if (!replies[runId]) void toggleReplies(runId);
  }

  async function runNow(promptIds?: string[]) {
    setRunning(true);
    try {
      const scope: { promptIds?: string[]; platforms?: string[] } = {};
      if (promptIds?.length) scope.promptIds = promptIds;
      if (selectedPlatforms.length < PLATFORM_ORDER.length) scope.platforms = selectedPlatforms;
      const res = await fetch(apiUrl(`/api/brands/${clientId}/run`), {
        method: "POST",
        ...(Object.keys(scope).length > 0
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(scope) }
          : {}),
      });
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
          <div style={{ display: "flex", gap: 4 }} title="Models the next manual run queries">
            {PLATFORM_ORDER.map((p) => {
              const on = selectedPlatforms.includes(p);
              return (
                <button
                  key={p}
                  onClick={() => togglePlatform(p)}
                  style={{ padding: "5px 10px", background: on ? "#fff7ed" : CARD, border: on ? `1px solid ${ACCENT}` : BORDER, borderRadius: 999, fontSize: 12, cursor: "pointer", color: on ? ACCENT : MUTED, fontWeight: on ? 600 : 400 }}
                >
                  {PLATFORM_LABEL[p]}
                </button>
              );
            })}
          </div>
          <label style={{ fontSize: 13, color: MUTED }}>
            Frequency{" "}
            <select
              value={brand?.runFrequency ?? "monthly"}
              onChange={(e) => void setFrequency(e.target.value as TrackerRunFrequency)}
              style={{ padding: "6px 8px", border: BORDER, borderRadius: 6 }}
            >
              <option value="manual">Manual only</option>
              <option value="weekly">Weekly (~{scheduledCost || "?"} credits/run)</option>
              <option value="monthly">Monthly (~{scheduledCost || "?"} credits/run)</option>
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
        {(["overview", "prompts", "runs"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ padding: "8px 2px", background: "none", border: "none", borderBottom: tab === t ? `2px solid ${ACCENT}` : "2px solid transparent", fontSize: 14, cursor: "pointer", color: tab === t ? "inherit" : MUTED }}
          >
            {t === "overview" ? "Overview" : t === "prompts" ? `Prompts (${prompts.length}/30)` : `Runs (${runs.length})`}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <section>
          {!latestComplete ? (
            <p style={{ color: MUTED, fontSize: 14 }}>
              No completed runs yet — add prompts and run them to see the dashboard.
            </p>
          ) : (
            (() => {
              const m = latestComplete.metrics!;
              const stats = latestComplete.citationStats;
              const soav =
                stats && stats.brandCitations + stats.competitorCitations > 0
                  ? stats.brandCitations / (stats.brandCitations + stats.competitorCitations)
                  : null;
              const trend = [...runs].filter((r) => r.status === "complete" && r.metrics).reverse();
              const latestReplies = replies[latestComplete.id];
              const latestSources = topSources[latestComplete.id];
              const sentimentCounts = latestReplies ? tallySentiment(finalAttempts(latestReplies)) : null;
              return (
                <div style={{ display: "grid", gap: 12 }}>
                  <div style={{ fontSize: 12, color: MUTED }}>
                    Latest complete run · {latestComplete.period} · {latestComplete.promptsTotal ?? "?"} prompt{latestComplete.promptsTotal === 1 ? "" : "s"}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                    <MetricCard
                      label="Brand citation rate"
                      value={stats?.brandCitationRate != null ? pct(stats.brandCitationRate) : "—"}
                      sub={brand?.domain ? `replies citing ${brand.domain}` : "set a domain to track this"}
                    />
                    <MetricCard label="Brand mentions" value={pct(m.brandMentionRate)} sub="replies naming the brand" />
                    <MetricCard label="Share of AI voice" value={soav != null ? pct(soav) : "—"} sub="brand vs competitor citations" />
                    <MetricCard label="Citations" value={String(stats?.totalCitations ?? 0)} sub={stats?.hallucinatedCitations ? `verified sources · ${stats.hallucinatedCitations} hallucinated filtered out` : "verified sources"} />
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px", flex: "1 1 220px" }}>
                      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Brand sentiment (latest run)</div>
                      {sentimentCounts ? (
                        <div style={{ display: "flex", gap: 14, fontSize: 14, flexWrap: "wrap" }}>
                          <SentimentSplit counts={sentimentCounts} onSelect={(sent) => showSentimentReplies(latestComplete.id, sent)} />
                          {sentimentCounts.positive + sentimentCounts.neutral + sentimentCounts.negative + sentimentCounts.unclassified === 0 && (
                            <span style={{ color: MUTED, fontSize: 12 }}>brand not mentioned in any reply</span>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: MUTED, fontSize: 12 }}>loading…</span>
                      )}
                    </div>
                    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px", flex: "1 1 220px" }}>
                      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Brand-citation trend ({trend.length} runs)</div>
                      <Sparkline values={trend.map((r) => r.citationStats?.brandCitationRate ?? 0)} color={ACCENT} />
                    </div>
                  </div>

                  {latestSources && latestSources.length > 0 && (
                    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px" }}>
                      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Top cited pages (latest run)</div>
                      <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                        {latestSources.filter((sSrc) => sSrc.check !== "dead" && sSrc.check !== "no_mention").map((sSrc) => (
                          <div key={sSrc.page} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                            <span style={{ overflowWrap: "anywhere" }}>
                              <a
                                href={sSrc.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={sSrc.url}
                                style={{ fontWeight: sSrc.brand ? 700 : 400, color: sSrc.brand ? GREEN : ACCENT }}
                              >
                                {sSrc.page.length > 70 ? `${sSrc.page.slice(0, 70)}…` : sSrc.page}{sSrc.brand ? " · you" : ""}
                              </a>
                              {" "}<CheckBadge check={sSrc.check} />
                            </span>
                            <span style={{ color: MUTED, whiteSpace: "nowrap" }}>
                              {sSrc.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(" + ")} · {sSrc.count}×
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {aiSearch !== null && aiSearch.length > 0 && (
                    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px" }}>
                      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
                        AI Search — Google AI Overview (checked daily)
                      </div>
                      <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
                        {aiSearch.map((row) => (
                          <div key={row.promptId}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                              <span style={{ overflowWrap: "anywhere" }}>{row.promptText}</span>
                              <span style={{ whiteSpace: "nowrap", fontWeight: 600, color: !row.present ? MUTED : row.brandMentioned ? GREEN : RED }}>
                                {!row.present ? "no AI Overview" : row.brandMentioned ? "✓ brand in overview" : "✗ brand absent"}
                              </span>
                            </div>
                            {row.present && row.citedUrls.length > 0 && (
                              <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                                Overview cites:{" "}
                                {row.citedUrls.slice(0, 6).map((c, i) => (
                                  <span key={c.url}>
                                    {i > 0 && " · "}
                                    <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: hostOf(c.url)?.endsWith(brand?.domain?.replace(/^www\./, "") ?? "\u0000") ? GREEN : ACCENT }}>
                                      {hostOf(c.url) ?? c.label}
                                    </a>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {m.platformBreakdown?.length > 0 && (
                    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px" }}>
                      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>By platform (latest run)</div>
                      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ color: MUTED, textAlign: "left" }}>
                            <th style={{ fontWeight: 400, paddingBottom: 6 }}>Platform</th>
                            <th style={{ fontWeight: 400 }}>Brand mentions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.platformBreakdown.map((p) => (
                            <tr key={p.platform} style={{ borderTop: BORDER }}>
                              <td style={{ padding: "6px 0" }}>{PLATFORM_LABEL[p.platform] ?? p.platform}</td>
                              <td><strong>{pct(p.brandMentionRate)}</strong></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {m.competitorMetrics?.length > 0 && (
                    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "14px 16px" }}>
                      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>Competitors cited (latest run)</div>
                      <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                        {m.competitorMetrics.map((c) => (
                          <div key={c.domain} style={{ display: "flex", justifyContent: "space-between" }}>
                            <span>{c.name} <span style={{ color: MUTED }}>({c.domain})</span></span>
                            <span><strong>{c.totalCitations}</strong> citations · {pct(c.citationRate)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()
          )}
        </section>
      )}

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
                  <button
                    onClick={() => void runNow([p.promptId])}
                    disabled={running || hasActiveRun}
                    title={`Run just this prompt on ${selectedPlatforms.map((x) => PLATFORM_LABEL[x]).join(", ")}`}
                    style={{ background: "none", border: BORDER, borderRadius: 999, padding: "3px 10px", color: ACCENT, cursor: "pointer", fontWeight: 600, opacity: running || hasActiveRun ? 0.5 : 1 }}
                  >
                    Run · {singleCost} cr
                  </button>
                  <button onClick={() => void toggleHistory(p.promptId)} style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer" }}>
                    {historyPromptId === p.promptId ? "Hide history" : "History"}
                  </button>
                  <button onClick={() => void editPrompt(p)} style={{ background: "none", border: "none", color: ACCENT, cursor: "pointer" }}>Edit</button>
                  <button onClick={() => void archivePrompt(p.promptId)} style={{ background: "none", border: "none", color: MUTED, cursor: "pointer" }}>Remove</button>
                </div>
              </div>
            ))}
            {historyPromptId && history[historyPromptId] && (
              <div style={{ background: CARD, border: BORDER, borderRadius: 10, padding: "12px 16px" }}>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>
                  How the answers evolved — oldest first. A version chip marks where the prompt wording changed.
                </div>
                {history[historyPromptId].length === 0 && (
                  <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>No replies yet — run the prompts first.</p>
                )}
                <div style={{ display: "grid", gap: 12 }}>
                  {history[historyPromptId].map((h, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>
                        {h.period} · {PLATFORM_LABEL[h.platform] ?? h.platform}
                        {h.attempt > 1 ? ` · attempt ${h.attempt}` : ""}
                        {(i === 0 || history[historyPromptId][i - 1].version !== h.version) && (
                          <span style={{ marginLeft: 6, padding: "1px 6px", background: "#fff7ed", border: BORDER, borderRadius: 999 }}>v{h.version}</span>
                        )}
                      </div>
                      <ReplyText text={h.responseText} mentioned={h.brandMentioned} sentiment={h.sentiment} citedUrls={h.citedUrls} />
                    </div>
                  ))}
                </div>
              </div>
            )}
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
                  <span style={{ color: MUTED, marginLeft: 8, fontSize: 12 }}>
                    {r.kind} · {r.promptsTotal ?? "?"} prompt{r.promptsTotal === 1 ? "" : "s"}
                    {r.scope?.platforms?.length
                      ? ` · ${r.scope.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(" + ")}`
                      : ""}
                  </span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: r.status === "complete" ? GREEN : r.status === "failed" ? RED : ACCENT }}>
                  {r.status}
                </span>
              </div>
              {r.metrics && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 10, fontSize: 13 }}>
                  <span>Brand cited <strong>{r.citationStats?.brandCitationRate != null ? pct(r.citationStats.brandCitationRate) : "—"}</strong></span>
                  <span>Brand mentions <strong>{pct(r.metrics.brandMentionRate)}</strong></span>
                  <span>Brand citations <strong>{r.citationStats?.brandCitations ?? 0}</strong></span>
                  <span>All citations <strong>{r.citationStats?.totalCitations ?? 0}</strong></span>
                </div>
              )}
              {r.error && <div style={{ marginTop: 8, fontSize: 12, color: RED }}>{r.error}</div>}
              {r.status === "complete" && (
                <button
                  onClick={() => void toggleReplies(r.id)}
                  style={{ marginTop: 10, background: "none", border: "none", color: ACCENT, fontSize: 12, cursor: "pointer", padding: 0 }}
                >
                  {openRunId === r.id ? "Hide replies" : "View replies"}
                </button>
              )}
              {openRunId === r.id && replies[r.id] && (
                <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
                  <RunDigest rows={replies[r.id]} onSelectSentiment={(sent) => setReplyFilter({ runId: r.id, sentiment: sent })} />
                  {replyFilter?.runId === r.id && (
                    <div style={{ fontSize: 12, color: SENTIMENT_STYLE[replyFilter.sentiment].color }}>
                      Showing {replyFilter.sentiment} replies only{" "}
                      <button onClick={() => setReplyFilter(null)} style={{ background: "none", border: "none", padding: 0, color: ACCENT, cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
                        show all
                      </button>
                    </div>
                  )}
                  {[...replies[r.id]]
                    .filter((row) => replyFilter?.runId !== r.id || row.sentiment === replyFilter.sentiment)
                    .sort((a, b) =>
                      a.promptText === b.promptText
                        ? PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform)
                        : 0,
                    )
                    .map((resp, i, sorted) => (
                    <div key={i}>
                      {(i === 0 || sorted[i - 1].promptText !== resp.promptText) && (
                        <div style={{ fontSize: 13, fontWeight: 600, margin: "6px 0" }}>{resp.promptText}</div>
                      )}
                      <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>
                        {PLATFORM_LABEL[resp.platform] ?? resp.platform}
                        {resp.model ? ` · ${resp.model}` : ""}
                        {resp.attempt > 1 ? ` · attempt ${resp.attempt}` : ""}
                      </div>
                      <ReplyText text={resp.responseText} mentioned={resp.brandMentioned} sentiment={resp.sentiment} citedUrls={resp.citedUrls} checks={sourceChecks[r.id]} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
