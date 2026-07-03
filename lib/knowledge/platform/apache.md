# Apache Integration

## What this platform is
Apache HTTP Server is a long-running HTTP server. Configuration lives in `httpd.conf` (or distribution-specific files like `apache2.conf`, `sites-available/000-default.conf` on Debian/Ubuntu). Site-level overrides use `.htaccess` files when `AllowOverride` is enabled.

## What you need before starting
- Shell or panel access to the Apache server
- Your FlowBlinq slug: {{SLUG}}
- `mod_rewrite` enabled (`a2enmod rewrite` on Debian/Ubuntu) and `mod_proxy` + `mod_proxy_http` enabled
- `AllowOverride All` (or `AllowOverride FileInfo`) on the relevant `<Directory>` block, so `.htaccess` rewrites are honoured

## Step 1 — Add the tracking pixel
Insert into your site HTML body via your origin's templating layer:
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

## Step 3 — Serve llms.txt via mod_rewrite + .htaccess
Edit (or create) `.htaccess` at your document root and add:
```
RewriteEngine On
RewriteRule ^/?llms\.txt$ https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt [P,L]
```
The `[P]` flag turns the rule into a transparent proxy (requires `mod_proxy_http`); `[L]` stops further rule processing. The user's URL stays on your domain.

If you don't have `.htaccess` write access but do have `httpd.conf` access, place the same rule inside your `<VirtualHost>`:
```apache
<VirtualHost *:443>
    ServerName yourdomain.com
    # ... your existing config ...
    RewriteEngine On
    RewriteRule ^/?llms\.txt$ https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt [P,L]
    SSLProxyEngine On
</VirtualHost>
```

`SSLProxyEngine On` is required when proxying to an HTTPS upstream.

After editing, reload Apache:
```
sudo apachectl configtest && sudo apachectl graceful
```

## Step 4 — Update robots.txt
Add a parallel rule:
```
RewriteRule ^/?robots\.txt$ https://geo.flowblinq.com/api/serve/{{SLUG}}/robots.txt [P,L]
```
Or maintain your own static `robots.txt` with explicit `Allow:` rules.

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- Curl: `curl -I https://yourdomain.com/llms.txt` returns 200

## Common errors on Apache
- **"500 Internal Server Error"** → Check the Apache error log (typically `/var/log/apache2/error.log`). The most common cause is `mod_rewrite` not enabled (`a2enmod rewrite`) or the `[P]` flag failing because `mod_proxy_http` is not enabled.
- **"Rule has no effect"** → `AllowOverride None` in the parent `<Directory>` block disables `.htaccess`. Either set `AllowOverride All` and reload, or move the rule into the VirtualHost itself.
- **"Proxy returns 502"** → `SSLProxyEngine` is not enabled, so the HTTPS handshake to FlowBlinq fails. Add `SSLProxyEngine On` to the VirtualHost.
- **"SPA index served instead of llms.txt"** → A SPA fallback rule (commonly `RewriteRule ^ index.html [L]`) is matching first. Place the `/llms.txt` rule **above** the SPA fallback.

## What NOT to try on Apache
- **`proxy_pass`** — That is nginx syntax. Apache uses `RewriteRule … [P]` or `ProxyPass`.
- **`_redirects`** — That is Netlify-specific.
- **`vercel.json`** — That is Vercel-specific.
- **`Redirect 301 /llms.txt …`** — A 301 sends the client elsewhere; we want the URL to remain on your domain. Use `RewriteRule … [P]`.
- **Editing `httpd.conf` without testing** — Always run `apachectl configtest` before reloading. A bad config will refuse to start.
