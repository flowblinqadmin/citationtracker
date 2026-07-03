/**
 * e2e/helpers/login.ts — shared login helpers for Playwright specs.
 *
 * Default `loginViaOtp` (Wave-1 globalSetup pivot — corr 81fe9767):
 *   1. admin.generateLink({ type:'magiclink', email }) → returns the
 *      `hashed_token` (token_hash) needed for OTP verification.
 *   2. Regular @supabase/supabase-js client.auth.verifyOtp({ type:'magiclink',
 *      token_hash }) → materializes a real session (access_token,
 *      refresh_token).
 *   3. A throw-away @supabase/ssr server client is constructed with
 *      capture-only cookie setters; calling `setSession(session)` causes
 *      that SSR client to emit the exact cookies the app's middleware/layout
 *      expects to find (cookie name + chunking + value encoding all match
 *      because we're using the same library the product uses).
 *   4. Playwright BrowserContext.addCookies receives those cookies, scoped to
 *      the test BASE_URL host. page.goto('/dashboard') then renders authed,
 *      with /consent intercept handled if it fires.
 *
 * No browser-driven /auth/login flow, no Mailpit, no /auth/callback hash
 * roundtrip. Pure service-role test infra.
 *
 * `loginViaOtpUI` preserves the original UI + Mailpit-poll flow for specs
 * that explicitly exercise the /auth/login form.
 *
 * Shastri greenlight: corr wave-1-autonomy-redispatch-2026-04-26 (test-infra
 * decisions delegated). CoFounder greenlight for Option A: corr 81fe9767.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getOtp } from "./otp";
import { getAdminClient } from "./supabase-admin";

// URL used for *actual* Supabase API calls (admin.generateLink, verifyOtp).
// The Playwright host process talks directly to local Supabase on the host
// network; host.docker.internal does not resolve from the host so this must
// remain a host-reachable URL (default 127.0.0.1:54321).
const LOCAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";

// projectRef used to derive the canonical @supabase/ssr cookie name
// (`sb-<projectRef>-auth-token`). The product container's middleware
// initializes @supabase/ssr with whatever NEXT_PUBLIC_SUPABASE_URL it sees
// inside the container; in the UAT-overlay that is
// `http://host.docker.internal:54321`, which derives a DIFFERENT projectRef
// (`host`) than the host-side `127.0.0.1` (`127`). If the cookie name the
// helper bakes does not match the name middleware reads, the browser
// session is invisible to the app.
//
// We cannot construct the cookie-bake @supabase/ssr client directly with
// host.docker.internal: the host process can't resolve that hostname, and
// supabase-js setSession network-hits the auth endpoint (`_getUser`) before
// emitting cookies. Instead we BAKE against the host-reachable
// LOCAL_SUPABASE_URL and then RENAME the captured cookie from
// `sb-<host-projectRef>-auth-token` (and chunked variants) to
// `sb-<container-projectRef>-auth-token` so middleware reads it correctly.
//
// PLAYWRIGHT_SUPABASE_URL (override): when set, its hostname's first
// dot-segment becomes the target projectRef for the rename. Default falls
// through to LOCAL_SUPABASE_URL so pure-localhost runs (Playwright vs
// `next dev` on localhost:3000) keep working unchanged.
const COOKIE_NAME_URL = process.env.PLAYWRIGHT_SUPABASE_URL ?? LOCAL_SUPABASE_URL;

function projectRefFromUrl(u: string): string {
  try { return new URL(u).hostname.split(".")[0]; } catch { return "127"; }
}
const SOURCE_REF = projectRefFromUrl(LOCAL_SUPABASE_URL);
const TARGET_REF = projectRefFromUrl(COOKIE_NAME_URL);

const LOCAL_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  // Local-Supabase well-known anon JWT (matches supabase-admin.ts).
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

function resolveBaseUrl(page: Page): string {
  const fromEnv = process.env.PLAYWRIGHT_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  try {
    const u = new URL(page.url());
    if (u.origin && u.origin !== "about:blank") return u.origin;
  } catch { /* ignore */ }
  return "http://localhost:3000";
}

type CapturedCookie = { name: string; value: string; options?: Record<string, unknown> };

/**
 * Mint Supabase auth cookies for `email` via service-role admin → verifyOtp →
 * @supabase/ssr capture-only setSession. Exported separately so specs can
 * bake additional users into a context without going through the
 * BASE_URL-binding flow in loginViaOtp (which is the storageState bootstrap
 * path).
 */
export async function mintAuthCookies(email: string): Promise<CapturedCookie[]> {
  const admin = getAdminClient();
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr) {
    throw new Error(`[mintAuthCookies] admin.generateLink failed for ${email}: ${linkErr.message}`);
  }
  const tokenHash = linkData?.properties?.hashed_token;
  if (!tokenHash) {
    throw new Error(`[mintAuthCookies] admin.generateLink returned no hashed_token for ${email}`);
  }

  const verifier = createPlainClient(LOCAL_SUPABASE_URL, LOCAL_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: verifyData, error: verifyErr } = await verifier.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });
  if (verifyErr) {
    throw new Error(`[mintAuthCookies] verifyOtp failed for ${email}: ${verifyErr.message}`);
  }
  const session = verifyData?.session;
  if (!session?.access_token || !session?.refresh_token) {
    throw new Error(`[mintAuthCookies] verifyOtp returned no session for ${email}`);
  }

  // Capture-only SSR client: re-emits cookies that the product's middleware/
  // layout consumes. Cookie name/chunking/encoding match because both sides
  // use @supabase/ssr.
  const captured: CapturedCookie[] = [];
  const baker = createServerClient(LOCAL_SUPABASE_URL, LOCAL_ANON_KEY, {
    cookies: {
      getAll: () => [],
      setAll: (toSet: CapturedCookie[]) => {
        for (const c of toSet) captured.push(c);
      },
    },
  });
  await baker.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (captured.length === 0) {
    throw new Error(`[mintAuthCookies] @supabase/ssr emitted no cookies for ${email}`);
  }

  // projectRef rename: `sb-<SOURCE_REF>-auth-token` → `sb-<TARGET_REF>-auth-token`
  // (preserving chunk suffixes like `.0`, `.1` if Supabase emitted chunked
  // cookies). No-op when SOURCE_REF === TARGET_REF.
  if (SOURCE_REF !== TARGET_REF) {
    const sourcePrefix = `sb-${SOURCE_REF}-auth-token`;
    const targetPrefix = `sb-${TARGET_REF}-auth-token`;
    for (const c of captured) {
      if (c.name === sourcePrefix || c.name.startsWith(`${sourcePrefix}.`)) {
        c.name = targetPrefix + c.name.slice(sourcePrefix.length);
      }
    }
  }
  return captured;
}

export async function loginViaOtp(page: Page, email: string): Promise<void> {
  const baseUrl = resolveBaseUrl(page);
  const host = (() => {
    try { return new URL(baseUrl).hostname; } catch { return "localhost"; }
  })();
  const captured = await mintAuthCookies(email);

  await page.context().addCookies(
    captured.map((c) => ({
      name: c.name,
      value: c.value,
      domain: host,
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    })),
  );

  await page.goto(`${baseUrl}/dashboard`);
  await expect(page).toHaveURL(/\/(dashboard|consent)/, { timeout: 20_000 });
  if (page.url().includes("/consent")) {
    await page.getByRole("button", { name: /accept|agree|continue/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  }
}

/**
 * UI-flow login: drives /auth/login + Mailpit OTP poll. Reserved for specs
 * that test the login form itself.
 */
export async function loginViaOtpUI(page: Page, email: string): Promise<void> {
  await page.goto("/auth/login");
  await expect(page.getByPlaceholder(/you@yourcompany\.com/i)).toBeVisible();
  await page.getByPlaceholder(/you@yourcompany\.com/i).fill(email);
  const sendBtn = page.getByRole("button", { name: /Send Code/i });
  await expect(sendBtn).toBeEnabled();
  await sendBtn.click();
  await expect(page.getByPlaceholder(/6-digit code/i)).toBeVisible({ timeout: 20_000 });
  const code = await getOtp("login", email, { timeoutMs: 20_000 });
  await page.getByPlaceholder(/6-digit code/i).fill(code);
  const verifyBtn = page.getByRole("button", { name: /Verify Code/i });
  await expect(verifyBtn).toBeEnabled();
  await verifyBtn.click();
  await expect(page).toHaveURL(/\/(dashboard|consent)/, { timeout: 20_000 });
  if (page.url().includes("/consent")) {
    await page.getByRole("button", { name: /accept|agree|continue/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  }
}
