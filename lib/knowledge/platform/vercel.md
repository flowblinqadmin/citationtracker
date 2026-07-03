# Vercel Integration

## What this platform is
Vercel is a serverless hosting platform for frontend frameworks (Next.js, SvelteKit, etc.). It serves static assets from a CDN and runs server-side code as Functions. Configuration lives in `vercel.json` at the project root, alongside the framework's own config.

## What you need before starting
- A Vercel project that deploys your domain
- Your FlowBlinq slug: {{SLUG}}
- Write access to the Git repository linked to the Vercel project

## Step 1 — Add the tracking pixel
Insert the pixel into your site's HTML body (typically the root layout or `_document`):
```html
<img src="https://geo.flowblinq.com/api/t/{{SLUG}}" alt="" style="display:none;" />
```
Commit and push to trigger a Vercel deployment.

## Step 2 — Inject schema (mandatory)
Fetch the structured data and inject as `application/ld+json` from the document head:
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

## Step 3 — Serve llms.txt via vercel.json rewrites
Create or edit `vercel.json` at your project root. Add a `rewrites` entry that proxies `/llms.txt` to the FlowBlinq serve endpoint:
```json
{
  "rewrites": [
    {
      "source": "/llms.txt",
      "destination": "https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt"
    }
  ]
}
```
Commit and push. Vercel applies the rewrite on the next deployment.

## Step 4 — Update robots.txt
Add a `rewrites` entry for `/robots.txt` if you want the FlowBlinq-managed file:
```json
{
  "rewrites": [
    { "source": "/llms.txt", "destination": "https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt" },
    { "source": "/robots.txt", "destination": "https://geo.flowblinq.com/api/serve/{{SLUG}}/robots.txt" }
  ]
}
```
Or keep your own `public/robots.txt` and add an `Allow:` rule for AI crawlers.

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- Curl test: `curl -I https://yourdomain.com/llms.txt` should return 200 with content from FlowBlinq

## Common errors on Vercel
- **"vercel.json not picked up"** → The file must be at the project root, not inside `app/`, `pages/`, or `public/`. Redeploy after committing.
- **"Rewrite returns 308 redirect instead of 200"** → A `redirects` entry was used instead of `rewrites`. Use `rewrites` for transparent proxying.
- **"llms.txt returns the SPA index"** → The Next.js or framework router is intercepting before `vercel.json` rewrites apply. `vercel.json` rewrites run at the edge before framework routing — confirm there is no conflicting `rewrites` block in `next.config.js`.
- **"Source path doesn't match"** → `/llms.txt` is exact-match. Patterns like `/llms*` need `:path*` syntax. Stick to the exact path.

## What NOT to try on Vercel
- **`.htaccess`** — Apache config files have no effect on Vercel.
- **`_redirects`** — That is Netlify-specific and is ignored by Vercel.
- **`theme.liquid` / Liquid templates** — Vercel does not host Shopify themes.
- **`proxy_pass`** — Nginx directives have no effect; Vercel's CDN handles routing through `vercel.json`.
- **Editing `next.config.js` rewrites instead of `vercel.json`** — Both work, but `vercel.json` is the canonical Vercel-platform answer for static path rewrites and survives framework migrations.
