import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { consentRecords } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { CURRENT_TOS_VERSION, CURRENT_EULA_VERSION } from "@/lib/config";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";

/**
 * GET /api/consent — check if authenticated user has accepted current TOS+EULA
 * POST /api/consent — record consent for authenticated user
 */

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user?.id) {
    return NextResponse.json({ hasConsent: false });
  }

  const [record] = await db.select({ id: consentRecords.id })
    .from(consentRecords)
    .where(and(
      eq(consentRecords.userId, user.id),
      eq(consentRecords.tosVersion, CURRENT_TOS_VERSION),
      eq(consentRecords.eulaVersion, CURRENT_EULA_VERSION),
    ));

  return NextResponse.json({ hasConsent: !!record });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user?.id || !user?.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json() as { tosAccepted?: boolean };
  if (!body.tosAccepted) {
    return NextResponse.json({ error: "TOS acceptance required" }, { status: 400 });
  }

  const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
  const userAgent = req.headers.get("user-agent") ?? "unknown";

  await db.insert(consentRecords).values({
    id: nanoid(),
    userId: user.id,
    email: user.email,
    tosVersion: CURRENT_TOS_VERSION,
    eulaVersion: CURRENT_EULA_VERSION,
    acceptedAt: new Date(),
    ipAddress,
    userAgent,
    createdAt: new Date(),
  }).onConflictDoNothing();

  return NextResponse.json({ success: true });
}
