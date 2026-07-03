# Wix Integration

## What this platform is
Wix is a hosted website builder; users edit through the Wix Studio interface and have no server access. Wix handles hosting and domain configuration entirely through the dashboard.

## What you need before starting
- A verified domain in Wix (Settings → Domain Management)
- Your FlowBlinq slug: {{SLUG}}
- Access to Wix Settings (Admin panel)

## Step 1 — Add the tracking pixel
In the Wix Admin panel:
1. Go to **Settings → Custom Code**
2. Click **Add Custom Code**
3. Paste the tracking pixel:
```html
<img src="https://geo.flowblinq.com/api/t/{{SLUG}}" alt="" style="display:none;" />
```
4. Set placement to **Footer Code**
5. Click **Apply**

## Step 2 — Inject schema (mandatory)
For the structured data schema:
1. Go to **Settings → Custom Code**
2. Click **Add Custom Code**
3. Paste the schema fetch:
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
4. Set placement to **Header Code**
5. Click **Apply**

## Step 3 — Serve llms.txt with Cloudflare Worker
Wix does NOT support server-side rewrites at arbitrary paths like `/llms.txt`. The canonical solution is to place a **Cloudflare Worker** in front of your Wix domain.

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
5. In your Cloudflare domain settings, add a **CNAME** record pointing back to your Wix domain

## Step 4 — Update robots.txt
Wix does NOT provide native robots.txt editing. If you need to allow AI crawlers:
1. Use Cloudflare Worker to intercept requests to `/robots.txt` and inject the allow rule, or
2. Add a meta tag in **Custom Code** → **Header Code**:
```html
<meta name="robots" content="index, follow">
```

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- If Cloudflare Worker is running, llms.txt should be reachable

## Common errors on Wix
- **"Cannot add rewrite rules in Wix"** → Wix is a hosted builder with no server config. Cloudflare Worker is the only solution for `/llms.txt` rewrites.
- **"Custom Code not showing"** → Check that the code is applied to **all pages**. In Settings → Custom Code, verify the scope is set to **All pages**.
- **"Schema script runs but tracking pixel doesn't"** → Verify both snippets are in Custom Code with Footer (tracking) and Header (schema) placement. Footer code runs after page load; Header code runs first.
- **"Cloudflare Worker timeout"** → Ensure the Cloudflare DNS is properly configured for your Wix domain. Test with `curl https://yourdomain.com/llms.txt`.
- **"CORS errors in console"** → The fetch may trigger CORS. Cloudflare Workers allow cross-origin fetches; this is expected behavior.

## What NOT to try on Wix
- **Velo by Wix backend functions** — Velo cannot serve files at arbitrary paths like `/llms.txt`. Velo is for custom app logic, not file serving.
- **Wix theme file editing** — Wix has no editable theme files (like WordPress theme.php or Shopify theme.liquid). All styling is visual.
- **Wix reverse proxy feature** — This feature does not exist in Wix. Do not look for "Project Settings → Hosting → Advanced" or similar. Use Cloudflare Worker instead.
- **Modifying Wix HTML directly** — You cannot edit raw HTML in Wix. Only Custom Code (via the dashboard) and visual editor changes apply.
