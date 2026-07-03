# Netlify Integration

## What this platform is
Netlify is a static-site and serverless hosting platform. It serves static assets from a global CDN and runs Edge Functions and serverless Functions on demand. Configuration lives in `netlify.toml` at the project root and in the `_redirects` file inside the publish directory.

## What you need before starting
- A Netlify site connected to your Git repository
- Your FlowBlinq slug: {{SLUG}}
- Write access to the repository

## Step 1 — Add the tracking pixel
Insert the pixel into your site HTML body:
```html
<img src="https://geo.flowblinq.com/api/t/{{SLUG}}" alt="" style="display:none;" />
```
Commit and push — Netlify deploys automatically.

## Step 2 — Inject schema (mandatory)
Fetch and inject the structured data from the document head:
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

## Step 3 — Serve llms.txt via _redirects
Add a line to your `_redirects` file (placed at the root of your publish directory, typically `public/_redirects` or `static/_redirects`):
```
/llms.txt  https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt  200
```
The `200` status code makes this a **rewrite** (proxy), not a redirect. The user's URL stays on your domain while content streams from FlowBlinq.

Alternatively, configure the rewrite in `netlify.toml`:
```toml
[[redirects]]
  from = "/llms.txt"
  to = "https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt"
  status = 200
  force = true
```
`force = true` ensures the redirect runs even when a static file with the same name exists.

## Step 4 — Update robots.txt
Either rewrite `/robots.txt` similarly:
```
/robots.txt  https://geo.flowblinq.com/api/serve/{{SLUG}}/robots.txt  200
```
Or maintain your own `public/robots.txt` with explicit `Allow:` rules for AI crawlers.

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- Curl: `curl -I https://yourdomain.com/llms.txt` returns 200

## Common errors on Netlify
- **"_redirects file not detected"** → The file must be in your **publish directory** as configured in `netlify.toml` (default `public/`). Check the deploy log for "X redirect rules processed".
- **"Returns 404 instead of FlowBlinq content"** → Without `force = true` (or `!` suffix in `_redirects`), Netlify serves any matching static file before applying the rewrite. Add `force = true` or remove the conflicting static file.
- **"Trailing newline missing"** → `_redirects` requires a newline at the end of the file. Some editors strip it.
- **"Rule applies but returns redirect, not proxy"** → Make sure the third token is `200`, not `301` or `302`. `200` = rewrite, `30x` = redirect.

## What NOT to try on Netlify
- **`vercel.json`** — That is Vercel-specific and ignored by Netlify.
- **`.htaccess`** — Apache config has no effect on Netlify's CDN.
- **`proxy_pass`** — Nginx directives don't apply.
- **Edit Functions to serve `/llms.txt`** — Functions work but `_redirects` is the canonical, simpler path. Functions add cold-start latency.
