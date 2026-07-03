import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { chatbotLogs, geoSiteView } from "@/lib/db/schema";
import { desc, inArray } from "drizzle-orm";
import { shouldEscalate } from "@/lib/chatbot/escalation";

const COPPER = "#c2652a";
const COPPER_BG = "#fff7ed";
const BORDER = "#e5e5ea";
const TEXT = "#1d1d1f";
const T2 = "#86868b";
const BG = "#fafafa";
const FONT_STACK = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

type Row = typeof chatbotLogs.$inferSelect;

type Conversation = {
  id: string;
  siteId: string | null;
  domain: string | null;
  lastUserMessage: string;
  topSimilarity: number;
  confidenceTier: string;
  toolUsed: boolean;
  escalated: boolean;
  lowConfidence: boolean;
  createdAt: Date | null;
  rowCount: number;
};

export default async function CleoTriagePage(
  { searchParams }: { searchParams: Promise<{ reveal?: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isAdminEmail(user?.email)) notFound();

  const { reveal } = await searchParams;
  const revealEmails = reveal === "1";

  const rows = await db
    .select()
    .from(chatbotLogs)
    .orderBy(desc(chatbotLogs.createdAt))
    .limit(200);

  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const list = grouped.get(row.conversationId) ?? [];
    list.push(row);
    grouped.set(row.conversationId, list);
  }

  // Resolve domains for distinct siteIds in one query.
  // Never read accessToken here — it's a bearer token granting site read access
  // and would leak into rendered HTML if surfaced.
  const siteIds = Array.from(new Set(rows.map((r) => r.siteId).filter((s): s is string => !!s)));
  const sites = siteIds.length
    ? await db
        .select({ siteId: geoSiteView.siteId, domain: geoSiteView.domain })
        .from(geoSiteView)
        .where(inArray(geoSiteView.siteId, siteIds))
    : [];
  const siteById = new Map(sites.map((s) => [s.siteId, s] as const));

  const conversations: Conversation[] = Array.from(grouped.entries()).map(([id, list]) => {
    const sorted = [...list].sort(
      (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
    );
    const messages = sorted.flatMap((r) => [
      { role: "user" as const, text: r.query },
      { role: "assistant" as const, text: r.response },
    ]);
    const escalated = shouldEscalate(messages);
    const last = sorted[sorted.length - 1];
    const topSimilarity = sorted.reduce((max, r) => Math.max(max, r.topSimilarity ?? 0), 0);
    const toolUsed = sorted.some((r) => Array.isArray(r.toolCalls) && (r.toolCalls as unknown[]).length > 0);
    const lastUser = sorted[sorted.length - 1]?.query ?? "(no query)";
    return {
      id,
      siteId: last.siteId,
      domain: last.siteId ? siteById.get(last.siteId)?.domain ?? null : null,
      lastUserMessage: lastUser,
      topSimilarity,
      confidenceTier: last.confidenceTier ?? "?",
      toolUsed,
      escalated,
      lowConfidence: topSimilarity < 0.45,
      createdAt: last.createdAt,
      rowCount: sorted.length,
    };
  });

  conversations.sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
  );

  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: FONT_STACK, color: TEXT }}>
      <div style={{ padding: "32px 40px", maxWidth: 1280, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Cleo triage</h1>
            <p style={{ fontSize: 13, color: T2, margin: "4px 0 0" }}>
              Last {rows.length} chatbot rows · {conversations.length} conversations
            </p>
          </div>
          <div style={{ fontSize: 12, color: T2 }}>
            {revealEmails ? (
              <Link href="/admin/cleo" style={{ color: COPPER }}>Hide emails</Link>
            ) : (
              <Link href="/admin/cleo?reveal=1" style={{ color: COPPER }}>Show emails</Link>
            )}
          </div>
        </div>

        <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f5f5f7", textAlign: "left" }}>
                <th style={th}>Conversation</th>
                <th style={th}>Site</th>
                <th style={th}>Tier</th>
                <th style={th}>Flags</th>
                <th style={th}>When</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                  <td style={td}>
                    <Link
                      href={`/admin/cleo/${c.id}${revealEmails ? "?reveal=1" : ""}`}
                      style={{ color: COPPER, textDecoration: "none", fontWeight: 500 }}
                    >
                      {c.lastUserMessage.slice(0, 80)}
                    </Link>
                    <div style={{ color: T2, fontSize: 11, marginTop: 2 }}>
                      {c.rowCount} turn{c.rowCount === 1 ? "" : "s"} · sim {c.topSimilarity.toFixed(2)}
                    </div>
                  </td>
                  <td style={td}>
                    {c.domain ?? <span style={{ color: T2 }}>—</span>}
                    {c.siteId && (
                      <div style={{ color: T2, fontSize: 11, marginTop: 2, fontFamily: "monospace" }}>
                        {c.siteId.slice(0, 12)}…
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    <span style={tierChip(c.confidenceTier)}>{c.confidenceTier}</span>
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {c.escalated && <span style={chipDanger}>Escalated</span>}
                      {c.lowConfidence && <span style={chipWarn}>Low confidence</span>}
                      {c.toolUsed && <span style={chipInfo}>Tool used</span>}
                    </div>
                  </td>
                  <td style={td}>
                    {c.createdAt
                      ? c.createdAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                      : "—"}
                  </td>
                </tr>
              ))}
              {conversations.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ ...td, textAlign: "center", color: T2, padding: "40px 16px" }}>
                    No chatbot conversations recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "10px 14px", fontWeight: 600, fontSize: 12, color: T2, textTransform: "uppercase", letterSpacing: "0.4px" };
const td: React.CSSProperties = { padding: "12px 14px", verticalAlign: "top" };
const chipBase: React.CSSProperties = { padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 500 };
const chipDanger: React.CSSProperties = { ...chipBase, background: "#fef2f2", color: "#b91c1c" };
const chipWarn: React.CSSProperties = { ...chipBase, background: "#fef3c7", color: "#92400e" };
const chipInfo: React.CSSProperties = { ...chipBase, background: COPPER_BG, color: COPPER };
function tierChip(tier: string): React.CSSProperties {
  if (tier === "full") return { ...chipBase, background: "#ecfdf5", color: "#047857" };
  if (tier === "hedged") return { ...chipBase, background: "#fef3c7", color: "#92400e" };
  return { ...chipBase, background: "#f5f5f7", color: T2 };
}
