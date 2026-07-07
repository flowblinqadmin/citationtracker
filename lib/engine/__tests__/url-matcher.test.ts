import { describe, it, expect } from "vitest";
import {
  normalizeArticleUrl,
  extractRegistrableDomain,
  isHomepageKey,
  resolveRedirects,
  matchCitation,
  buildMatchContext,
  isBlockedRedirectTarget,
} from "@/lib/engine/url-matcher";

describe("normalizeArticleUrl", () => {
  it("prepends scheme and lowercases host", () => {
    expect(normalizeArticleUrl("Example.COM/Path")).toBe("example.com/Path");
  });

  it("strips www / m / amp host prefixes", () => {
    expect(normalizeArticleUrl("https://www.example.com/a")).toBe("example.com/a");
    expect(normalizeArticleUrl("https://m.dailyhunt.in/news/x")).toBe("dailyhunt.in/news/x");
    expect(normalizeArticleUrl("https://amp.example.com/a")).toBe("example.com/a");
  });

  it("strips a trailing slash but keeps root", () => {
    expect(normalizeArticleUrl("https://example.com/a/")).toBe("example.com/a");
    expect(normalizeArticleUrl("https://example.com/")).toBe("example.com/");
    expect(normalizeArticleUrl("https://example.com")).toBe("example.com/");
  });

  it("drops fragments", () => {
    expect(normalizeArticleUrl("https://example.com/a#section")).toBe("example.com/a");
  });

  it("strips utm_* and known tracking params, keeps + sorts the rest", () => {
    expect(normalizeArticleUrl("https://example.com/a?utm_source=x&utm_medium=y")).toBe("example.com/a");
    expect(normalizeArticleUrl("https://example.com/a?fbclid=123&gclid=456")).toBe("example.com/a");
    expect(normalizeArticleUrl("https://example.com/a?b=2&a=1")).toBe("example.com/a?a=1&b=2");
    expect(normalizeArticleUrl("https://example.com/a?id=7&utm_source=x")).toBe("example.com/a?id=7");
  });

  it("unwraps google.com/url?q= redirect wrappers (real seed-log shape)", () => {
    expect(normalizeArticleUrl("google.com/url?q=https://motoring-trends.com/technology/drivebuddy"))
      .toBe("motoring-trends.com/technology/drivebuddy");
    expect(normalizeArticleUrl("https://www.google.com/url?q=https%3A%2F%2Fmediabrief.com%2Fpcg-secures"))
      .toBe("mediabrief.com/pcg-secures");
  });

  it("unwraps Google AMP cache and ampproject.org", () => {
    expect(normalizeArticleUrl("https://www.google.com/amp/s/example.com/article"))
      .toBe("example.com/article");
    expect(normalizeArticleUrl("https://example-com.cdn.ampproject.org/c/s/example.com/article"))
      .toBe("example.com/article");
  });

  it("strips /amp path suffixes", () => {
    expect(normalizeArticleUrl("https://example.com/article/amp")).toBe("example.com/article");
    expect(normalizeArticleUrl("https://example.com/amp/article")).toBe("example.com/article");
  });

  it("is idempotent", () => {
    const once = normalizeArticleUrl("https://www.Example.com/A/?utm_source=x#y")!;
    expect(normalizeArticleUrl(once)).toBe(once);
  });

  it("returns null for unparseable / non-http(s) input", () => {
    expect(normalizeArticleUrl("")).toBeNull();
    expect(normalizeArticleUrl("not a url")).toBeNull();
    expect(normalizeArticleUrl("ftp://example.com/a")).toBeNull();
    expect(normalizeArticleUrl("mailto:x@y.com")).toBeNull();
    expect(normalizeArticleUrl("javascript:alert(1)")).toBeNull();
  });

  it("collapses UTM/AMP/mobile variants of the same article to one key", () => {
    const keys = new Set([
      normalizeArticleUrl("https://www.example.com/news/story"),
      normalizeArticleUrl("https://m.example.com/news/story?utm_source=twitter"),
      normalizeArticleUrl("https://example.com/news/story/amp"),
      normalizeArticleUrl("https://example.com/news/story/#top"),
    ]);
    expect(keys.size).toBe(1);
  });
});

describe("extractRegistrableDomain", () => {
  it("returns the bare domain for a 2-label host", () => {
    expect(extractRegistrableDomain("https://example.com/a")).toBe("example.com");
  });
  it("collapses subdomains to eTLD+1", () => {
    expect(extractRegistrableDomain("https://auto.economictimes.indiatimes.com/news/x"))
      .toBe("indiatimes.com");
  });
  it("handles multi-part ccTLDs", () => {
    expect(extractRegistrableDomain("https://news.example.co.uk/a")).toBe("example.co.uk");
    expect(extractRegistrableDomain("https://sub.brand.co.in/a")).toBe("brand.co.in");
  });
  it("accepts bare hosts and strips prefixes", () => {
    expect(extractRegistrableDomain("m.dailyhunt.in")).toBe("dailyhunt.in");
  });
});

describe("isHomepageKey", () => {
  it("detects site roots", () => {
    expect(isHomepageKey("example.com/")).toBe(true);
    expect(isHomepageKey("example.com")).toBe(true);
    expect(isHomepageKey("example.com/article/x")).toBe(false);
  });
});

describe("resolveRedirects", () => {
  function mockFetch(chain: Record<string, { status: number; location?: string }>): typeof fetch {
    return (async (url: any) => {
      const hop = chain[String(url)] ?? { status: 200 };
      return {
        status: hop.status,
        headers: { get: (h: string) => (h.toLowerCase() === "location" ? hop.location ?? null : null) },
      } as Response;
    }) as unknown as typeof fetch;
  }

  it("follows a 301/302 chain to the final URL", async () => {
    const fetchImpl = mockFetch({
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc": { status: 302, location: "https://hop2.com/x" },
      "https://hop2.com/x": { status: 301, location: "https://final.com/article" },
      "https://final.com/article": { status: 200 },
    });
    const out = await resolveRedirects("https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", { fetchImpl });
    expect(out).toBe("https://final.com/article");
  });

  it("stops at maxHops and returns the last reached URL", async () => {
    const fetchImpl = mockFetch({
      "https://a.com/": { status: 302, location: "https://b.com/" },
      "https://b.com/": { status: 302, location: "https://c.com/" },
    });
    const out = await resolveRedirects("https://a.com/", { fetchImpl, maxHops: 1 });
    expect(out).toBe("https://b.com/");
  });

  it("uses + populates the cache", async () => {
    const cache = new Map<string, string>();
    const fetchImpl = mockFetch({
      "https://a.com/": { status: 301, location: "https://final.com/" },
      "https://final.com/": { status: 200 },
    });
    const out = await resolveRedirects("https://a.com/", { fetchImpl, cache });
    expect(out).toBe("https://final.com/");
    expect(cache.get("https://a.com/")).toBe("https://final.com/");
  });

  it("returns the original URL on fetch failure", async () => {
    const fetchImpl = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    const out = await resolveRedirects("https://a.com/x", { fetchImpl });
    expect(out).toBe("https://a.com/x");
  });
});

describe("matchCitation + buildMatchContext", () => {
  const articles = [
    { id: "art1", normalizedUrl: normalizeArticleUrl("https://autocarpro.in/news/drivebuddy-patent")! },
    { id: "art2", normalizedUrl: normalizeArticleUrl("https://overdrive.in/news/drivebuddy-funding")! },
  ];
  const ctx = buildMatchContext(articles, ["zoomcar.com", "cartrade.com"]);

  it("exact-matches an article URL (even via a UTM variant)", () => {
    const r = matchCitation("https://www.autocarpro.in/news/drivebuddy-patent?utm_source=chatgpt", ctx);
    expect(r.matchType).toBe("exact");
    expect(r.articleId).toBe("art1");
  });

  it("partial-matches the outlet homepage of an article's domain", () => {
    const r = matchCitation("https://autocarpro.in/", ctx);
    expect(r.matchType).toBe("partial");
    expect(r.articleId).toBeNull();
    expect(r.domain).toBe("autocarpro.in");
  });

  it("flags a competitor domain as unmatched-but-competitor", () => {
    const r = matchCitation("https://www.zoomcar.com/blog/ai-cars", ctx);
    expect(r.matchType).toBe("unmatched");
    expect(r.competitorDomain).toBe("zoomcar.com");
  });

  it("returns unmatched for an unrelated third-party URL", () => {
    const r = matchCitation("https://wikipedia.org/wiki/Car", ctx);
    expect(r.matchType).toBe("unmatched");
    expect(r.competitorDomain).toBeNull();
    expect(r.articleId).toBeNull();
  });

  it("returns unmatched with null normalized for garbage", () => {
    const r = matchCitation("not-a-url", ctx);
    expect(r.matchType).toBe("unmatched");
    expect(r.normalizedUrl).toBeNull();
  });

  // Review fix #8: an outlet that is ALSO a competitor must classify as a client
  // partial WITHOUT carrying competitorDomain (no double-bucketing).
  it("does not tag a client-outlet partial with competitorDomain even if the domain is also a competitor", () => {
    const overlapCtx = buildMatchContext(
      [{ id: "art1", normalizedUrl: normalizeArticleUrl("https://forbes.com/news/drivebuddy")! }],
      ["forbes.com"],
    );
    const r = matchCitation("https://forbes.com/", overlapCtx);
    expect(r.matchType).toBe("partial");
    expect(r.competitorDomain).toBeNull();
  });
});

// Review fix #1: real registrable domains whose leftmost label is literally
// www/m/amp must NOT be collapsed to the bare TLD.
describe("normalizeArticleUrl / extractRegistrableDomain — short-label hosts (fix #1)", () => {
  it("preserves amp.* / m.* registrable domains", () => {
    expect(normalizeArticleUrl("https://amp.com/dev")).toBe("amp.com/dev");
    expect(normalizeArticleUrl("https://m.com/x")).toBe("m.com/x");
    expect(extractRegistrableDomain("https://amp.com/dev")).toBe("amp.com");
    expect(extractRegistrableDomain("https://amp.dev/guide")).toBe("amp.dev");
  });
  it("still collapses www/m/amp when they are real subdomains", () => {
    expect(normalizeArticleUrl("https://www.bbc.com/news")).toBe("bbc.com/news");
    expect(normalizeArticleUrl("https://m.timesofindia.com/x")).toBe("timesofindia.com/x");
    expect(normalizeArticleUrl("https://amp.theguardian.com/a")).toBe("theguardian.com/a");
  });
});

// Review fix #2: PSL multi-tenant + gov/registry suffixes must keep the
// distinguishing label so distinct sites don't collapse.
describe("extractRegistrableDomain — PSL suffixes (fix #2)", () => {
  it("keeps the sub-host for India gov/registry suffixes", () => {
    expect(extractRegistrableDomain("https://pib.gov.in/a")).toBe("pib.gov.in");
    expect(extractRegistrableDomain("https://rbidocs.gov.in/b")).toBe("rbidocs.gov.in");
    expect(extractRegistrableDomain("https://pib.gov.in/a")).not.toBe(
      extractRegistrableDomain("https://rbidocs.gov.in/b"),
    );
    expect(extractRegistrableDomain("https://mygov.nic.in/x")).toBe("mygov.nic.in");
  });
  it("keeps the tenant sub-host for multi-tenant hosting", () => {
    expect(extractRegistrableDomain("https://clienta.blogspot.com/x")).toBe("clienta.blogspot.com");
    expect(extractRegistrableDomain("https://competitorb.blogspot.com/y")).toBe("competitorb.blogspot.com");
    expect(extractRegistrableDomain("https://someone.medium.com/post")).toBe("someone.medium.com");
  });
});

// Review fix #7: AMP-cache unwrap must take the query from the real article,
// not the cache wrapper.
describe("normalizeArticleUrl — AMP cache query source (fix #7)", () => {
  it("drops the wrapper's own params and keeps the article's", () => {
    expect(normalizeArticleUrl("https://www.google.com/amp/s/example.com/article?id=7"))
      .toBe("example.com/article?id=7");
    // utm on the inner article is still stripped
    expect(normalizeArticleUrl("https://www.google.com/amp/s/example.com/article?utm_source=g"))
      .toBe("example.com/article");
  });
});

// Review fix #4: resolveRedirects must not follow a redirect into a
// private/internal host (SSRF), nor fetch a private initial URL.
describe("resolveRedirects — SSRF guard (fix #4)", () => {
  function mockFetch(chain: Record<string, { status: number; location?: string }>): typeof fetch {
    return (async (url: any) => {
      const hop = chain[String(url)] ?? { status: 200 };
      return {
        status: hop.status,
        headers: { get: (h: string) => (h.toLowerCase() === "location" ? hop.location ?? null : null) },
      } as Response;
    }) as unknown as typeof fetch;
  }

  it("does not follow a redirect into the cloud metadata IP", async () => {
    const fetchImpl = mockFetch({
      "https://attacker.example/redir": { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
    });
    const out = await resolveRedirects("https://attacker.example/redir", { fetchImpl });
    expect(out).toBe("https://attacker.example/redir"); // stayed at the last public URL
  });

  it("does not follow a redirect into metadata.google.internal", async () => {
    const fetchImpl = mockFetch({
      "https://attacker.example/redir": { status: 302, location: "http://metadata.google.internal/computeMetadata/v1/" },
    });
    const out = await resolveRedirects("https://attacker.example/redir", { fetchImpl });
    expect(out).toBe("https://attacker.example/redir");
  });

  it("never fetches a private initial URL", async () => {
    let fetched = false;
    const fetchImpl = (async () => { fetched = true; return { status: 200, headers: { get: () => null } } as unknown as Response; }) as unknown as typeof fetch;
    const out = await resolveRedirects("http://127.0.0.1/admin", { fetchImpl });
    expect(fetched).toBe(false);
    expect(out).toBe("http://127.0.0.1/admin");
  });
});

// R08: IPv6 bypass forms that the original PRIVATE_RANGES missed.
// The WHATWG URL parser normalises [::127.0.0.1] to [::7f00:1], etc.
describe("isBlockedRedirectTarget — IPv6 bypass (R08)", () => {
  it("blocks IPv4-compatible loopback [::127.0.0.1] (normalised to [::7f00:1])", () => {
    // WHATWG URL normalises ::127.0.0.1 → ::7f00:1
    expect(isBlockedRedirectTarget("http://[::7f00:1]/")).toBe(true);
  });

  it("blocks IPv4-compatible link-local [::169.254.169.254] (normalised to [::a9fe:a9fe])", () => {
    expect(isBlockedRedirectTarget("http://[::a9fe:a9fe]/")).toBe(true);
  });

  it("blocks all-zeros / unspecified address [::]", () => {
    expect(isBlockedRedirectTarget("http://[::]/")).toBe(true);
  });

  it("blocks NAT64 well-known prefix [64:ff9b::169.254.169.254]", () => {
    expect(isBlockedRedirectTarget("http://[64:ff9b::a9fe:a9fe]/")).toBe(true);
  });

  it("resolveRedirects does not follow a redirect to [::7f00:1] (IPv4-compat loopback)", async () => {
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u === "https://attacker.example/redir") {
        return {
          status: 302,
          headers: { get: (h: string) => h.toLowerCase() === "location" ? "http://[::7f00:1]/admin" : null },
        } as unknown as Response;
      }
      // Should never reach here
      return { status: 200, headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;
    const out = await resolveRedirects("https://attacker.example/redir", { fetchImpl });
    expect(out).toBe("https://attacker.example/redir");
  });
});

// R09: DNS-rebinding / DNS-to-internal bypass.
// A public hostname that resolves to a private IP must be blocked BEFORE fetch is
// called. dnsLookupImpl is the injectable seam for tests.
describe("resolveRedirects — DNS pre-flight guard (R09)", () => {
  function mockFetch(chain: Record<string, { status: number; location?: string }>): typeof fetch {
    return (async (url: any) => {
      const hop = chain[String(url)] ?? { status: 200 };
      return {
        status: hop.status,
        headers: { get: (h: string) => (h.toLowerCase() === "location" ? hop.location ?? null : null) },
      } as Response;
    }) as unknown as typeof fetch;
  }

  it("blocks a public hostname that resolves (stubbed) to 127.0.0.1 — fetch is NOT called", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (url: any) => {
      fetched.push(String(url));
      return { status: 200, headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;

    const dnsLookupImpl = async (hostname: string) => {
      if (hostname === "localtest.me") return "127.0.0.1";
      return "1.2.3.4";
    };

    const out = await resolveRedirects("http://localtest.me/admin", { fetchImpl, dnsLookupImpl });
    // Must NOT have fetched (blocked by DNS pre-flight)
    expect(fetched).toHaveLength(0);
    // Must return original URL unchanged (fail-closed on private DNS result)
    expect(out).toBe("http://localtest.me/admin");
  });

  it("blocks a public hostname that resolves (stubbed) to 169.254.169.254 — fetch is NOT called", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (url: any) => {
      fetched.push(String(url));
      return { status: 200, headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;

    const dnsLookupImpl = async (hostname: string) => {
      if (hostname === "evil-imds.example.com") return "169.254.169.254";
      return "1.2.3.4";
    };

    const out = await resolveRedirects("http://evil-imds.example.com/latest/meta-data/", { fetchImpl, dnsLookupImpl });
    expect(fetched).toHaveLength(0);
    expect(out).toBe("http://evil-imds.example.com/latest/meta-data/");
  });

  it("allows a public hostname that resolves (stubbed) to a public IP — fetch IS called", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (url: any) => {
      fetched.push(String(url));
      return { status: 200, headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;

    const dnsLookupImpl = async (_hostname: string) => "93.184.216.34"; // example.com

    const out = await resolveRedirects("https://example.com/article", { fetchImpl, dnsLookupImpl });
    expect(fetched).toHaveLength(1);
    expect(out).toBe("https://example.com/article");
  });

  it("blocks a redirect hop whose resolved hostname points to 127.0.0.1", async () => {
    const fetched: string[] = [];
    const fetchImpl = mockFetch({
      "https://attacker.example/redir": { status: 302, location: "http://localtest.me/admin" },
    });
    const wrappedFetch = (async (url: any) => {
      fetched.push(String(url));
      return (fetchImpl as any)(url);
    }) as unknown as typeof fetch;

    const dnsLookupImpl = async (hostname: string) => {
      if (hostname === "localtest.me") return "127.0.0.1";
      return "1.2.3.4";
    };

    const out = await resolveRedirects("https://attacker.example/redir", { fetchImpl: wrappedFetch, dnsLookupImpl });
    // First hop (attacker.example) is fetched, redirect to localtest.me is blocked
    expect(fetched).toHaveLength(1);
    expect(out).toBe("https://attacker.example/redir");
  });

  it("blocks an unresolvable hostname (DNS failure → fail closed)", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (url: any) => {
      fetched.push(String(url));
      return { status: 200, headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;

    const dnsLookupImpl = async (_hostname: string): Promise<string> => {
      throw new Error("ENOTFOUND");
    };

    const out = await resolveRedirects("https://unresolvable.invalid/path", { fetchImpl, dnsLookupImpl });
    expect(fetched).toHaveLength(0);
    expect(out).toBe("https://unresolvable.invalid/path");
  });

  it("skips DNS pre-flight when neither dnsLookupImpl nor fetchImpl is provided (production path uses its own DNS)", async () => {
    // When no dnsLookupImpl is provided and no fetchImpl is provided, the
    // function should not crash — this is the production path. We can't test
    // the real DNS here, so just verify the function signature accepts the opts.
    // We pass a fetchImpl to prevent a real network call, but no dnsLookupImpl.
    const fetchImpl = (async () => {
      return { status: 200, headers: { get: () => null } } as unknown as Response;
    }) as unknown as typeof fetch;

    // No dnsLookupImpl — should work without erroring
    const out = await resolveRedirects("https://example.com/", { fetchImpl });
    expect(out).toBe("https://example.com/");
  });
});
