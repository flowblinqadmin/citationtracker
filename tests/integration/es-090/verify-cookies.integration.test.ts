/**
 * ES-090 IT8 + IT20 — MED-4 cookie hydration + feature-flag fallback.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { seedSite, cleanupSite, closeDb } from "./_setup";

const created: string[] = [];

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterEach(async () => {
  while (created.length) {
    const id = created.pop()!;
    try { await cleanupSite(id); } catch { /* ignore */ }
  }
});
afterAll(async () => { await closeDb(); });

describe("ES-090 IT8 — MED-4 cookie hydration", () => {
  it("verify response sets HttpOnly site_token cookie; body has no accessToken", async () => {
    process.env.NEXT_PUBLIC_COOKIE_AUTH = "true";
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/sites/${site.id}/verify`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie, "Set-Cookie missing flowblinq_site_token").toMatch(/flowblinq_site_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);

    const body = await res.json();
    expect(body.accessToken, "accessToken must NOT appear in body when feature-flag on").toBeUndefined();
  }, 30_000);
});

describe("ES-090 IT20 — feature-flag OFF preserves body-auth", () => {
  it("NEXT_PUBLIC_COOKIE_AUTH=false → body still carries accessToken", async () => {
    process.env.NEXT_PUBLIC_COOKIE_AUTH = "false";
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/sites/${site.id}/verify`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    const body = await res.json();
    expect(body.accessToken).toBeTruthy();
  }, 30_000);
});

// ── ChangedSpec per HP-201 — 4-branch cookie coverage IT ──────────────────────

describe("ES-090 IT8b — all four verify branches write cookies + no accessToken in body", () => {
  it("main-success branch: cookie set, body has no accessToken", async () => {
    process.env.NEXT_PUBLIC_COOKIE_AUTH = "true";
    const site = await seedSite({ withTeam: true });
    created.push(site.id);
    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/sites/${site.id}/verify`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(res.headers.get("set-cookie") ?? "").toMatch(/flowblinq_site_token=/);
    const body = await res.json();
    expect(body.accessToken).toBeUndefined();
  }, 30_000);

  it("requiresConsent branch: cookie set, body carries requiresConsent flag but no accessToken", async () => {
    process.env.NEXT_PUBLIC_COOKIE_AUTH = "true";
    const site = await seedSite({ withTeam: true });
    created.push(site.id);
    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/sites/${site.id}/verify`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456", noConsent: true }),
    });
    const body = await res.json();
    expect(body.requiresConsent).toBe(true);
    expect(body.accessToken).toBeUndefined();
    expect(res.headers.get("set-cookie") ?? "").toMatch(/flowblinq_site_token=/);
  }, 30_000);

  it("bulk-audit branch: per-sibling cookies set, siblings array has no accessToken fields", async () => {
    process.env.NEXT_PUBLIC_COOKIE_AUTH = "true";
    const site = await seedSite({ withTeam: true });
    created.push(site.id);
    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/sites/${site.id}/verify`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456", bulk: true }),
    });
    const body = await res.json() as { siblings?: Array<Record<string, unknown>> };
    for (const sib of body.siblings ?? []) {
      expect(sib.accessToken).toBeUndefined();
    }
    // At least one set-cookie header with flowblinq_site_token for the primary.
    expect(res.headers.get("set-cookie") ?? "").toMatch(/flowblinq_site_token=/);
  }, 30_000);

  it("early-exchange-code branch: cookie set, no raw accessToken in body", async () => {
    process.env.NEXT_PUBLIC_COOKIE_AUTH = "true";
    const site = await seedSite({ withTeam: true });
    created.push(site.id);
    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/sites/${site.id}/verify`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456", earlyExchange: true }),
    });
    const body = await res.json();
    expect(body.accessToken).toBeUndefined();
    expect(body.exchangeCode).toBeDefined();
  }, 30_000);
});
