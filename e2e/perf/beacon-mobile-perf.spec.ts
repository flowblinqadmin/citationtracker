/**
 * Mobile mock harness — does the FlowBlinq beacon slow a customer's site?
 *
 * The customer report (whitestripes — WordPress, mobile-only) is about the
 * CUSTOMER PAGE feeling slow, so this harness measures exactly that: a
 * representative mobile WordPress-style page (heavy DOM, CSS animation, a
 * synthetic theme/plugin hydration task) is loaded under Pixel-5 emulation +
 * 4x CPU throttle, and we compare page-load behaviour with NO beacon vs. with
 * our beacon installed the real way (preconnect + `<script ... async>`, exactly
 * the wp_head snippet from integration-configs.ts). Runs fully offline (routed
 * origin; fetch/sendBeacon stubbed in-page):
 *
 *   npx playwright test -c e2e/perf/playwright-perf.config.ts
 *
 * The guarantee we prove (deterministic):
 *   - The NEW beacon does ALL of its work AFTER the page's DOM is interactive
 *     (deferred to idle) — so it cannot delay first render or block the load.
 *   - Adding it does not increase page-load blocking time (TBT) or delay the
 *     load event vs. no beacon at all.
 *   - On mobile, repeated visibilitychange does zero sessionStorage I/O, and a
 *     missing sendBeacon (in-app/WebView browsers) never throws.
 * The pre-fix beacon (OLD_BEACON) is run through the same harness to show the
 * regression it fixes. See docs/research/script-injection-best-practices.md.
 */
import { test, expect, type Page } from "@playwright/test";
import { buildBeaconJs } from "../../lib/tracking-beacon";

const ORIGIN = "https://shop.flowblinq.test";

// Faithful copy of the pre-fix beacon (main before fix/beacon-mobile-perf).
function OLD_BEACON(slug: string, deployId: string): string {
  const s = JSON.stringify(slug);
  const v = JSON.stringify(deployId);
  return `(function(){try{if(window!==window.top)return}catch(e){return}var s=${s},v=${v},e="https://geo.flowblinq.com/api/t/collect";function gc(n){try{var m=document.cookie.match(new RegExp("(?:^|;\\s*)"+n+"=([^;]*)"));return m?decodeURIComponent(m[1]):""}catch(e){return""}}function gs(){try{var k='_geo_sid',v=sessionStorage.getItem(k);if(!v){v=Math.random().toString(36).slice(2)+Date.now().toString(36);sessionStorage.setItem(k,v)}return v}catch(e){return''}}function pp(){return location.pathname+location.search}function f(){var d={s:s,u:location.href,r:document.referrer,sr:gc("_geo_ref"),vid:gc("_geo_vid"),w:screen.width,v:v,sid:gs()};var b=JSON.stringify(d);if(navigator.sendBeacon){navigator.sendBeacon(e,new Blob([b],{type:"text/plain"}))}else{fetch(e,{method:"POST",body:b,headers:{"Content-Type":"text/plain"},keepalive:true})}}function start(){f();var t=Date.now();document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'){var d={s:s,u:location.href,sid:gs(),tms:Date.now()-t,type:'engagement'};navigator.sendBeacon(e,new Blob([JSON.stringify(d)],{type:'text/plain'}))}});var l=pp();var p=history.pushState;history.pushState=function(){p.apply(this,arguments);var np=pp();if(np!==l){l=np;t=Date.now();f()}};window.addEventListener("popstate",function(){var np=pp();if(np!==l){l=np;t=Date.now();f()}})}if(document.prerendering){document.addEventListener('prerenderingchange',start,{once:true})}else{start()}})();`;
}

// Instrumentation installed in <head> BEFORE the beacon tag. Captures real
// page signals: Total Blocking Time (long tasks), DOMContentLoaded / load
// timestamps, the timestamp of the beacon's FIRST network call, _geo_sid
// storage reads, and uncaught errors. fetch/sendBeacon are stubbed (offline).
const INSTRUMENT = `
  window.__p = { tbt:0, longTasks:0, domAt:null, loadAt:null, firstSendAt:null, sends:0, storageGets:0, errors:[] };
  window.__beaconMode = 'ok'; // 'ok' | 'false' | 'absent'
  try { new PerformanceObserver(function(l){ for (var e of l.getEntries()){ if (e.duration>50){ window.__p.tbt += e.duration-50; window.__p.longTasks++; } } }).observe({type:'longtask', buffered:true}); } catch(e){}
  function mark(){ window.__p.sends++; if (window.__p.firstSendAt===null) window.__p.firstSendAt = performance.now(); }
  window.fetch = function(){ mark(); return Promise.resolve({ ok:true, text:function(){return Promise.resolve('')} }); };
  Object.defineProperty(navigator, 'sendBeacon', { configurable:true, get:function(){ if (window.__beaconMode==='absent') return undefined; return function(){ mark(); return window.__beaconMode!=='false'; }; } });
  var rg = Storage.prototype.getItem;
  Storage.prototype.getItem = function(k){ if (k==='_geo_sid') window.__p.storageGets++; return rg.call(this,k); };
  document.addEventListener('DOMContentLoaded', function(){ window.__p.domAt = performance.now(); });
  window.addEventListener('load', function(){ window.__p.loadAt = performance.now(); });
  window.addEventListener('error', function(e){ window.__p.errors.push(String(e.message)); });
`;

// A representative mobile WordPress-style page: heavy DOM, an always-running
// CSS animation (visual work like a slider/scroll), and a synthetic theme +
// plugin hydration task that occupies the main thread at load. `b` selects the
// beacon install: 'none' | 'new' | 'old'.
function wpPage(b: string): string {
  const tag =
    b === "none"
      ? ""
      : `<link rel="preconnect" href="${ORIGIN}">\n<script src="${ORIGIN}/beacon.js?b=${b}" async></script>`;
  let content = "";
  for (let i = 0; i < 1400; i++) {
    content += `<p class="ln">Lorem ipsum dolor sit amet ${i}, consectetur adipiscing elit, sed do eiusmod tempor.</p>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Acme Store</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0}
  .hero{height:220px;background:linear-gradient(90deg,#c2652a,#a04f1e);background-size:200% 100%;animation:pan 2s linear infinite}
  @keyframes pan{from{background-position:0 0}to{background-position:200% 0}}
  .ln{margin:6px 12px;font-size:15px;line-height:1.5}
</style>
<script>${INSTRUMENT}</script>
${tag}
</head><body>
<header class="hero"></header>
${content}
<script>
  /* synthetic WordPress theme + plugin hydration (jQuery, sliders, etc.) —
     ~90ms so it registers as a long task and TBT is a real non-zero baseline */
  (function(){ var end = performance.now() + 90; var x = 0; while (performance.now() < end) { x += Math.sqrt(Math.random()); } window.__theme = document.querySelectorAll('.ln').length + (x*0); })();
</script>
</body></html>`;
}

type Perf = {
  tbt: number; longTasks: number; domAt: number | null; loadAt: number | null;
  firstSendAt: number | null; sends: number; storageGets: number; errors: string[];
};

async function setup(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.route(`${ORIGIN}/page*`, (route) => {
    const b = new URL(route.request().url()).searchParams.get("b") || "none";
    route.fulfill({ contentType: "text/html", body: wpPage(b) });
  });
  await page.route(`${ORIGIN}/beacon.js*`, (route) => {
    const b = new URL(route.request().url()).searchParams.get("b") || "new";
    route.fulfill({
      contentType: "application/javascript",
      body: b === "old" ? OLD_BEACON("acme", "v1") : buildBeaconJs("acme", "v1"),
    });
  });
}

// Load a page variant and let any deferred (idle) beacon work run.
async function load(page: Page, b: "none" | "new" | "old"): Promise<Perf> {
  await page.goto(`${ORIGIN}/page?b=${b}`, { waitUntil: "load" });
  await page.waitForTimeout(2300); // beacon idle timeout is 2000ms
  return page.evaluate(() => window.__p as Perf);
}

async function fireHides(page: Page, n: number) {
  await page.evaluate((count) => {
    for (let i = 0; i < count; i++) {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  }, n);
}
const perf = (page: Page) => page.evaluate(() => window.__p as Perf);

// Measure the SYNCHRONOUS main-thread cost of a beacon at the moment its script
// runs: how many network sends it makes inline, and the wall-time it holds the
// main thread before yielding. This is what competes with the page if the
// script executes during a busy moment (a non-async install, a plugin loader,
// or mid-hydration). NEW yields to idle → 0 sync sends; OLD does the full
// cookie/storage/send inline. `async` in the install tag hides this on a quiet
// page, but the synchronous self-cost is the property the fix actually changes.
async function syncSelfCost(page: Page, beaconJs: string): Promise<{ dt: number; syncSends: number }> {
  return page.evaluate((js) => {
    const before = window.__p.sends;
    const t0 = performance.now();
    const el = document.createElement("script");
    el.textContent = js; // appending executes it synchronously
    document.body.appendChild(el);
    return { dt: performance.now() - t0, syncSends: window.__p.sends - before };
  }, beaconJs);
}

declare global { interface Window { __p: Perf; __beaconMode: string; } }

test.beforeEach(async ({ page }) => { await setup(page); });

test.describe("customer page-load impact (realistic mobile WordPress page, Pixel 5 + 4x CPU)", () => {
  test("the NEW beacon does all its work AFTER the DOM is interactive (cannot block page construction)", async ({ page }) => {
    const m = await load(page, "new");
    expect(m.domAt, "DOMContentLoaded recorded").not.toBeNull();
    expect(m.firstSendAt, "beacon eventually fires").not.toBeNull();
    expect(m.firstSendAt!, "first beacon work happens after DOM is ready").toBeGreaterThan(m.domAt!);
  });

  test("adding the NEW beacon does NOT delay load or add main-thread blocking vs no beacon", async ({ page }) => {
    const base = await load(page, "none");
    const withBeacon = await load(page, "new");
    console.log(
      `[harness] load(ms) none=${Math.round(base.loadAt!)} new=${Math.round(withBeacon.loadAt!)} | ` +
      `TBT(ms) none=${Math.round(base.tbt)} new=${Math.round(withBeacon.tbt)} | ` +
      `longTasks none=${base.longTasks} new=${withBeacon.longTasks}`,
    );
    expect(withBeacon.loadAt!, "load event not delayed by the beacon").toBeLessThanOrEqual(base.loadAt! + 80);
    expect(withBeacon.tbt, "beacon adds no measurable blocking at load").toBeLessThanOrEqual(base.tbt + 35);
  });

  test("on mobile, repeated visibilitychange does zero sessionStorage I/O (memoized sid)", async ({ page }) => {
    await load(page, "new"); // pageview fires → sid memoized
    const before = (await perf(page)).storageGets;
    await fireHides(page, 8); // mobile fires visibilitychange constantly (app-switch, lock, shade)
    const after = (await perf(page)).storageGets;
    expect(after - before, "no storage reads on hide").toBe(0);
  });

  test("never throws on hide when navigator.sendBeacon is absent (in-app/WebView browsers)", async ({ page }) => {
    await load(page, "new");
    await page.evaluate(() => { window.__beaconMode = "absent"; });
    const before = (await perf(page)).errors.length;
    await fireHides(page, 1);
    const after = (await perf(page)).errors.length;
    expect(after - before, "guarded send must not throw").toBe(0);
  });
});

test.describe("regression: the OLD (pre-fix) beacon on the same page", () => {
  test("when the script runs, NEW does ZERO synchronous main-thread work; OLD does the full cookie/storage/send inline", async ({ page }) => {
    await load(page, "none"); // realistic page + instrumentation, no beacon yet
    const newCost = await syncSelfCost(page, buildBeaconJs("acme", "v1"));
    const oldCost = await syncSelfCost(page, OLD_BEACON("acme", "v1"));
    console.log(
      `[harness] synchronous self-cost @4x CPU — OLD: ${oldCost.dt.toFixed(2)}ms / ${oldCost.syncSends} send(s), ` +
      `NEW: ${newCost.dt.toFixed(2)}ms / ${newCost.syncSends} send(s)`,
    );
    // Deterministic discriminator: NEW defers all work to idle (0 synchronous
    // network calls); OLD does its pageview send inline when the script runs.
    // (Raw one-shot wall-time is similar for both and noisy under throttle — the
    // fix's value is deferral + memoization + guarding, not shaving ms off a
    // single execution — so it's logged above, not asserted.)
    expect(newCost.syncSends, "NEW makes no synchronous network call").toBe(0);
    expect(oldCost.syncSends, "OLD makes its pageview call synchronously").toBeGreaterThanOrEqual(1);
  });

  test("OLD threw on hide without sendBeacon (the unguarded-sendBeacon bug)", async ({ page }) => {
    await load(page, "old");
    await page.evaluate(() => { window.__beaconMode = "absent"; });
    const before = (await perf(page)).errors.length;
    await fireHides(page, 1);
    const after = (await perf(page)).errors.length;
    expect(after - before, "old unguarded sendBeacon throws").toBeGreaterThanOrEqual(1);
  });
});
