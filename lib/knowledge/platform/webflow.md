# Webflow Integration

## What this platform is
Webflow is a hosted visual website builder. Webflow handles hosting, CDN, and DNS through its own infrastructure. Custom code is added through **Project Settings → Custom Code** at either the Head or Footer level. Webflow does NOT support server-side rewrites at arbitrary paths.

## What you need before starting
- Designer/Editor access to the Webflow project
- Your FlowBlinq slug: {{SLUG}}
- A Cloudflare account (required for Step 3 — Webflow has no native rewrite mechanism)

## Step 1 — Add the tracking pixel
1. Open the project in the Webflow Designer.
2. Go to **Project Settings → Custom Code**.
3. In the **Footer Code** field, paste:
```html
<img src="https://geo.flowblinq.com/api/t/{{SLUG}}" alt="" style="display:none;" />
```
4. Click **Save Changes** and **Publish** the site.

## Step 2 — Inject schema (mandatory)
Same panel:
1. **Project Settings → Custom Code → Head Code**
2. Paste:
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
3. **Save Changes** → **Publish**.

## Step 3 — Serve llms.txt with a Cloudflare Worker
Webflow does NOT support server-side rewrites at arbitrary paths — there is no `.htaccess`, no `vercel.json`, no `_redirects`, no Webflow-managed rewrite mechanism. The canonical solution is a **Cloudflare Worker in front of your Webflow site**.

1. Move your domain's DNS to Cloudflare (change nameservers at your registrar).
2. In Cloudflare, create the necessary records pointing at Webflow's hosting (per Webflow's custom-domain instructions).
3. In Cloudflare dashboard → **Workers & Pages → Create application → Create Worker**.
4. Paste:
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
5. **Save and Deploy**.
6. Bind the Worker to a Route: `yourdomain.com/llms.txt*` (and `/robots.txt*` if needed).

## Step 4 — Update robots.txt
The Worker above already serves `/robots.txt`. Webflow ALSO has a built-in `robots.txt` editor in **Project Settings → SEO** — but the Cloudflare Worker rewrite takes precedence at the edge, so configure it there.

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- Curl: `curl -I https://yourdomain.com/llms.txt` returns 200

## Common errors on Webflow
- **"Custom Code didn't appear after Save"** → Custom Code only applies to the **published** site. Hit **Publish** after saving.
- **"Schema script blocked by CSP"** → Webflow's default CSP is permissive, but enterprise plans can tighten it. Check the browser console for `Content-Security-Policy` warnings.
- **"Cloudflare Worker not triggered"** → DNS records must be **proxied** (orange cloud) for Workers to receive traffic. Grey-cloud (DNS only) records bypass Cloudflare entirely.
- **"Edge-cached old content"** → After deploying a new Worker, purge the Cloudflare cache (Caching → Purge Everything) or wait for TTL.

## What NOT to try on Webflow
- **`webflow.config.js`** — No such file. Webflow has no project-level config file for rewrites.
- **`Project Settings → Hosting → Advanced` rewrite rules** — That section does NOT exist in Webflow. Some AI tools fabricate this path; ignore it.
- **`.htaccess`, `_redirects`, `vercel.json`** — None of these are read by Webflow's hosting.
- **Webflow's "Reverse proxy" feature** — Webflow does NOT have a reverse-proxy feature. The only way to rewrite paths is to put Cloudflare (or another CDN with edge-scripting) in front.
- **Using Webflow's built-in `301 redirect` setting for `/llms.txt`** — A 301 sends the client to FlowBlinq's URL; we want the URL to remain on your domain. Use a Cloudflare Worker.
