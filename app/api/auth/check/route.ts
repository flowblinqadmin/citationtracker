import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";

/**
 * GET /api/auth/check?email=...
 *
 * C5 (2026-05-27 audit): this route was a public, unrate-limited
 * email-enumeration oracle. It distinguished registered from unregistered
 * emails via the `{exists}` field, letting an attacker walk a public address
 * list to identify FlowBlinq customers.
 *
 * Fix: always answer `{exists: true}` (no enumeration signal) and impose an
 * aggressive per-IP rate limit so even the no-signal endpoint cannot be used
 * as a slow-side-channel. The login flow's UX is unaffected — every email
 * now flows through OTP regardless, which matches the intended "send code,
 * then verify" behavior.
 */
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const ip = getClientIp(req);
  const rl = await checkRateLimit(`auth_check:${ip}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too Many Requests" }, { status: 429 });
  }

  // Constant response — no enumeration signal.
  return NextResponse.json({ exists: true });
}
