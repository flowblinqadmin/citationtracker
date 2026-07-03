import type { CrawledProduct, AgentSimulation, SovGapData } from "@/lib/types/commerce-report";

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
            "You simulate how AI shopping agents (ChatGPT, Claude) would respond to purchase queries if they had full access to a merchant's catalog via ACP (Agent Commerce Protocol). Use REAL product names and prices provided. Return ONLY valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      max_completion_tokens: 2000,
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

export async function generateSimulations(
  products: CrawledProduct[],
  brandName: string,
  vertical: string,
  sovGap?: SovGapData | null
): Promise<AgentSimulation[]> {
  // Build product context from the best products
  const visibleProducts = products.filter((p) => p.status === "visible" || p.status === "partial");
  const productList = (visibleProducts.length > 5 ? visibleProducts : products)
    .slice(0, 15)
    .map((p) => `- ${p.name} ($${p.price}) [SKU: ${p.sku}] — ${p.category}`)
    .join("\n");

  // Build real SoV context if available
  let sovContext = "";
  if (sovGap && sovGap.queries.length > 0) {
    const sovLines = sovGap.queries.slice(0, 4).map((q) => {
      const platformResults = q.platforms
        .map((p) => `${p.platform}: ${p.mentioned ? "mentioned" : `NOT mentioned (recommended ${p.topCompetitor || "competitor"})`}`)
        .join(", ");
      return `- "${q.query}" → ${platformResults}`;
    });
    sovContext = `

REAL SOV DATA — We actually asked AI agents these queries. Here's what happened:
${sovLines.join("\n")}
Brand SoV: ${sovGap.brandSov}% | Top competitor (${sovGap.topCompetitorName}): ${sovGap.topCompetitorSov}%

IMPORTANT: Use the REAL queries from SoV data above as the simulation queries. Show what ACTUALLY happens today (competitor gets recommended) vs what WOULD happen with ACP (this brand's product gets recommended with price, stock, and checkout).`;
  }

  const prompt = `Create 2 AI shopping agent purchase simulations for ${brandName} (${vertical}).

REAL PRODUCTS FROM THEIR CATALOG:
${productList}
${sovContext}

SIMULATION 1: Single product recommendation
- ${sovGap ? "Use one of the REAL queries from the SoV data above" : "A natural customer query asking for a specific type of product this brand sells"}
- The agent recommends one specific product from the catalog list above with a detailed reason
- Include the exact product name and price
- The "excluded" section must describe what ACTUALLY happens today: the AI agent recommends a competitor instead

SIMULATION 2: Bundle/upsell scenario
- ${sovGap ? "Use another REAL query from the SoV data, or combine two" : "A customer asking for a broader solution or project build"}
- The agent recommends 3-4 complementary products from the list as a bundle
- Show the total bundle price
- Explain why bundling these makes sense
- The "excluded" section must name the specific competitor that gets recommended today

For BOTH simulations, the "excluded" explanation must be brutally specific about what happens TODAY — name the competitor that wins the recommendation, explain that the customer leaves and buys from them.

Return JSON:
{
  "simulations": [
    {
      "title": "ChatGPT — Shopping Agent Simulation",
      "query": "the natural customer query in quotes",
      "products": [
        { "name": "exact product name from list", "price": "$XX.XX", "reason": "why recommended — use <strong> tags for emphasis" }
      ],
      "excludedExplanation": "what happens without ACP — name the competitor, use <strong> tags for emphasis"
    }
  ]
}`;

  try {
    const raw = await queryOpenAI(prompt);
    const parsed = JSON.parse(raw);
    return (parsed.simulations || []).slice(0, 2);
  } catch (err) {
    console.error("Simulation generation failed:", (err as Error).message);
    // Return minimal fallback using real product data
    const first = products[0];
    return [
      {
        title: "ChatGPT — Shopping Agent Simulation",
        query: `What's the best ${vertical} product from ${brandName}?`,
        products: first
          ? [
              {
                name: first.name,
                price: first.price,
                reason: `Top-rated product in ${vertical}. Direct from ${brandName}.`,
              },
            ]
          : [],
        excludedExplanation: `Without ACP, the agent <strong>cannot query ${brandName}'s catalog directly</strong>. No checkout endpoints exist. The transaction goes to whichever competitor has ACP infrastructure live.`,
      },
    ];
  }
}
