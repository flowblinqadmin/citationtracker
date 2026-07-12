// POST /api/brands/suggest — onboarding auto-population.
// Given a domain, returns a suggested brand name, competitors, and prompts.
// Provider failure is NEVER a 5xx: the engine degrades to empties, and the
// route also catches any thrown error and returns the same 200-degraded body.
import { NextRequest, NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { checkRateLimit } from "@/lib/rate-limit";
import { normalizeDomain } from "@/lib/domain";
import { fetchBrandSuggestions } from "@/lib/suggest";

const SUGGESTS_PER_HOUR = 10; // per team — each call burns a Firecrawl scrape + an LLM call
const DEGRADED = { name: null as string | null, competitors: [], prompts: [] };

export async function POST(req: NextRequest) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const rawDomain = body && typeof body.domain === "string" ? body.domain : "";
  const domain = normalizeDomain(rawDomain);
  if (!domain) return NextResponse.json({ error: "invalid domain" }, { status: 400 });

  const rate = await checkRateLimit(`cite-suggest:${ctx.teamId}`, SUGGESTS_PER_HOUR, 60 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded — try again later" }, { status: 429 });
  }

  try {
    const suggestions = await fetchBrandSuggestions(domain);
    return NextResponse.json(suggestions);
  } catch {
    // Belt-and-suspenders: the engine should already degrade, but a thrown
    // provider error must still be a 200-degraded response, never a 5xx.
    return NextResponse.json(DEGRADED);
  }
}
