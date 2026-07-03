/**
 * ES-055: C10 — Engine Preference Analysis
 * Analyzes accumulated citation check responses to extract per-engine rules.
 * Uses Claude Sonnet. Non-blocking, non-critical.
 */

import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { citationCheckScores, citationCheckResponses, geoSites } from "@/lib/db/schema";
import { count, eq } from "drizzle-orm";
import type { EnginePreference, EngineRule } from "@/lib/types/content-strategy";

const SONNET_TIMEOUT_MS = 30_000;
const MAX_RULES_PER_PROVIDER = 5;

// Checkpoint logic: 3rd, 5th, 10th, every 10th thereafter
function isCheckpoint(checkCount: number): boolean {
  if (checkCount < 3) return false;
  if (checkCount === 3 || checkCount === 5) return true;
  if (checkCount % 10 === 0) return true;
  return false;
}

type ResponseStructure = "list" | "paragraph" | "mixed";

function detectResponseStructure(response: string): ResponseStructure {
  const lines = response.split("\n");
  // FIX-7: require letter after number+punct to exclude phone numbers/addresses
  const listLines = lines.filter(l => /^\d+[.)]\s+[A-Za-z]/.test(l) || /^[-*]\s/.test(l));
  const hasLists = listLines.length >= 2;
  const hasParagraphs = lines.some(l => l.trim().length > 50 && !/^\d+[.)]\s+[A-Za-z]/.test(l) && !/^[-*]\s/.test(l));
  if (hasLists && hasParagraphs) return "mixed";
  if (hasLists) return "list";
  return "paragraph";
}

/**
 * Analyze accumulated citation check responses to extract per-engine preference rules.
 * Returns null if < 3 checks, not a checkpoint, or on failure.
 */
export async function analyzeEnginePreferences(
  domain: string,
  siteId: string
): Promise<EnginePreference[] | null> {
  try {
    // 1. Count existing checks for this site (FIX-1: use count() not column id)
    const countResult = await db.select({ count: count() })
      .from(citationCheckScores)
      .where(eq(citationCheckScores.siteId, siteId));

    const checkCount = countResult[0]?.count ?? 0;

    if (!isCheckpoint(checkCount)) {
      console.debug(`[engine-prefs] ${domain}: skipped (count=${checkCount}, not a checkpoint)`);
      return null;
    }

    // FIX-5: Dedup guard — skip if enginePreferences was updated within the last 60s
    // No .limit() so the mock chain works (siteId is unique, returns ≤1 row)
    const siteRows = await db.select({ enginePreferences: geoSites.enginePreferences })
      .from(geoSites)
      .where(eq(geoSites.id, siteId));
    const [siteRow] = siteRows;
    if (siteRow?.enginePreferences) {
      const lastAnalyzed = (siteRow.enginePreferences as EnginePreference[])[0]?.analyzedAt;
      if (lastAnalyzed && Date.now() - new Date(lastAnalyzed).getTime() < 60_000) {
        console.debug(`[engine-prefs] ${domain}: skipped (recently analyzed)`);
        return null;
      }
    }

    console.info(`[engine-prefs] ${domain}: triggered at checkCount=${checkCount}`);

    // 2. Fetch accumulated responses
    const responses = await db.select()
      .from(citationCheckResponses)
      .where(eq(citationCheckResponses.siteId, siteId));

    // 3. Build analysis payload grouped by provider
    type EngineInput = {
      provider: string;
      prompt: string;
      mentioned: boolean;
      position: number | null;
      responseStructure: ResponseStructure;
      sentiment: string | null;
    };

    const byProvider = new Map<string, EngineInput[]>();
    for (const r of responses) {
      const structure = detectResponseStructure(r.response ?? "");
      const entry: EngineInput = {
        provider: r.provider,
        prompt: r.query,
        mentioned: r.mentioned,
        position: r.position,
        responseStructure: structure,
        sentiment: r.sentiment,
      };
      const existing = byProvider.get(r.provider) ?? [];
      existing.push(entry);
      byProvider.set(r.provider, existing);
    }

    // 4. Call Claude Sonnet
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn(`[engine-prefs] ${domain}: no ANTHROPIC_API_KEY`);
      return null;
    }

    const client = new Anthropic();

    const userPrompt = JSON.stringify(
      Object.fromEntries([...byProvider.entries()].map(([provider, inputs]) => [provider, inputs])),
      null, 2
    );

    const response = await Promise.race([
      client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        temperature: 0,
        system: `You are an AI citation pattern analyst. Given citation check results across multiple runs for a single domain, identify patterns in which AI providers mention this brand and when.

Extract 3-5 actionable rules per provider. Focus on:
- What content characteristics correlate with being mentioned
- What response format correlates with higher/lower positioning
- Provider-specific quirks (one provider consistently ranks the brand higher than others)

Confidence thresholds:
- "high": pattern appears in ≥70% of relevant responses
- "medium": 50-69%
- "low": 30-49%

Return JSON array. No prose.`,
        messages: [{ role: "user", content: userPrompt }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Sonnet timeout after ${SONNET_TIMEOUT_MS}ms`)), SONNET_TIMEOUT_MS)
      ),
    ]);

    // 5. Parse and cap rules
    const text = response.content[0].type === "text" ? response.content[0].text : "";
    let parsed: EnginePreference[];
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn(`[engine-prefs] ${domain}: invalid JSON from Sonnet`);
      return null;
    }

    if (!Array.isArray(parsed)) return null;

    // FIX-3: Validate each element structure before storing
    const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
    const now = new Date().toISOString();
    const result: EnginePreference[] = parsed
      .filter(p => typeof p.provider === "string" && p.provider.length > 0 && Array.isArray(p.rules))
      .map(p => ({
        provider: p.provider as string,
        rules: ((p.rules as unknown[]).filter((r): r is EngineRule =>
          r !== null && typeof r === "object" &&
          typeof (r as EngineRule).rule === "string" &&
          VALID_CONFIDENCE.has((r as EngineRule).confidence) &&
          typeof (r as EngineRule).evidence === "string"
        ) as EngineRule[]).slice(0, MAX_RULES_PER_PROVIDER),
        analyzedAt: typeof p.analyzedAt === "string" ? p.analyzedAt : now,
        checkCount: typeof p.checkCount === "number" ? p.checkCount : checkCount,
      }));

    if (result.length === 0) {
      console.warn(`[engine-prefs] ${domain}: all elements invalid after validation`);
      return null;
    }

    console.info(`[engine-prefs.complete] ${domain}: ${result.length} providers analyzed`);
    return result;

  } catch (err) {
    console.warn(`[engine-prefs.failed] ${domain}:`, err);
    return null;
  }
}
