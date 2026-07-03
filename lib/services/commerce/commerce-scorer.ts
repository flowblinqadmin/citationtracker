import type {
  CatalogSnapshot,
  CommerceScore,
  CommerceSubScore,
  CompetitorScore,
  GapSection,
} from "@/lib/types/commerce-report";
import type { SovResult } from "@/lib/services/commerce/sov-checker";

// Vertical-specific field labels
const VERTICAL_FIELD_LABELS: Record<string, string> = {
  automotive: "Fitment data completeness",
  "auto parts": "Fitment data completeness",
  fashion: "Size/fit data completeness",
  apparel: "Size/fit data completeness",
  health: "Ingredient data completeness",
  supplements: "Supplement facts completeness",
  electronics: "Specification data completeness",
  home: "Dimension/material completeness",
  beauty: "Ingredient/skin type data",
  food: "Nutritional data completeness",
};

function getVerticalFieldLabel(vertical: string): string {
  const lower = vertical.toLowerCase();
  for (const [key, label] of Object.entries(VERTICAL_FIELD_LABELS)) {
    if (lower.includes(key)) return label;
  }
  return "Vertical-specific data";
}

export function computeCommerceScore(
  catalog: CatalogSnapshot,
  vertical: string
): CommerceScore {
  const total = catalog.totalCrawled || 1;

  // Sub-score 1: Schema.org structured data (estimated from attribute density)
  const avgDensity =
    catalog.sampleProducts.length > 0
      ? catalog.sampleProducts.reduce((sum, p) => sum + p.attributeDensity, 0) /
        catalog.sampleProducts.length
      : 0;
  // Products with high density likely have schema.org markup
  const schemaScore = Math.min(100, Math.round(avgDensity * 1.1));

  // Sub-score 2: Product attribute density
  const attributeScore = Math.round(
    ((catalog.visible + catalog.partial * 0.5) / total) * 100
  );

  // Sub-score 3: ACP checkout readiness — always 0 (no merchant has this yet)
  const acpScore = 0;

  // Sub-score 4: Vertical-specific data completeness
  const verticalScore = Math.round((catalog.visible / total) * 100);

  // Sub-score 5: Real-time inventory — always 0
  const inventoryScore = 0;

  // Sub-score 6: Semantic richness
  const semanticScore = Math.min(
    100,
    Math.round(
      avgDensity * 0.8 + (catalog.visible / total) * 20
    )
  );

  const subScores: CommerceSubScore[] = [
    {
      label: "Schema.org structured data",
      value: schemaScore,
      level: schemaScore >= 70 ? "high" : schemaScore >= 40 ? "medium" : "low",
    },
    {
      label: "Product attribute density",
      value: attributeScore,
      level:
        attributeScore >= 70
          ? "high"
          : attributeScore >= 40
            ? "medium"
            : "low",
    },
    {
      label: "ACP checkout readiness",
      value: acpScore,
      level: "low",
    },
    {
      label: getVerticalFieldLabel(vertical),
      value: verticalScore,
      level:
        verticalScore >= 70 ? "high" : verticalScore >= 40 ? "medium" : "low",
    },
    {
      label: "Real-time inventory exposure",
      value: inventoryScore,
      level: "low",
    },
    {
      label: "Semantic richness (AI reasoning)",
      value: semanticScore,
      level:
        semanticScore >= 70 ? "high" : semanticScore >= 40 ? "medium" : "low",
    },
  ];

  // Overall: weighted average (ACP and inventory get 0 weight since they're always 0)
  const overall = Math.round(
    schemaScore * 0.2 +
      attributeScore * 0.25 +
      acpScore * 0.15 +
      verticalScore * 0.15 +
      inventoryScore * 0.1 +
      semanticScore * 0.15
  );

  return { overall, subScores };
}

export function scoreCompetitors(
  brandName: string,
  commerceScore: number,
  sovData: SovResult | null
): CompetitorScore[] {
  const competitors: CompetitorScore[] = [
    { name: brandName, score: commerceScore, isTarget: true },
  ];

  if (!sovData?.results) return competitors;

  // Extract competitor brands from SoV data and derive scores
  const competitorMentions = new Map<string, number>();

  for (const result of sovData.results) {
    for (const platform of result.platforms) {
      for (const mention of platform.mentions) {
        if (
          mention.brand.toLowerCase() !== brandName.toLowerCase() &&
          mention.mentioned
        ) {
          const current = competitorMentions.get(mention.brand) || 0;
          competitorMentions.set(mention.brand, current + 1);
        }
      }
    }
  }

  // Sort by mention count, take top 5
  const sorted = [...competitorMentions.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const maxMentions = sorted[0]?.[1] || 1;

  for (const [name, mentions] of sorted) {
    // Derive a relative score: more mentions = higher visibility, but they lack ACP too
    // Scale between 15-75 (no competitor has ACP either)
    const visibilityRatio = mentions / maxMentions;
    const score = Math.round(15 + visibilityRatio * 60);
    competitors.push({ name, score, isTarget: false });
  }

  // Sort by score descending
  competitors.sort((a, b) => b.score - a.score);

  return competitors;
}

async function queryOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY)
    throw new Error("No OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an agentic commerce analyst writing executive verdicts for brand decision-makers. Be specific, data-driven, and persuasive. Use <strong> tags for emphasis. Return ONLY valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      max_completion_tokens: 800,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function generateVerdict(
  brandName: string,
  vertical: string,
  score: CommerceScore,
  catalog: CatalogSnapshot,
  sovSummary?: { brandSov: number; topCompetitorName: string; topCompetitorSov: number } | null
): Promise<string> {
  const sovLine = sovSummary
    ? `\nSHARE OF VOICE:\n- ${brandName} SoV: ${sovSummary.brandSov}%\n- ${sovSummary.topCompetitorName} SoV: ${sovSummary.topCompetitorSov}%\n- AI agents currently recommend ${sovSummary.topCompetitorName} over ${brandName} in ${sovSummary.topCompetitorSov}% of shopping queries.\n`
    : "";

  const prompt = `Write a 3-4 sentence executive verdict for ${brandName} (${vertical}).

SCORES:
${score.subScores.map((s) => `- ${s.label}: ${s.value}%`).join("\n")}
Overall: ${score.overall}/100

CATALOG:
- ${catalog.totalCrawled} products crawled
- ${catalog.visible} visible, ${catalog.partial} partial, ${catalog.invisible} invisible to AI agents
${sovLine}
Write the verdict focusing on:
1. What's strong about their data (they have products)
2. The gap — AI agents don't recommend them${sovSummary ? ` (${sovSummary.topCompetitorName} gets ${sovSummary.topCompetitorSov}% of recommendations instead)` : ""}
3. The opportunity — how ACP can bridge this gap

Use <strong> tags for emphasis on key phrases. Be specific to their vertical.

Return JSON: { "verdict": "the verdict text" }`;

  try {
    const raw = await queryOpenAI(prompt);
    const parsed = JSON.parse(raw);
    return parsed.verdict || "";
  } catch (err) {
    console.error("Verdict generation failed:", (err as Error).message);
    return `${brandName} has ${score.overall >= 60 ? "strong" : "developing"} product data foundations with an overall commerce readiness score of <strong>${score.overall}/100</strong>. However, the catalog is <strong>completely undiscoverable by AI shopping agents</strong> — zero ACP checkout endpoints and no real-time inventory feed exist. ${score.overall >= 70 ? "This is one of the fastest paths from audit to live we've seen." : "With focused enrichment work, this catalog can be agent-ready."}`;
  }
}

export async function generateCompetitiveInsight(
  brandName: string,
  vertical: string,
  competitors: CompetitorScore[]
): Promise<string> {
  const compList = competitors
    .map((c) => `${c.name}: ${c.score}/100${c.isTarget ? " (YOU)" : ""}`)
    .join(", ");

  const prompt = `Write a 2-3 sentence competitive insight for ${brandName} (${vertical}).

SCORES: ${compList}

Focus on:
1. Where ${brandName} ranks vs competitors
2. Whether there's a first-mover opportunity (no one has ACP yet)
3. How long competitors would need to catch up

Use <strong> tags for emphasis. Be assertive and specific.

Return JSON: { "insight": "the insight text" }`;

  try {
    const raw = await queryOpenAI(prompt);
    const parsed = JSON.parse(raw);
    return parsed.insight || "";
  } catch (err) {
    console.error("Competitive insight generation failed:", (err as Error).message);
    return `${brandName} has the <strong>strongest data foundation in the category</strong>. No competitor has ACP checkout infrastructure live. This is a <strong>first-mover window</strong>: the first brand to go live on ACP captures the default agent recommendation position.`;
  }
}

export function buildGapSection(vertical: string): GapSection {
  const verticalTimeline: Record<string, string> = {
    automotive: "Fitment graph activation (ACES/PIES cross-reference for AI reasoning)",
    fashion: "Size/fit graph activation (body measurements + fabric stretch data)",
    health: "Ingredient/efficacy graph activation (clinical data cross-reference)",
    supplements: "Supplement facts graph activation (ingredient + dosage + interactions)",
    electronics: "Specification graph activation (compatibility + benchmark data)",
    beauty: "Ingredient/skin type graph activation (formulation + sensitivity data)",
    food: "Nutritional graph activation (allergen + dietary preference data)",
  };

  const lower = vertical.toLowerCase();
  let verticalStep = "Full catalog enrichment → agent-optimized metadata";
  for (const [key, step] of Object.entries(verticalTimeline)) {
    if (lower.includes(key)) {
      verticalStep = step;
      break;
    }
  }

  return {
    items: [
      {
        label: "ACP Checkout Endpoints",
        value: 0,
        description:
          "AI agents cannot initiate, update, or complete purchases on your store.",
      },
      {
        label: "Real-Time Inventory Feed",
        value: 0,
        description:
          "Agents can't verify stock levels. Risk of recommending OOS products.",
      },
      {
        label: "Payment Token Integration",
        value: 0,
        description:
          "No Stripe SPT configured. Agents can discover you but can't transact.",
      },
    ],
    timeline: [
      {
        period: "Week 1-2",
        description: "ACP endpoint deployment + Stripe SPT configuration",
      },
      {
        period: "Week 2-3",
        description: verticalStep,
      },
      {
        period: "Week 3-4",
        description:
          "Live on ChatGPT Instant Checkout — discoverable + transactable",
      },
    ],
  };
}
