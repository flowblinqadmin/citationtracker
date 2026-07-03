import { createClient } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Creates a Supabase client using the JWT forwarded from middleware.
 * Eliminates the need for duplicate auth.getUser() calls.
 *
 * @returns Object containing authenticated Supabase client, userId, and token
 * @throws Error if no authentication token is found in headers
 */
export async function createAuthenticatedClient() {
  const headersList = await headers();
  const token = headersList.get("x-supabase-token");
  const userId = headersList.get("x-user-id");

  if (!token) {
    throw new Error("No authentication token found");
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    }
  );

  return { supabase, userId, token };
}

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

/**
 * Higher-order function that wraps API route handlers with authentication.
 * Automatically checks for authenticated user and passes user info to handler.
 *
 * @example
 * export const GET = withAuth(async (request, user) => {
 *   const { supabase } = await createAuthenticatedClient();
 *   return NextResponse.json({ data: "success" });
 * });
 */
export function withAuth<T extends unknown[]>(
  handler: (
    ...args: [...T, { id: string; email: string | null; token: string; tokenExpiry: Date | null }]
  ) => Promise<NextResponse>
) {
  return async (...args: T): Promise<NextResponse> => {
    const user = await getAuthenticatedUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return handler(...args, user);
  };
}
