// Schema-drift gate: every mirrored Drizzle declaration must match the real
// database. Runs against TEST_DATABASE_URL (test fixture locally; point it at
// prod with a read-only role for the pre-deploy check). Catches geo migrations
// that changed a shared table without this repo mirroring the change.
import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getTableColumns, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const dbUrl = process.env.TEST_DATABASE_URL;

const MIRRORED_TABLES = [
  schema.teams,
  schema.teamMembers,
  schema.creditTransactions,
  schema.rateLimits,
  schema.trackerOrgs,
  schema.trackerClients,
  schema.trackerPrompts,
  schema.trackerPromptVersions,
  schema.trackerRuns,
  schema.trackerResponses,
  schema.trackerCitations,
  schema.trackerArticles,
];

describe.skipIf(!dbUrl)("schema drift (mirror vs information_schema)", () => {
  it("every declared column exists in the DB with matching nullability", async () => {

    const problems: string[] = [];

    for (const table of MIRRORED_TABLES) {
      const { name: tableName, schema: schemaName } = getTableConfig(table);
      const pgSchemaName = schemaName ?? "public";

      const rows = await db.execute(sql`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = ${pgSchemaName} AND table_name = ${tableName}
      `);
      const dbCols = new Map(
        (rows as unknown as { column_name: string; is_nullable: string }[]).map((r) => [
          r.column_name,
          r.is_nullable === "YES",
        ]),
      );

      if (dbCols.size === 0) {
        problems.push(`${pgSchemaName}.${tableName}: table missing from database`);
        continue;
      }

      for (const col of Object.values(getTableColumns(table))) {
        const dbNullable = dbCols.get(col.name);
        if (dbNullable === undefined) {
          problems.push(`${pgSchemaName}.${tableName}.${col.name}: column missing from database`);
        } else if (dbNullable === col.notNull) {
          problems.push(
            `${pgSchemaName}.${tableName}.${col.name}: nullability mismatch (mirror notNull=${col.notNull}, db nullable=${dbNullable})`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it("the citation ledger idempotency index exists", async () => {
    const { db } = await import("@/lib/db");
    const { sql } = await import("drizzle-orm");
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'credit_transactions' AND indexname = 'uq_credit_tx_citation_run_op'
    `);
    expect((rows as unknown as unknown[]).length).toBe(1);
  });

  it("the worker idempotency index on tracker.responses exists", async () => {
    // The engine's onConflictDoNothing dedup (resume / QStash re-delivery)
    // silently stops working if this index is missing.
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'tracker' AND tablename = 'responses'
        AND indexname = 'tracker_responses_run_pv_platform_attempt_uniq'
    `);
    expect((rows as unknown as unknown[]).length).toBe(1);
  });
});
