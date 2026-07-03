/**
 * Shared Claude / LLM call utility.
 * Tries Claude Sonnet 4.6, falls back to OpenAI gpt-5.4, then Gemini 2.5 Flash.
 *
 * @param prompt    User prompt sent to the provider.
 * @param maxTokens Output-token ceiling applied uniformly across the whole
 *                  fallback chain (default 600). Exposed as a parameter so
 *                  longer-form callers don't have to edit this util.
 */

import { openAILikeBaseUrl, openAIApiKey, resolveOpenAIModel, isLocalLLM } from "@/lib/llm/openai-route";

// FIND-MODELAPPROPRIATENESS-007: the fallback chain spans providers with very
// different context windows (Sonnet-4.6 ≈ 200k → gpt-5.4 → Gemini-2.5-flash
// ≈ 1M). Guard on the SMALLEST window (Sonnet) so an oversized prompt fails the
// same way regardless of which provider key happens to be set — otherwise the
// helper's behavior would depend on environment config (fail on Sonnet, but
// silently succeed on the larger-window fallback) rather than on the input.
const MIN_CONTEXT_TOKENS = 200_000;      // Sonnet-4.6, the smallest window in the chain
const APPROX_CHARS_PER_TOKEN = 4;        // conservative English-text estimate

export async function callClaude(prompt: string, maxTokens = 600): Promise<string> {
  // Input-length assertion (see MIN_CONTEXT_TOKENS note above). Reject before
  // hitting any provider so the chain truncates consistently instead of
  // succeeding only when a large-window fallback key is configured.
  const estimatedInputTokens = Math.ceil(prompt.length / APPROX_CHARS_PER_TOKEN);
  if (estimatedInputTokens + maxTokens > MIN_CONTEXT_TOKENS) {
    throw new Error(
      `callClaude: prompt too large — ~${estimatedInputTokens} estimated input tokens + ` +
      `${maxTokens} output exceeds the ${MIN_CONTEXT_TOKENS}-token window of the smallest ` +
      `fallback provider (claude-sonnet-4-6)`
    );
  }

  // Local LLM short-circuit: bypass Anthropic entirely and route directly to the
  // OpenAI-compatible gateway (LM Studio / gemma) when LLM_LOCAL=1.
  // Use Math.max(maxTokens, 900) — gemma is a reasoning model that consumes tokens
  // for chain-of-thought; a tight ceiling starves the visible output.
  if (isLocalLLM()) {
    const res = await fetch(`${openAILikeBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openAIApiKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: resolveOpenAIModel("gpt-5.4"),
        max_completion_tokens: Math.max(maxTokens, 900),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json() as { choices?: { message: { content: string } }[]; error?: { message: string } };
    if (!res.ok) throw new Error(`[assembler] Local LLM error (${res.status}): ${data.error?.message}`);
    return data.choices?.[0]?.message?.content ?? "";
  }

  // Try Claude Sonnet 4.6 first
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json() as { content?: { text: string }[]; error?: { message: string } };
      if (res.ok) return data.content?.[0]?.text ?? "";
      const isRetryable = res.status === 529 || res.status === 503 || res.status === 429;
      console.warn(`[assembler] Claude failed (${res.status}): ${data.error?.message}${isRetryable ? " — retrying in 5s" : " — falling back to OpenAI"}`);
      if (isRetryable) {
        await new Promise((r) => setTimeout(r, 5000));
        const retry = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY!,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: maxTokens,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const retryData = await retry.json() as { content?: { text: string }[]; error?: { message: string } };
        if (retry.ok) return retryData.content?.[0]?.text ?? "";
        console.warn(`[assembler] Claude retry failed (${retry.status}): ${retryData.error?.message} — falling back to OpenAI`);
      }
    } catch (err) {
      console.warn(`[assembler] Claude error: ${err} — falling back to OpenAI`);
    }
  } else {
    console.warn("[assembler] ANTHROPIC_API_KEY not set — falling back to OpenAI");
  }

  // Fallback 1: OpenAI-compatible endpoint (real OpenAI or local LM Studio)
  const _openAIKey = openAIApiKey();
  if (_openAIKey) {
    try {
      const res = await fetch(`${openAILikeBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${_openAIKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: resolveOpenAIModel("gpt-5.4"),
          max_completion_tokens: maxTokens,  // NEW-AI-03: gpt-5.x reasoning models require max_completion_tokens, not max_tokens
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json() as { choices?: { message: { content: string } }[]; error?: { message: string } };
      if (res.ok) return data.choices?.[0]?.message?.content ?? "";
      console.warn(`[assembler] OpenAI-compatible failed (${res.status}): ${data.error?.message}${isLocalLLM() ? "" : " — falling back to Gemini"}`);
    } catch (err) {
      console.warn(`[assembler] OpenAI-compatible error: ${err}${isLocalLLM() ? "" : " — falling back to Gemini"}`);
    }
  } else {
    console.warn("[assembler] OPENAI_API_KEY not set — falling back to Gemini");
  }

  // Fallback 2: Gemini 3.5 Flash (2026-06-10 modernization, was gemini-2.5-flash)
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error("All LLM providers failed — no keys available");
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // Floor at 8192: gemini thinking tokens share this allowance, and a small
        // caller maxTokens (default 600) would be consumed by reasoning, starving
        // the visible output (the gemini-2.5 scorecard-starvation class).
        generationConfig: { maxOutputTokens: Math.max(maxTokens, 8192) },
      }),
    }
  );
  const geminiData = await geminiRes.json() as {
    candidates?: { content: { parts: { text: string }[] } }[];
    error?: { message: string };
  };
  if (!geminiRes.ok) throw new Error(geminiData.error?.message ?? "Gemini fallback failed");
  return geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
