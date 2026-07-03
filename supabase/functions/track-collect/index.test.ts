// Tests for supabase/functions/track-collect/index.ts.
//
// Two layers:
//   1. Source-level static assertions — enforce the substitution table on
//      every CI run, no DB required.
//   2. Behavioral tests — invoke the handler() in-process and assert HTTP
//      semantics. Requires SUPABASE_DB_URL.
//
// Set:
//   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
//   IP_HASH_SECRET=test-secret-for-unit-tests
//   PUBLIC_COLLECT_URL=https://test.example.supabase.co/functions/v1/track-collect

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const handlerModulePath = new URL("./index.ts", import.meta.url).pathname;
const handlerSource = await Deno.readTextFile(handlerModulePath);
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const code = stripComments(handlerSource);

// ─────────────────────────────────────────────────────────────────────────────
// Static substitution-table assertions (no DB)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("track-collect: never imports next/server", () => {
  assertEquals(code.includes('from "next/server"'), false);
});

Deno.test("track-collect: no @/ path aliases", () => {
  assertEquals(/from\s+["']@\//.test(code), false);
});

Deno.test("track-collect: no process.env usage", () => {
  assertEquals(code.includes("process.env"), false);
});

Deno.test("track-collect: never references service-role key", () => {
  assertEquals(code.includes("SERVICE_ROLE"), false);
  assertEquals(code.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
});

Deno.test("track-collect: uses Deno.serve entrypoint", () => {
  assertStringIncludes(code, "Deno.serve");
});

Deno.test("track-collect: imports shared modules via relative path only", () => {
  // Every import line that hits a local file must be relative ../_shared
  const localImports = code.match(/from\s+["'](\.\.?\/[^"']+)["']/g) ?? [];
  for (const line of localImports) {
    assertMatch(line, /from\s+["']\.\.\/_shared\/[^"']+\.ts["']/);
  }
});

Deno.test("track-collect: rate-limit key is exactly `beacon:<ip>`", () => {
  assertStringIncludes(code, "beacon:");
  // The literal must be `beacon:${ip}` (with the colon, no extra namespace)
  assert(
    /["'`]beacon:\$\{[^}]+\}/.test(code) || /["'`]beacon:["'`]\s*\+/.test(code),
    "expected rate-limit key literal `beacon:` + IP variable",
  );
});

Deno.test("track-collect: calls hashIp() for ipHash population (ES-090 §b.1 COMP-2)", () => {
  assertStringIncludes(code, "hashIp");
  assertStringIncludes(code, "ipHash");
});

Deno.test("track-collect: calls enrichGeo() for country/city/region", () => {
  assertStringIncludes(code, "enrichGeo");
});

Deno.test("track-collect: does NOT block on isBlockedUA (per plan — only track-slug blocks)", () => {
  // The plan's table is explicit: track-collect doesn't UA-block today;
  // preserve that. isBlockedUA may be imported but must not 403 the request.
  // We verify by asserting no `403` literal in the source.
  assertEquals(code.includes("status: 403"), false);
  assertEquals(code.includes('"status":403'), false);
});

Deno.test("track-collect: GET → 405 (method restriction)", () => {
  // Look for any 405 literal — the handler must reject non-POST/OPTIONS.
  assertStringIncludes(code, "405");
});

Deno.test("track-collect: body size cap 8192 bytes", () => {
  assertStringIncludes(code, "8192");
});

Deno.test("track-collect: console.log/info are NOT used (only warn/error)", () => {
  assertEquals(code.includes("console.log"), false);
  assertEquals(code.includes("console.info"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral tests (requires DB)
// ─────────────────────────────────────────────────────────────────────────────

const hasDb = !!Deno.env.get("SUPABASE_DB_URL");

if (!hasDb) {
  console.warn(
    "[track-collect.test] SUPABASE_DB_URL unset — skipping behavioral tests.",
  );
} else {
  const { handler } = await import("./index.ts");
  const postgres = (await import("npm:postgres@3.4.9")).default;
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
    max: 1,
    prepare: false,
  });

  const TEST_RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const uniqueIp = () =>
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${
      Math.floor(Math.random() * 250)
    }`;

  // Build a Request with the common headers
  function makeReq(
    body: unknown,
    opts: {
      method?: string;
      ip?: string;
      ua?: string;
      contentLength?: number;
      rawBody?: string;
    } = {},
  ): Request {
    const method = opts.method ?? "POST";
    const ip = opts.ip ?? "127.0.0.1";
    const ua = opts.ua ?? "Mozilla/5.0 (X11; Linux x86_64) Chrome/120";
    const headers = new Headers({
      "content-type": "application/json",
      "user-agent": ua,
      "x-forwarded-for": ip,
    });
    const rawBody = opts.rawBody ?? (body === undefined ? "" : JSON.stringify(body));
    if (opts.contentLength !== undefined) {
      headers.set("content-length", String(opts.contentLength));
    } else if (method !== "GET" && method !== "OPTIONS") {
      headers.set("content-length", String(rawBody.length));
    }
    return new Request("http://localhost/functions/v1/track-collect", {
      method,
      headers,
      body: method === "GET" || method === "OPTIONS" ? undefined : rawBody,
    });
  }

  async function fetchLatestRowForSlug(slug: string) {
    const rows = await sql`
      SELECT * FROM geo_page_views WHERE slug = ${slug}
      ORDER BY viewed_at DESC LIMIT 1
    `;
    return rows[0] ?? null;
  }

  Deno.test({
    name: "track-collect: happy path → 204 + row inserted with ipHash",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-happy-${TEST_RUN}`;
      const res = await handler(
        makeReq({ s: slug, u: "https://example.com/page" }, { ip: uniqueIp() }),
      );
      assertEquals(res.status, 204);
      const row = await fetchLatestRowForSlug(slug);
      assert(row, "row should be inserted");
      assertEquals(row.slug, slug);
      assertEquals(row.page_url, "https://example.com/page");
      assert(row.ip_hash, "ip_hash should be populated");
      assertMatch(row.ip_hash, /^[0-9a-f]{64}$/);
    },
  });

  Deno.test({
    name: "track-collect: body >8KB → 413 before parse",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      // Send Content-Length: 100000 (a fake but explicit oversized declaration)
      const res = await handler(
        makeReq(null, {
          contentLength: 100_000,
          rawBody: JSON.stringify({ s: "x", u: "https://a.b" }),
        }),
      );
      assertEquals(res.status, 413);
    },
  });

  Deno.test({
    name: "track-collect: missing slug → 400",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq({ u: "https://example.com" }, { ip: uniqueIp() }),
      );
      assertEquals(res.status, 400);
    },
  });

  Deno.test({
    name: "track-collect: oversized field → stored truncated (pageUrl 5000 → 2048)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-trunc-${TEST_RUN}`;
      const longTail = "x".repeat(5000);
      const u = `https://example.com/${longTail}`;
      const res = await handler(
        makeReq({ s: slug, u }, { ip: uniqueIp() }),
      );
      assertEquals(res.status, 204);
      const row = await fetchLatestRowForSlug(slug);
      assert(row);
      assertEquals(row.page_url.length, 2048);
    },
  });

  Deno.test({
    name: "track-collect: malformed JSON → 204 (graceful)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(null, {
          rawBody: "{not valid json",
          ip: uniqueIp(),
        }),
      );
      assertEquals(res.status, 204);
    },
  });

  Deno.test({
    name: "track-collect: malicious UA (sqlmap) does NOT 403 — collect intentionally does not UA-block",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      // Plan-flagged review item: the prior source-grep guard ('"status: 403"'
      // absent in source) would have passed even if a future edit introduced
      // object-notation 403s ({status:403,...}). This behavioral test is the
      // real guarantee: even with a textbook attack-tool UA, the request is
      // accepted (204) and the row is written. Only track-slug UA-blocks.
      const slug = `tc-ua-${TEST_RUN}`;
      const res = await handler(
        makeReq(
          { s: slug, u: "https://a.b" },
          {
            ip: uniqueIp(),
            ua: "Mozilla/5.0 (sqlmap/1.6.5 https://sqlmap.org)",
          },
        ),
      );
      assertEquals(res.status, 204);
      const row = await fetchLatestRowForSlug(slug);
      assert(row, "row should be inserted even with malicious UA");
      assertStringIncludes(row.user_agent ?? "", "sqlmap");
    },
  });

  Deno.test({
    name: "track-collect: rate-limit exceeded → 429",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const ip = uniqueIp();
      const slug = `tc-rl-${TEST_RUN}`;
      // Hit the limit (100/min)
      for (let i = 0; i < 100; i++) {
        const r = await handler(makeReq({ s: slug, u: "https://a.b" }, { ip }));
        assert(r.status === 204, `expected 204 at hit ${i}, got ${r.status}`);
      }
      const blocked = await handler(
        makeReq({ s: slug, u: "https://a.b" }, { ip }),
      );
      assertEquals(blocked.status, 429);
    },
  });

  Deno.test({
    name: "track-collect: flat-object guard — nested props → eventProps null",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-nested-${TEST_RUN}`;
      const res = await handler(
        makeReq(
          {
            s: slug,
            u: "https://a.b",
            type: "event",
            props: { nested: { a: 1 } },
          },
          { ip: uniqueIp() },
        ),
      );
      assertEquals(res.status, 204);
      const row = await fetchLatestRowForSlug(slug);
      assert(row);
      assertEquals(row.event_props, null);
    },
  });

  Deno.test({
    name: "track-collect: props with 51 keys → eventProps null",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-51-${TEST_RUN}`;
      const props: Record<string, string> = {};
      for (let i = 0; i < 51; i++) props[`k${i}`] = "v";
      const res = await handler(
        makeReq(
          { s: slug, u: "https://a.b", type: "event", props },
          { ip: uniqueIp() },
        ),
      );
      assertEquals(res.status, 204);
      const row = await fetchLatestRowForSlug(slug);
      assert(row);
      assertEquals(row.event_props, null);
    },
  });

  Deno.test({
    name: "track-collect: type \"<script>\" → stored as \"pageview\"",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-type-${TEST_RUN}`;
      const res = await handler(
        makeReq(
          { s: slug, u: "https://a.b", type: "<script>" },
          { ip: uniqueIp() },
        ),
      );
      assertEquals(res.status, 204);
      const row = await fetchLatestRowForSlug(slug);
      assert(row);
      assertEquals(row.type, "pageview");
    },
  });

  Deno.test({
    name: "track-collect: malformed URL `u: \"not a url\"` → row inserted, utm_* null",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-badurl-${TEST_RUN}`;
      const res = await handler(
        makeReq({ s: slug, u: "not a url" }, { ip: uniqueIp() }),
      );
      assertEquals(res.status, 204);
      const row = await fetchLatestRowForSlug(slug);
      assert(row);
      assertEquals(row.utm_source, null);
      assertEquals(row.utm_medium, null);
      assertEquals(row.utm_campaign, null);
    },
  });

  Deno.test({
    name: "track-collect: GET method → 405",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(makeReq(null, { method: "GET" }));
      assertEquals(res.status, 405);
    },
  });

  Deno.test({
    name: "track-collect: OPTIONS preflight → 204 with CORS headers",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(makeReq(null, { method: "OPTIONS" }));
      assertEquals(res.status, 204);
      assert(res.headers.get("access-control-allow-methods"));
    },
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Batched payload tests (task #5 — array of beacons)
  // ───────────────────────────────────────────────────────────────────────────

  Deno.test({
    name: "track-collect: array of 5 → 204 + 5 rows inserted",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-batch5-${TEST_RUN}`;
      const batch = Array.from({ length: 5 }, (_, i) => ({
        s: slug,
        u: `https://example.com/p${i}`,
      }));
      const res = await handler(makeReq(batch, { ip: uniqueIp() }));
      assertEquals(res.status, 204);
      const rows = await sql`
        SELECT * FROM geo_page_views WHERE slug = ${slug}
      `;
      assertEquals(rows.length, 5);
    },
  });

  Deno.test({
    name: "track-collect: array of 21 → 400 (over batch cap)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-batch21-${TEST_RUN}`;
      const batch = Array.from({ length: 21 }, (_, i) => ({
        s: slug,
        u: `https://example.com/p${i}`,
      }));
      const res = await handler(makeReq(batch, { ip: uniqueIp() }));
      assertEquals(res.status, 400);
      const rows = await sql`
        SELECT count(*)::int AS c FROM geo_page_views WHERE slug = ${slug}
      `;
      assertEquals(rows[0].c, 0);
    },
  });

  Deno.test({
    name: "track-collect: empty array → 400 (no rows to validate)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(makeReq([], { ip: uniqueIp() }));
      assertEquals(res.status, 400);
    },
  });

  Deno.test({
    name:
      "track-collect: array with one entry missing slug → 400 (strict, whole batch rejected)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-batchbad-${TEST_RUN}`;
      // 2nd entry has no `s`
      const batch = [
        { s: slug, u: "https://a.b/1" },
        { u: "https://a.b/2" } as unknown as { s: string; u: string },
        { s: slug, u: "https://a.b/3" },
      ];
      const res = await handler(makeReq(batch, { ip: uniqueIp() }));
      assertEquals(res.status, 400);
      const rows = await sql`
        SELECT count(*)::int AS c FROM geo_page_views WHERE slug = ${slug}
      `;
      assertEquals(rows[0].c, 0, "no rows should be inserted for a bad batch");
    },
  });

  Deno.test({
    name:
      "track-collect: array preserves per-row UTM independence (malformed u doesn't poison neighbours)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-batchutm-${TEST_RUN}`;
      const batch = [
        // bad URL — UTMs must be null but row still inserts
        { s: slug, u: "not a url" },
        // good URL with utms — UTMs must be extracted intact
        {
          s: slug,
          u: "https://example.com/p?utm_source=src&utm_medium=med&utm_campaign=cmp",
        },
      ];
      const res = await handler(makeReq(batch, { ip: uniqueIp() }));
      assertEquals(res.status, 204);
      const rows = await sql`
        SELECT page_url, utm_source, utm_medium, utm_campaign
        FROM geo_page_views
        WHERE slug = ${slug}
        ORDER BY page_url ASC
      `;
      assertEquals(rows.length, 2);
      // 'https://...' sorts after 'not a url' lexicographically? No, 'h' < 'n'.
      const typedRows = rows as unknown as Array<{
        page_url: string;
        utm_source: string | null;
        utm_medium: string | null;
        utm_campaign: string | null;
      }>;
      const good = typedRows.find((r) => r.page_url.startsWith("https://"))!;
      const bad = typedRows.find((r) => !r.page_url.startsWith("https://"))!;
      assert(good, "good row present");
      assert(bad, "bad row present");
      assertEquals(good.utm_source, "src");
      assertEquals(good.utm_medium, "med");
      assertEquals(good.utm_campaign, "cmp");
      assertEquals(bad.utm_source, null);
      assertEquals(bad.utm_medium, null);
      assertEquals(bad.utm_campaign, null);
    },
  });

  Deno.test({
    name:
      "track-collect: per-row ipHash populated 64 hex on every row of a batch",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tc-batchhash-${TEST_RUN}`;
      const batch = Array.from({ length: 4 }, (_, i) => ({
        s: slug,
        u: `https://a.b/${i}`,
      }));
      const res = await handler(makeReq(batch, { ip: uniqueIp() }));
      assertEquals(res.status, 204);
      const rows = await sql`
        SELECT ip_hash FROM geo_page_views WHERE slug = ${slug}
      `;
      assertEquals(rows.length, 4);
      for (const r of rows) {
        assert(r.ip_hash, "ip_hash populated");
        assertMatch(r.ip_hash, /^[0-9a-f]{64}$/);
      }
    },
  });

  Deno.test({
    name:
      "track-collect: rate limit is per-request, not per-row (1 batch of 10 + 99 singles = 100 ok, 101st → 429)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const ip = uniqueIp();
      const slug = `tc-batchrl-${TEST_RUN}`;
      // First request: a batch of 10. Counts as 1 hit.
      const batchRes = await handler(
        makeReq(
          Array.from({ length: 10 }, (_, i) => ({
            s: slug,
            u: `https://a.b/${i}`,
          })),
          { ip },
        ),
      );
      assertEquals(batchRes.status, 204);
      // Next 99 single requests: hits 2-100. All should succeed.
      for (let i = 0; i < 99; i++) {
        const r = await handler(
          makeReq({ s: slug, u: "https://a.b/single" }, { ip }),
        );
        assert(r.status === 204, `expected 204 at single hit ${i}, got ${r.status}`);
      }
      // Hit #101 — must block.
      const blocked = await handler(
        makeReq({ s: slug, u: "https://a.b/blocked" }, { ip }),
      );
      assertEquals(blocked.status, 429);
    },
  });

  Deno.test({
    name: "track-collect: cleanup",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      try {
        await sql`DELETE FROM geo_page_views WHERE slug LIKE ${`tc-%${TEST_RUN}`}`;
        await sql`DELETE FROM rate_limits WHERE key LIKE ${`beacon:10.%`}`;
      } finally {
        await sql.end();
      }
    },
  });
}
