// Tests for supabase/functions/track-slug/index.ts.
//
// Layers:
//   1. Source-level substitution-table assertions (always run)
//   2. Behavioral tests against the handler() (requires SUPABASE_DB_URL)
//
// Required env:
//   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
//   IP_HASH_SECRET=test-secret-for-unit-tests
//   PUBLIC_COLLECT_URL=https://test.example.supabase.co/functions/v1/track-collect

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const handlerSource = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url).pathname,
);
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const code = stripComments(handlerSource);

// ─────────────────────────────────────────────────────────────────────────────
// Static assertions
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("track-slug: never imports next/server", () => {
  assertEquals(code.includes('from "next/server"'), false);
});

Deno.test("track-slug: no @/ aliases", () => {
  assertEquals(/from\s+["']@\//.test(code), false);
});

Deno.test("track-slug: no process.env", () => {
  assertEquals(code.includes("process.env"), false);
});

Deno.test("track-slug: never references service-role key", () => {
  assertEquals(code.includes("SERVICE_ROLE"), false);
  assertEquals(code.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
});

Deno.test("track-slug: rate-limit key is `slug-serve:<ip>`", () => {
  assertStringIncludes(code, "slug-serve:");
});

Deno.test("track-slug: emitted JS uses PUBLIC_COLLECT_URL env, NOT hardcoded URL", () => {
  // The critical regression check — test #17 in the verify harness.
  assertEquals(
    code.includes("geo.flowblinq.com/api/t/collect"),
    false,
    "hardcoded production URL must NOT appear — read PUBLIC_COLLECT_URL from env",
  );
  assertStringIncludes(code, 'Deno.env.get("PUBLIC_COLLECT_URL")');
});

Deno.test("track-slug: PIXEL_GIF uses atob (no Node Buffer)", () => {
  assertEquals(code.includes("Buffer.from"), false);
  assertStringIncludes(code, "atob");
});

Deno.test("track-slug: uses new URL(req.url) instead of req.nextUrl", () => {
  assertEquals(code.includes("nextUrl"), false);
  assertStringIncludes(code, "new URL(req.url)");
});

Deno.test("track-slug: blocks malicious UA (isBlockedUA)", () => {
  assertStringIncludes(code, "isBlockedUA");
  assertStringIncludes(code, "403");
});

Deno.test("track-slug: console.log/info are NOT used", () => {
  assertEquals(code.includes("console.log"), false);
  assertEquals(code.includes("console.info"), false);
});

Deno.test("track-slug: imports shared modules via relative ../_shared paths", () => {
  const localImports = code.match(/from\s+["'](\.\.?\/[^"']+)["']/g) ?? [];
  for (const line of localImports) {
    assertMatch(line, /from\s+["']\.\.\/_shared\/[^"']+\.ts["']/);
  }
});

Deno.test("track-slug: extracts slug from URL pathname (no params injection)", () => {
  // Supabase Edge passes /functions/v1/track-slug/<slug> — handler must
  // parse the pathname itself. We spot-check by ensuring no Next.js
  // params signature lingers.
  assertEquals(code.includes("params: Promise"), false);
  assertEquals(code.includes("await params"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral tests
// ─────────────────────────────────────────────────────────────────────────────

const hasDb = !!Deno.env.get("SUPABASE_DB_URL");

if (!hasDb) {
  console.warn(
    "[track-slug.test] SUPABASE_DB_URL unset — skipping behavioral tests.",
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

  function makeReq(
    slug: string,
    opts: {
      method?: string;
      ip?: string;
      ua?: string;
      accept?: string;
      referer?: string;
    } = {},
  ): Request {
    const method = opts.method ?? "GET";
    const ip = opts.ip ?? "127.0.0.1";
    const ua = opts.ua ?? "Mozilla/5.0 Chrome/120";
    const headers = new Headers({
      "user-agent": ua,
      "x-forwarded-for": ip,
    });
    if (opts.accept) headers.set("accept", opts.accept);
    if (opts.referer) headers.set("referer", opts.referer);
    return new Request(
      `http://localhost/functions/v1/track-slug/${slug}`,
      { method, headers },
    );
  }

  Deno.test({
    name: "track-slug: img pixel path → 200 + GIF body for bot UA + Accept image/*",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(`tslug-pix-${TEST_RUN}`, {
          ip: uniqueIp(),
          accept: "image/gif",
          ua: "Mozilla/5.0 (compatible; GPTBot/1.0)",
          referer: "https://example.com/page",
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "image/gif");
      const body = new Uint8Array(await res.arrayBuffer());
      // GIF magic bytes: "GIF8"
      assertEquals(body[0], 0x47);
      assertEquals(body[1], 0x49);
      assertEquals(body[2], 0x46);
      assertEquals(body[3], 0x38);
    },
  });

  Deno.test({
    name: "track-slug: bot UA returns schema-injection JS when site has schema blocks",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const slug = `tslug-schema-${TEST_RUN}`;
      const blocks = [
        {
          type: "Organization",
          pageTarget: "all pages",
          jsonLd: { "@type": "Organization", name: "Test" },
        },
      ];
      // Seed a site with schema blocks. owner_email is NOT NULL in prod
      // (required for OTP), use a synthetic test value.
      await sql`
        INSERT INTO geo_sites (id, domain, slug, owner_email, pipeline_status, generated_schema_blocks, created_at)
        VALUES (${slug + "-id"}, ${"test-" + TEST_RUN + ".example.com"}, ${slug},
                ${"test-" + TEST_RUN + "@example.com"}, 'complete',
                ${JSON.stringify(blocks)}::jsonb, now())
        ON CONFLICT (slug) DO NOTHING
      `;
      const res = await handler(
        makeReq(slug, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 (compatible; GPTBot/1.0)",
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "application/javascript");
      const body = await res.text();
      assertStringIncludes(body, "FlowBlinq GEO Schema");
      assertStringIncludes(body, "_fbInject");
    },
  });

  Deno.test({
    name: "track-slug: human UA returns beacon JS string (with env-templated URL)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(`tslug-human-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 (Macintosh) Chrome/120",
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "application/javascript");
      const body = await res.text();
      // beacon JS structure spot-check
      assertStringIncludes(body, "sendBeacon");
      assertStringIncludes(body, "location.href");
    },
  });

  Deno.test({
    name: "track-slug: emitted beacon JS does NOT contain hardcoded URL",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(`tslug-url-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      );
      const body = await res.text();
      assertEquals(
        body.includes("geo.flowblinq.com/api/t/collect"),
        false,
        "emitted JS leaks the hardcoded production URL — migration would no-op",
      );
    },
  });

  Deno.test({
    name: "track-slug: emitted beacon JS DOES contain PUBLIC_COLLECT_URL env value",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const expected = Deno.env.get("PUBLIC_COLLECT_URL")!;
      assert(expected, "PUBLIC_COLLECT_URL must be set for this test");
      const res = await handler(
        makeReq(`tslug-envurl-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      );
      const body = await res.text();
      assertStringIncludes(body, expected);
    },
  });

  Deno.test({
    name: "track-slug: 110 GETs from same IP → last 10 return 429 (rate limit)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const ip = uniqueIp();
      const slug = `tslug-rl-${TEST_RUN}`;
      let lastTen429 = 0;
      for (let i = 0; i < 110; i++) {
        const res = await handler(
          makeReq(slug, { ip, ua: "Mozilla/5.0 Chrome/120" }),
        );
        if (i >= 100 && res.status === 429) lastTen429++;
        // Drain the body to release any underlying reader
        await res.body?.cancel();
      }
      assertEquals(lastTen429, 10, `expected 10 of last 10 to be 429`);
    },
  });

  Deno.test({
    name: "track-slug: malicious UA (sqlmap) → 403",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(`tslug-mal-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "sqlmap/1.6.5",
        }),
      );
      assertEquals(res.status, 403);
    },
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Batched + sampled emitter tests (task #5)
  // ───────────────────────────────────────────────────────────────────────────

  // Helper: hit the loader path with optional querystring (e.g. ?sample=0.5)
  function makeReqWithQuery(
    slug: string,
    query: string,
    opts: { ip?: string; ua?: string } = {},
  ): Request {
    const ip = opts.ip ?? "127.0.0.1";
    const ua = opts.ua ?? "Mozilla/5.0 Chrome/120";
    const headers = new Headers({
      "user-agent": ua,
      "x-forwarded-for": ip,
    });
    return new Request(
      `http://localhost/functions/v1/track-slug/${slug}${query}`,
      { method: "GET", headers },
    );
  }

  Deno.test({
    name: "track-slug: emitted JS contains queue + flush primitives",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(`tslug-q-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      );
      const body = await res.text();
      // queue var + flush function — names may be short but must be present.
      assertStringIncludes(body, "q=[]");
      assertStringIncludes(body, "function flush(");
    },
  });

  Deno.test({
    name:
      "track-slug: emitted JS hooks both visibilitychange AND beforeunload for flush",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(`tslug-vis-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      );
      const body = await res.text();
      assertStringIncludes(body, "visibilitychange");
      assertStringIncludes(body, "beforeunload");
    },
  });

  Deno.test({
    name:
      "track-slug: ?sample=0.5 querystring parameterizes the emitted sample rate",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const noSample = await (await handler(
        makeReq(`tslug-s0-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      )).text();
      // Default sample rate is 1.0
      assertStringIncludes(noSample, "sr=1");

      const half = await (await handler(
        makeReqWithQuery(`tslug-s05-${TEST_RUN}`, "?sample=0.5", {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      )).text();
      assertStringIncludes(half, "sr=0.5");

      // Out-of-range values clamp to [0, 1].
      const tooHigh = await (await handler(
        makeReqWithQuery(`tslug-s99-${TEST_RUN}`, "?sample=99", {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      )).text();
      assertStringIncludes(tooHigh, "sr=1");

      const negative = await (await handler(
        makeReqWithQuery(`tslug-sneg-${TEST_RUN}`, "?sample=-1", {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      )).text();
      assertStringIncludes(negative, "sr=0");
    },
  });

  Deno.test({
    name:
      "track-slug: emitted JS sends array-shaped payload (JSON.stringify of queue)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(`tslug-arr-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      );
      const body = await res.text();
      // The queue is drained via splice(0,…); the batch must be JSON.stringified
      // and sent via sendBeacon — the array shape comes from passing the queue
      // (an Array) directly to JSON.stringify.
      assertStringIncludes(body, "JSON.stringify(batch)");
      assertStringIncludes(body, "q.splice");
    },
  });

  Deno.test({
    name: "track-slug: emitted JS hard-caps batch size at 20 (server limit)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(`tslug-bs-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      );
      const body = await res.text();
      assertStringIncludes(body, "bs=20");
    },
  });

  Deno.test({
    name: "track-slug: emitted JS does NOT use async/await or Promise",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(`tslug-noasync-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      );
      const body = await res.text();
      // Old-browser safety — XHR-free, Promise-free, async-free.
      assertEquals(body.includes("async "), false);
      assertEquals(body.includes("await "), false);
      assertEquals(body.includes("Promise"), false);
    },
  });

  Deno.test({
    name: "track-slug: emitted JS under 2500-byte budget",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const res = await handler(
        makeReq(`tslug-budget-${TEST_RUN}`, {
          ip: uniqueIp(),
          ua: "Mozilla/5.0 Chrome/120",
        }),
      );
      const body = await res.text();
      assert(
        body.length < 2500,
        `emitted JS is ${body.length} bytes — exceeds 2500-byte budget`,
      );
    },
  });

  Deno.test({
    name: "track-slug: cleanup",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      try {
        await sql`DELETE FROM geo_crawl_logs WHERE slug LIKE ${`tslug-%${TEST_RUN}`}`;
        await sql`DELETE FROM geo_sites WHERE slug LIKE ${`tslug-%${TEST_RUN}`}`;
        await sql`DELETE FROM rate_limits WHERE key LIKE ${`slug-serve:10.%`}`;
      } finally {
        await sql.end();
      }
    },
  });
}
