// Unit tests for _shared/geo-enrich.ts.
//
// The module replaces Vercel/Cloudflare edge headers (cf-ipcountry,
// x-vercel-ip-country, x-vercel-ip-city, x-vercel-ip-region-code) which
// don't exist on Supabase Edge. Free-tier vendor with sampling + fail-open.

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enrichGeo, _shouldSample } from "../geo-enrich.ts";

// Stub fetch so we never hit a real vendor in unit tests. Each test sets
// globalThis.fetch and restores after.
function withFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

Deno.test("geo-enrich: returns null when ip is null/empty", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not be called when ip is null");
    },
    async () => {
      assertEquals(await enrichGeo(null), null);
      assertEquals(await enrichGeo(""), null);
    },
  );
});

Deno.test("geo-enrich: returns null on vendor 4xx without crashing beacon", async () => {
  await withFetch(
    () => Promise.resolve(new Response("nope", { status: 429 })),
    async () => {
      // Force sample to true so we attempt the lookup
      Deno.env.set("GEO_SAMPLE_RATE", "1");
      Deno.env.set("IPINFO_TOKEN", "fake-token");
      try {
        const res = await enrichGeo("1.2.3.4");
        assertEquals(res, null);
      } finally {
        Deno.env.delete("GEO_SAMPLE_RATE");
        Deno.env.delete("IPINFO_TOKEN");
      }
    },
  );
});

Deno.test("geo-enrich: parses ipinfo.io country/city/region", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ country: "US", city: "Toronto", region: "ON" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    async () => {
      Deno.env.set("GEO_SAMPLE_RATE", "1");
      Deno.env.set("IPINFO_TOKEN", "fake-token");
      try {
        const res = await enrichGeo("1.2.3.4");
        assertEquals(res, { country: "US", city: "Toronto", region: "ON" });
      } finally {
        Deno.env.delete("GEO_SAMPLE_RATE");
        Deno.env.delete("IPINFO_TOKEN");
      }
    },
  );
});

Deno.test("geo-enrich: returns null when network throws (fail-open)", async () => {
  await withFetch(
    () => Promise.reject(new Error("ENETDOWN")),
    async () => {
      Deno.env.set("GEO_SAMPLE_RATE", "1");
      Deno.env.set("IPINFO_TOKEN", "fake-token");
      try {
        const res = await enrichGeo("1.2.3.4");
        assertEquals(res, null);
      } finally {
        Deno.env.delete("GEO_SAMPLE_RATE");
        Deno.env.delete("IPINFO_TOKEN");
      }
    },
  );
});

Deno.test("geo-enrich: skips lookup when sample says no (returns null)", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return Promise.resolve(new Response("{}"));
    },
    async () => {
      Deno.env.set("GEO_SAMPLE_RATE", "0");
      Deno.env.set("IPINFO_TOKEN", "fake-token");
      try {
        const res = await enrichGeo("1.2.3.4");
        assertEquals(res, null);
        assertEquals(calls, 0, "fetch must not be called when sample says no");
      } finally {
        Deno.env.delete("GEO_SAMPLE_RATE");
        Deno.env.delete("IPINFO_TOKEN");
      }
    },
  );
});

Deno.test("geo-enrich: returns null when IPINFO_TOKEN is missing", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return Promise.resolve(new Response("{}"));
    },
    async () => {
      Deno.env.set("GEO_SAMPLE_RATE", "1");
      Deno.env.delete("IPINFO_TOKEN");
      const res = await enrichGeo("1.2.3.4");
      assertEquals(res, null);
      assertEquals(calls, 0);
      Deno.env.delete("GEO_SAMPLE_RATE");
    },
  );
});

Deno.test("_shouldSample: rate=1 always samples", () => {
  for (let i = 0; i < 50; i++) assertEquals(_shouldSample(1), true);
});

Deno.test("_shouldSample: rate=0 never samples", () => {
  for (let i = 0; i < 50; i++) assertEquals(_shouldSample(0), false);
});

Deno.test("_shouldSample: rate=0.1 is roughly 10% (loose envelope)", () => {
  const N = 10_000;
  let hits = 0;
  for (let i = 0; i < N; i++) if (_shouldSample(0.1)) hits++;
  // Loose envelope so test is not flaky — 6% to 14% acceptable
  assertEquals(hits / N > 0.06, true, `got ${hits}/${N}`);
  assertEquals(hits / N < 0.14, true, `got ${hits}/${N}`);
  // Distribution sanity — clearly not 0% or 100%
  assertNotEquals(hits, 0);
  assertNotEquals(hits, N);
});
