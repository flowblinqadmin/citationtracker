# CM-001: Security Hardening Rollout — Customer Communication Plan

**Related spec:** ES-089 GEO Integration Security Hardening
**Owner:** Adithya Rao
**Status:** Draft — not sent
**Rollout phase:** Phase 1 (silent parallel)

---

## Audience Map

| Audience | Message | Channel | Timing |
|---|---|---|---|
| Existing customers (e.g. Manipal) | Nothing changes for you today | — | No message in Phase 1 |
| New customers | Onboard to v1 script directly; v2 available as opt-in | Onboarding email | Phase 1 ship |
| Appiness / Manipal integration team | Explain security improvements and migration path when ready | Direct email | Phase 2 opt-in |
| All customers (pre-sunset) | Upgrade required by [date] | In-app banner + email | Phase 3, 60 days before sunset |

---

## Phase 1 — Silent Parallel (No Customer Communication Required)

All changes in Phase 1 are fully server-side and backward-compatible:
- Schema.json unicode-escape fix (P0)
- Token endpoint added (`GET /api/t/{slug}/token`)
- Ingest endpoint gains validation in `legacy` mode (accepts beacons without token, logs warning)
- `securityMode = 'legacy'` default for all existing customers

**No email, no banner, no contact required.** Ship and monitor.

Internal action only: verify `securityMode = 'legacy'` row exists for every active site after migration.

---

## Phase 2 — Opt-In Upgrade

### 2a. Trigger conditions for outreach

Reach out to a customer's integration contact when:
- They report a security audit finding (like Appiness/Manipal)
- They ask about CSP compatibility
- They upgrade to a paid plan (good moment to offer enhanced security)
- Proactively, after v2 beacon is stable (~4 weeks post-Phase 1 ship)

### 2b. Email template — integration partner / developer contact

**Subject:** Flowblinq GEO — v2 beacon upgrade available (optional, recommended)

> Hi [Name],
>
> We've shipped an upgrade to the Flowblinq GEO beacon script that adds cryptographic supply-chain protection — ensuring only your site can send data to your Flowblinq account, even if third-party scripts are compromised.
>
> **Your current integration continues to work exactly as-is.** This is an opt-in upgrade.
>
> **To upgrade (one line change):**
>
> Replace your current `<script>` tag:
> ```html
> <!-- Old (v1 — still works) -->
> <script src="https://geo.flowblinq.com/api/t/{slug}" async></script>
>
> <!-- New (v2 — recommended) -->
> <script src="https://geo.flowblinq.com/api/t/v2/{slug}" async></script>
> ```
>
> The v2 script fetches a short-lived cryptographic token on page load and includes it with every analytics event. This satisfies HMAC-based supply chain validation requirements.
>
> Once you've updated the script tag, let us know and we'll switch your account to Secure Mode in the dashboard.
>
> No other configuration changes are needed for a standard Apache/PHP or WordPress setup. If you're using Cloudflare, we have an optional Worker template that provides first-party proxying and eliminates the script from the browser's supply chain entirely — happy to walk through that if useful.
>
> Let me know if you have questions.
>
> — Adithya
> Flowblinq

---

### 2c. Appiness / Manipal-specific note

Appiness raised the original security concern in their Traffic Validation Study (April 2026). When Phase 2 ships:

1. Email Appiness dev contact with the template above
2. Reference their specific findings from the study:
   - "HMAC token verification" addresses their "beacon tampering" concern
   - "v2 script + Secure Mode" addresses their "third-party script trust" concern
   - The Apache `.htaccess` reverse proxy snippet (in ES-089 §5.2) addresses their "script served from third-party domain" concern if they want first-party delivery
3. Once Appiness upgrades and confirms, flip Manipal's `securityMode` to `'secure'`
4. Share the security mode status in the dashboard as a trust signal for Appiness's compliance review

---

## Phase 3 — Sunset Legacy Mode

### 3a. Timeline

| Date | Action |
|---|---|
| Phase 1 ship date | `legacySunsetAt` set to +6 months for all legacy customers |
| T−60 days | In-app banner appears for legacy customers |
| T−30 days | Email to all customers still in legacy mode |
| T−7 days | Second email, more urgent tone |
| T=0 | `securityMode` auto-flipped to `'secure'` |
| T=0 to T+90 | Grace period: beacons without token return `429` with upgrade message (not hard `401`) |
| T+90 | Grace period ends. Beacons without token = `401`. Legacy mode fully removed. |

### 3b. In-app banner copy (T−60 days)

> **Action required by [DATE]:** Your Flowblinq integration is running in Legacy Mode.
> Update your script tag to v2 before [DATE] to avoid interruption.
> [View upgrade guide →]

### 3c. Email template — sunset warning (T−30 days)

**Subject:** Action required: Flowblinq GEO beacon upgrade by [DATE]

> Hi [Name],
>
> A reminder that Legacy Mode for the Flowblinq GEO beacon will be discontinued on **[DATE]**.
>
> After this date, beacon events sent without a v2 cryptographic token will not be recorded.
>
> **To upgrade, update one line in your integration:**
> ```html
> <script src="https://geo.flowblinq.com/api/t/v2/{slug}" async></script>
> ```
>
> That's all that's needed for most integrations. Full platform-specific guides are at [link to docs].
>
> If you need help with the upgrade or have questions about your specific setup (Shopify, WordPress, Cloudflare, etc.), reply to this email and we'll help directly.
>
> — Adithya
> Flowblinq

### 3d. Email template — grace period (T=0, 429 responses active)

**Subject:** Flowblinq GEO — Legacy Mode ended, 90-day grace period active

> Hi [Name],
>
> Legacy Mode ended on [DATE]. Your beacon is currently in a 90-day grace period — events are being buffered with a warning response, but **will not be recorded** until you upgrade.
>
> Please update your script tag to v2 as soon as possible:
> ```html
> <script src="https://geo.flowblinq.com/api/t/v2/{slug}" async></script>
> ```
>
> Grace period ends: [DATE + 90 days]. After that date, unupgraded integrations stop sending data entirely.
>
> — Adithya
> Flowblinq

---

## Dashboard Signals (no email required)

These are visible in the customer dashboard at all times:

| Status | Badge | Copy |
|---|---|---|
| Legacy mode | Amber | "Integration: Legacy Mode — [Upgrade to v2 →]" |
| Secure mode | Green | "Integration: Secure Mode (v2 beacon active)" |
| Sunset warning | Red | "Legacy Mode ends [DATE] — upgrade now to avoid interruption" |

---

## Internal Tracking

Before Phase 3 sunset, run:
```sql
SELECT slug, security_mode, legacy_sunset_at
FROM geo_sites
WHERE security_mode = 'legacy'
ORDER BY legacy_sunset_at;
```

Flag any accounts with > $100 MRR for personal outreach before the auto-flip.
