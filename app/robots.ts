import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: "/",
      },
      {
        userAgent: [
          "GPTBot",
          "ChatGPT-User",
          "ClaudeBot",
          "PerplexityBot",
          "OAI-SearchBot",
          "Googlebot",
          "Bingbot",
          "DuckDuckBot",
        ],
        allow: "/api/serve/",
        disallow: "/",
      },
    ],
    host: "https://geo.flowblinq.com",
  };
}
