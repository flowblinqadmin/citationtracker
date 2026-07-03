# Shopify Integration

## What this platform is
Shopify is a hosted e-commerce platform with built-in hosting; merchants edit storefronts through the Shopify Admin. Shopify provides theme editing (Liquid template language) and app integrations, but no server-side rewrite capabilities.

## What you need before starting
- A verified custom domain in Shopify (Settings → Domains and SSL)
- Your FlowBlinq slug: {{SLUG}}
- Access to Shopify Admin (Online Store → Themes section)

## Step 1 — Add the tracking pixel
In the Shopify Admin:
1. Go to **Online Store → Themes**
2. Find your active theme
3. Click **Actions → Edit code**
4. In the **Layout** section, click **theme.liquid**
5. Find the closing `</body>` tag (near the end of the file)
6. Paste just before `</body>`:
```html
<img src="https://geo.flowblinq.com/api/t/{{SLUG}}" alt="" style="display:none;" />
```
7. Click **Save**

## Step 2 — Inject schema (mandatory)
For the structured data schema:
1. In the same **theme.liquid** file, find the closing `</head>` tag
2. Paste just before `</head>`:
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
Shopify does NOT support arbitrary path rewrites (like `/llms.txt`). Shopify's URL routing is fixed to its commerce paths. The canonical solution is to place a **Cloudflare Worker** in front of your Shopify domain.

1. Point your domain to Cloudflare (change nameservers at your domain registrar or in Shopify's domain settings)
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
5. In Cloudflare or your domain registrar, point the domain back to your Shopify store

## Step 4 — Update robots.txt
Shopify auto-generates a robots.txt file. To allow AI crawlers:
1. Go to **Settings → Files**
2. Upload a custom `robots.txt` file with:
```
User-agent: GPTBot
Disallow:

User-agent: ClaudeBot
Disallow:

User-agent: PerplexityBot
Disallow:

User-agent: *
Disallow: /admin
Disallow: /checkout
```
3. Save the file

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- If Cloudflare Worker is running, llms.txt should be reachable

## Common errors on Shopify
- **"Shopify URL rewrites not working"** → Shopify does not support arbitrary path rewrites. Cloudflare Worker is the only solution for `/llms.txt`.
- **"theme.liquid edit not saving"** → Ensure you have Admin access. Some Shopify staff accounts have restricted theme editing permissions. Contact your Shopify account owner.
- **".htaccess doesn't work on Shopify"** → Shopify isn't Apache. Do not use .htaccess syntax. Use Shopify Files (robots.txt) or theme.liquid edits only.
- **"Tracking script fires but schema doesn't load"** → Verify the fetch URL is correct. Shopify may cache responses; clear the cache in **Online Store → Themes → Actions → Refresh the theme**. Also check browser console for CORS errors.
- **"Cloudflare Worker timeout"** → Ensure Cloudflare DNS is correctly pointing to your Shopify store. Test with `curl -I https://yourdomain.com/llms.txt`.

## What NOT to try on Shopify
- **Shopify URL rewrites at /llms.txt** — Shopify does not support this natively. Cloudflare Worker is mandatory.
- **".htaccess on Shopify"** — Shopify is not Apache. .htaccess rules do not apply.
- **Shopify Functions for file serving** — Shopify Functions are for order workflow and payment customization, not arbitrary file serving.
- **Apps that promise "Shopify rewrites"** — Beware false claims. No Shopify app can rewrite to `/llms.txt` without Cloudflare in front.
