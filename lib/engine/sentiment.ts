// Brand sentiment classification — one cheap, ungrounded Gemini call per
// brand-mentioned response. Best-effort: any failure returns null and the
// response row simply stores no sentiment (the run itself never fails on this).

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getGoogleGenAIKey } from "@/lib/engine/google-genai-key";
import { MODELS } from "@/lib/engine/providers";
import type { TrackerSentiment } from "@/lib/types/tracker";

const TIMEOUT_MS = 20_000;
// Enough to judge tone; keeps classification input tokens bounded.
const MAX_TEXT_CHARS = 6_000;

/** First sentiment word in the model's reply, or null if it answered anything else. */
export function parseSentiment(raw: string): TrackerSentiment | null {
  const m = raw.trim().toLowerCase().match(/\b(positive|negative|neutral)\b/);
  return (m?.[1] as TrackerSentiment | undefined) ?? null;
}

export async function classifyBrandSentiment(
  brand: string,
  responseText: string,
): Promise<TrackerSentiment | null> {
  try {
    const client = new GoogleGenerativeAI(getGoogleGenAIKey());
    // No search grounding — classification reads the given text only.
    const model = client.getGenerativeModel({
      model: MODELS.google,
      systemInstruction:
        "You classify how an AI assistant's answer portrays a brand. Reply with exactly one word: positive, negative, or neutral.",
    });
    const res = await Promise.race([
      model.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: `Brand: ${brand}\n\nAnswer:\n${responseText.slice(0, MAX_TEXT_CHARS)}` }],
          },
        ],
        // Gemini 3.5 spends "thinking" tokens from this budget before emitting
        // text — 8 returns MAX_TOKENS with an empty reply (verified live).
        generationConfig: { maxOutputTokens: 256, temperature: 0 },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    return parseSentiment(res.response.text());
  } catch {
    return null;
  }
}
