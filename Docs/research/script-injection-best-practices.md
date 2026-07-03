# Best practices: non-blocking analytics/tracking script injection

Research backing the `fix/beacon-mobile-perf` branch. Sources gathered 2026-06-04.

> Note: Firecrawl was attempted first (per request) but the `FIRECRAWL_API_KEY`
> in `.env.local` returns `Unauthorized: Invalid token` — the key has rotated.
> Sources below were fetched via WebFetch instead. **Action item: refresh the
> Firecrawl key in `.env.local` + Vercel.**

## Sources
- web.dev — Efficiently load third-party JavaScript
- MDN — `Navigator.sendBeacon()`
- MDN — `Window.requestIdleCallback()`
- web.dev — Optimize long tasks

## What production analytics (e.g. Google gtag.js) do to avoid jank

1. **Load `async`** so the script never blocks HTML parsing. `async` (not `defer`)
   is correct for analytics because you want it to run early enough to not miss
   pageviews. ✅ Our tag already uses `async`.

2. **Defer the non-critical work off the load critical path.** web.dev: update
   user-visible work first, then "defer database saves and analytics collection
   to a separate task." GA schedules its work so it doesn't contend with first
   paint / first input. ✅ Our fix wraps the initial pageview in
   `requestIdleCallback({timeout:2000})` with a `setTimeout(…,1)` fallback.
   **iOS Safari has no `requestIdleCallback`**, so the `setTimeout` fallback is
   what actually protects iOS — the device class in the whitestripes report.

3. **`sendBeacon` for transport, fired on `visibilitychange:hidden`.** MDN
   confirms this is the *canonical* exit-beacon pattern (not a bug) — it's
   non-blocking and bfcache-safe. GA uses `transport_type:'beacon'`. ✅ We keep
   the `visibilitychange` handler.
   - **Refinement applied:** `sendBeacon` can return `false` (queue full / >64KiB).
     Best practice is to check the return value and fall back to `fetch(...,
     {keepalive:true})`. Our `send()` now does exactly this.
   - **Never** use `unload`/`beforeunload` — unreliable on mobile and disables
     bfcache. ✅ We don't.

4. **No synchronous storage in hot/exit paths.** `sessionStorage.getItem` is a
   synchronous, potentially disk-backed call. Reading it inside the
   `visibilitychange` handler (which fires far more often on mobile —
   app-switch, lock, notification shade) runs blocking I/O at the worst moment.
   ✅ Our fix memoizes the session id (`_sid`) so storage is touched once.

5. **`preconnect` to the analytics origin.** web.dev: a `<link rel="preconnect">`
   to a third-party origin saves ~100–500ms of DNS+TCP+TLS, which matters most
   on high-latency mobile networks. ⏳ Added to the customer integration snippet
   (front-end update on this branch).

## Mapping to the whitestripes (WordPress, mobile-only) report
- WordPress = full page reloads → the `pushState` monkeypatch is inert; not the cause.
- Mobile-only is explained by: (a) weak CPU running the load-time long task,
  (b) `visibilitychange` firing far more often on mobile while doing sync
  storage I/O, (c) third-party origin handshake over cellular.
- All three are addressed by changes 2–5 above.
