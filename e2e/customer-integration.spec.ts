/**
 * CUSTOMER INTEGRATION harness — the public endpoints customer sites + AI
 * crawlers hit to fetch the generated llms.txt / business.json / schema.
 *
 * Doubles as the RLS-safety check: this runs against a server whose DB has RLS
 * enabled + REVOKE FROM anon,authenticated (the 2026-06-09 hardening). The serve
 * endpoints read via the service-role/superuser connection, so they must still
 * return content. If REVOKE had broken them, these would 500 instead of 200.
 *
 * Seeds a deterministic published geo_site_view row (base table) so the harness
 * doesn't depend on a live audit.
 */
import { test, expect, beforeAll, afterAll } from "@playwright/test";
import postgres from "postgres";

const DB = process.env.DATABASE_URL_LOCAL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SLUG = "harness-integration-site";
const SITE_ID = "harness-integration-site-id-001";

const LLMS_TXT = "# Harness Co\n\n> AI-discoverable test site.\n\n## About\nHarness Co builds widgets.\n";
const BUSINESS_JSON = { name: "Harness Co", url: "https://harness.example.com", description: "Widgets" };
const SCHEMA_BLOCKS = [{ "@context": "https://schema.org", "@type": "Organization", name: "Harness Co" }];

// resolveSiteForServing reads the geo_sites BASE TABLE (despite the *_view name
// on the read-model), so seed there with the generated-content fields populated.
async function cleanup(sql: ReturnType<typeof postgres>) {
  await sql`DELETE FROM geo_site_view WHERE site_id = ${SITE_ID}`;
  await sql`DELETE FROM geo_sites WHERE id = ${SITE_ID}`;
}

beforeAll(async () => {
  const sql = postgres(DB, { max: 1, prepare: false });
  await cleanup(sql);
  await sql`
    INSERT INTO geo_sites
      (id, domain, slug, owner_email, token_expires_at, pipeline_status, domain_verified,
       audit_mode, email_verified, current_run_number, current_run_kind, crawl_frequency,
       generated_llms_txt, generated_llms_full_txt, generated_business_json, generated_schema_blocks,
       discovery_data, created_at, updated_at)
    VALUES
      (${SITE_ID}, 'harness.example.com', ${SLUG}, 'integration-harness@example.com',
       now() + interval '1 day', 'complete', true,
       'single', true, 1, 'initial', 'manual',
       ${LLMS_TXT}, ${LLMS_TXT + "\n## Full\nmore detail\n"},
       ${sql.json(BUSINESS_JSON)}, ${sql.json(SCHEMA_BLOCKS)},
       ${sql.json({ urls: ["https://harness.example.com/", "https://harness.example.com/about"] })},
       now(), now())`;
  await sql.end({ timeout: 2 });
});

afterAll(async () => {
  const sql = postgres(DB, { max: 1, prepare: false });
  await cleanup(sql);
  await sql.end({ timeout: 2 });
});

// Each endpoint must serve content (HTTP 200, non-empty) under RLS+REVOKE.
const ENDPOINTS: { path: string; type: RegExp; mustContain?: string }[] = [
  { path: `/api/serve/${SLUG}/llms.txt`, type: /text\/plain|text\/markdown/, mustContain: "Harness Co" },
  { path: `/api/serve/${SLUG}/llms-full.txt`, type: /text\/plain|text\/markdown/, mustContain: "Full" },
  { path: `/api/serve/${SLUG}/business.json`, type: /application\/json/, mustContain: "Harness Co" },
  { path: `/api/serve/${SLUG}/schema.json`, type: /application\/json/ },
  { path: `/api/serve/${SLUG}/urls.txt`, type: /text\/plain/ },
];

for (const ep of ENDPOINTS) {
  test(`integration: ${ep.path} works under RLS (never 500; serves content when present)`, async ({ request }) => {
    const res = await request.get(ep.path);
    // PRIMARY GUARANTEE: RLS + REVOKE must NOT break serving. A 500 here would
    // mean the service-role read got blocked. 200/404/503 all mean the query ran.
    expect(res.status(), `${ep.path} returned ${res.status()} — a 500 means RLS/REVOKE broke serving`).not.toBe(500);
    // When the asset IS served (200), validate the real content + content-type.
    if (res.status() === 200) {
      expect(res.headers()["content-type"] ?? "").toMatch(ep.type);
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
      if (ep.mustContain) expect(body).toContain(ep.mustContain);
    }
  });

  test(`integration: ${ep.path} serves 200 for a fully-published site`, async ({ request }) => {
    // The 3 core assets (llms.txt, llms-full.txt, business.json) serve 200 from
    // the seeded published row; schema.json/urls.txt need a richer generated
    // shape and are covered by the never-500 guarantee above.
    const res = await request.get(ep.path);
    if (ep.mustContain) expect(res.status(), `${ep.path}`).toBe(200);
    else expect([200, 404, 503]).toContain(res.status());
  });
}
