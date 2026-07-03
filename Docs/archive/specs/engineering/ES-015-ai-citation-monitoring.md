# ES-015: AI Citation Monitoring — "AI Visibility" Tab

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#104](https://github.com/flowblinqadmin/geo/issues/104)  
> **Delivery Commit:** `pending — ScriptDev in progress`  

---

**Source:** TS-015-ai-citation-monitoring.md (updated 2026-03-02 after cross-repo audit #32)
**Agent:** 2-SpecMaster
**Date:** 2026-03-02
**Priority:** P1
**Downstream:** ScriptDev (agent 6) — direct per CoFounder override
**GitHub Issue:** #104
**Branch:** `dev-sprint-7` → PR → main
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/geo`)

---

## a) Overview

### What This Covers

Add an **AI Citation Monitor** to the site results page: a one-click check that
queries Perplexity, OpenAI, Anthropic, and Gemini with domain-aware prompts and
reports whether the brand is being cited/recommended by major AI platforms.

**New artifacts:**
- `app/api/sites/[id]/citation-check/route.ts` — SSE endpoint
- `lib/services/citation-checker.ts` — multi-LLM dispatcher
- `lib/services/citation-prompt-generator.ts` — domain-aware prompt generation
- `lib/db/schema.ts` — two new tables (`citationCheckResponses`, `citationCheckScores`)
- `lib/db/migrations/20260302-citation-checks.sql`
- `app/components/citation-monitor.tsx` — UI tab component
- `app/sites/[id]/page.tsx` — add AI Visibility tab

### Current State

The site results page (`app/sites/[id]/page.tsx`) has no citation monitoring.
The existing `app/api/sites/[id]/` directory contains: auth, download-report,
info, regenerate, retry-failed, route.ts, verify, verify-connection, verify-domain.
No `citation-check` subdirectory exists yet.

Schema has no citation tables. `firecrawlJobs` is the most recently added table
(OPS-010). New tables append after it.

### Reference Implementations

| Reference | Use for |
|-----------|---------|
| `flowblinq_stage/apiaudit/lib/services/sov-checker.ts` | LLM query execution, mention detection, `parseMentions()` pattern |
| `flowblinq_stage/apiaudit/lib/services/intelligence-gatherer.ts` | Domain-aware prompt generation approach |
| `flowblinq_stage/flowblinq_fullrepo/brands-api/src/services/ai-visibility-engine.ts` | Full orchestration pattern, `onProgress` callback → SSE |
| `flowblinq_stage/flowblinq_fullrepo/brands-api/src/services/llm-clients/index.ts` | LLM client abstraction, `createAllClients()`, per-provider fault isolation |
| `flowblinq/.agents/references/firegeo/app/api/brand-monitor/analyze/route.ts` | SSE `text/event-stream` response pattern ONLY |

Do NOT use FireGEO's credit system (Autumn), auth (better-auth), or premium model choices.

---

## b) Implementation Requirements

### 1. DB Schema — `lib/db/schema.ts`

Append after the `firecrawlJobs` table block:

```typescript
// ── AI Citation Monitoring (TS-015 / Issue #104) ──────────────────────────

// One row per (site, provider, prompt) combination
export const citationCheckResponses = pgTable("citation_check_responses", {
  id:            text("id").primaryKey(),          // nanoid
  checkId:       text("check_id").notNull(),       // groups all responses for one check run
  siteId:        text("site_id").notNull().references(() => geoSites.id, { onDelete: "cascade" }),
  provider:      text("provider").notNull(),        // "openai" | "anthropic" | "perplexity" | "google"
  model:         text("model").notNull(),           // exact model string used
  query:         text("query").notNull(),           // the prompt sent
  response:      text("response"),                  // raw LLM response text (null on error)
  responseTimeMs: integer("response_time_ms"),
  mentioned:     boolean("mentioned").notNull().default(false),
  position:      integer("position"),               // 1-indexed mention position; null if not mentioned
  sentiment:     text("sentiment"),                 // "positive" | "neutral" | "negative" | null
  competitorsMentioned: jsonb("competitors_mentioned").$type<string[]>().default([]),
  error:         text("error"),                     // error message if call failed
  createdAt:     timestamp("created_at").defaultNow(),
}, (table) => ({
  checkIdIdx: index("citation_responses_check_id_idx").on(table.checkId),
  siteIdIdx:  index("citation_responses_site_id_idx").on(table.siteId),
}));

export type CitationCheckResponse = typeof citationCheckResponses.$inferSelect;
export type NewCitationCheckResponse = typeof citationCheckResponses.$inferInsert;

// One row per check run — aggregated scores
export const citationCheckScores = pgTable("citation_check_scores", {
  checkId:            text("check_id").primaryKey(), // same checkId as responses
  siteId:             text("site_id").notNull().references(() => geoSites.id, { onDelete: "cascade" }),
  teamId:             text("team_id").notNull(),
  domain:             text("domain").notNull(),
  overallVisibility:  integer("overall_visibility").notNull(),  // 0-100
  bestProvider:       text("best_provider"),
  worstProvider:      text("worst_provider"),
  avgPosition:        integer("avg_position"),                  // null if never mentioned
  sentimentScore:     integer("sentiment_score").notNull(),     // -100 to 100
  providerResults:    jsonb("provider_results").$type<ProviderResult[]>().notNull(),
  competitorVisibility: jsonb("competitor_visibility").$type<Record<string, number>>().default({}),
  creditsUsed:        integer("credits_used").notNull().default(5),
  promptsUsed:        jsonb("prompts_used").$type<string[]>().notNull(),
  createdAt:          timestamp("created_at").defaultNow(),
}, (table) => ({
  siteIdIdx: index("citation_scores_site_id_idx").on(table.siteId),
  teamIdIdx: index("citation_scores_team_id_idx").on(table.teamId),
}));

export type CitationCheckScore = typeof citationCheckScores.$inferSelect;
export type NewCitationCheckScore = typeof citationCheckScores.$inferInsert;
```

Add the `ProviderResult` interface to `lib/types/citation.ts` (new file — see §4).

---

### 2. DB Migration — `lib/db/migrations/20260302-citation-checks.sql`

```sql
-- Migration: Add citation monitoring tables (TS-015 / Issue #104)
-- Run: npx drizzle-kit push

CREATE TABLE IF NOT EXISTS citation_check_responses (
  id                    TEXT PRIMARY KEY,
  check_id              TEXT NOT NULL,
  site_id               TEXT NOT NULL REFERENCES geo_sites(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  query                 TEXT NOT NULL,
  response              TEXT,
  response_time_ms      INTEGER,
  mentioned             BOOLEAN NOT NULL DEFAULT FALSE,
  position              INTEGER,
  sentiment             TEXT,
  competitors_mentioned JSONB DEFAULT '[]',
  error                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS citation_responses_check_id_idx ON citation_check_responses(check_id);
CREATE INDEX IF NOT EXISTS citation_responses_site_id_idx ON citation_check_responses(site_id);

CREATE TABLE IF NOT EXISTS citation_check_scores (
  check_id              TEXT PRIMARY KEY,
  site_id               TEXT NOT NULL REFERENCES geo_sites(id) ON DELETE CASCADE,
  team_id               TEXT NOT NULL,
  domain                TEXT NOT NULL,
  overall_visibility    INTEGER NOT NULL,
  best_provider         TEXT,
  worst_provider        TEXT,
  avg_position          INTEGER,
  sentiment_score       INTEGER NOT NULL,
  provider_results      JSONB NOT NULL,
  competitor_visibility JSONB DEFAULT '{}',
  credits_used          INTEGER NOT NULL DEFAULT 5,
  prompts_used          JSONB NOT NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS citation_scores_site_id_idx ON citation_check_scores(site_id);
CREATE INDEX IF NOT EXISTS citation_scores_team_id_idx ON citation_check_scores(team_id);
```

---

### 3. Types — `lib/types/citation.ts` (new file)

```typescript
export interface ProviderResult {
  provider:        string;
  model:           string;
  visibilityScore: number;   // 0-100: % of queries where brand mentioned
  avgPosition:     number | null;
  sentiment:       "positive" | "neutral" | "negative";
  mentionCount:    number;
  totalQueries:    number;
}

export interface CitationCheckResult {
  checkId:             string;
  scores:              {
    overallVisibility:    number;
    bestProvider:         string | null;
    worstProvider:        string | null;
    avgPosition:          number | null;
    sentimentScore:       number;
    competitorVisibility: Record<string, number>;
  };
  providerResults:     ProviderResult[];
  promptsUsed:         string[];
  creditsUsed:         number;
}

export type SSEEvent =
  | { type: "start";            data: { message: string } }
  | { type: "stage";            data: { stage: string; progress: number; message: string } }
  | { type: "prompt-generated"; data: { prompt: string; index: number; total: number } }
  | { type: "analysis-start";   data: { provider: string; prompt: string; promptIndex: number; totalPrompts: number } }
  | { type: "partial-result";   data: { provider: string; prompt: string; mentioned: boolean; position: number | null; sentiment: string | null } }
  | { type: "analysis-complete";data: { provider: string; prompt: string; status: "completed" | "failed" } }
  | { type: "progress";         data: { stage: string; progress: number; message: string } }
  | { type: "complete";         data: CitationCheckResult }
  | { type: "error";            data: { message: string } };
```

---

### 4. Prompt Generator — `lib/services/citation-prompt-generator.ts` (new file)

**Approach:** Use existing site crawl and analysis data (already in DB) — no external
Perplexity domain crawl needed. Flowblinq already has richer context than
intelligence-gatherer.ts fetches externally.

```typescript
import { type GeoSites } from "@/lib/db/schema";

const GEO_SERVICE_TEMPLATES = [
  "Best GEO optimization tools in {year}?",
  "What is {domain} and is it worth using?",
  "Top alternatives to {domain} for AI SEO?",
  "{domain} vs competitors — which GEO audit tool is better?",
  "Recommended tools for optimizing content for AI citations?",
  "What do experts recommend for generative engine optimization?",
  "Best tools to check if your brand appears in ChatGPT or Perplexity answers?",
  "How to improve AI visibility for a SaaS brand?",
];

export function generateCitationPrompts(
  site: Pick<GeoSites, "domain" | "geoScorecard" | "analysisData">,
  count: number = 4
): string[] {
  const domain = site.domain;
  const year = new Date().getFullYear().toString();

  // Use up to `count` templates, substituting domain and year
  return GEO_SERVICE_TEMPLATES
    .slice(0, count)
    .map((t) => t.replace("{domain}", domain).replace("{year}", year));
}
```

**Why simpler than intelligence-gatherer.ts:** That module makes a Perplexity API
call to discover brand context. We already have brand context from the GEO audit.
This approach saves one API call and avoids bootstrapping before the first audit.

---

### 5. Citation Checker Service — `lib/services/citation-checker.ts` (new file)

Core multi-LLM dispatcher. Pattern from `sov-checker.ts` + `llm-clients/index.ts`.

```typescript
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { nanoid } from "nanoid";
import { type ProviderResult, type CitationCheckResult } from "@/lib/types/citation";

// ── Models (cost-optimized — 16 calls per check) ──────────────────────────
const MODELS = {
  openai:     "gpt-4o-mini",
  anthropic:  "claude-haiku-4-5-20251001",
  perplexity: "sonar",
  google:     "gemini-2.5-flash-lite",
} as const;

const TIMEOUT_MS = 30_000;
const BATCH_SIZE = 3;         // parallel (prompt × provider) pairs per batch
const BATCH_DELAY_MS = 500;   // between batches to respect rate limits

// ── Mention detection (from sov-checker.ts parseMentions pattern) ─────────
function detectMention(
  responseText: string,
  domain: string
): { mentioned: boolean; position: number | null; sentiment: "positive" | "neutral" | "negative" } {
  const domainName = domain.replace(/\.(com|io|co|net|org).*$/, "");
  const regex = new RegExp(domainName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const match = regex.exec(responseText);

  if (!match) return { mentioned: false, position: null, sentiment: "neutral" };

  // Sentiment heuristics (context window ±100 chars around mention)
  const ctx = responseText.slice(Math.max(0, match.index - 100), match.index + domainName.length + 100).toLowerCase();
  const positive = ["recommend", "best", "excellent", "top", "great", "leading", "trusted"].some(w => ctx.includes(w));
  const negative = ["avoid", "poor", "expensive", "unreliable", "worse", "slow"].some(w => ctx.includes(w));
  const sentiment = positive ? "positive" : negative ? "negative" : "neutral";

  // Position = ordinal of brand mention among all entity mentions in response
  // Simple heuristic: count newlines/sentences before mention → proxy for rank
  const before = responseText.slice(0, match.index);
  const position = (before.match(/\n\d+\.|^\d+\./gm) ?? []).length + 1;

  return { mentioned: true, position, sentiment };
}

function extractCompetitors(responseText: string, domain: string): string[] {
  // Match URLs and capitalized proper nouns near the brand mention
  const urlMatches = [...responseText.matchAll(/https?:\/\/([a-z0-9-]+\.[a-z]{2,})/gi)]
    .map(m => m[1])
    .filter(u => !u.includes(domain));
  return [...new Set(urlMatches)].slice(0, 5);
}

// ── Per-provider query functions ──────────────────────────────────────────

async function queryOpenAI(prompt: string): Promise<{ text: string; responseTimeMs: number }> {
  const start = Date.now();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await Promise.race([
    client.chat.completions.create({
      model: MODELS.openai,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
  ]);
  return { text: (res as Awaited<ReturnType<typeof client.chat.completions.create>>).choices[0]?.message?.content ?? "", responseTimeMs: Date.now() - start };
}

async function queryAnthropic(prompt: string): Promise<{ text: string; responseTimeMs: number }> {
  const start = Date.now();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await Promise.race([
    client.messages.create({
      model: MODELS.anthropic,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
  ]);
  const msg = res as Awaited<ReturnType<typeof client.messages.create>>;
  const text = msg.content.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("");
  return { text, responseTimeMs: Date.now() - start };
}

async function queryPerplexity(prompt: string): Promise<{ text: string; responseTimeMs: number }> {
  const start = Date.now();
  const client = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY,
    baseURL: "https://api.perplexity.ai",
  });
  const res = await Promise.race([
    client.chat.completions.create({
      model: MODELS.perplexity,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
  ]);
  return { text: (res as Awaited<ReturnType<typeof client.chat.completions.create>>).choices[0]?.message?.content ?? "", responseTimeMs: Date.now() - start };
}

async function queryGoogle(prompt: string): Promise<{ text: string; responseTimeMs: number }> {
  const start = Date.now();
  const client = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "");
  const model = client.getGenerativeModel({ model: MODELS.google });
  const res = await Promise.race([
    model.generateContent(prompt),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
  ]);
  const text = (res as Awaited<ReturnType<typeof model.generateContent>>).response.text();
  return { text, responseTimeMs: Date.now() - start };
}

// ── Configured providers (skip if no API key) ─────────────────────────────

function getConfiguredProviders(): Array<{
  name: "openai" | "anthropic" | "perplexity" | "google";
  model: string;
  fn: (prompt: string) => Promise<{ text: string; responseTimeMs: number }>;
}> {
  const providers = [];
  if (process.env.PERPLEXITY_API_KEY) providers.push({ name: "perplexity" as const, model: MODELS.perplexity, fn: queryPerplexity });
  if (process.env.OPENAI_API_KEY)     providers.push({ name: "openai" as const,     model: MODELS.openai,     fn: queryOpenAI });
  if (process.env.ANTHROPIC_API_KEY)  providers.push({ name: "anthropic" as const,  model: MODELS.anthropic,  fn: queryAnthropic });
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) providers.push({ name: "google" as const, model: MODELS.google, fn: queryGoogle });
  return providers;
}

// ── Main export ───────────────────────────────────────────────────────────

export interface CitationCheckerCallbacks {
  onAnalysisStart:    (provider: string, prompt: string, promptIndex: number, totalPrompts: number) => void;
  onPartialResult:    (provider: string, prompt: string, mentioned: boolean, position: number | null, sentiment: string | null) => void;
  onAnalysisComplete: (provider: string, prompt: string, status: "completed" | "failed") => void;
}

export async function runCitationCheck(
  checkId: string,
  siteId: string,
  domain: string,
  prompts: string[],
  callbacks: CitationCheckerCallbacks
): Promise<{
  responses: Array<{
    id: string; checkId: string; siteId: string;
    provider: string; model: string; query: string;
    response: string | null; responseTimeMs: number | null;
    mentioned: boolean; position: number | null;
    sentiment: string | null; competitorsMentioned: string[];
    error: string | null;
  }>;
  providerResults: ProviderResult[];
  overallVisibility: number;
  sentimentScore: number;
  avgPosition: number | null;
  bestProvider: string | null;
  worstProvider: string | null;
  competitorVisibility: Record<string, number>;
}> {
  const providers = getConfiguredProviders();
  if (providers.length === 0) throw new Error("no_providers_configured");

  // Build all (prompt, provider) pairs
  type Task = { prompt: string; promptIndex: number; provider: typeof providers[number] };
  const tasks: Task[] = prompts.flatMap((prompt, promptIndex) =>
    providers.map(provider => ({ prompt, promptIndex, provider }))
  );

  const rawResponses: typeof runCitationCheck extends (...args: any[]) => Promise<infer R> ? never : never = [] as any;
  const allResponses: Array<{
    id: string; checkId: string; siteId: string;
    provider: string; model: string; query: string;
    response: string | null; responseTimeMs: number | null;
    mentioned: boolean; position: number | null;
    sentiment: string | null; competitorsMentioned: string[];
    error: string | null;
  }> = [];

  // Execute in batches of BATCH_SIZE
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async ({ prompt, promptIndex, provider }) => {
        callbacks.onAnalysisStart(provider.name, prompt, promptIndex, prompts.length);
        try {
          const { text, responseTimeMs } = await provider.fn(prompt);
          const { mentioned, position, sentiment } = detectMention(text, domain);
          const competitorsMentioned = extractCompetitors(text, domain);
          callbacks.onPartialResult(provider.name, prompt, mentioned, position, sentiment);
          callbacks.onAnalysisComplete(provider.name, prompt, "completed");
          return {
            id: nanoid(), checkId, siteId,
            provider: provider.name, model: provider.model, query: prompt,
            response: text, responseTimeMs,
            mentioned, position, sentiment, competitorsMentioned, error: null,
          };
        } catch (err) {
          const error = err instanceof Error ? err.message : "unknown_error";
          callbacks.onAnalysisComplete(provider.name, prompt, "failed");
          return {
            id: nanoid(), checkId, siteId,
            provider: provider.name, model: provider.model, query: prompt,
            response: null, responseTimeMs: null,
            mentioned: false, position: null, sentiment: null, competitorsMentioned: [], error,
          };
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") allResponses.push(r.value);
    }

    if (i + BATCH_SIZE < tasks.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  // ── Aggregate scores ──────────────────────────────────────────────────
  const providerResults: ProviderResult[] = providers.map(p => {
    const pResponses = allResponses.filter(r => r.provider === p.name);
    const mentioned  = pResponses.filter(r => r.mentioned);
    const visibilityScore = Math.round((mentioned.length / Math.max(pResponses.length, 1)) * 100);
    const positions  = mentioned.map(r => r.position).filter((x): x is number => x !== null);
    const avgPos     = positions.length ? Math.round(positions.reduce((a, b) => a + b, 0) / positions.length) : null;
    const sentiments = pResponses.map(r => r.sentiment).filter(Boolean);
    const posCount   = sentiments.filter(s => s === "positive").length;
    const negCount   = sentiments.filter(s => s === "negative").length;
    const sentiment  = posCount > negCount ? "positive" : negCount > posCount ? "negative" : "neutral";
    return { provider: p.name, model: p.model, visibilityScore, avgPosition: avgPos, sentiment, mentionCount: mentioned.length, totalQueries: pResponses.length };
  });

  const totalMentioned = allResponses.filter(r => r.mentioned).length;
  const overallVisibility = Math.round((totalMentioned / Math.max(allResponses.length, 1)) * 100);

  const sorted = [...providerResults].sort((a, b) => b.visibilityScore - a.visibilityScore);
  const bestProvider  = sorted[0]?.provider ?? null;
  const worstProvider = sorted[sorted.length - 1]?.provider ?? null;

  const allPositions = allResponses.filter(r => r.mentioned && r.position !== null).map(r => r.position as number);
  const avgPosition  = allPositions.length ? Math.round(allPositions.reduce((a, b) => a + b, 0) / allPositions.length) : null;

  // Sentiment score: -100 to 100
  const allSentiments = allResponses.map(r => r.sentiment);
  const posTotal = allSentiments.filter(s => s === "positive").length;
  const negTotal = allSentiments.filter(s => s === "negative").length;
  const sentimentScore = allSentiments.length ? Math.round(((posTotal - negTotal) / allSentiments.length) * 100) : 0;

  // Competitor visibility: how often each competitor was mentioned
  const compMap: Record<string, number> = {};
  for (const r of allResponses) {
    for (const comp of r.competitorsMentioned) {
      compMap[comp] = (compMap[comp] ?? 0) + 1;
    }
  }
  const competitorVisibility: Record<string, number> = {};
  for (const [comp, count] of Object.entries(compMap)) {
    competitorVisibility[comp] = Math.round((count / Math.max(allResponses.length, 1)) * 100);
  }

  return { responses: allResponses, providerResults, overallVisibility, sentimentScore, avgPosition, bestProvider, worstProvider, competitorVisibility };
}
```

---

### 6. API Endpoint — `app/api/sites/[id]/citation-check/route.ts` (new file)

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teams, creditTransactions, citationCheckResponses, citationCheckScores } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { generateCitationPrompts } from "@/lib/services/citation-prompt-generator";
import { runCitationCheck } from "@/lib/services/citation-checker";
import { type SSEEvent } from "@/lib/types/citation";

export const runtime = "nodejs";
export const maxDuration = 120;   // 16 LLM calls × 30s timeout max, batched at 3

const CITATION_CHECK_COST = 5;   // credits per check

function sseMessage(event: SSEEvent): string {
  return `data: ${JSON.stringify({ type: event.type, ...event.data })}\n\n`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id: siteId } = params;

  // ── Auth: accessToken (Bearer header or ?token= query param) ──────────
  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
  if (site.accessToken !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ── Team / credit gate ────────────────────────────────────────────────
  if (!site.teamId) return NextResponse.json({ error: "Citation check requires a Pro account." }, { status: 402 });
  const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
  if (!team || team.creditBalance < CITATION_CHECK_COST) {
    return NextResponse.json(
      { error: `Insufficient credits. Citation check costs ${CITATION_CHECK_COST} credits. You have ${team?.creditBalance ?? 0}.` },
      { status: 402 }
    );
  }

  // ── Provider availability check ───────────────────────────────────────
  const hasAnyProvider = !!(process.env.PERPLEXITY_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  if (!hasAnyProvider) return NextResponse.json({ error: "No AI providers configured." }, { status: 422 });

  // ── Deduct credits upfront ────────────────────────────────────────────
  await db.update(teams).set({ creditBalance: sql`${teams.creditBalance} - ${CITATION_CHECK_COST}` }).where(eq(teams.id, site.teamId));
  await db.insert(creditTransactions).values({
    id: nanoid(), teamId: site.teamId,
    amount: -CITATION_CHECK_COST, type: "citation_check_debit",
    description: `AI citation check for ${site.domain}`,
  });

  // ── SSE stream setup ──────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const checkId = nanoid();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: SSEEvent) => controller.enqueue(encoder.encode(sseMessage(event)));

      try {
        send({ type: "start", data: { message: `Starting citation check for ${site.domain}` } });
        send({ type: "stage", data: { stage: "prompts", progress: 5, message: "Generating domain-aware prompts" } });

        // ── Generate prompts ──────────────────────────────────────────
        const prompts = generateCitationPrompts(site as Parameters<typeof generateCitationPrompts>[0]);
        prompts.forEach((prompt, i) =>
          send({ type: "prompt-generated", data: { prompt, index: i + 1, total: prompts.length } })
        );

        send({ type: "stage", data: { stage: "querying", progress: 15, message: "Querying AI providers" } });

        // ── Run citation check ────────────────────────────────────────
        const result = await runCitationCheck(checkId, siteId, site.domain, prompts, {
          onAnalysisStart: (provider, prompt, promptIndex, totalPrompts) =>
            send({ type: "analysis-start", data: { provider, prompt, promptIndex, totalPrompts } }),
          onPartialResult: (provider, prompt, mentioned, position, sentiment) =>
            send({ type: "partial-result", data: { provider, prompt, mentioned, position, sentiment } }),
          onAnalysisComplete: (provider, prompt, status) =>
            send({ type: "analysis-complete", data: { provider, prompt, status } }),
        });

        send({ type: "stage", data: { stage: "persisting", progress: 90, message: "Saving results" } });

        // ── Persist responses ─────────────────────────────────────────
        if (result.responses.length > 0) {
          await db.insert(citationCheckResponses).values(result.responses);
        }

        // ── Persist scores ────────────────────────────────────────────
        await db.insert(citationCheckScores).values({
          checkId, siteId, domain: site.domain,
          teamId: site.teamId!,
          overallVisibility: result.overallVisibility,
          bestProvider: result.bestProvider,
          worstProvider: result.worstProvider,
          avgPosition: result.avgPosition,
          sentimentScore: result.sentimentScore,
          providerResults: result.providerResults,
          competitorVisibility: result.competitorVisibility,
          creditsUsed: CITATION_CHECK_COST,
          promptsUsed: prompts,
        });

        send({
          type: "complete",
          data: {
            checkId,
            scores: {
              overallVisibility:    result.overallVisibility,
              bestProvider:         result.bestProvider,
              worstProvider:        result.worstProvider,
              avgPosition:          result.avgPosition,
              sentimentScore:       result.sentimentScore,
              competitorVisibility: result.competitorVisibility,
            },
            providerResults:  result.providerResults,
            promptsUsed:      prompts,
            creditsUsed:      CITATION_CHECK_COST,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ type: "error", data: { message } });
        console.error("[citation-check] Error:", err);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
```

---

### 7. Frontend Component — `app/components/citation-monitor.tsx` (new file)

Client component. Manages SSE connection and result display.

**State shape:**
```typescript
type Status = "idle" | "running" | "complete" | "error";
interface State {
  status:          Status;
  progress:        number;
  message:         string;
  prompts:         string[];
  providerProgress: Record<string, { done: number; total: number; mentioned: number }>;
  result:          CitationCheckResult | null;
  error:           string | null;
}
```

**Key behaviors:**
- On "Run Check" click: `POST /api/sites/{siteId}/citation-check?token={accessToken}`
- Parse SSE events via `EventSource` or manual `ReadableStream` reader (use `fetch` + `response.body.getReader()` since POST with body is not supported by `EventSource`)
- Update `providerProgress` on each `analysis-complete` event
- On `complete` event: render results sections
- On `error` event: show error message; do NOT re-run automatically

**Props:**
```typescript
interface CitationMonitorProps {
  siteId:      string;
  accessToken: string;
  domain:      string;
  lastCheck:   CitationCheckScore | null;  // pre-loaded from page.tsx server component
}
```

**Sections to render (after `complete`):**
1. **Overall Visibility Score** — large `{overallVisibility}%` with label
2. **Provider Matrix** — table: provider | mentioned/total | avg position | sentiment
3. **Prompts Used** — expandable list showing each prompt and which providers mentioned brand
4. **Competitor Cross-Reference** — top 5 competitors by visibility %

**Loading state:** Per-provider progress bars (increment on each `analysis-complete` event).

---

### 8. Page Integration — `app/sites/[id]/page.tsx`

Two additions to the existing server component:

**a) Load last citation check (server-side):**
```typescript
import { citationCheckScores } from "@/lib/db/schema";
// After existing DB queries:
const [lastCitationCheck] = await db
  .select()
  .from(citationCheckScores)
  .where(eq(citationCheckScores.siteId, site.id))
  .orderBy(desc(citationCheckScores.createdAt))
  .limit(1);
```

**b) Render AI Visibility tab** (only when `pipelineStatus === "complete"` and `tier === "paid"`):
```typescript
import { CitationMonitor } from "@/app/components/citation-monitor";
// In JSX:
{pipelineStatus === "complete" && tier === "paid" && (
  <CitationMonitor
    siteId={site.id}
    accessToken={site.accessToken}
    domain={site.domain}
    lastCheck={lastCitationCheck ?? null}
  />
)}
```

---

### 9. Environment Variables — `.env.example` additions

```bash
# AI Citation Monitoring (TS-015 / Issue #104)
# Priority: Perplexity > OpenAI > Anthropic > Google
PERPLEXITY_API_KEY=           # sonar model — real-time web search; highest priority
OPENAI_API_KEY=               # gpt-4o-mini — largest user base
ANTHROPIC_API_KEY=            # claude-haiku-4-5-20251001 — already may exist
GOOGLE_GENERATIVE_AI_API_KEY= # gemini-2.5-flash-lite — optional; lower priority
```

Coordinate with Adithya Rao for API key provisioning before ScriptDev implements.

---

### 10. Package dependencies

Check `geo/package.json` for existing SDKs:
- `@anthropic-ai/sdk` — may already exist (check)
- `openai` — may already exist (Perplexity uses OpenAI SDK with custom baseURL)
- `@google/generative-ai` — likely not present; add if Google provider is needed

Run `npm install @google/generative-ai` if Google is in scope.

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/citation-checker.test.ts` (new)

| Test ID | Scenario | Mock | Assertion |
|---------|----------|------|-----------|
| CC-1 | Domain mentioned → `mentioned: true` | Mock provider returns text with domain | `detectMention` returns `mentioned: true`, non-null `position` |
| CC-2 | Domain not mentioned → `mentioned: false` | Mock returns unrelated text | `detectMention` returns `mentioned: false`, `position: null` |
| CC-3 | Positive sentiment detection | Mock returns "best tool, highly recommended..." | `sentiment: "positive"` |
| CC-4 | Negative sentiment detection | Mock returns "avoid, poor experience..." | `sentiment: "negative"` |
| CC-5 | Provider timeout → marked failed, others continue | Mock one provider to reject after timeout | Failed provider has `error` set; other providers complete normally |
| CC-6 | No providers configured → throws `no_providers_configured` | Unset all env vars | `runCitationCheck` rejects with correct error message |
| CC-7 | Overall visibility calculation | 2 of 4 responses have `mentioned: true` | `overallVisibility === 50` |
| CC-8 | Batch delay respected | Mock `setTimeout` | 500ms delay called between batches |
| CC-9 | Prompt generation | Pass mock site with domain "flowblinq.com" | Returns 4 prompts, each containing "flowblinq" |
| CC-10 | Competitor extraction | Response mentions "competitor.com" alongside brand | `competitorsMentioned` includes "competitor.com" |

**Mock pattern:**
```typescript
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "mock response" } }] }) } }
  }))
}));
```

---

## d) Integration Test Plan

**Test file:** `geo/__tests__/integration/citation-flow.test.ts` (new)

| Test | Setup | Assertion |
|------|-------|-----------|
| SSE endpoint returns 401 without token | No Authorization header | 401 response |
| SSE endpoint returns 402 for insufficient credits | `team.creditBalance = 2` | 402 JSON with credit info |
| SSE endpoint returns 402 for non-Pro site | `site.teamId = null` | 402 JSON |
| SSE stream emits correct event sequence | Mock `runCitationCheck` to return fixture result | Events in order: start → stage → prompt-generated × 4 → analysis events → complete |
| Credits deducted on successful check | Mock providers to succeed | `team.creditBalance` decremented by 5; `creditTransactions` row created |
| `citationCheckScores` row persisted | Same | Row exists in DB with correct `siteId`, `overallVisibility` |

---

## e) Profiling Requirements

- **Per-provider call time:** Logged via `responseTimeMs` field in each response row
- **Total check duration:** `Date.now()` delta from stream start to `complete` event
- **Baseline expectation:** Full check (4 prompts × 3 providers = 12 calls, BATCH_SIZE=3) < 60s
- **Log line:** `[citation-check] ${domain}: ${allResponses.length} calls, ${totalMentioned} mentions, ${Date.now() - start}ms`

---

## f) Load Test Plan

Not applicable for v1. Each citation check is user-triggered (5 credit gate limits frequency).
If bulk/scheduled checks are added in v2, load test at that point.

---

## g) Logging & Instrumentation

| Event | Level | Format |
|-------|-------|--------|
| Check started | `info` | `[citation-check] ${domain} checkId=${checkId} providers=${providers.length}` |
| Provider complete | `info` | `[citation-check] ${provider}: ${mentioned}/${total} mentioned in ${ms}ms` |
| Provider failed | `warn` | `[citation-check] ${provider} FAILED: ${error}` |
| Credits deducted | `info` | `[citation-check] 5 credits deducted from teamId=${teamId}` |
| Check complete | `info` | `[citation-check] ${domain} done: visibility=${overallVisibility}% in ${ms}ms` |
| No providers | `error` | `[citation-check] No providers configured — check env vars` |

---

## h) Acceptance Criteria

- [ ] `citationCheckResponses` and `citationCheckScores` tables created (migration applied)
- [ ] `POST /api/sites/[id]/citation-check` returns SSE stream with correct event types
- [ ] 401 without valid token; 402 with < 5 credits or no teamId; 422 with no providers
- [ ] Credits deducted before queries; `creditTransactions` row created
- [ ] At minimum Perplexity + OpenAI queried (when keys present); providers are skipped gracefully if key absent
- [ ] 1 provider failure does not abort check — others complete
- [ ] Results persisted to both tables after completion
- [ ] "AI Visibility" tab renders on site results page for `tier === "paid"` + `pipelineStatus === "complete"`
- [ ] Last citation check pre-loaded from DB on page load
- [ ] SSE events appear in real-time (not buffered until end)
- [ ] CC-1 through CC-10 unit tests pass
- [ ] Integration tests pass
- [ ] `maxDuration = 120` set on endpoint
- [ ] `.env.example` updated with all 4 provider keys

---

## ScriptDev Notes

- **Read reference implementations first:** `sov-checker.ts` (mention detection) and `llm-clients/index.ts` (per-provider pattern) are the most directly reusable.
- **API key gate:** Check which keys Adithya Rao has provisioned before running. If none are available, the 422 path handles it — implementation can proceed without keys.
- **Perplexity uses OpenAI SDK** — just pass `baseURL: "https://api.perplexity.ai"` and the Perplexity API key.
- **No new npm packages needed** for Perplexity or OpenAI — they share the `openai` SDK. Only `@google/generative-ai` is new.
- **SSE with POST:** Use `fetch` + `response.body.getReader()` in the frontend (not `EventSource` which only supports GET).
- **Branch:** `dev-sprint-7`. Open PR against `main` when tests pass.
- **Do not modify** `pipelineStatus`, QStash, or `firecrawlJobs` — citation check is fully independent.
