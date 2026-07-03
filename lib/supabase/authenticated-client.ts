import { headers } from "next/headers";

/**
 * Gets authenticated user information from forwarded headers.
 * No Supabase API call needed — data is extracted from middleware headers.
 *
 * @returns User information object or null if not authenticated
 */
export async function getAuthenticatedUser() {
  const headersList = await headers();
  const userId = headersList.get("x-user-id");
  const email = headersList.get("x-user-email");
  const tokenExp = headersList.get("x-token-exp");

  // Primary: token forwarded by middleware
  let token = headersList.get("x-supabase-token");

  // Fallback: Authorization: Bearer <token> (used by dashboard server component)
  if (!token) {
    const authHeader = headersList.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }

  if (!token) return null;

  // If middleware forwarded userId, use it directly
  if (userId) {
    return {
      id: userId,
      email,
      token,
      tokenExpiry: tokenExp ? new Date(Number(tokenExp) * 1000) : null,
    };
  }

  // Fallback: decode userId from the JWT (no network call)
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    if (!payload.sub) return null;
    return {
      id: payload.sub as string,
      email: (payload.email as string | undefined) ?? null,
      token,
      tokenExpiry: payload.exp ? new Date(payload.exp * 1000) : null,
    };
  } catch {
    return null;
  }
}

