# Squarespace Integration

## What this platform is
Squarespace is a hosted website builder with built-in hosting and commerce; users edit through the visual editor and have no server access. All configuration happens through the Squarespace dashboard.

## What you need before starting
- A verified custom domain in Squarespace (Settings → Domains & SSL)
- Your FlowBlinq slug: {{SLUG}}
- Access to Squarespace Settings (Admin panel)

## Step 1 — Add the tracking pixel
In the Squarespace Admin panel:
1. Go to **Settings → Advanced → Code Injection**
2. Under **Footer Code**, paste:
```html
<img src="https://geo.flowblinq.com/api/t/{{SLUG}}" alt="" style="display:none;" />
```
3. Click **Save**

## Step 2 — Inject schema (mandatory)
For the structured data schema:
1. Go to **Settings → Advanced → Code Injection**
2. Under **Header Code**, paste:
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
3. Click **Save**

## Step 3 — Serve llms.txt with Cloudflare Worker
Squarespace does NOT support server-side rewrites at arbitrary paths like `/llms.txt`. The canonical solution is to place a **Cloudflare Worker** in front of your Squarespace domain.

1. Point your domain to Cloudflare (change nameservers at your domain registrar)
2. In Cloudflare Dashboard, go to **Workers & Pages → Create Application → Create Worker**
3. Paste this code into the worker:
```javascript
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/llms.txt") {
      return fetch(`https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt`);
    }
    return fetch(request);
  }
};
```
4. Click **Deploy**
5. In Cloudflare, update your domain DNS to point back to your Squarespace site

## Step 4 — Update robots.txt
Squarespace does NOT provide native robots.txt editing in the UI. If you need to allow AI crawlers:
1. Use Cloudflare Worker to intercept `/robots.txt` requests and inject the allow rule, or
2. Add a meta tag in **Settings → Advanced → Code Injection** → **Header Code**:
```html
<meta name="robots" content="index, follow">
```

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- If Cloudflare Worker is running, llms.txt should be reachable

## Common errors on Squarespace
- **"Squarespace doesn't support rewrites"** → Correct. Squarespace is a fully hosted platform with no server configuration. Cloudflare Worker is the only solution.
- **"Code Injection not visible on my site"** → Code Injection runs on all pages by default. If custom code doesn't appear, check for browser cache (`Cmd+Shift+R` to hard refresh).
- **"Fetch fails silently"** → Squarespace Content Security Policy (CSP) may block cross-origin fetches. Check browser console for CSP warnings. If blocked, inject the schema inline instead.
- **"Tracking pixel not firing"** → Footer Code runs after page load. Use browser DevTools (Network tab) to confirm the image request is being made. Check that {{SLUG}} was substituted correctly.
- **"Cloudflare Worker doesn't intercept requests"** → Verify Cloudflare DNS is active for your domain. Test with `curl -I https://yourdomain.com/llms.txt`.

## What NOT to try on Squarespace
- **"Squarespace supports server-side rewrites"** — False. Squarespace does not allow rewrites, redirects, or arbitrary file serving at custom paths.
- **"Settings → Advanced → Code Injection rewrites"** — Code Injection is for client-side code only (scripts, styles, tracking). It cannot rewrite URLs.
- **Editing Squarespace template files** — Squarespace has no editable template files. Possible to customize CSS and layout, but updates may revert when Squarespace rolls out platform changes.
- **Squarespace's built-in SEO tools for llms.txt** — Squarespace does not have an llms.txt generator or server-side rewrite feature. Cloudflare Worker is mandatory.
