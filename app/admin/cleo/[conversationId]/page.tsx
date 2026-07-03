import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { chatbotLogs, geoSiteView } from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import AddToGoldenSetButton from "./AddToGoldenSetButton";

const COPPER = "#c2652a";
const COPPER_BG = "#fff7ed";
const BORDER = "#e5e5ea";
const TEXT = "#1d1d1f";
const T2 = "#86868b";
const BG = "#fafafa";
const FONT_STACK = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export default async function CleoConversationDetail(
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isAdminEmail(user?.email)) notFound();

  const { conversationId } = await params;
  const isProd = process.env.VERCEL_ENV === "production";

  const rows = await db
    .select()
    .from(chatbotLogs)
    .where(eq(chatbotLogs.conversationId, conversationId))
    .orderBy(asc(chatbotLogs.createdAt));

  if (!rows.length) notFound();

  const siteId = rows[rows.length - 1].siteId;
  const [site] = siteId
    ? await db
        .select({ siteId: geoSiteView.siteId, domain: geoSiteView.domain })
        .from(geoSiteView)
        .where(eq(geoSiteView.siteId, siteId))
    : [];

  const last = rows[rows.length - 1];
  const lastQuery = last.query;
  const lastResponse = last.response;

  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: FONT_STACK, color: TEXT }}>
      <div style={{ padding: "32px 40px", maxWidth: 1024, margin: "0 auto" }}>
        <Link href="/admin/cleo" style={{ color: COPPER, fontSize: 13 }}>← Back to triage</Link>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Conversation</h1>
            <div style={{ fontFamily: MONO, fontSize: 12, color: T2, marginTop: 4 }}>{conversationId}</div>
          </div>
          {site?.domain && (
            <span style={{ color: T2, fontSize: 13 }}>
              {site.domain}
            </span>
          )}
        </div>

        {/* Transcript */}
        <h2 style={h2Style}>Transcript</h2>
        <div style={cardStyle}>
          {rows.map((r) => (
            <div key={r.id} style={{ marginBottom: 16 }}>
              <Bubble role="user" text={r.query} />
              <Bubble role="assistant" text={r.response} />
              <div style={metaRowStyle}>
                tier: <strong>{r.confidenceTier ?? "?"}</strong> · sim: {(r.topSimilarity ?? 0).toFixed(3)}
                {r.viewContext ? ` · view: ${describeView(r.viewContext)}` : ""}
                {r.createdAt ? ` · ${r.createdAt.toLocaleString()}` : ""}
              </div>
            </div>
          ))}
        </div>

        {/* Retrieved chunks (last turn) */}
        <h2 style={h2Style}>Retrieved chunks (last turn)</h2>
        <div style={cardStyle}>
          {Array.isArray(last.retrievedChunks) && (last.retrievedChunks as unknown[]).length ? (
            (last.retrievedChunks as Array<{ source: string; similarity: number; contentPreview: string }>).map((c, i) => (
              <div key={i} style={{ borderBottom: `1px solid ${BORDER}`, padding: "8px 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T2, marginBottom: 4 }}>
                  <span style={{ fontFamily: MONO }}>{c.source}</span>
                  <span>sim {c.similarity.toFixed(3)}</span>
                </div>
                <div style={{ fontSize: 13, color: TEXT, whiteSpace: "pre-wrap" }}>{c.contentPreview}</div>
              </div>
            ))
          ) : (
            <div style={{ color: T2, fontSize: 13 }}>No chunks recorded.</div>
          )}
        </div>

        {/* Tool calls */}
        <h2 style={h2Style}>Tool calls (last turn)</h2>
        <div style={cardStyle}>
          {last.toolCalls && Array.isArray(last.toolCalls) && (last.toolCalls as unknown[]).length ? (
            <pre style={{
              fontFamily: MONO, fontSize: 12, color: TEXT, background: "#f5f5f7",
              padding: 12, borderRadius: 8, overflowX: "auto", margin: 0,
            }}>{JSON.stringify(last.toolCalls, null, 2)}</pre>
          ) : (
            <div style={{ color: T2, fontSize: 13 }}>No tool calls recorded.</div>
          )}
        </div>

        {/* Add to golden set */}
        <h2 style={h2Style}>Promote to golden set</h2>
        <div style={cardStyle}>
          <p style={{ fontSize: 13, color: T2, marginTop: 0 }}>
            Capture this conversation as a regression case in <code>eval/failures/curated.jsonl</code>.
            The user query becomes the input; the expected answer below grounds the assertion.
          </p>
          <AddToGoldenSetButton
            conversationId={conversationId}
            isProd={isProd}
            defaultExpected={lastResponse.slice(0, 400)}
          />
          <div style={{ fontSize: 11, color: T2, marginTop: 8 }}>
            Latest user query: <em>{lastQuery.slice(0, 160)}</em>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, text }: { role: "user" | "assistant"; text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: role === "user" ? "flex-end" : "flex-start", marginBottom: 6 }}>
      <div style={{
        maxWidth: "85%", padding: "10px 14px",
        borderRadius: role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
        background: role === "user" ? COPPER : "#f0f0f2",
        color: role === "user" ? "#fff" : TEXT,
        fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>{text}</div>
    </div>
  );
}

function describeView(view: unknown): string {
  if (!view || typeof view !== "object") return String(view);
  const v = view as Record<string, unknown>;
  const parts: string[] = [];
  if (v.page) parts.push(String(v.page));
  if (v.currentTab) parts.push(`tab=${v.currentTab}`);
  if (v.platformDetected) parts.push(`platform=${v.platformDetected}`);
  return parts.join(" ");
}

const h2Style: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: "0.4px", marginTop: 24, marginBottom: 8 };
const cardStyle: React.CSSProperties = { background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16 };
const metaRowStyle: React.CSSProperties = { fontSize: 11, color: T2, marginTop: 4, padding: "4px 8px", background: COPPER_BG, borderRadius: 4, display: "inline-block" };
