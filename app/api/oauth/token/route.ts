// POST /api/oauth/token — issue JWT access tokens (OAuth 2.0 client_credentials)
// IMPORTANT: Must run in Node.js runtime (bcryptjs is not edge-safe).
// Do NOT add `export const runtime = 'edge'`.

import { NextRequest, NextResponse } from "next/server";
import {
  getApiClientByClientId,
  verifyApiClientSecret,
  touchApiClientLastUsed,
} from "@/lib/db/api-clients";
import { signApiToken } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  try {
    // RFC 6749 §4.4.2 — token endpoint MUST accept application/x-www-form-urlencoded.
    // We also accept application/json for convenience. Anything else => 400.
    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    let grant_type: string | undefined;
    let client_id: string | undefined;
    let client_secret: string | undefined;
    try {
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const form = new URLSearchParams(await req.text());
        grant_type    = form.get("grant_type")    || undefined;
        client_id     = form.get("client_id")     || undefined;
        client_secret = form.get("client_secret") || undefined;
      } else if (contentType.includes("application/json") || contentType === "") {
        const body = await req.json() as {
          grant_type?: string; client_id?: string; client_secret?: string;
        };
        grant_type    = body.grant_type;
        client_id     = body.client_id;
        client_secret = body.client_secret;
      } else {
        return NextResponse.json(
          { error: "invalid_request", error_description: `unsupported content-type: ${contentType}` },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: "invalid_request", error_description: "malformed request body" },
        { status: 400 }
      );
    }

    // Validate request shape
    if (grant_type !== "client_credentials") {
      return NextResponse.json(
        { error: "invalid_request", error_description: "grant_type must be client_credentials" },
        { status: 400 }
      );
    }

    if (!client_id || typeof client_id !== "string") {
      return NextResponse.json(
        { error: "invalid_request", error_description: "client_id is required" },
        { status: 400 }
      );
    }

    if (!client_secret || typeof client_secret !== "string") {
      return NextResponse.json(
        { error: "invalid_request", error_description: "client_secret is required" },
        { status: 400 }
      );
    }

    // Rate limit: 10 requests per minute per client_id
    const rateLimit = await checkRateLimit("oauth:" + client_id, 10, 60_000);
    if (!rateLimit.allowed) {
      console.warn(JSON.stringify({ event: "v1_rate_limit_exceeded", clientId: client_id, count: 10 }));
      return NextResponse.json(
        { error: "rate_limit_exceeded" },
        { status: 429 }
      );
    }

    // Look up client
    const client = await getApiClientByClientId(client_id);
    if (!client) {
      console.warn(JSON.stringify({ event: "oauth_token_rejected", clientId: client_id, reason: "not_found" }));
      return NextResponse.json(
        { error: "invalid_client", error_description: "Client not found" },
        { status: 401 }
      );
    }

    // Check revocation
    if (client.revokedAt) {
      console.warn(JSON.stringify({ event: "oauth_token_rejected", clientId: client_id, reason: "revoked" }));
      return NextResponse.json(
        { error: "client_revoked", error_description: "client_revoked" },
        { status: 401 }
      );
    }

    // Verify secret
    const secretValid = await verifyApiClientSecret(client, client_secret);
    if (!secretValid) {
      console.warn(JSON.stringify({ event: "oauth_token_rejected", clientId: client_id, reason: "bad_secret" }));
      return NextResponse.json(
        { error: "invalid_client", error_description: "Invalid credentials" },
        { status: 401 }
      );
    }

    // Sign JWT
    const accessToken = await signApiToken({
      sub: client.clientId,
      team_id: client.teamId,
      scopes: client.scopes,
    });

    // Update lastUsedAt (fire and forget — don't delay response)
    touchApiClientLastUsed(client.clientId).catch(() => {});

    console.log(JSON.stringify({
      event: "oauth_token_issued",
      clientId: client.clientId,
      teamId: client.teamId,
      scopes: client.scopes,
    }));

    return NextResponse.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: client.scopes.join(" "),
    });

  } catch (err) {
    console.error("[oauth/token] error:", err);
    return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
  }
}
