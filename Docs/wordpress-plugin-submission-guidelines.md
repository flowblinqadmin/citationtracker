# WordPress Plugin Submission Guidelines

> Research compiled for the Flowblinq WordPress plugin initiative.
> Last updated: 2026-03-03

---

## Master Index

- **Plugin Directory overview:** [developer.wordpress.org/plugins/wordpress-org/](https://developer.wordpress.org/plugins/wordpress-org/)
- **Detailed Plugin Guidelines:** [developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/)
- **Plugin Developer FAQ:** [developer.wordpress.org/plugins/wordpress-org/plugin-developer-faq/](https://developer.wordpress.org/plugins/wordpress-org/plugin-developer-faq/)

---

## The 18 Detailed Rules

| # | Rule | Summary | Flowblinq Implication |
|---|------|---------|----------------------|
| 1 | [GPL Compatibility](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#1-plugins-must-be-compatible-with-the-gnu-general-public-license) | All plugin code must be GPL v2+ or compatible | SaaS backend can be closed-source — only the plugin itself must be GPL |
| 2 | [Developer Responsibility](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#2-developers-are-responsible-for-the-contents-of-their-plugins) | Developers bear sole responsibility for plugin contents and licensing | Standard due diligence required |
| 3 | [Stable Version Only](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#3-a-stable-version-of-a-plugin-must-be-available-from-its-wordpress-org-page) | Only one distributable version at a time via the directory | Do not submit until v0.1 is production-ready |
| 4 | [Human-Readable Code](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#4-code-must-be-mostly-human-readable) | No obfuscation or packer-style minification without including source | Thin API wrapper = low risk here |
| 5 | [No Trialware](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#5-trialware-is-not-permitted) | Cannot lock or disable functionality after a trial period | **Free GEO audit must be genuinely functional, not crippled** |
| 6 | [SaaS is Permitted](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#6-software-as-a-service-is-permitted) | Plugins can call external paid services | **Green light for the entire Flowblinq model.** License-validation-only services are prohibited, but real API calls are fine |
| 7 | [No Tracking Without Consent](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#7-plugins-may-not-track-users-without-their-knowledge) | No external server contact without explicit user authorization | Domain submission must be an explicit user action — no background scanning |
| 8 | [No Unauthorized External Code Execution](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#8-plugins-may-not-send-executable-code-via-third-party-systems) | Cannot pull and execute remote code | Calling our own API is fine; cannot run code fetched from a CDN |
| 9 | [No Illegal or Dishonest Content](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#9-plugins-may-not-do-illegal-things) | No fake reviews, spam, credential stuffing, SEO manipulation | Standard — no issue |
| 10 | [No Unauthorized External Links](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#10-plugins-may-not-embed-external-links-or-credits-on-the-public-website-without-explicit-user-permission) | "Powered by" or credit displays must be opt-in and off by default | **"Powered by Flowblinq" must default to hidden** |
| 11 | [Don't Hijack the Admin Dashboard](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#11-plugins-should-not-hijack-the-admin-dashboard) | Upgrade prompts and notices must be contextual and dismissible | No persistent upsell banners in WP admin |
| 12 | [No Spam in Public Pages](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#12-plugins-may-not-create-false-or-misleading-information) | No keyword stuffing or affiliate spam injected into the site | No issue — plugin only touches admin panel |
| 13 | [Use WordPress Default Libraries](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#13-plugins-must-use-wordpress-default-libraries) | Use built-in WP functions rather than bundling duplicates | Use `wp_remote_post()` for HTTP calls, not raw `curl` |
| 14 | [Avoid Excessive SVN Commits](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#14-plugins-should-not-be-updating-unnecessarily) | Minimize unnecessary SVN commits | Tag releases properly — don't spam SVN trunk |
| 15 | [Increment Version Numbers](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#15-plugin-version-numbers-must-be-incremented-for-each-new-release) | Each release requires a version bump | Standard semver discipline |
| 16 | [Complete at Submission](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#16-a-complete-plugin-must-be-submitted) | No placeholder features or coming-soon stubs | **Ship when the free audit flow is fully working end-to-end** |
| 17 | [Respect Trademarks](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#17-plugins-must-not-clutter-the-plugin-repository) | Cannot use "WordPress", "WooCommerce" etc. as primary identifier in plugin name | Do not name the plugin "WordPress GEO" — use "Flowblinq GEO" or similar |
| 18 | [Directory Integrity](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/#18-the-directory-reserves-the-right-to-maintain-the-plugin-directory-integrity) | WordPress.org can remove plugins at will | Maintain compliance continuously — no one-time checkbox |

---

## Submission Mechanics

| Topic | Key Fact | Reference |
|-------|----------|-----------|
| Where to submit | ZIP file upload, must be under 10MB, production-ready | [Plugin Add Page](https://wordpress.org/plugins/developers/add/) |
| Plugin slug | Auto-generated from Plugin Name header; **permanent once approved** | [FAQ — Slugs](https://developer.wordpress.org/plugins/wordpress-org/plugin-developer-faq/#plugin-slugspermalinks) |
| Review timeline | Guaranteed response within 7 business days | [FAQ — Submissions](https://developer.wordpress.org/plugins/wordpress-org/plugin-developer-faq/#submissions-and-reviews) |
| Version control | All releases via SVN tags (not trunk) | [How to Use SVN](https://developer.wordpress.org/plugins/wordpress-org/how-to-use-subversion/) |
| Readme | Controls the Directory listing page — treat it like a landing page | [How readme.txt Works](https://developer.wordpress.org/plugins/wordpress-org/how-your-readme-txt-works/) |
| Plugin headers | Required fields: Plugin Name, Version, Requires at least, Tested up to, License | [Header Requirements](https://developer.wordpress.org/plugins/the-basics/header-requirements/) |
| Assets | Banner: 772×250px (retina: 1544×500px). Icon: 128×128px (retina: 256×256px) | [Plugin Assets](https://developer.wordpress.org/plugins/wordpress-org/plugin-assets/) |
| Contact | plugins@wordpress.org for review team | [FAQ](https://developer.wordpress.org/plugins/wordpress-org/plugin-developer-faq/) |

---

## Key Compliance Flags for Flowblinq

These are the rules most likely to affect the plugin build:

### ✅ Structural Enabler — Rule 6 (SaaS Permitted)
The entire Flowblinq model (plugin calls external API, credits purchased on flowblinq.com) is explicitly permitted. The backend can be fully proprietary. The only constraint: the plugin itself must perform real functions, not just validate a license.

### ⚠️ Free Tier Must Be Real — Rule 5 (No Trialware)
The free GEO audit cannot be artificially crippled. It must deliver genuine value. Limiting to one audit per domain or gating score improvement behind credits is fine — that is a feature boundary, not trialware. Locking the report behind a paywall after it has been generated is not.

### ⚠️ Explicit Consent for Domain Submission — Rule 7 (No Tracking)
The plugin cannot scan or submit domain data in the background. Every API call must be initiated by an explicit user action (e.g., clicking "Run Audit"). This is already aligned with the proposed UX.

### ⚠️ "Powered by Flowblinq" is Opt-In — Rule 10
Any front-facing branding (badge, footer link, etc.) must be disabled by default. Can be offered as a toggle in plugin settings.

### ⚠️ Use `wp_remote_post()` — Rule 13
All HTTP calls from the plugin to the Flowblinq API must use WordPress's built-in HTTP API, not raw `curl` or a bundled HTTP library.

### ⚠️ Slug is Permanent — FAQ
Choose the plugin slug carefully before submission. It determines the WordPress.org URL, the folder name on user installations, and the text domain. It cannot be changed after approval.

---

## Additional References

| Resource | URL |
|----------|-----|
| Plugin Developer Handbook | [developer.wordpress.org/plugins/](https://developer.wordpress.org/plugins/) |
| Block-Specific Guidelines | [Block Plugin Guidelines](https://developer.wordpress.org/plugins/wordpress-org/block-specific-plugin-guidelines/) |
| GPL-Compatible Licenses | [gnu.org/philosophy/license-list.html#GPLCompatibleLicenses](https://www.gnu.org/philosophy/license-list.html#GPLCompatibleLicenses) |
| Community Code of Conduct | [make.wordpress.org/handbook/community-code-of-conduct/](https://make.wordpress.org/handbook/community-code-of-conduct/) |
| Plugin Security Guide | [developer.wordpress.org/apis/security/](https://developer.wordpress.org/apis/security/) |
| Reporting Security Issues | [Plugin Security Reporting](https://developer.wordpress.org/plugins/wordpress-org/plugin-security/reporting-plugin-security-issues/) |
| Take Over an Existing Plugin | [Takeover Guide](https://developer.wordpress.org/plugins/wordpress-org/take-over-an-existing-plugin/) |
| Support Forums Guide | [Using the Forums](https://developer.wordpress.org/plugins/wordpress-org/using-the-forums/) |
| Plugin Ownership Transfer | [Transferring Your Plugin](https://developer.wordpress.org/plugins/wordpress-org/transferring-your-plugin-to-a-new-owner/) |
