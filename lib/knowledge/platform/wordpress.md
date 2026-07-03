# WordPress Integration

## What this platform is
WordPress is a PHP-based CMS. Themes provide HTML layout (in PHP files like `header.php`, `footer.php`, `functions.php`), and plugins extend behaviour. WordPress runs on top of either Apache or nginx — the underlying web server determines how `/llms.txt` rewrites are configured.

## What you need before starting
- Admin access to the WordPress dashboard
- Your FlowBlinq slug: {{SLUG}}
- Knowledge of which web server is hosting the site (Apache vs nginx) — check your hosting panel
- For code edits: SFTP/SSH access OR a code-injection plugin (recommended: **WPCode** or **Insert Headers and Footers**)

## Step 1 — Add the tracking pixel
The recommended path is the **WPCode** plugin (`wordpress.org/plugins/insert-headers-and-footers`):
1. Install and activate **WPCode** (formerly "Insert Headers and Footers").
2. Go to **Code Snippets → Header & Footer**.
3. In the **Footer** section, paste:
```html
<img src="https://geo.flowblinq.com/api/t/{{SLUG}}" alt="" style="display:none;" />
```
4. Click **Save**.

If you'd rather edit theme files directly, append the same `<img>` tag to your child theme's `footer.php` just before `</body>`.

## Step 2 — Inject schema (mandatory)
Same plugin path:
1. **WPCode → Code Snippets → Header & Footer**.
2. In the **Header** section, paste:
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
3. Click **Save**.

The functions.php alternative (child theme):
```php
add_action("wp_head", function () {
    echo '<script>fetch("https://geo.flowblinq.com/api/serve/{{SLUG}}/schema.json").then(r=>r.json()).then(data=>{const s=document.createElement("script");s.type="application/ld+json";s.textContent=JSON.stringify(data);document.head.appendChild(s);});</script>';
});
```

## Step 3 — Serve llms.txt
WordPress itself does not handle path rewrites — your underlying web server does. Use the appropriate platform's mechanism:

**If your host runs Apache** (most shared hosts: Bluehost, SiteGround, DreamHost, etc.):
Edit `.htaccess` at the WordPress root (above the `# BEGIN WordPress` block):
```
RewriteEngine On
RewriteRule ^/?llms\.txt$ https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt [P,L]
```
This requires `mod_proxy` + `mod_proxy_http` to be enabled (most shared hosts have this enabled by default).

**If your host runs nginx** (some managed WordPress hosts: Kinsta, WP Engine, Cloudways/nginx):
You usually cannot edit nginx config directly. Either:
- Open a support ticket with your host requesting a `proxy_pass` rule for `/llms.txt`, or
- Place a Cloudflare Worker in front (see the Cloudflare guide).

**Do NOT** assume `.htaccess` works — Kinsta/WP Engine/etc. ignore `.htaccess` because they run nginx.

## Step 4 — Update robots.txt
WordPress generates `/robots.txt` dynamically. Override it via:
1. **Yoast SEO** → Tools → File editor → robots.txt, or
2. The same `.htaccess`/nginx-config rewrite pattern as Step 3, pointed at `https://geo.flowblinq.com/api/serve/{{SLUG}}/robots.txt`.

## Step 5 — Verify
- In FlowBlinq, go to **Setup tab → Test Connection**
- Expected: "Connected — llms.txt confirmed at {domain}/llms.txt"
- Curl: `curl -I https://yourdomain.com/llms.txt` returns 200

## Common errors on WordPress
- **"Edited `.htaccess` but rewrite has no effect"** → The host is running nginx, not Apache. WordPress permalinks may still work via WordPress's own URL handling, but `.htaccess` is ignored. Confirm with your host.
- **"WPCode snippet runs on admin pages and breaks them"** → In WPCode, scope the snippet to **Frontend Only** (Site-wide Header/Footer). Header & Footer auto-loaders default to frontend.
- **"functions.php edit broke the site"** → Always edit a **child theme's** functions.php, not the parent theme. Parent theme edits are wiped on theme updates and a syntax error there can lock you out of `wp-admin`.
- **"Schema script runs but Test Connection still fails"** → Schema injection (Step 2) and llms.txt serving (Step 3) are independent. Test Connection probes `/llms.txt` over HTTP — that requires the rewrite, not just the schema script.

## What NOT to try on WordPress
- **Always editing `.htaccess`** — Only valid on Apache hosts. nginx-hosted WordPress sites (Kinsta, WP Engine, etc.) ignore `.htaccess` entirely.
- **Adding the rewrite to a WordPress hook** — `add_rewrite_rule()` in WordPress only handles internal URL → query mapping, not transparent proxying to an external origin.
- **Editing the parent theme's PHP files** — Updates will overwrite your changes. Use a child theme.
- **Disabling WordPress's own `robots.txt` virtual file before configuring a replacement** — You'll end up with a 404 for `/robots.txt` and crawlers will be unhappy.
