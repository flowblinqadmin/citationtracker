# nginx Integration

## What this platform is
nginx is a high-performance HTTP server and reverse proxy. Configuration lives in `nginx.conf` (typically at `/etc/nginx/nginx.conf` or in `/etc/nginx/sites-available/`). Site-specific blocks are defined inside `server { ... }` and request handling inside `location { ... }` blocks.

## What you need before starting
- Shell access to the server running nginx
- Your FlowBlinq slug: {{SLUG}}
- Permission to reload the nginx service (`nginx -s reload` or `systemctl reload nginx`)

## Step 1 — Add the tracking pixel
Insert into your site HTML body (in your origin app's template):
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

## Step 3 — Serve llms.txt via a location + proxy_pass block
Inside your existing `server { ... }` block, add a `location` for `/llms.txt`:
```nginx
server {
    server_name yourdomain.com;
    # ... your existing TLS / root / index directives ...

    location = /llms.txt {
        proxy_pass https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt;
        proxy_set_header Host geo.flowblinq.com;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_ssl_server_name on;
    }
}
```
Notes:
- `location = /llms.txt` (with the `=` modifier) is exact-match — it has higher priority than prefix matches.
- `proxy_ssl_server_name on` is required so SNI is sent to FlowBlinq's TLS listener.
- `proxy_set_header Host geo.flowblinq.com` ensures the upstream request has the correct virtual host.

Reload nginx:
```
sudo nginx -t && sudo nginx -s reload
```

## Step 4 — Update robots.txt
Add a parallel `location` for `/robots.txt` (or maintain your own static file with explicit `Allow:` rules):
```nginx
location = /robots.txt {
    proxy_pass https://geo.flowblinq.com/api/serve/{{SLUG}}/robots.txt;
    proxy_set_header Host geo.flowblinq.com;
    proxy_ssl_server_name on;
}
```

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- Curl: `curl -I https://yourdomain.com/llms.txt` returns 200

## Common errors on nginx
- **`nginx: [emerg] no resolver defined`** → If your `proxy_pass` targets a hostname (not an IP), nginx needs a `resolver` directive at the http or server scope, e.g. `resolver 1.1.1.1 8.8.8.8 valid=60s;`. Without it, nginx fails to resolve `geo.flowblinq.com` at startup.
- **`502 Bad Gateway`** → Often `proxy_ssl_server_name` is missing, so SNI is not sent and the upstream TLS handshake fails. Add `proxy_ssl_server_name on;`.
- **Returns the SPA index instead of llms.txt** → A `try_files` directive with `$uri` and a fallback is intercepting before the new `location` block. Remember `location = /llms.txt` (exact match) takes priority over prefix matches like `location /`.
- **Config edits don't take effect** → After editing, run `sudo nginx -t` to syntax-check, then `sudo nginx -s reload` to apply. Forgetting to reload is the most common silent failure.

## What NOT to try on nginx
- **`.htaccess`** — That is Apache. nginx ignores `.htaccess` files entirely.
- **`RewriteEngine On` / `RewriteRule`** — Those are Apache mod_rewrite directives. nginx uses `rewrite` and `return`, but for proxying to another origin, `proxy_pass` is the correct primitive.
- **`_redirects`** — That is Netlify-specific.
- **`vercel.json`** — That is Vercel-specific.
- **A `redirect` directive** — A redirect (301/302) sends the client elsewhere; we want the URL to remain on your domain. Use `proxy_pass`.
