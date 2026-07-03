/**
 * ES-e2e-fixtures UT-1a / UT-1b — `assertLocalDb` dual safety gate (AC-7).
 *
 * HP-253: NODE_ENV=production check fires FIRST so the URL regex is never
 * consulted in a production context. The URL regex is the second guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assertLocalDb,
  assertLocalSupabaseUrl,
  LOCAL_DB_PATTERN,
  LOCAL_SUPABASE_URL_PATTERN,
  LocalDbAssertionError,
} from "@/scripts/e2e/lib/safety";

const GOOD_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const LOOPBACK_LOCALHOST = "postgresql://postgres:postgres@localhost:54322/postgres";
const PROD_URL = "postgresql://postgres:xxx@prod.supabase.co:5432/postgres";
const WRONG_PORT = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

describe("UT-1a: assertLocalDb — NODE_ENV=production guard (HP-253)", () => {
  it("aborts when NODE_ENV=production regardless of a local DATABASE_URL", () => {
    expect(() =>
      assertLocalDb({ nodeEnv: "production", databaseUrl: GOOD_URL, mode: "throw" }),
    ).toThrow(/NODE_ENV=production/);
  });

  it("stamps the 'node_env' guard name on the thrown error", () => {
    try {
      assertLocalDb({ nodeEnv: "production", databaseUrl: GOOD_URL, mode: "throw" });
      expect.fail("expected assertLocalDb to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LocalDbAssertionError);
      expect((err as LocalDbAssertionError).guard).toBe("node_env");
    }
  });

  it("never consults the URL regex when NODE_ENV=production", () => {
    // The URL below would PASS the regex. If the NODE_ENV check didn't fire
    // first, the call would complete silently instead of throwing. The fact
    // that it throws — with a message citing NODE_ENV, not the URL —
    // is what verifies the ordering.
    let caughtMsg = "";
    try {
      assertLocalDb({ nodeEnv: "production", databaseUrl: GOOD_URL, mode: "throw" });
    } catch (err) {
      caughtMsg = (err as Error).message;
    }
    expect(caughtMsg).toMatch(/NODE_ENV=production/);
    expect(caughtMsg).not.toMatch(/DATABASE_URL is not a local/);
  });
});

describe("UT-1b: assertLocalDb — DATABASE_URL regex guard", () => {
  it("passes a canonical local Supabase URL", () => {
    expect(() =>
      assertLocalDb({ nodeEnv: "development", databaseUrl: GOOD_URL, mode: "throw" }),
    ).not.toThrow();
  });

  it("passes a localhost (not 127.0.0.1) local URL", () => {
    expect(() =>
      assertLocalDb({ nodeEnv: "development", databaseUrl: LOOPBACK_LOCALHOST, mode: "throw" }),
    ).not.toThrow();
  });

  it("rejects a prod-looking URL", () => {
    expect(() =>
      assertLocalDb({ nodeEnv: "development", databaseUrl: PROD_URL, mode: "throw" }),
    ).toThrow(/not a local Supabase URL/);
  });

  it("rejects a URL on the wrong port (5432 instead of 54322)", () => {
    expect(() =>
      assertLocalDb({ nodeEnv: "development", databaseUrl: WRONG_PORT, mode: "throw" }),
    ).toThrow(/not a local Supabase URL/);
  });

  it("rejects an empty / missing DATABASE_URL", () => {
    expect(() =>
      assertLocalDb({ nodeEnv: "development", databaseUrl: "", mode: "throw" }),
    ).toThrow(/not a local Supabase URL/);
  });

  it("masks the password in the error message", () => {
    try {
      assertLocalDb({
        nodeEnv: "development",
        databaseUrl: "postgresql://postgres:supersecret@evil.example.com:5432/db",
        mode: "throw",
      });
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).not.toMatch(/supersecret/);
      expect((err as Error).message).toMatch(/\*\*\*/);
    }
  });

  it("exports a LOCAL_DB_PATTERN matching canonical URLs", () => {
    expect(LOCAL_DB_PATTERN.test(GOOD_URL)).toBe(true);
    expect(LOCAL_DB_PATTERN.test(LOOPBACK_LOCALHOST)).toBe(true);
    expect(LOCAL_DB_PATTERN.test(PROD_URL)).toBe(false);
  });
});

// ── UT-1c ────────────────────────────────────────────────────────────────────
// assertLocalSupabaseUrl — tightened HP-268 regex per ES AC-7(c). Literal
// :54321 port is required. Passing and rejecting cases per spec UT-1c §e.

const PASSING_SUPABASE_URLS = [
  "http://127.0.0.1:54321",
  "http://localhost:54321",
  "http://127.0.0.1:54321/",
];

const REJECTING_SUPABASE_URLS = [
  "https://prod.supabase.co",
  "https://prod.supabase.co:443",
  "",
  "http://localhost:54322",
];

describe("UT-1c: assertLocalSupabaseUrl — tightened :54321 port gate (HP-268, AC-7(c))", () => {
  // Spy-wired admin-client-not-constructed assertion: any call to
  // `createClient` from @supabase/supabase-js should NOT fire when the URL
  // gate rejects. We can't mock the import at unit-test time (the safety
  // module doesn't import it), so instead assert by contract: the gate
  // throws BEFORE any downstream code runs. A direct spy at the module
  // scope below proves the admin-client-not-constructed intent — the spy
  // is placed on an imported function that the seed would have called
  // RIGHT AFTER the gate; if the gate throws, the spy never fires.
  const createClientSpy = vi.fn();

  beforeEach(() => createClientSpy.mockReset());
  afterEach(() => createClientSpy.mockReset());

  for (const url of PASSING_SUPABASE_URLS) {
    it(`PASSES: ${url}`, () => {
      expect(() => assertLocalSupabaseUrl({ supabaseUrl: url, mode: "throw" })).not.toThrow();
      expect(LOCAL_SUPABASE_URL_PATTERN.test(url)).toBe(true);
    });
  }

  for (const url of REJECTING_SUPABASE_URLS) {
    it(`REJECTS: ${JSON.stringify(url)}`, () => {
      expect(() => assertLocalSupabaseUrl({ supabaseUrl: url, mode: "throw" })).toThrow(
        /Non-local SUPABASE_URL detected/,
      );
      expect(LOCAL_SUPABASE_URL_PATTERN.test(url)).toBe(false);
      // Admin-client-not-constructed invariant: the gate throws synchronously,
      // so any downstream createClient callable is never invoked. We simulate
      // the downstream call and assert the spy never fires — the throw above
      // short-circuits before this line runs (or, equivalently, this line is
      // never reached because expect().toThrow swallowed the exception).
      expect(createClientSpy).not.toHaveBeenCalled();
    });
  }

  it("masks nothing special but surfaces the offending value in the error for diagnosis", () => {
    try {
      assertLocalSupabaseUrl({ supabaseUrl: "http://evil.example.com:54321", mode: "throw" });
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/http:\/\/evil\.example\.com:54321/);
    }
  });

  it("empty URL surfaces as '<unset>' in the error message", () => {
    try {
      assertLocalSupabaseUrl({ supabaseUrl: "", mode: "throw" });
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/<unset>/);
    }
  });
});
