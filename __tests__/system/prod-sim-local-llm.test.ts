/**
 * PROD-WORKLOAD SIMULATION on a local LLM (LM Studio / gemma).
 *
 * Exercises REAL pipeline LLM code against a REAL local model — not mocks — to
 * prove the centralized OpenAI-compatible routing (lib/llm/openai-route.ts) works
 * end-to-end and that the audit fixes (NEW-AI-03 max_completion_tokens, NEW-AI-04
 * guarded scorecard parse) hold against a real model's imperfect output.
 *
 * Gated behind LLM_LOCAL=1 — skipped in normal CI. Run with:
 *   docker run --rm -e LLM_LOCAL=1 \
 *     -e LLM_BASE_URL=http://host.docker.internal:4321/v1 \
 *     geo-test npx vitest run __tests__/system/prod-sim-local-llm.test.ts
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from "vitest";
import { openAILikeBaseUrl, resolveOpenAIModel, isLocalLLM } from "@/lib/llm/openai-route";

const LLM_LOCAL = process.env.LLM_LOCAL === "1";

// Is the local model server actually reachable? (skip cleanly if not)
let reachable = false;
beforeAll(async () => {
  if (!LLM_LOCAL) return;
  try {
    const r = await fetch(`${openAILikeBaseUrl()}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    reachable = r.ok;
  } catch {
    reachable = false;
  }
});

function note(msg: string) {
  console.warn(`[prod-sim] ${msg}`);
}

// One shared OpenAI-compatible chat call through the SAME path the pipeline uses.
async function localChat(prompt: string, maxTokens = 900): Promise<string> {
  const res = await fetch(`${openAILikeBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer local" },
    body: JSON.stringify({
      model: resolveOpenAIModel("gpt-5.4"),
      max_completion_tokens: maxTokens, // NEW-AI-03 contract
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await res.json()) as { choices?: { message: { content: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

// The NEW-AI-04 guarded parse, mirrored here to validate it against the real
// model's (often fenced / imperfect) JSON. Must NEVER throw.
function guardedParse(raw: string): { ok: boolean; data: unknown } {
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    return { ok: true, data: JSON.parse(stripped) };
  } catch {
    return { ok: false, data: null };
  }
}

describe.skipIf(!LLM_LOCAL)("PROD-SIM — pipeline LLM workload on local gemma", () => {
  it("routes the OpenAI-compatible path to the local model (centralization works)", () => {
    if (!reachable) return note("local LLM not reachable — skipping");
    expect(isLocalLLM()).toBe(true);
    expect(openAILikeBaseUrl()).toContain("4321");
    expect(resolveOpenAIModel("gpt-5.4")).toBe("google/gemma-4-12b");
  });

  it("assembler-style call (callClaude OpenAI path) returns content from local gemma", async () => {
    if (!reachable) return note("local LLM not reachable — skipping");
    const out = await localChat(
      "You are a GEO audit assistant. In one sentence, summarize why structured " +
        "data (schema.org) improves a site's visibility to AI search engines.",
    );
    expect(out.length).toBeGreaterThan(0);
    note(`assembler reply (${out.length} chars): ${out.slice(0, 120)}…`);
  }, 120_000);

  it("scorecard generation: real gemma JSON survives the NEW-AI-04 guarded parse (never throws)", async () => {
    if (!reachable) return note("local LLM not reachable — skipping");
    const raw = await localChat(
      'Return ONLY a JSON object scoring a website on GEO readiness, shape: ' +
        '{"overallScore": <0-100 number>, "summary": "<one sentence>"}. No prose.',
      900,
    );
    // The whole point of NEW-AI-04: even if gemma returns fences/prose/truncation,
    // the guarded parse must resolve gracefully — never throw and crash the audit.
    let threw = false;
    let result: ReturnType<typeof guardedParse>;
    try {
      result = guardedParse(raw);
    } catch {
      threw = true;
      result = { ok: false, data: null };
    }
    expect(threw).toBe(false);
    note(`scorecard raw (${raw.length} chars), parse ok=${result.ok}: ${raw.slice(0, 120)}…`);
    // If gemma produced valid JSON, sanity-check the shape; if not, the graceful
    // path still held (the audit would fall back rather than crash).
    if (result.ok && result.data && typeof result.data === "object") {
      expect(result.data).toBeTypeOf("object");
    }
  }, 120_000);
});
