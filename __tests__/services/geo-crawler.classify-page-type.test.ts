/**
 * ES-085 ScriptDev Phase 1 unit tests for the rewritten classifyPageType.
 *
 * Coverage per ES-085 §c.1 (54 fixture cases — both trailing-slash and
 * non-slash variants for every structural type per HP-182).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { classifyPageType } from "@/lib/services/geo-crawler";

const URL_PREFIX = "https://example.com";

describe("ES-085 §c.1 — classifyPageType (54 fixture cases per HP-182)", () => {
  // ── about-us / about ──
  it("U1: /about-us/ → about", () => expect(classifyPageType(`${URL_PREFIX}/about-us/`)).toBe("about"));
  it("U2: /about-us → about",  () => expect(classifyPageType(`${URL_PREFIX}/about-us`)).toBe("about"));
  it("U3: /about/ → about",    () => expect(classifyPageType(`${URL_PREFIX}/about/`)).toBe("about"));
  it("U4: /about → about",     () => expect(classifyPageType(`${URL_PREFIX}/about`)).toBe("about"));

  // ── contact-us / contact ──
  it("U5: /contact-us/ → contact", () => expect(classifyPageType(`${URL_PREFIX}/contact-us/`)).toBe("contact"));
  it("U6: /contact-us → contact",  () => expect(classifyPageType(`${URL_PREFIX}/contact-us`)).toBe("contact"));
  it("U7: /contact/ → contact",    () => expect(classifyPageType(`${URL_PREFIX}/contact/`)).toBe("contact"));
  it("U8: /contact → contact",     () => expect(classifyPageType(`${URL_PREFIX}/contact`)).toBe("contact"));

  // ── specialities / specialties → services ──
  it("U9: /specialities/ → services", () => expect(classifyPageType(`${URL_PREFIX}/specialities/`)).toBe("services"));
  it("U10: /specialities → services", () => expect(classifyPageType(`${URL_PREFIX}/specialities`)).toBe("services"));
  it("U11: /specialties/ → services", () => expect(classifyPageType(`${URL_PREFIX}/specialties/`)).toBe("services"));
  it("U12: /specialties → services",  () => expect(classifyPageType(`${URL_PREFIX}/specialties`)).toBe("services"));

  // ── services / products → services ──
  it("U13: /services/ → services", () => expect(classifyPageType(`${URL_PREFIX}/services/`)).toBe("services"));
  it("U14: /services → services",  () => expect(classifyPageType(`${URL_PREFIX}/services`)).toBe("services"));
  it("U15: /products/ → services", () => expect(classifyPageType(`${URL_PREFIX}/products/`)).toBe("services"));
  it("U16: /products → services",  () => expect(classifyPageType(`${URL_PREFIX}/products`)).toBe("services"));

  // ── team ──
  it("U17: /team/ → team", () => expect(classifyPageType(`${URL_PREFIX}/team/`)).toBe("team"));
  it("U18: /team → team",  () => expect(classifyPageType(`${URL_PREFIX}/team`)).toBe("team"));

  // ── pricing ──
  it("U19: /pricing/ → pricing", () => expect(classifyPageType(`${URL_PREFIX}/pricing/`)).toBe("pricing"));
  it("U20: /pricing → pricing",  () => expect(classifyPageType(`${URL_PREFIX}/pricing`)).toBe("pricing"));

  // ── homepage ──
  it("U21: / → homepage (preserved)", () => expect(classifyPageType(`${URL_PREFIX}/`)).toBe("homepage"));
  it("U22: empty → homepage (URL constructor returns /)", () => expect(classifyPageType(URL_PREFIX)).toBe("homepage"));

  // ── query strings preserved (path matches still work) ──
  it("U23: /about-us?utm_source=email → about", () => expect(classifyPageType(`${URL_PREFIX}/about-us?utm_source=email`)).toBe("about"));
  it("U24: /contact-us?ref=footer → contact", () => expect(classifyPageType(`${URL_PREFIX}/contact-us?ref=footer`)).toBe("contact"));
  it("U25: /about?utm=launch → about", () => expect(classifyPageType(`${URL_PREFIX}/about?utm=launch`)).toBe("about"));

  // ── fragments preserved ──
  it("U26: /about-us#leadership → about", () => expect(classifyPageType(`${URL_PREFIX}/about-us#leadership`)).toBe("about"));
  it("U27: /contact#form → contact",      () => expect(classifyPageType(`${URL_PREFIX}/contact#form`)).toBe("contact"));
  it("U28: /services#derm → services",    () => expect(classifyPageType(`${URL_PREFIX}/services#derm`)).toBe("services"));

  // ── combined query + fragment + trailing slash ──
  it("U29: combined → about", () =>
    expect(classifyPageType(`${URL_PREFIX}/about-us/?utm_source=newsletter&utm_campaign=q1#leadership`)).toBe("about"));

  // ── index.html variants ──
  it("U30: /about/index.html → about",    () => expect(classifyPageType(`${URL_PREFIX}/about/index.html`)).toBe("about"));
  it("U31: /services/index.htm → services", () => expect(classifyPageType(`${URL_PREFIX}/services/index.htm`)).toBe("services"));
  it("U32: /about-us/index.html → about", () => expect(classifyPageType(`${URL_PREFIX}/about-us/index.html`)).toBe("about"));

  // ── double slash collapse ──
  it("U33: //about-us/ → about", () => expect(classifyPageType(`${URL_PREFIX}//about-us/`)).toBe("about"));
  it("U34: /about//us/ → other (collapses to /about/us, no exact match)", () =>
    expect(classifyPageType(`${URL_PREFIX}/about//us/`)).toBe("other"));

  // ── case variants ──
  it("U35: /About-Us/ → about",     () => expect(classifyPageType(`${URL_PREFIX}/About-Us/`)).toBe("about"));
  it("U36: /CONTACT/ → contact",    () => expect(classifyPageType(`${URL_PREFIX}/CONTACT/`)).toBe("contact"));
  it("U37: /SPECIALITIES/ → services", () => expect(classifyPageType(`${URL_PREFIX}/SPECIALITIES/`)).toBe("services"));

  // ── multi-segment brand path (Manipal city pattern) ──
  it("U38: /india/bangalore/about-us/ → about", () =>
    expect(classifyPageType(`${URL_PREFIX}/india/bangalore/about-us/`)).toBe("about"));

  // ── subpath false positives — blog post titles ──
  // Per ES-085 spec U39-U41: blog posts should classify as "blog" (the
  // first segment IS /blog/), NOT as the structural type matched in the
  // post title. The about/contact endsWith guard prevents about/contact
  // misclassification; the pathHasSegment first-segment matcher prevents
  // services/etc misclassification on /blog/X paths.
  it("U39: /blog/about-us-launch-q1 → blog (about endsWith guard fires; first-segment matches blog)", () =>
    expect(classifyPageType(`${URL_PREFIX}/blog/about-us-launch-q1`)).toBe("blog"));
  it("U40: /blog/services-update → blog (services first-segment guard prevents services match)", () =>
    expect(classifyPageType(`${URL_PREFIX}/blog/services-update`)).toBe("blog"));
  it("U41: /news/contact-tracing → blog (news is in blog matchers; contact endsWith guard fires)", () =>
    expect(classifyPageType(`${URL_PREFIX}/news/contact-tracing`)).toBe("blog"));

  // ── case-studies + team ordering: /case-studies/team-formation matches case-studies first ──
  it("U42: /case-studies/team-formation → case-studies (matcher order)", () =>
    expect(classifyPageType(`${URL_PREFIX}/case-studies/team-formation`)).toBe("case-studies"));

  // ── subpath trailing slash ──
  it("U43: /services/dermatology/ → services", () =>
    expect(classifyPageType(`${URL_PREFIX}/services/dermatology/`)).toBe("services"));

  // ── existing matchers regression ──
  it("U44: /blog/ → blog", () => expect(classifyPageType(`${URL_PREFIX}/blog/`)).toBe("blog"));
  it("U45: /docs/ → docs", () => expect(classifyPageType(`${URL_PREFIX}/docs/`)).toBe("docs"));
  it("U46: /faq/ → faq",   () => expect(classifyPageType(`${URL_PREFIX}/faq/`)).toBe("faq"));

  // ── legal patterns ──
  it("U47: /privacy/ → legal",         () => expect(classifyPageType(`${URL_PREFIX}/privacy/`)).toBe("legal"));
  it("U48: /terms-of-service/ → legal", () => expect(classifyPageType(`${URL_PREFIX}/terms-of-service/`)).toBe("legal"));
  it("U49: /cookie-policy/ → legal",   () => expect(classifyPageType(`${URL_PREFIX}/cookie-policy/`)).toBe("legal"));

  // ── unknown paths ──
  it("U50: /random-page → other", () => expect(classifyPageType(`${URL_PREFIX}/random-page`)).toBe("other"));

  // ── invalid URL ──
  it("U51: not-a-url → other (catch block)", () => expect(classifyPageType("not-a-url")).toBe("other"));

  // ── special edge cases ──
  it("U52: /about-us/# → about", () => expect(classifyPageType(`${URL_PREFIX}/about-us/#`)).toBe("about"));
  it("U53: https://EXAMPLE.com/SERVICES/ → services", () =>
    expect(classifyPageType("https://EXAMPLE.com/SERVICES/")).toBe("services"));
  it("U54: https://www.EXAMPLE.com/ABOUT-US/ → about", () =>
    expect(classifyPageType("https://www.EXAMPLE.com/ABOUT-US/")).toBe("about"));

  // ── Deep-path regression fixtures (2026-04-10) ────────────────────
  // Manipal-class URL pattern: /{city}/{section}/{leaf}. Prior first-
  // segment-only pathHasSegment misclassified these as "other", dragging
  // content-evaluation pillar scores. Regex-based pathHasSegment now
  // matches the section keyword at any depth provided it's bounded by
  // `/` on both sides.
  it("U55: /bangalore/specialities/cardiology/ → services (Manipal pattern)", () =>
    expect(classifyPageType(`${URL_PREFIX}/bangalore/specialities/cardiology/`)).toBe("services"));
  it("U56: /bangalore/doctors-list/cardiology/ → team (doctors-list alias)", () =>
    expect(classifyPageType(`${URL_PREFIX}/bangalore/doctors-list/cardiology/`)).toBe("team"));
  it("U57: /bangalore/blog/nutrition-tips → blog (deep blog)", () =>
    expect(classifyPageType(`${URL_PREFIX}/bangalore/blog/nutrition-tips`)).toBe("blog"));
  it("U58: /india/services/consulting/ → services (deep services)", () =>
    expect(classifyPageType(`${URL_PREFIX}/india/services/consulting/`)).toBe("services"));
  it("U59: /api/docs/getting-started → docs (deep docs)", () =>
    expect(classifyPageType(`${URL_PREFIX}/api/docs/getting-started`)).toBe("docs"));

  // ── Regression guards: the word-boundary regex must NOT match these ──
  // These are the false-positives that HP-182 guarded against. The new
  // impl still prevents them because the regex requires `/` or `$` after
  // the keyword — `services-update` has a hyphen, so no match.
  it("U60: /good-services/foo → other (hyphenated compound, not a /services/ segment)", () =>
    expect(classifyPageType(`${URL_PREFIX}/good-services/foo`)).toBe("other"));
  it("U61: /my-blog-post → other (no segment boundary)", () =>
    expect(classifyPageType(`${URL_PREFIX}/my-blog-post`)).toBe("other"));
});
