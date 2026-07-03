import { NextRequest, NextResponse } from "next/server";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { db } from "@/lib/db";
import { geoSiteView, teams, teamMembers, chatbotLogs } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { checkGuardrails, navIntent } from "@/lib/chatbot/guardrails";
import { retrieveKnowledge } from "@/lib/chatbot/retrieve";
import { type ViewContext, type SiteContext } from "@/lib/chatbot/system-prompt";
import { probeIntegration } from "@/lib/chatbot/integration-probe";
import { shouldEscalate, escalateToOps } from "@/lib/chatbot/escalation";
import { checkRateLimit } from "@/lib/rate-limit";
import { streamChatbotResponse } from "@/lib/chatbot/generate";

export const runtime = "nodejs";
export const maxDuration = 60;

const CHATBOT_RATE_LIMIT = 30;           // max requests
const CHATBOT_RATE_WINDOW_MS = 10 * 60 * 1000; // per 10 minutes

const NO_MATCH_RESPONSE = `I don't have specific information about that in my knowledge base.

I can help with:
• Understanding your audit scores and recommendations
• Implementing GEO fixes on your website platform
• Navigating the GEO portal (pricing, credits, reports)
• Structured data, robots.txt, and llms.txt setup

For other questions, reach out to hello@flowblinq.com.`;

export async function POST(req: NextRequest) {
  try {
    // ── Auth: site access token (header only — never accept token in URL) ─
    const siteId = req.nextUrl.searchParams.get("siteId");
    const token = req.headers.get("authorization")?.replace("Bearer ", "");

    if (!token || !siteId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify token against site
    const [site] = await db
      .select()
      .from(geoSiteView)
      .where(eq(geoSiteView.siteId, siteId));

    if (!site || site.accessToken !== token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // NULL tokenExpiresAt treated as expired (parity with /api/sites/[id]).
    if (!site.tokenExpiresAt || site.tokenExpiresAt < new Date()) {
      return NextResponse.json(
        { error: "Unauthorized", code: "TOKEN_EXPIRED" },
        { status: 401 },
      );
    }

    // ── Rate limiting ────────────────────────────────────────────────────
    const rateLimit = await checkRateLimit(`chatbot:${siteId}`, CHATBOT_RATE_LIMIT, CHATBOT_RATE_WINDOW_MS);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please wait before sending more messages." },
        { status: 429, headers: { "Retry-After": String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)) } },
      );
    }

    // ── Parse request body ───────────────────────────────────────────────
    const body = await req.json();
    const messages = body.messages as Array<{ role: "user" | "assistant"; content: string }>;
    const rawViewContext = body.viewContext ?? null;
    const conversationId = typeof body.conversationId === "string" && body.conversationId.length <= 50
      ? body.conversationId : nanoid();

    // Sanitize viewContext — strip newlines/control chars, cap lengths (prevents prompt injection)
    const viewContext = rawViewContext ? sanitizeViewContext(rawViewContext) : null;

    if (!messages?.length) {
      return NextResponse.json({ error: "No messages" }, { status: 400 });
    }

    // Cap conversation length
    if (messages.length > 30) {
      return NextResponse.json(
        { error: "Conversation too long. Please start a new chat." },
        { status: 400 },
      );
    }

    const lastUserMessage = messages.filter((m: { role: string }) => m.role === "user").pop();
    if (!lastUserMessage) {
      return NextResponse.json({ error: "No user message" }, { status: 400 });
    }

    // Extract text from either content string or parts array (AI SDK v6 sends parts)
    const userText = extractMessageText(lastUserMessage);
    if (!userText) {
      return NextResponse.json({ error: "Empty message" }, { status: 400 });
    }

    // ── Guardrails (check ALL user messages, not just the last one) ─────
    // Prevents prompt injection via fabricated earlier turns
    for (const msg of messages) {
      if ((msg as { role: string }).role !== "user") continue;
      const text = extractMessageText(msg as Record<string, unknown>);
      if (!text) continue;
      const check = checkGuardrails(text);
      if (!check.allowed) {
        return streamRefusal(check.refusalMessage!);
      }
    }

    // ── Build site context ───────────────────────────────────────────────
    let siteContext: SiteContext | null = null;
    let ownerEmail: string | null = null;
    if (site) {
      // Get team credit balance + owner email
      let credits: number | undefined;
      let tier: "free" | "paid" = "free";
      if (site.teamId) {
        const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
        if (team) {
          credits = team.creditBalance;
          tier = team.creditBalance > 0 || team.subscriptionTier !== "free" ? "paid" : "free";
        }
        const [owner] = await db.select({ email: teamMembers.email }).from(teamMembers)
          .where(eq(teamMembers.teamId, site.teamId));
        ownerEmail = owner?.email ?? null;
      }

      const pillars = (site.pillars as Array<{ pillarName: string; score: number; priority: string; findings?: string; recommendation?: string; impactedPages?: string[] }>) ?? [];
      const recs = (site.rankedRecommendations as Array<{ rank: number; title: string; pillar: string; priority: string; specificAction?: string; estimatedBoost?: string }>) ?? [];
      const perPageResults = (site.perPageResults as Array<{ url: string; overallPageHealth?: string }>) ?? [];

      // Build condensed per-page summary
      let perPageSummary: string | undefined;
      if (perPageResults.length > 0) {
        const healthCounts = { good: 0, fair: 0, poor: 0, other: 0 };
        for (const p of perPageResults) {
          const h = (p.overallPageHealth ?? "").toLowerCase();
          if (h.includes("good")) healthCounts.good++;
          else if (h.includes("fair") || h.includes("medium")) healthCounts.fair++;
          else if (h.includes("poor") || h.includes("critical")) healthCounts.poor++;
          else healthCounts.other++;
        }
        perPageSummary = `${perPageResults.length} pages analyzed: ${healthCounts.good} good, ${healthCounts.fair} fair, ${healthCounts.poor} poor`;
      }

      siteContext = {
        domain: site.domain,
        siteId: site.siteId ?? undefined,
        slug: site.slug ?? undefined,
        domainVerified: site.domainVerified ?? undefined,
        overallScore: site.overallScore,
        executiveSummary: site.executiveSummary,
        pillars,
        rankedRecommendations: recs,
        platformDetected: site.platformDetected,
        tier,
        credits,
        pageCount: (site as { pageCount?: number }).pageCount ?? perPageResults.length,
        perPageSummary,
      };

      // ── Integration probe (only if domain verified) ─────────────────────
      if (site.domainVerified && site.siteId && site.slug) {
        try {
          const integrationLive = await probeIntegration({
            siteId: site.siteId,
            slug: site.slug,
            domain: site.domain,
            generatedLlmsTxt: site.generatedLlmsTxt,
            generatedSchemaBlocks: site.generatedSchemaBlocks as unknown[] | null,
            generatedBusinessJson: site.generatedBusinessJson,
          });
          siteContext.integrationLive = integrationLive;
        } catch (err) {
          console.error(`[chatbot] probeIntegration failed for ${siteId}:`, err);
          // Continue without integrationLive — probe failure must not break chatbot
        }
      }
    }

    // ── Escalation check (dissatisfied customer detection) ───────────────
    const conversationTexts = messages.map((m: Record<string, unknown>) => ({
      role: (m.role as string) ?? "user",
      text: extractMessageText(m),
    }));

    if (shouldEscalate(conversationTexts)) {
      // Cooldown: max 1 escalation per site per hour (prevents email spam)
      const escalationKey = `escalation:${siteId}`;
      const escalationLimit = await checkRateLimit(escalationKey, 1, 60 * 60 * 1000);
      if (escalationLimit.allowed) {
        // Best-effort fan-out — Promise.allSettled inside escalateToOps
        // prevents rejections, but log any catastrophic top-level failure.
        // Streaming response below keeps the function alive long enough for
        // the parallel network calls to typically complete.
        escalateToOps({
          domain: site.domain,
          siteId,
          userEmail: ownerEmail,
          conversationHistory: conversationTexts,
          triggerMessage: userText,
        }).catch((err) => console.error("[chatbot] escalateToOps top-level failure:", err));
      }
    }

    // ── Build conversation context from prior user turns (last 2, excluding current) ─
    const priorUserTurns = messages
      .filter((m: { role: string }) => m.role === "user")
      .slice(-3, -1)  // Last 2 user turns BEFORE the current one
      .map((m: Record<string, unknown>) => extractMessageText(m))
      .filter(Boolean)
      .join("\n");
    const conversationContext = priorUserTurns.slice(0, 2000) || undefined;

    // ── RAG retrieval with multi-turn context ────────────────────────────
    const retrieval = await retrieveKnowledge(
      userText,
      site.platformDetected,
      conversationContext,
    );

    // ── Tool call rate limiting ──────────────────────────────────────────
    const toolLimit = await checkRateLimit(
      `chatbot-tools:${conversationId}`,
      3,                  // max 3 tool calls per conversation
      10 * 60 * 1000,     // per 10 minutes
    );
    const allowTools = toolLimit.allowed;

    // If confidence is too low AND the question isn't contextual, return canned response (no LLM cost)
    // Always send to LLM if viewContext is present — user is on the audit page and may be asking about what they see
    const { isNav } = navIntent(userText, viewContext);
    if (retrieval.tier === "refused" && !viewContext && !isNav && !shouldSendToLLM(userText, conversationTexts)) {
      await logConversation(siteId, site.teamId, conversationId, userText, NO_MATCH_RESPONSE, retrieval, viewContext);
      return streamRefusal(NO_MATCH_RESPONSE);
    }

    // ── Stream LLM response via consolidated generate module ─────────────
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "OpenAI API not configured" }, { status: 500 });
    }
    const result = await streamChatbotResponse({
      messages,
      siteContext,
      viewContext,
      retrieval,
      allowTools,
      onFinish: async ({ text, toolCalls }) => {
        // Log conversation asynchronously
        await logConversation(siteId, site.teamId, conversationId, userText, text, retrieval, viewContext, toolCalls)
          .catch((err) => console.error("[chatbot] Failed to log conversation:", err));
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (err) {
    console.error("POST /api/chatbot error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ── GET: conversation history ────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const siteId = req.nextUrl.searchParams.get("siteId");
    const token = req.headers.get("authorization")?.replace("Bearer ", "");

    if (!token || !siteId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [site] = await db.select().from(geoSiteView).where(eq(geoSiteView.siteId, siteId));
    if (!site || site.accessToken !== token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!site.tokenExpiresAt || site.tokenExpiresAt < new Date()) {
      return NextResponse.json(
        { error: "Unauthorized", code: "TOKEN_EXPIRED" },
        { status: 401 },
      );
    }

    // Fetch recent logs and group into conversations (max 10)
    const rows = await db
      .select({
        conversationId: chatbotLogs.conversationId,
        query: chatbotLogs.query,
        response: chatbotLogs.response,
        createdAt: chatbotLogs.createdAt,
      })
      .from(chatbotLogs)
      .where(eq(chatbotLogs.siteId, siteId))
      .orderBy(desc(chatbotLogs.createdAt))
      .limit(200);

    // Group by conversationId, cap at 10 unique conversations
    const grouped = new Map<string, Array<{ role: "user" | "assistant"; text: string; createdAt: Date | null }>>();
    for (const row of rows) {
      if (!row.conversationId) continue;
      if (!grouped.has(row.conversationId)) {
        if (grouped.size >= 10) continue; // Skip rows from conversations beyond the 10th
        grouped.set(row.conversationId, []);
      }
      grouped.get(row.conversationId)!.push(
        { role: "user", text: row.query, createdAt: row.createdAt },
        { role: "assistant", text: row.response, createdAt: row.createdAt },
      );
    }

    const conversations = Array.from(grouped.entries()).map(([id, msgs]) => {
      const sorted = msgs.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
      const latestUserMsg = sorted.filter((m) => m.role === "user").pop();
      return {
        id,
        messages: sorted,
        preview: latestUserMsg?.text?.slice(0, 80) ?? "Conversation",
        timestamp: sorted[sorted.length - 1]?.createdAt?.toISOString() ?? null,
      };
    });

    return NextResponse.json({ conversations });
  } catch (err) {
    console.error("GET /api/chatbot error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stream a static refusal message in UIMessageStream format for useChat compatibility */
function streamRefusal(refusalText: string): Response {
  const msgId = nanoid();
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      writer.write({ type: "start-step" });
      writer.write({ type: "text-start", id: msgId });
      // Send in small chunks to mimic streaming
      const words = refusalText.split(" ");
      for (const word of words) {
        writer.write({ type: "text-delta", delta: word + " ", id: msgId });
      }
      writer.write({ type: "text-end", id: msgId });
      writer.write({ type: "finish-step" });
      writer.write({ type: "finish" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

/** Sanitize a string field: strip newlines, control chars, cap length */
function sanitizeStr(val: unknown, maxLen: number): string | undefined {
  if (typeof val !== "string") return undefined;
  return val.replace(/[\n\r\t\x00-\x1f]/g, " ").trim().slice(0, maxLen) || undefined;
}

/** Sanitize viewContext from untrusted client to prevent prompt injection */
function sanitizeViewContext(raw: Record<string, unknown>): ViewContext {
  const page = raw.page === "dashboard" ? "dashboard" : "results";
  const validTabs = ["overview", "scorecard", "recommendations", "pages", "history", "setup"];
  return {
    page,
    currentTab: validTabs.includes(raw.currentTab as string) ? (raw.currentTab as string) : undefined,
    domain: sanitizeStr(raw.domain, 100),
    overallScore: typeof raw.overallScore === "number" ? Math.max(0, Math.min(100, Math.round(raw.overallScore))) : undefined,
    tier: raw.tier === "paid" ? "paid" : "free",
    credits: typeof raw.credits === "number" ? Math.max(0, Math.round(raw.credits)) : undefined,
    pipelineStatus: sanitizeStr(raw.pipelineStatus, 30),
    expandedPillar: sanitizeStr(raw.expandedPillar, 100),
    expandedRecommendation: typeof raw.expandedRecommendation === "number" ? Math.max(0, Math.min(100, Math.round(raw.expandedRecommendation))) : undefined,
    platformDetected: sanitizeStr(raw.platformDetected, 50),
  };
}

function extractMessageText(msg: Record<string, unknown>): string {
  // AI SDK v6 UIMessage format: { role, parts: [{ type: "text", text: "..." }] }
  if (Array.isArray(msg.parts)) {
    return (msg.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("");
  }
  // Legacy format: { role, content: "..." }
  if (typeof msg.content === "string") return msg.content;
  return "";
}

/**
 * Should this query go to the LLM even if RAG returned low-confidence chunks?
 * Checks both the current message AND conversation history — if any prior message
 * was on-topic, follow-ups should go to the LLM too.
 */
function shouldSendToLLM(currentMessage: string, allMessages: Array<{ role: string; text: string }>): boolean {
  const ON_TOPIC_KEYWORDS = [
    // Product/billing
    "price", "pricing", "cost", "credit", "upgrade", "plan", "subscription",
    "billing", "payment", "free", "pro", "starter", "growth",
    // Portal navigation
    "dashboard", "tab", "download", "report", "zip", "pdf",
    // Questions
    "how do i", "how to", "how can", "where", "navigate", "find", "button",
    "can you", "explain", "what do you mean", "tell me more", "simpler",
    // Audit
    "score", "audit", "pillar", "recommendation", "fix", "improve",
    "why is", "what is", "what does", "what are", "low", "high", "poor", "weak",
    // Technical
    "schema", "structured data", "robots", "llms.txt", "meta", "seo",
    "cta", "content", "authority", "link", "image", "faq",
    // Connection / integration
    "connect", "integration", "setup", "deploy", "install", "implement", "plugin",
    // Platforms
    "wordpress", "shopify", "wix", "squarespace", "webflow", "next.js", "nextjs",
    "magento", "drupal", "ghost", "framer", "hubspot", "bigcommerce",
    // Technical terms
    "proxy", "tracking pixel", "json-ld", "functions.php", "htaccess", "nginx",
    "theme", "code injection", "custom code", "header", "footer",
  ];

  const currentLower = currentMessage.toLowerCase();

  // Current message is on-topic
  if (ON_TOPIC_KEYWORDS.some((k) => currentLower.includes(k))) return true;

  // If conversation has prior on-topic messages, follow-ups are likely on-topic too
  // (user asking "can you explain that?" or "I can't find it" after an on-topic exchange)
  if (allMessages.length > 1) {
    const priorUserMessages = allMessages.filter((m) => m.role === "user").slice(0, -1);
    const anyPriorOnTopic = priorUserMessages.some((m) => {
      const lower = m.text.toLowerCase();
      return ON_TOPIC_KEYWORDS.some((k) => lower.includes(k));
    });
    if (anyPriorOnTopic) return true;
  }

  return false;
}

async function logConversation(
  siteId: string,
  teamId: string | null,
  conversationId: string,
  query: string,
  response: string,
  retrieval: { tier: string; chunks: Array<{ content: string; source: string; similarity: number }> },
  viewContext: ViewContext | null,
  toolCalls?: Array<{ type: string; name?: string; result?: unknown }> | null,
) {
  try {
    await db.insert(chatbotLogs).values({
      id: nanoid(),
      conversationId,
      siteId,
      teamId,
      query,
      response,
      retrievedChunks: retrieval.chunks.map((c) => ({
        source: c.source,
        similarity: c.similarity,
        contentPreview: c.content.slice(0, 200),
      })),
      topSimilarity: retrieval.chunks[0]?.similarity ?? 0,
      confidenceTier: retrieval.tier,
      viewContext: viewContext as Record<string, unknown> | null,
      toolCalls: toolCalls ? (toolCalls as unknown) : null,
    });
  } catch (err) {
    console.error("Failed to log chatbot conversation:", err);
  }
}
