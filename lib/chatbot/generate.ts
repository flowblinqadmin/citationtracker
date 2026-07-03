/**
 * Consolidated LLM response generation for both streaming (route) and non-streaming (replay) paths.
 * Shares system prompt construction and model selection logic to ensure consistency.
 */

import { streamText, generateText, convertToModelMessages, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { buildSystemPrompt, type ViewContext, type SiteContext } from "./system-prompt";
import { probeIntegration } from "./integration-probe";
import type { RetrievedChunk, ConfidenceTier } from "./retrieve";

export interface GenerateOpts {
  messages: Array<{ role: "user" | "assistant"; content?: string; parts?: unknown[] }>;
  siteContext: SiteContext | null;
  viewContext: ViewContext | null;
  retrieval: { tier: ConfidenceTier; chunks: RetrievedChunk[] };
  allowTools?: boolean;
  modelOverride?: string;
  temperatureOverride?: number;
  seedOverride?: number;
}

interface StreamOpts extends GenerateOpts {
  onFinish: (args: { text: string; toolCalls?: Array<{ type: string; name?: string; result?: unknown }> | null }) => void | Promise<void>;
}

/**
 * Get the OpenAI client or throw if API key is missing.
 */
function getOpenAIClient(): ReturnType<typeof createOpenAI> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OpenAI API key not configured");
  }
  return createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Normalize messages from client format (mixed content/parts) to AI SDK format.
 * Ensures both streaming and non-streaming paths use identical message transformation.
 * This mirrors the exact transformation done in app/api/chatbot/route.ts lines 213-221.
 */
async function normalizeMessages(
  messages: Array<{ role: "user" | "assistant"; content?: string; parts?: unknown[] }>,
): Promise<any> {
  // Convert to UIMessage format first (with id and parts)
  const uiMessages = messages.map((m, i) => ({
    id: (m as any).id ?? String(i),
    role: m.role as "user" | "assistant",
    parts: Array.isArray(m.parts)
      ? m.parts
      : [{ type: "text" as const, text: (m.content as string) ?? "" }],
  }));

  // Then convert to model messages using AI SDK's function
  // This handles protocol conversion to the model's expected format
  return await convertToModelMessages(uiMessages as any);
}

/**
 * Select the model to use for generation.
 * Defaults from env, with optional override.
 * Guards against unsupported providers (Anthropic not yet wired into route handler).
 */
function selectModel(modelOverride?: string): string {
  const model = modelOverride ?? process.env.CLEO_MODEL_ID ?? "gpt-5.4-mini";

  // Guard: only OpenAI for now (route.ts only ever passes OpenAI models)
  if (model.startsWith("claude-") || model.startsWith("anthropic/")) {
    throw new Error("Anthropic not yet wired into route — only replay harness uses claude -p");
  }

  return model;
}

/**
 * Get temperature value: override takes precedence, then env, then default 0.1.
 */
function getTemperature(temperatureOverride?: number): number {
  if (typeof temperatureOverride === "number") return temperatureOverride;
  if (process.env.CLEO_TEMPERATURE) {
    const parsed = parseFloat(process.env.CLEO_TEMPERATURE);
    if (!isNaN(parsed)) return parsed;
  }
  return 0.1;
}

/**
 * Build the full system prompt using the same logic as the route handler.
 */
function buildFullSystemPrompt(opts: GenerateOpts): string {
  return buildSystemPrompt(
    opts.siteContext,
    opts.viewContext,
    opts.retrieval.chunks,
    opts.retrieval.tier,
  );
}

/**
 * Stream a chatbot response to the client.
 * Used by app/api/chatbot/route.ts.
 *
 * Returns the AI SDK streamText result, which can be converted to UIMessageStreamResponse.
 */
export async function streamChatbotResponse(opts: StreamOpts): Promise<any> {
  const systemPrompt = buildFullSystemPrompt(opts);
  const modelMessages = await normalizeMessages(opts.messages);

  const client = getOpenAIClient();
  const model = selectModel(opts.modelOverride);
  const temperature = getTemperature(opts.temperatureOverride);

  // Register probe_integration tool only if domain is verified, tools are allowed, and we have slug + domain
  const tools = (opts.allowTools && opts.siteContext?.domainVerified && opts.siteContext?.slug && opts.siteContext?.domain && opts.siteContext?.siteId)
    ? {
        probe_integration: tool({
          description:
            "Run a fresh check of the user's integration — HEAD-fetch their /llms.txt and /schema.json, look up recent tracking-pixel hits. Use ONLY when the user claims they have just deployed/changed something OR explicitly asks 'is my integration working?'. Do NOT call on greetings, navigation questions, or general explanations.",
          inputSchema: z.object({ reason: z.string().describe("Why this probe is needed (1 sentence)") }),
          execute: async () => {
            try {
              const live = await probeIntegration(
                {
                  siteId: opts.siteContext!.siteId!,
                  slug: opts.siteContext!.slug!,
                  domain: opts.siteContext!.domain,
                  generatedLlmsTxt: null,
                  generatedSchemaBlocks: null,
                  generatedBusinessJson: null,
                },
                { force: true },
              );
              return live;
            } catch (err) {
              console.error("[chatbot-tools] probe_integration failed:", err);
              // Return error state without breaking the chatbot
              return {
                llmsTxt: { ok: false, method: null, checkedAt: new Date() },
                schemaJson: { ok: false, checkedAt: new Date() },
                trackingPixel: { lastSeenAt: null },
                generatedArtifactsReady: { llmsTxt: false, schemaBlocks: 0, businessJson: false },
              };
            }
          },
        }),
      }
    : undefined;

  return streamText({
    model: client(model),
    system: systemPrompt,
    messages: modelMessages,
    maxOutputTokens: 1000,
    temperature,
    ...(tools && { tools, stopWhen: stepCountIs(2) }),  // 1 tool call + 1 continuation, no recursion
    onFinish: async (result) => {
      // Extract tool calls from result if available
      const toolCalls = (result as any).toolCalls?.length ? (result as any).toolCalls : null;
      await opts.onFinish({ text: result.text, toolCalls });
    },
  });
}

/**
 * Generate a non-streaming response (used by replay harness).
 * Supports optional seed parameter for deterministic sampling in evaluation runs.
 * Only OpenAI supports seed; Anthropic does not.
 */
export async function generateChatbotResponse(
  opts: GenerateOpts,
): Promise<{ text: string; systemPrompt: string }> {
  const systemPrompt = buildFullSystemPrompt(opts);
  const modelMessages = await normalizeMessages(opts.messages);

  const client = getOpenAIClient();
  const model = selectModel(opts.modelOverride);
  const temperature = getTemperature(opts.temperatureOverride);

  const generateOpts: Parameters<typeof generateText>[0] = {
    model: client(model),
    system: systemPrompt,
    messages: modelMessages,
    maxOutputTokens: 1000,
    temperature,
  };

  // Add seed if provided (OpenAI only — Anthropic has no seed support)
  if (typeof opts.seedOverride === "number") {
    (generateOpts as Parameters<typeof generateText>[0] & { seed?: number }).seed = opts.seedOverride;
  }

  const result = await generateText(generateOpts);

  return { text: result.text, systemPrompt };
}
