#!/usr/bin/env node
/**
 * test-run.mjs — Minimal cost test of the AI surface experiment
 *
 * Runs 2 healthcare merchants × 2 queries × 3 surfaces = 12 API calls.
 * Pulls Manipal signals from GEO DB (free). Apollo gets site-level only (free).
 * Estimated cost: ~$0.10-0.15
 *
 * Usage: node --env-file=.env.local scripts/experiments/ai-surface-audit/test-run.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { extractSiteLevelSignals } from "./signal-extractor.mjs";
import { detectMerchantMention, extractCitedDomains } from "./surface-probes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

// ── Config: keep it cheap ────────────────────────────────────────────────────

const MERCHANTS = [
  { domain: "manipalhospitals.com", label: "Manipal (live client)", pullFromDb: true },
  { domain: "apollohospitals.com", label: "Apollo (competitor)", pullFromDb: false },
];

const QUERIES = [
  "Best multi-specialty hospitals in India for cardiac surgery",
  "Compare Apollo Hospitals vs Manipal Hospitals vs Fortis Healthcare",
];

// Only use the 3 cheapest surfaces
const SURFACE_CONFIG = [
  { name: "google_ai_overview", label: "Google AI Overviews" },
  { name: "perplexity_shopping", label: "Perplexity" },
  { name: "chatgpt_shopping", label: "ChatGPT" },
];

// ── Cheap surface query functions (no Rufus, no Meta = saves ~40%) ───────────

import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

const SYSTEM = `You are a helpful assistant answering questions about hospitals and healthcare.
Answer in a numbered list of 3-7 items. Name specific hospitals and cities. Be concise.`;

async function queryGoogle(q) {
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");
  const model = client.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM,
    tools: [{ googleSearch: {} }],
  });
  const start = Date.now();
  try {
    const res = await Promise.race([
      model.generateContent(q),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000)),
    ]);
    const text = res.response.text();
    const citations = res.response.candidates?.[0]?.groundingMetadata?.groundingChunks
      ?.map(c => c.web?.uri)?.filter(Boolean) ?? [];
    return { text, citations, ms: Date.now() - start, error: null };
  } catch (e) { return { text: "", citations: [], ms: Date.now() - start, error: e.message }; }
}

async function queryPerplexity(q) {
  const client = new OpenAI({ apiKey: process.env.PERPLEXITY_API_KEY, baseURL: "https://api.perplexity.ai" });
  const start = Date.now();
  try {
    const res = await Promise.race([
      client.chat.completions.create({
        model: "sonar", max_tokens: 256,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: q }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000)),
    ]);
    const text = res.choices[0]?.message?.content ?? "";
    return { text, citations: res.citations ?? [], ms: Date.now() - start, error: null };
  } catch (e) { return { text: "", citations: [], ms: Date.now() - start, error: e.message }; }
}

async function queryChatGPT(q) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const start = Date.now();
  try {
    const res = await Promise.race([
      client.responses.create({
        model: "gpt-5.4-mini", max_output_tokens: 256,
        instructions: SYSTEM,
        tools: [{ type: "web_search", search_context_size: "low" }],
        input: q,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000)),
    ]);
    const text = res.output
      ?.filter(i => i.type === "message")?.flatMap(i => i.content)
      ?.filter(b => b.type === "output_text")?.map(b => b.text)?.join("") ?? "";
    return { text, citations: [], ms: Date.now() - start, error: null };
  } catch (e) { return { text: "", citations: [], ms: Date.now() - start, error: e.message }; }
}

const SURFACES = {
  google_ai_overview: queryGoogle,
  perplexity_shopping: queryPerplexity,
  chatgpt_shopping: queryChatGPT,
};

// ── Pull Manipal signals from GEO DB ─────────────────────────────────────────

async function pullSignalsFromDb(domain) {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: "require" });
  try {
    const rows = await sql`
      SELECT geo_scorecard, crawl_data, discovered_competitors, extracted_categories,
             generated_llms_txt, executive_summary
      FROM geo_sites
      WHERE domain = ${domain} AND pipeline_status = 'complete'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length === 0) return null;
    const r = rows[0];
    const scorecard = typeof r.geo_scorecard === "string" ? JSON.parse(r.geo_scorecard) : r.geo_scorecard;
    const crawl = typeof r.crawl_data === "string" ? JSON.parse(r.crawl_data) : r.crawl_data;
    const comps = typeof r.discovered_competitors === "string" ? JSON.parse(r.discovered_competitors) : r.discovered_competitors;

    return {
      domain,
      source: "geo_db",
      overallScore: scorecard?.overallScore ?? null,
      pillars: scorecard?.pillars?.map(p => ({ name: p.pillarName, score: p.score })) ?? [],
      totalPages: crawl?.totalCrawled ?? crawl?.pages?.length ?? 0,
      hasLlmsTxt: !!r.generated_llms_txt,
      competitors: (comps || []).slice(0, 5).map(c => c.name || c.domain),
      executiveSummary: typeof r.executive_summary === "string"
        ? r.executive_summary.slice(0, 300)
        : JSON.stringify(r.executive_summary)?.slice(0, 300),
    };
  } finally {
    await sql.end();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log("═══════════════════════════════════════════════════════");
  console.log("  AI Surface Test Run — Healthcare (budget: $0.50)");
  console.log("═══════════════════════════════════════════════════════\n");

  const results = [];

  for (const merchant of MERCHANTS) {
    console.log(`\n── ${merchant.label} (${merchant.domain}) ──\n`);

    // Phase 1: Signals
    let signals;
    if (merchant.pullFromDb) {
      console.log("  Pulling signals from GEO DB (free)...");
      signals = await pullSignalsFromDb(merchant.domain);
      if (signals) {
        console.log(`  Score: ${signals.overallScore}/100 | Pages: ${signals.totalPages} | llms.txt: ${signals.hasLlmsTxt}`);
        console.log(`  Competitors: ${signals.competitors.join(", ")}`);
      }
    }
    if (!signals) {
      console.log("  Fetching site-level signals (free)...");
      signals = await extractSiteLevelSignals(merchant.domain);
      signals.domain = merchant.domain;
      signals.source = "site_level";
      console.log(`  robots.txt: ${signals.hasRobotsTxt} | llms.txt: ${signals.hasLlmsTxt} | sitemap: ${signals.hasSitemap} | AI bots: ${signals.allowsAIBots}`);
    }

    // Phase 2: Surface probes
    const probes = [];
    for (const surface of SURFACE_CONFIG) {
      const fn = SURFACES[surface.name];
      for (const query of QUERIES) {
        console.log(`  [${surface.label}] "${query.slice(0, 50)}..."`);
        const response = await fn(query);
        const mention = detectMerchantMention(response.text, merchant.domain);
        const cited = extractCitedDomains(response.text);

        const icon = mention.mentioned ? (mention.position ? `#${mention.position}` : "YES") : "NO";
        console.log(`    → Mentioned: ${icon} | Sentiment: ${mention.sentiment} | ${response.ms}ms${response.error ? " ERROR: " + response.error : ""}`);

        probes.push({
          surface: surface.name,
          query,
          mentioned: mention.mentioned,
          position: mention.position,
          sentiment: mention.sentiment,
          citedDomains: cited.slice(0, 10),
          citations: response.citations?.slice(0, 5),
          responseMs: response.ms,
          responseText: response.text.slice(0, 500),
          error: response.error,
        });

        // Small delay between calls
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Aggregate
    const mentioned = probes.filter(p => p.mentioned);
    const visibility = probes.length > 0 ? Math.round((mentioned.length / probes.length) * 100) : 0;
    const positions = mentioned.map(p => p.position).filter(p => p !== null);
    const avgPos = positions.length > 0 ? Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 10) / 10 : null;

    // Per-surface breakdown
    const perSurface = {};
    for (const s of SURFACE_CONFIG) {
      const sp = probes.filter(p => p.surface === s.name);
      const sm = sp.filter(p => p.mentioned);
      perSurface[s.name] = {
        visibility: sp.length > 0 ? Math.round((sm.length / sp.length) * 100) : 0,
        mentions: sm.length,
        total: sp.length,
      };
    }

    console.log(`\n  RESULT: ${merchant.domain}`);
    console.log(`    Overall visibility: ${visibility}% (${mentioned.length}/${probes.length} mentions)`);
    console.log(`    Avg position: ${avgPos ?? "N/A"}`);
    for (const [s, d] of Object.entries(perSurface)) {
      console.log(`    ${s}: ${d.visibility}% (${d.mentions}/${d.total})`);
    }

    // All cited domains across responses (who IS getting mentioned?)
    const allCited = [...new Set(probes.flatMap(p => p.citedDomains))];
    console.log(`    Cited domains: ${allCited.slice(0, 15).join(", ")}`);

    results.push({
      domain: merchant.domain,
      label: merchant.label,
      signals,
      visibility,
      avgPosition: avgPos,
      perSurface,
      mentionedCount: mentioned.length,
      totalProbes: probes.length,
      allCitedDomains: allCited,
      probes,
    });
  }

  // ── Output ───────────────────────────────────────────────────────────────

  const runtime = Math.round((Date.now() - startTime) / 1000);

  // Save JSON
  const jsonPath = join(RESULTS_DIR, "test-run-healthcare.json");
  writeFileSync(jsonPath, JSON.stringify({ meta: { date: new Date().toISOString(), runtime: `${runtime}s`, queries: QUERIES.length, surfaces: SURFACE_CONFIG.length, estimatedCost: "$0.10-0.15" }, results }, null, 2));

  // Save markdown report
  const md = [];
  md.push("# AI Surface Test Run — Healthcare");
  md.push("");
  md.push(`**Date:** ${new Date().toISOString().split("T")[0]}  `);
  md.push(`**Runtime:** ${runtime}s  `);
  md.push(`**Queries:** ${QUERIES.length} | **Surfaces:** ${SURFACE_CONFIG.length} | **Est. cost:** $0.10-0.15`);
  md.push("");
  md.push("---");
  md.push("");

  md.push("## Results");
  md.push("");
  md.push("| Merchant | Overall | Google AI | Perplexity | ChatGPT | Avg Pos |");
  md.push("|----------|---------|-----------|------------|---------|---------|");
  for (const r of results) {
    md.push(`| **${r.domain}** | **${r.visibility}%** | ${r.perSurface.google_ai_overview?.visibility ?? 0}% | ${r.perSurface.perplexity_shopping?.visibility ?? 0}% | ${r.perSurface.chatgpt_shopping?.visibility ?? 0}% | ${r.avgPosition ?? "N/A"} |`);
  }
  md.push("");

  // Signal comparison
  md.push("## Signal Comparison");
  md.push("");
  for (const r of results) {
    md.push(`### ${r.domain}`);
    md.push("");
    if (r.signals.source === "geo_db") {
      md.push(`- GEO Score: **${r.signals.overallScore}/100**`);
      md.push(`- Pages audited: ${r.signals.totalPages}`);
      md.push(`- llms.txt: ${r.signals.hasLlmsTxt ? "Yes" : "No"}`);
      md.push(`- Top competitors: ${r.signals.competitors.join(", ")}`);
    } else {
      md.push(`- robots.txt: ${r.signals.hasRobotsTxt ? "Yes" : "Missing"}`);
      md.push(`- llms.txt: ${r.signals.hasLlmsTxt ? "Yes" : "Missing"}`);
      md.push(`- Sitemap: ${r.signals.hasSitemap ? "Yes" : "Missing"}`);
      md.push(`- AI bots allowed: ${r.signals.allowsAIBots === true ? "Yes" : r.signals.allowsAIBots === false ? "Blocked" : "Unknown"}`);
    }
    md.push("");
  }

  // All cited domains (who ARE the AI surfaces recommending?)
  md.push("## Who AI Surfaces Actually Recommend");
  md.push("");
  const allDomains = {};
  for (const r of results) {
    for (const p of r.probes) {
      for (const d of p.citedDomains) {
        allDomains[d] = (allDomains[d] || 0) + 1;
      }
    }
  }
  const sorted = Object.entries(allDomains).sort((a, b) => b[1] - a[1]);
  md.push("| Domain | Mention Count |");
  md.push("|--------|--------------|");
  for (const [d, c] of sorted.slice(0, 20)) {
    md.push(`| ${d} | ${c} |`);
  }
  md.push("");

  // Sample responses
  md.push("## Sample Responses");
  md.push("");
  for (const r of results) {
    for (const p of r.probes.slice(0, 2)) {
      md.push(`**${p.surface}** — "${p.query}"`);
      md.push("");
      md.push("```");
      md.push(p.responseText);
      md.push("```");
      md.push("");
    }
  }

  const mdPath = join(RESULTS_DIR, "test-run-healthcare.md");
  writeFileSync(mdPath, md.join("\n"));

  // Also save to Cofounder
  const cfPath = "/Users/adithya/Code/Cofounder/deliverables/tech/ai-surface-test-run-healthcare.md";
  writeFileSync(cfPath, md.join("\n"));

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  DONE in ${runtime}s`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  Report: ${mdPath}`);
  console.log(`  Cofounder: ${cfPath}`);
  console.log(`═══════════════════════════════════════════════════════`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
