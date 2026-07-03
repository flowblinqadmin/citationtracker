import type { CrawledProduct, EnrichmentPreview } from "@/lib/types/commerce-report";

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
            "You are an e-commerce data enrichment specialist. You generate realistic, accurate product attribute values based on product names and descriptions. Return ONLY valid JSON, no markdown fences.",
        },
        { role: "user", content: prompt },
      ],
      max_completion_tokens: 1500,
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

export async function generateEnrichmentPreview(
  products: CrawledProduct[],
  vertical: string
): Promise<EnrichmentPreview> {
  // Pick the most incomplete product
  const sorted = [...products].sort(
    (a, b) => a.attributeDensity - b.attributeDensity
  );
  const worst = sorted[0];

  const prompt = `You are enriching product data for an AI-commerce catalog.

PRODUCT:
- Name: ${worst.name}
- Price: ${worst.price}
- Category: ${worst.category || "unknown"}
- Description: ${worst.description || "none"}
- Vertical: ${vertical}

MISSING FIELDS: ${worst.missingAttributes.join(", ")}

EXISTING FIELDS:
${Object.entries(worst.attributes)
  .filter(([, v]) => v)
  .map(([k, v]) => `${k}: ${v}`)
  .join("\n")}

Generate realistic values for ALL missing fields. These should be plausible for this specific product — not generic.

Return JSON:
{
  "fields": [
    { "key": "field_name", "before": null, "after": "enriched value" }
  ]
}

Also include the existing fields with their current values as "before" (set "after" to the same value for those).`;

  try {
    const raw = await queryOpenAI(prompt);
    const parsed = JSON.parse(raw);
    const fields = parsed.fields || [];

    // Merge: include existing fields first, then enriched
    const allFields = Object.entries(worst.attributes).map(([key, val]) => {
      const enriched = fields.find(
        (f: { key: string; after: string }) => f.key === key
      );
      return {
        key,
        before: val,
        after: enriched?.after || val || "",
      };
    });

    // Add any extra fields from enrichment that weren't in original
    for (const f of fields) {
      if (!allFields.find((a) => a.key === f.key)) {
        allFields.push({ key: f.key, before: null, after: f.after });
      }
    }

    return {
      productName: worst.name,
      missingCount: worst.missingAttributes.length,
      totalFields: allFields.length,
      fields: allFields,
    };
  } catch (err) {
    console.error("Enrichment generation failed:", (err as Error).message);
    // Fallback: show raw missing fields without enrichment
    return {
      productName: worst.name,
      missingCount: worst.missingAttributes.length,
      totalFields: Object.keys(worst.attributes).length,
      fields: Object.entries(worst.attributes).map(([key, val]) => ({
        key,
        before: val,
        after: val || "—",
      })),
    };
  }
}
