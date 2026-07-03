import { SignJWT } from "jose";

interface ExchangeCodeParams {
  accessToken: string;
  refreshToken: string;
  redirect: string;
  siteToken: string;
  siteId: string;
}

/**
 * Generate a short-lived JWT exchange code for cross-domain session handoff.
 * Contains Supabase session tokens + site access token so the receiving
 * domain can establish a session without exposing tokens in URLs.
 */
export async function generateExchangeCode(params: ExchangeCodeParams): Promise<string> {
  const jwtSecret = process.env.API_JWT_SECRET;
  if (!jwtSecret) throw new Error("API_JWT_SECRET not configured");

  const secret = new TextEncoder().encode(jwtSecret);
  return new SignJWT({
    access_token: params.accessToken,
    refresh_token: params.refreshToken,
    redirect: params.redirect,
    site_token: params.siteToken,
    site_id: params.siteId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(secret);
}
