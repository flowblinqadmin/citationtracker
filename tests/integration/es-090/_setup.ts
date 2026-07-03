/**
 * ES-090 integration-test setup helpers.
 * Shared DB connection + seed/teardown utilities.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { geoSites, teams } from "@/lib/db/schema";

const DB_URL =
  process.env.SUPABASE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL;

if (!DB_URL) {
  throw new Error("ES-090 IT requires SUPABASE_DATABASE_URL / DATABASE_URL");
}

const sql = postgres(DB_URL, { prepare: false });
export const db = drizzle(sql);
export { eq };

export interface SeededSite {
  id: string;
  domain: string;
  ownerEmail: string;
  accessToken: string;
  teamId: string | null;
}

export async function seedSite(opts: {
  withTeam?: boolean;
  tokenExpiresAt?: Date | null;
  pipelineStatus?: string;
} = {}): Promise<SeededSite> {
  const teamId = opts.withTeam ? randomUUID() : null;
  if (teamId) {
    await db.insert(teams).values({
      id: teamId,
      name: `es090-test-${teamId.slice(0, 8)}`,
      creditBalance: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  const id = randomUUID();
  const accessToken = `tok_${randomUUID().replace(/-/g, "")}`;
  await db.insert(geoSites).values({
    id,
    domain: `es090-${id.slice(0, 8)}.test`,
    slug: `es090-${id.slice(0, 8)}`,
    ownerEmail: `es090+${id.slice(0, 8)}@example.test`,
    accessToken,
    emailVerified: true,
    pipelineStatus: opts.pipelineStatus ?? "complete",
    teamId,
    // tokenExpiresAt column is added by ES-090 migration. Drizzle will throw
    // on unknown column until the migration lands — this is the deliberate
    // RED on the schema side.
    ...(opts.tokenExpiresAt !== undefined ? { tokenExpiresAt: opts.tokenExpiresAt } : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Parameters<typeof db.insert>[0] extends never ? never : Record<string, unknown>);
  return {
    id,
    domain: `es090-${id.slice(0, 8)}.test`,
    ownerEmail: `es090+${id.slice(0, 8)}@example.test`,
    accessToken,
    teamId,
  };
}

export async function cleanupSite(id: string): Promise<void> {
  await db.delete(geoSites).where(eq(geoSites.id, id));
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
