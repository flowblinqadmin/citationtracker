# Cloudflare Integration

## What this platform is
Cloudflare is a CDN and edge platform. There are two related products:
- **Cloudflare Workers** — serverless code that runs at the edge in front of any origin (Wix, Shopify, your own server, etc.). Workers are scriptable JavaScript handlers and are the right tool for path-based rewrites.
- **Cloudflare Pages** — static site hosting with `_redirects` and Pages Functions. Use Pages Functions only when your site is hosted on Pages itself.

This guide covers **Cloudflare Workers in front of an existing origin**, which is the canonical FlowBlinq path.

## What you need before starting
- A domain on Cloudflare (nameservers pointed at Cloudflare)
- Your FlowBlinq slug: {{SLUG}}
- A Cloudflare Workers account (free tier is sufficient)

## Step 1 — Add the tracking pixel
Insert into your site HTML body via whatever mechanism your origin supports:
```html
<img src="https://geo.flowblinq.com/api/t/{{SLUG}}" alt="" style="display:none;" />
```

## Step 2 — Inject schema (mandatory)
Add to the document head:
```html
<script>
  fetch("https://geo.flowblinq.com/api/serve/{{SLUG}}/schema.json")
    .then(r => r.json())
    .then(data => {
      const script = document.createElement("script");
      script.type = "application/ld+json";
      script.textContent = JSON.stringify(data);
      document.head.appendChild(script);
    });
</script>
```

## Step 3 — Serve llms.txt via a Cloudflare Worker
1. In the Cloudflare dashboard, go to **Workers & Pages → Create application → Create Worker**.
2. Paste the following script:
```javascript
addEventListener("fetch", (event) => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  const url = new URL(request.url);
  if (url.pathname === "/llms.txt") {
    return fetch("https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt");
  }
  if (url.pathname === "/robots.txt") {
    return fetch("https://geo.flowblinq.com/api/serve/{{SLUG}}/robots.txt");
  }
  return fetch(request);
}
```
3. Click **Save and Deploy**.
4. Go to your Worker → **Triggers → Routes → Add Route**.
5. Set the route to `yourdomain.com/llms.txt*` (and a separate route for `/robots.txt*` if needed) and bind it to your Worker.

## Step 4 — Update robots.txt
The Worker above already proxies `/robots.txt`. If you prefer static, edit your origin's robots.txt with explicit `Allow:` rules for AI crawlers.

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- Curl: `curl -I https://yourdomain.com/llms.txt` returns 200

## Common errors on Cloudflare
- **"Worker not triggered"** → Routes are required. A Worker with no Routes does not intercept any traffic. Verify the route pattern matches the path including the trailing wildcard (`/llms.txt*`).
- **"Worker returns 1042"** → The Worker's outbound `fetch()` to FlowBlinq failed. Check that `geo.flowblinq.com` is reachable and not blocked at your edge.
- **"DNS not proxied (grey cloud)"** → Cloudflare DNS records must be **proxied** (orange cloud) for the Worker to receive the request. A grey-cloud record bypasses Cloudflare entirely.
- **"Conflicts with Page Rules"** → Workers run after Page Rules in the request pipeline, but a 30x redirect Page Rule on `/llms.txt` will short-circuit. Remove conflicting Page Rules.

## What NOT to try on Cloudflare
- **Page Rules to rewrite `/llms.txt`** — Page Rules can redirect but cannot transparently rewrite to a different origin while preserving the URL. Use a Worker.
- **Cloudflare Pages Functions when site is NOT on Pages** — Pages Functions only apply if the site is hosted on Cloudflare Pages. If your origin is Wix, Shopify, or anywhere else, use a Worker.
- **`.htaccess`, `_redirects`, `vercel.json`** — None of those are read by Cloudflare's edge.
- **Workers without Routes** — A deployed Worker does nothing without a Route binding. This is the most common mistake.
