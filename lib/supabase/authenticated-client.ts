import { headers } from "next/headers";

/**
 * Authenticated user from middleware-stamped headers ONLY.
 *
 * updateSession() verifies the session against the Supabase Auth server and
 * stamps x-user-id / x-user-email / x-supabase-token / x-token-exp after
 * stripping any client-supplied values. There is deliberately NO fallback to
 * the Authorization header or to decoding a JWT locally — an unverified decode
 * would be an impersonation primitive if ever reached from a public path.
 */
export async function getAuthenticatedUser() {
  const headersList = await headers();
  const userId = headersList.get("x-user-id");
  const token = headersList.get("x-supabase-token");
  if (!userId || !token) return null;

  const tokenExp = headersList.get("x-token-exp");
  return {
    id: userId,
    email: headersList.get("x-user-email"),
    token,
    tokenExpiry: tokenExp ? new Date(Number(tokenExp) * 1000) : null,
  };
}
