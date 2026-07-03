export type ProbeResult = {
  name: string;
  found: boolean;
  score: number; // 0-25
  details: string;
};

export type ProbeResults = {
  wellKnown: ProbeResult;
  feedJson: ProbeResult;
  stripeSpt: ProbeResult;
  realtimeInventory: ProbeResult;
  schemaOrg: ProbeResult;
};

const TIMEOUT_MS = 8000;
const BOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

async function fetchWithTimeout(
  url: string,
  timeoutMs = TIMEOUT_MS
): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BOT_UA, Accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    return res;
  } catch {
    return null;
  }
}

// Probe 1: /.well-known/agent-commerce
export async function probeWellKnown(domain: string): Promise<ProbeResult> {
  const url = `https://${domain}/.well-known/agent-commerce`;
  const res = await fetchWithTimeout(url);

  if (!res || !res.ok) {
    return {
      name: "ACP Well-Known Endpoint",
      found: false,
      score: 0,
      details: `No /.well-known/agent-commerce endpoint found at ${domain}`,
    };
  }

  try {
    const text = await res.text();
    const data = JSON.parse(text);
    const hasVersion = !!data.version;
    const hasEndpoints = !!data.endpoints;
    const score = hasVersion && hasEndpoints ? 25 : hasVersion ? 15 : 10;

    return {
      name: "ACP Well-Known Endpoint",
      found: true,
      score,
      details: `Found agent-commerce manifest. Version: ${data.version || "unknown"}. Endpoints: ${hasEndpoints ? "defined" : "missing"}.`,
    };
  } catch {
    return {
      name: "ACP Well-Known Endpoint",
      found: true,
      score: 5,
      details: "Endpoint exists but response is not valid JSON.",
    };
  }
}

// Probe 2: /feed.json (product feed)
export async function probeFeedJson(domain: string): Promise<ProbeResult> {
  const feedPaths = ["/feed.json", "/products.json", "/api/products.json"];

  for (const path of feedPaths) {
    const url = `https://${domain}${path}`;
    const res = await fetchWithTimeout(url);

    if (res && res.ok) {
      try {
        const text = await res.text();
        const data = JSON.parse(text);
        const isArray = Array.isArray(data);
        const hasProducts =
          isArray ||
          (data.products && Array.isArray(data.products));
        const count = isArray
          ? data.length
          : data.products?.length ?? 0;

        if (hasProducts && count > 0) {
          return {
            name: "Product Feed (JSON)",
            found: true,
            score: count >= 10 ? 25 : count >= 3 ? 15 : 10,
            details: `Found ${count} products at ${path}.`,
          };
        }
      } catch {
        // Not valid JSON, continue
      }
    }
  }

  return {
    name: "Product Feed (JSON)",
    found: false,
    score: 0,
    details: "No JSON product feed found at /feed.json, /products.json, or /api/products.json.",
  };
}

// Probe 3: Stripe SPT (Secure Payment Token) signals
export async function probeStripeSpt(domain: string): Promise<ProbeResult> {
  const url = `https://${domain}`;
  const res = await fetchWithTimeout(url);

  if (!res || !res.ok) {
    return {
      name: "Stripe Payment Signals",
      found: false,
      score: 0,
      details: "Could not fetch homepage to check for Stripe integration.",
    };
  }

  const html = await res.text();

  const hasStripeJs = html.includes("js.stripe.com") || html.includes("stripe.js");
  const hasStripeElement =
    html.includes("stripe-element") || html.includes("StripeElement");
  const hasPaymentIntent =
    html.includes("payment_intent") || html.includes("PaymentIntent");
  const hasCheckoutSession =
    html.includes("checkout.stripe.com") || html.includes("checkout-session");

  const signals = [hasStripeJs, hasStripeElement, hasPaymentIntent, hasCheckoutSession];
  const found = signals.some(Boolean);
  const signalCount = signals.filter(Boolean).length;

  return {
    name: "Stripe Payment Signals",
    found,
    score: signalCount >= 3 ? 25 : signalCount === 2 ? 18 : signalCount === 1 ? 10 : 0,
    details: found
      ? `Found ${signalCount} Stripe signal(s): ${[
          hasStripeJs && "Stripe.js",
          hasStripeElement && "Stripe Elements",
          hasPaymentIntent && "Payment Intents",
          hasCheckoutSession && "Checkout Sessions",
        ]
          .filter(Boolean)
          .join(", ")}.`
      : "No Stripe payment integration detected on homepage.",
  };
}

// Probe 4: Real-time inventory signals
export async function probeRealtimeInventory(
  domain: string
): Promise<ProbeResult> {
  const inventoryPaths = [
    "/api/inventory",
    "/api/stock",
    "/api/availability",
    "/.well-known/inventory",
  ];

  for (const path of inventoryPaths) {
    const url = `https://${domain}${path}`;
    const res = await fetchWithTimeout(url, 5000);

    if (res && (res.ok || res.status === 401 || res.status === 403)) {
      // Even 401/403 means the endpoint exists (just needs auth)
      const exists = res.ok || res.status === 401 || res.status === 403;
      if (exists) {
        return {
          name: "Real-Time Inventory API",
          found: true,
          score: res.ok ? 25 : 15,
          details: res.ok
            ? `Inventory endpoint found at ${path} (publicly accessible).`
            : `Inventory endpoint found at ${path} (requires authentication — HTTP ${res.status}).`,
        };
      }
    }
  }

  return {
    name: "Real-Time Inventory API",
    found: false,
    score: 0,
    details:
      "No inventory API found at /api/inventory, /api/stock, /api/availability, or /.well-known/inventory.",
  };
}

// Probe 5: Schema.org Product markup
export async function probeSchemaOrg(domain: string): Promise<ProbeResult> {
  const url = `https://${domain}`;
  const res = await fetchWithTimeout(url);

  if (!res || !res.ok) {
    return {
      name: "Schema.org Product Markup",
      found: false,
      score: 0,
      details: "Could not fetch homepage to check for schema.org markup.",
    };
  }

  const html = await res.text();

  const jsonLdMatches = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  if (!jsonLdMatches) {
    return {
      name: "Schema.org Product Markup",
      found: false,
      score: 0,
      details: "No JSON-LD structured data found on homepage.",
    };
  }

  let hasOrganization = false;
  let hasProduct = false;
  let hasWebSite = false;

  for (const match of jsonLdMatches) {
    try {
      const content = match.replace(/<\/?script[^>]*>/gi, "").trim();
      const data = JSON.parse(content);
      const types = Array.isArray(data["@graph"])
        ? data["@graph"].map((d: Record<string, string>) => d["@type"])
        : [data["@type"]];

      if (types.includes("Organization")) hasOrganization = true;
      if (types.includes("Product")) hasProduct = true;
      if (types.includes("WebSite")) hasWebSite = true;
    } catch {
      // Invalid JSON-LD
    }
  }

  const schemaCount = [hasOrganization, hasProduct, hasWebSite].filter(
    Boolean
  ).length;

  return {
    name: "Schema.org Product Markup",
    found: schemaCount > 0,
    score: hasProduct ? 25 : schemaCount >= 2 ? 18 : schemaCount === 1 ? 10 : 0,
    details:
      schemaCount > 0
        ? `Found schema.org types: ${[
            hasOrganization && "Organization",
            hasProduct && "Product",
            hasWebSite && "WebSite",
          ]
            .filter(Boolean)
            .join(", ")}.`
        : "JSON-LD found but no relevant schema.org types (Organization, Product, WebSite).",
  };
}

// Run all 5 probes
export async function runAllProbes(domain: string): Promise<{
  results: ProbeResults;
  scores: Record<string, number>;
  infrastructureScore: number;
}> {
  const [wellKnown, feedJson, stripeSpt, realtimeInventory, schemaOrg] =
    await Promise.allSettled([
      probeWellKnown(domain),
      probeFeedJson(domain),
      probeStripeSpt(domain),
      probeRealtimeInventory(domain),
      probeSchemaOrg(domain),
    ]);

  const results: ProbeResults = {
    wellKnown:
      wellKnown.status === "fulfilled"
        ? wellKnown.value
        : { name: "ACP Well-Known Endpoint", found: false, score: 0, details: "Probe failed" },
    feedJson:
      feedJson.status === "fulfilled"
        ? feedJson.value
        : { name: "Product Feed (JSON)", found: false, score: 0, details: "Probe failed" },
    stripeSpt:
      stripeSpt.status === "fulfilled"
        ? stripeSpt.value
        : { name: "Stripe Payment Signals", found: false, score: 0, details: "Probe failed" },
    realtimeInventory:
      realtimeInventory.status === "fulfilled"
        ? realtimeInventory.value
        : { name: "Real-Time Inventory API", found: false, score: 0, details: "Probe failed" },
    schemaOrg:
      schemaOrg.status === "fulfilled"
        ? schemaOrg.value
        : { name: "Schema.org Product Markup", found: false, score: 0, details: "Probe failed" },
  };

  const scores = {
    wellKnown: results.wellKnown.score,
    feedJson: results.feedJson.score,
    stripeSpt: results.stripeSpt.score,
    realtimeInventory: results.realtimeInventory.score,
    schemaOrg: results.schemaOrg.score,
  };

  const infrastructureScore = Object.values(scores).reduce((a, b) => a + b, 0);

  return { results, scores, infrastructureScore };
}
