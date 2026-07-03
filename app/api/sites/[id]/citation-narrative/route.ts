import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
// sync to geo_site_view handled by Postgres trigger
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGoogleGenAIKey } from "@/lib/google-genai-key";

export const runtime = "nodejs";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface NarrativeInput {
  overallScore:         number;
  indirectVisibility:   number;
  brandKnowledge:       number;
  citationQualityScore: number;
  bestProvider:         string | null;
  worstProvider:        string | null;
  pillarVisibility:     Record<string, number>;
  previousScore?:       number | null;
}

const PILLAR_LABELS: Record<string, string> = {
  author_authority:        "Authority",
  competitive_positioning: "Positioning",
  offering_clarity:        "Clarity",
  faq_coverage:            "FAQ Coverage",
  evidence_statistics:     "Evidence",
  contact_trust:           "Trust",
  content_freshness:       "Freshness",
  structured_data:         "Structured Data",
  entity_definitions:      "Entities",
  metadata_freshness:      "Metadata",
  semantic_html:           "Semantic HTML",
  multi_format:            "Formats",
  licensing_signals:       "Licensing",
  internal_linking:        "Linking",
  content_structure:       "Structure",
  cta_structure:           "CTA",
};

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI", chatgpt: "ChatGPT", anthropic: "Anthropic",
  claude: "Claude", google: "Google AI", perplexity: "Perplexity", gemini: "Gemini",
};

function buildPrompt(
  brandName: string,
  domain: string,
  siteType: string | null,
  input: NarrativeInput,
): { system: string; user: string } {
  const { overallScore, indirectVisibility, brandKnowledge, citationQualityScore, bestProvider, worstProvider, pillarVisibility, previousScore } = input;

  const sortedPillars = Object.entries(pillarVisibility).sort((a, b) => a[1] - b[1]);
  const weakest   = sortedPillars.slice(0, 3).map(([k]) => PILLAR_LABELS[k] ?? k).join(", ");
  const zeroCount = sortedPillars.filter(([, v]) => v === 0).length;

  const bestProviderName  = bestProvider  ? (PROVIDER_NAMES[bestProvider]  ?? bestProvider)  : null;
  const worstProviderName = worstProvider ? (PROVIDER_NAMES[worstProvider] ?? worstProvider) : null;

  const delta     = previousScore != null ? overallScore - previousScore : null;
  const deltaSign = delta !== null && delta >= 0 ? "+" : "";

  const system = `You are a GEO strategist writing a post-audit headline for a client dashboard.
Write with the precision of a senior consultant — direct, specific, no filler.

Banned phrases: "exciting opportunity", "journey", "leverage", "unlock", "game-changer", "powerful", "untapped potential"
Do not mention GEO, AI visibility tools, or audits.
Write in plain prose only. No bullets, no headers, no markdown.`;

  const user = `Write exactly 2 sentences (max 65 words total) about the audit data below.

Rules:
- Sentence 1: State the single largest numerical gap in the data below. Name the brand. Include at least one specific number from the audit data.
- Sentence 2: State what this gap means for the brand's discoverability in AI-powered search — but do NOT speculate on causes. Do not use "because", "this is due to", "this suggests that", or "likely caused by".
- If Organic Citation and Brand Knowledge are both below 20%, say so directly. Do not frame two low numbers as a "paradox" or "tension" — they are both low.
- Do not invent any details not present in the data below.
- Do not reference any pillars, themes, or scores not listed below.

<audit_data>
Brand: ${brandName} (${domain})
Category: ${siteType ?? "software/SaaS"}
Overall AI Visibility: ${overallScore}%
${delta !== null ? `Change from prior scan: ${deltaSign}${delta} points (prior was ${previousScore}%)` : ""}
Organic Citation (unprompted mentions): ${indirectVisibility}%
Brand Knowledge (direct questions): ${brandKnowledge}%
Citation Quality (accuracy when cited): ${citationQualityScore}%
${bestProviderName ? `Best performing AI engine: ${bestProviderName}` : ""}
${worstProviderName && worstProviderName !== bestProviderName ? `Weakest AI engine: ${worstProviderName}` : ""}
Themes with zero visibility: ${weakest}${zeroCount > 0 ? ` (${zeroCount} of 16 at 0%)` : ""}
</audit_data>`;

  return { system, user };
}

async function generateNarrative(system: string, user: string): Promise<string> {
  const TIMEOUT = 15_000;

  // Anthropic first (best at brand voice)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic();
      const res = await Promise.race([
        client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 150,
          system,
          messages: [{ role: "user", content: user }],
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT)),
      ]);
      const text = res.content.filter(b => b.type === "text").map(b => (b as { type: "text"; text: string }).text).join("").trim();
      if (text) return text;
    } catch { /* fall through */ }
  }

  // OpenAI fallback
  if (process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const res = await Promise.race([
        client.chat.completions.create({
          model: "gpt-5.4-mini",
          max_tokens: 150,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT)),
      ]);
      const text = res.choices[0]?.message?.content?.trim() ?? "";
      if (text) return text;
    } catch { /* fall through */ }
  }

  // Google fallback
  if (process.env.GEMINI_API_KEY) {
    try {
      const genai = new GoogleGenerativeAI(getGoogleGenAIKey());
      const model = genai.getGenerativeModel({ model: "gemini-3.1-flash-lite", systemInstruction: system });  // 2026-06-10 modernization (was gemini-2.5-flash-lite) — narrative gen, cost-optimized lite tier
      const res = await Promise.race([
        model.generateContent(user),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT)),
      ]);
      const text = res.response.text().trim();
      if (text) return text;
    } catch { /* fall through */ }
  }

  throw new Error("no_providers_configured");
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: siteId } = await params;

  // Auth: accessToken
  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (site.accessToken !== token) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json() as NarrativeInput;
  if (typeof body.overallScore !== "number") {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const domain    = site.domain.replace(/^www\./, "");
  const brandName = domain.replace(/\.(com|io|co|net|org|ai|app).*$/, "");
  const { system, user } = buildPrompt(brandName, domain, site.siteType as string | null, body);

  try {
    const narrative = await generateNarrative(system, user);
    await db.update(geoSites).set({ citationNarrative: narrative }).where(eq(geoSites.id, siteId));
    return NextResponse.json({ narrative });
  } catch {
    return NextResponse.json({ error: "Generation failed" }, { status: 503 });
  }
}
