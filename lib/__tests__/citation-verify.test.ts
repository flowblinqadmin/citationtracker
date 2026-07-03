// Hallucination guard: cited pages must be alive AND actually mention the
// brand. Pure classifier + SSRF URL guard; the fetch itself is exercised with
// an injected fetcher.
import { describe, it, expect, vi } from "vitest";
import { classifyPage, isFetchableUrl, verifyCitationUrl, stripHtml } from "@/lib/citation-verify";

describe("isFetchableUrl (SSRF guard)", () => {
  it("allows plain public http(s) URLs", () => {
    expect(isFetchableUrl("https://g2.com/products/x")).toBe(true);
    expect(isFetchableUrl("http://example.org/a?b=c")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    expect(isFetchableUrl("ftp://example.org/x")).toBe(false);
    expect(isFetchableUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchableUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects localhost, private/link-local names and ALL IP literals", () => {
    for (const u of [
      "http://localhost/x",
      "https://127.0.0.1/x",
      "https://10.0.0.1/x",
      "https://192.168.1.1/x",
      "https://172.16.0.9/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://8.8.8.8/x", // IP literals are junk citations anyway — block all
      "https://internal.local/x",
      "https://foo.internal/x",
    ]) {
      expect(isFetchableUrl(u), u).toBe(false);
    }
  });

  it("rejects non-default ports and garbage", () => {
    expect(isFetchableUrl("https://example.org:8443/x")).toBe(false);
    expect(isFetchableUrl("not a url")).toBe(false);
  });
});

describe("classifyPage", () => {
  const KW = ["FlowBlinq", "flowblinq"];

  it("dead on 4xx/5xx", () => {
    expect(classifyPage(404, "text/html", "", KW).status).toBe("dead");
    expect(classifyPage(500, "text/html", "", KW).status).toBe("dead");
  });

  it("unverifiable (not dead) when the site blocks bots — the page may be fine in a browser", () => {
    expect(classifyPage(403, "text/html", "", KW).status).toBe("unverifiable");
    expect(classifyPage(429, "text/html", "", KW).status).toBe("unverifiable");
  });

  it("verified when the page mentions a brand keyword (case-insensitive)", () => {
    const r = classifyPage(200, "text/html", "<p>Why FLOWBLINQ is great</p>", KW);
    expect(r).toEqual({ status: "verified", brandMatched: true });
  });

  it("no_mention when the page is live but never mentions the brand — the hallucination case", () => {
    const r = classifyPage(200, "text/html", "<h1>Best AI Flow alternatives</h1><p>Appfire Flow…</p>", KW);
    expect(r).toEqual({ status: "no_mention", brandMatched: false });
  });

  it("does not match keywords inside HTML attributes/tags only", () => {
    // keyword appears only in a URL attribute, not in visible text
    const html = '<a href="https://flowblinq.com/x">click</a>';
    expect(classifyPage(200, "text/html", html, KW).status).toBe("no_mention");
  });

  it("unverifiable for non-text content", () => {
    expect(classifyPage(200, "application/pdf", "", KW).status).toBe("unverifiable");
  });
});

describe("stripHtml", () => {
  it("drops tags, scripts and styles but keeps visible text", () => {
    const html = "<script>var flowblinq=1</script><style>.flowblinq{}</style><b>Hello</b> world";
    const text = stripHtml(html);
    expect(text).toContain("Hello world");
    expect(text.toLowerCase()).not.toContain("flowblinq");
  });
});

describe("verifyCitationUrl", () => {
  const KW = ["FlowBlinq"];

  it("classifies via the injected fetcher and follows safe redirects", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: "https://real.example.com/page" } }),
      )
      .mockResolvedValueOnce(
        new Response("<p>FlowBlinq review</p>", { status: 200, headers: { "content-type": "text/html" } }),
      );
    const r = await verifyCitationUrl("https://redir.example.com/x", KW, fetcher);
    expect(r).toMatchObject({ status: "verified", httpStatus: 200, brandMatched: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses to follow a redirect into a private host", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/meta" } }),
    );
    const r = await verifyCitationUrl("https://redir.example.com/x", KW, fetcher);
    expect(r.status).toBe("unverifiable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("dead on network error", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await verifyCitationUrl("https://gone.example.com/x", KW, fetcher);
    expect(r.status).toBe("dead");
  });

  it("unverifiable for a blocked URL without fetching", async () => {
    const fetcher = vi.fn();
    const r = await verifyCitationUrl("http://localhost/x", KW, fetcher);
    expect(r.status).toBe("unverifiable");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
