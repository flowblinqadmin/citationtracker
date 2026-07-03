import { NextResponse } from "next/server";
import postgres from "postgres";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const ALLOWED_EMAILS = [
  "ar@flowblinq.com",
  "an@flowblinq.com",
  "roshan@flowblinq.com",
];

let _sql: ReturnType<typeof postgres> | null = null;

function getPartsSql(): ReturnType<typeof postgres> | null {
  if (_sql) return _sql;
  const url = process.env.NEON_PARTS_DB_URL;
  if (!url) {
    console.error("[parts/intel] NEON_PARTS_DB_URL not configured; refusing to serve");
    return null;
  }
  _sql = postgres(url, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: "require",
  });
  return _sql;
}

async function validateAuth(request: Request): Promise<{ email: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user?.email) return null;

  const email = user.email.toLowerCase();
  if (!ALLOWED_EMAILS.includes(email)) return null;

  return { email };
}

export async function GET(request: Request) {
  const auth = await validateAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const seller = searchParams.get("seller") || "demo";

  try {
    const sql = getPartsSql();
    if (!sql) {
      return NextResponse.json({ error: "Parts intel not configured" }, { status: 503 });
    }
    const [row] = await sql`
      SELECT data, generated_at
      FROM parts_intel
      WHERE seller = ${seller}
      ORDER BY generated_at DESC
      LIMIT 1
    `;

    if (!row) {
      return NextResponse.json(
        { error: "No intel data found. Run: node scripts/parts/compute-intel.mjs" },
        { status: 404 }
      );
    }

    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "private, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    console.error("Parts intel API error:", err);
    return NextResponse.json(
      { error: "Failed to fetch intel data" },
      { status: 500 }
    );
  }
}
