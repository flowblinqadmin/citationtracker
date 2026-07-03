# Next.js Integration

## What this platform is
Next.js is a React framework with two routing modes:
- **App Router** (Next.js 13+, the default in 14 / 15) — file-based routing under `app/`. API and asset routes are defined as `route.ts` files inside `app/...`.
- **Pages Router** (legacy but supported) — file-based routing under `pages/` with API routes under `pages/api/`.

Path rewrites can be configured via either `next.config.js` (or `next.config.ts` in Next 15) `rewrites` or, for App Router, by writing a Route Handler that returns the FlowBlinq content.

## What you need before starting
- A Next.js application
- Your FlowBlinq slug: {{SLUG}}
- Knowledge of which router your project uses (App or Pages — App is `app/`, Pages is `pages/`)

## Step 1 — Add the tracking pixel
**App Router** — `app/layout.tsx`:
```tsx
export default function RootLayout({ children }) {
  return (
    <html><body>
      {children}
      <img src="https://geo.flowblinq.com/api/t/{{SLUG}}" alt="" style={{ display: "none" }} />
    </body></html>
  );
}
```
**Pages Router** — `pages/_document.tsx`:
```tsx
import { Html, Head, Main, NextScript } from "next/document";
export default function Document() {
  return (
    <Html><Head /><body>
      <Main /><NextScript />
      <img src="https://geo.flowblinq.com/api/t/{{SLUG}}" alt="" style={{ display: "none" }} />
    </body></Html>
  );
}
```

## Step 2 — Inject schema (mandatory)
The cleanest path is server-side: fetch in a Server Component (App Router) or `getStaticProps` (Pages Router) and emit `<script type="application/ld+json">` with the JSON pre-baked. Client-side fetch is also fine:
```tsx
<script
  dangerouslySetInnerHTML={{ __html: `
    fetch("https://geo.flowblinq.com/api/serve/{{SLUG}}/schema.json")
      .then(r => r.json())
      .then(data => {
        const s = document.createElement("script");
        s.type = "application/ld+json";
        s.textContent = JSON.stringify(data);
        document.head.appendChild(s);
      });
  ` }}
/>
```

## Step 3 — Serve llms.txt
There are two equally valid approaches; pick one.

### Approach A — `next.config.js` rewrites
In `next.config.js` (or `next.config.ts` in Next 15):
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/llms.txt",
        destination: "https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt",
      },
    ];
  },
};
module.exports = nextConfig;
```
Restart `next dev` (or redeploy) — the rewrite applies to all environments.

### Approach B — App Router Route Handler
For App Router projects, create `app/llms.txt/route.ts`:
```ts
export const dynamic = "force-dynamic";

export async function GET() {
  const upstream = await fetch("https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt", {
    cache: "no-store",
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
```
This gives you full control over caching, headers, and error handling.

For **Pages Router** projects, do NOT use `pages/api/llms.txt.ts` — API routes are mounted under `/api/...`, not at the root. Use Approach A (rewrites) for Pages Router.

## Step 4 — Update robots.txt
Either add a parallel `rewrites` entry pointing at `https://geo.flowblinq.com/api/serve/{{SLUG}}/robots.txt`, or place a static `public/robots.txt` with explicit `Allow:` rules for AI crawlers.

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- Curl: `curl -I https://yourdomain.com/llms.txt` returns 200

## Common errors on Next.js
- **"Rewrite added but `/llms.txt` returns 404"** → The dev server caches `next.config.js` at startup. Stop and restart `next dev` (Ctrl-C then re-run). For production, redeploy.
- **"Static file in `public/llms.txt` overrides the rewrite"** → Files in `public/` take precedence over `rewrites`. Delete or rename the static file.
- **"App Router route returns HTML instead of plain text"** → Forgot to set `Content-Type: text/plain` in the Response headers, or the route is being intercepted by middleware that returns the SPA shell. Check `middleware.ts`.
- **"Route Handler builds but doesn't update at runtime"** → Add `export const dynamic = "force-dynamic"` to disable Next.js's static optimization for this route.

## What NOT to try on Next.js
- **`pages/api/llms.txt.ts`** — API routes mount under `/api/...`, so this would serve at `/api/llms.txt`, not `/llms.txt`. Use `next.config.js` rewrites or an App Router Route Handler at `app/llms.txt/route.ts`.
- **Putting the rewrite in `vercel.json` AND `next.config.js`** — Pick one. Both work on Vercel, but having both can cause confusion when debugging.
- **`.htaccess` / `_redirects`** — Not read by Next.js. Use `rewrites` in `next.config.js`.
- **Mixing App Router and Pages Router in the same path** — Next.js will prefer one based on file presence. Be deliberate about which directory holds `llms.txt`.
