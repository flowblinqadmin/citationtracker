// Direct DB access for tests — set balances, simulate geo's worker finishing.
import postgres from "postgres";
import { E2E } from "./global-setup";

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E.dbUrl, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

export const setBalance = (credits: number) =>
  withDb((sql) => sql`UPDATE teams SET credit_balance = ${credits} WHERE id = ${E2E.teamId}`);

export const getBalance = () =>
  withDb(async (sql) => {
    const [row] = await sql`SELECT credit_balance FROM teams WHERE id = ${E2E.teamId}`;
    return row.credit_balance as number;
  });

/** Simulate geo's deployed worker completing a run with stored metrics. */
export const completeRun = (runId: string) =>
  withDb(
    (sql) => sql`
      UPDATE tracker.runs
      SET status = 'complete', completed_at = now(), metrics = ${sql.json({
        promptsTotal: 2,
        citationRate: 0.5,
        brandMentionRate: 1,
        totalCitations: 3,
        uniqueArticlesCited: 0,
        newThisMonthCited: 0,
        shareOfAiVoice: 0.75,
        topCitedArticles: [],
        platformBreakdown: [],
        competitorMetrics: [],
      })}
      WHERE id = ${runId}
    `,
  );

export const latestRunId = () =>
  withDb(async (sql) => {
    const [row] = await sql`
      SELECT r.id FROM tracker.runs r WHERE r.org_id = ${"team_" + E2E.teamId}
      ORDER BY r.created_at DESC LIMIT 1
    `;
    return row?.id as string | undefined;
  });
