/**
 * ES-e2e-fixtures §b.10 / HP-253 — production-DB safety gate.
 *
 * Called by `seed.ts` and `teardown.ts` as the FIRST line of the main body,
 * before any SQL connection opens. Exit code 2 distinguishes a safety abort
 * from a generic failure (exit 1). AC-7 dual gate:
 *   (a) NODE_ENV === "production" aborts regardless of URL — covers the
 *       SSH-tunnel-to-prod scenario where DATABASE_URL looks local.
 *   (b) DATABASE_URL must match the local Supabase pattern.
 */

export const LOCAL_DB_PATTERN =
  /^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost):54322\//;

/**
 * Companion gate to LOCAL_DB_PATTERN — the Supabase API URL the seed contacts
 * via auth.admin.{listUsers,deleteUser,createUser}. MUST match a local host
 * (127.0.0.1 or localhost) so a prod URL in process.env (e.g. leaked from
 * .env.local during an ad-hoc run outside playwright) can never provision
 * auth.users in production.
 */
// HP-268 tightened regex — ES AC-7(c) requires literal :54321 port. The
// previous (:|/|$) tail accepted any port and would have silently passed
// a :54322 (Postgres port) or portless origin.
export const LOCAL_SUPABASE_URL_PATTERN =
  /^https?:\/\/(127\.0\.0\.1|localhost):54321(\/|$)/;

export class LocalDbAssertionError extends Error {
  constructor(message: string, public readonly guard: "node_env" | "url") {
    super(message);
    this.name = "LocalDbAssertionError";
  }
}

export interface AssertLocalDbOptions {
  /** Override NODE_ENV (for tests). Defaults to `process.env.NODE_ENV`. */
  nodeEnv?: string;
  /** Override DATABASE_URL (for tests). Defaults to `process.env.DATABASE_URL`. */
  databaseUrl?: string;
  /**
   * Exit policy. `"throw"` throws `LocalDbAssertionError` (used by unit tests).
   * `"exit"` writes to stderr and `process.exit(2)`. Default: `"exit"`.
   */
  mode?: "throw" | "exit";
}

function maskUrl(url: string): string {
  return url.replace(/:[^:@]*@/, ":***@");
}

/**
 * Run the dual safety gate. Returns silently on pass. On fail, either throws
 * `LocalDbAssertionError` (`mode:"throw"`) or writes to stderr + exits 2.
 *
 * HP-253 ordering: the NODE_ENV check fires FIRST so the URL regex is never
 * consulted in production contexts. UT-1a asserts this ordering with a spy.
 */
export function assertLocalDb(opts: AssertLocalDbOptions = {}): void {
  const mode = opts.mode ?? "exit";
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL ?? "";

  if (nodeEnv === "production") {
    const msg =
      "[e2e/seed] REFUSING: NODE_ENV=production. Seed/teardown never run in production context.";
    if (mode === "throw") throw new LocalDbAssertionError(msg, "node_env");
    process.stderr.write(msg + "\n");
    process.exit(2);
  }

  if (!LOCAL_DB_PATTERN.test(databaseUrl)) {
    const lines = [
      "[e2e/seed] REFUSING: DATABASE_URL is not a local Supabase URL.",
      "[e2e/seed] Expected: postgresql://…@127.0.0.1:54322/…",
      "[e2e/seed] Got:      " + maskUrl(databaseUrl),
    ];
    const msg = lines.join("\n");
    if (mode === "throw") throw new LocalDbAssertionError(msg, "url");
    for (const l of lines) process.stderr.write(l + "\n");
    process.exit(2);
  }
}

export interface AssertLocalSupabaseUrlOptions {
  /** Override NEXT_PUBLIC_SUPABASE_URL (for tests). */
  supabaseUrl?: string;
  mode?: "throw" | "exit";
}

/**
 * Companion to `assertLocalDb` — gates the Supabase API URL the seed will
 * contact for auth.users provisioning. Prevents a prod URL in process.env
 * (e.g. .env.local leaking into an ad-hoc seed run outside playwright) from
 * ever reaching the admin endpoints.
 */
export function assertLocalSupabaseUrl(opts: AssertLocalSupabaseUrlOptions = {}): void {
  const mode = opts.mode ?? "exit";
  const url = opts.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!LOCAL_SUPABASE_URL_PATTERN.test(url)) {
    const msg =
      `[e2e/seed] Non-local SUPABASE_URL detected: ${url || "<unset>"}. ` +
      "Seed refuses to contact non-local Supabase. Ensure playwright.config.ts " +
      "LOCAL_SUPABASE_ENV is applied OR set NEXT_PUBLIC_SUPABASE_URL to " +
      "http://127.0.0.1:54321 before invoking seed.";
    if (mode === "throw") throw new LocalDbAssertionError(msg, "url");
    process.stderr.write(msg + "\n");
    process.exit(2);
  }
}
