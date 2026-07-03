import { db } from "@/lib/db";
import { apiClients } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import bcrypt from "bcryptjs";
import type { ApiClient } from "@/lib/db/schema";

const SALT_ROUNDS = 12;

// ── createApiClient ───────────────────────────────────────────────────────────
// Returns the plaintext client_secret ONCE — only the hash is stored.

export async function createApiClient(input: {
  teamId: string;
  name: string;
  scopes: string[];
  createdByUserId?: string;
}): Promise<{ client_id: string; client_secret: string }> {
  const clientId = nanoid(24);
  const clientSecret = nanoid(32);
  const clientSecretHash = await bcrypt.hash(clientSecret, SALT_ROUNDS);

  await db.insert(apiClients).values({
    id: nanoid(),
    teamId: input.teamId,
    clientId,
    clientSecretHash,
    name: input.name,
    scopes: input.scopes,
    createdByUserId: input.createdByUserId,
  });

  return { client_id: clientId, client_secret: clientSecret };
}

// ── getApiClientByClientId ────────────────────────────────────────────────────

export async function getApiClientByClientId(clientId: string): Promise<ApiClient | null> {
  const [client] = await db
    .select()
    .from(apiClients)
    .where(eq(apiClients.clientId, clientId));
  return client ?? null;
}

// ── verifyApiClientSecret ─────────────────────────────────────────────────────

export async function verifyApiClientSecret(client: ApiClient, secret: string): Promise<boolean> {
  return bcrypt.compare(secret, client.clientSecretHash);
}

// ── touchApiClientLastUsed ────────────────────────────────────────────────────

export async function touchApiClientLastUsed(clientId: string): Promise<void> {
  await db
    .update(apiClients)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiClients.clientId, clientId));
}

// ── listApiClientsForTeam ─────────────────────────────────────────────────────

export async function listApiClientsForTeam(teamId: string): Promise<ApiClient[]> {
  return db
    .select()
    .from(apiClients)
    .where(and(eq(apiClients.teamId, teamId), isNull(apiClients.revokedAt)));
}

// ── revokeApiClient ───────────────────────────────────────────────────────────

export async function revokeApiClient(clientId: string, teamId: string): Promise<void> {
  await db
    .update(apiClients)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiClients.clientId, clientId), eq(apiClients.teamId, teamId)));
}
