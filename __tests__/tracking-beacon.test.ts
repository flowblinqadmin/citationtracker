/**
 * Structural contract tests for the customer-page analytics beacon
 * (lib/tracking-beacon.ts). These guard the specific properties whose ABSENCE
 * caused the 2026-06 mobile-jank report (whitestripes, WordPress, mobile-only).
 *
 * Behavioral execution of the beacon in a real (mobile-emulated, CPU-throttled)
 * browser lives in the mock harness: e2e/perf/beacon-mobile-perf.spec.ts —
 * that's where the OLD vs NEW long-task / storage-I/O difference is measured.
 * Here we assert the source-level contract that the harness depends on, so a
 * regression is caught fast in the unit suite even without a browser.
 *
 * A faithful copy of the PRE-FIX beacon (OLD_BEACON) is included to prove each
 * guard actually distinguishes fixed code from the regression.
 *
 * See docs/research/script-injection-best-practices.md for the why.
 */

import { describe, it, expect } from "vitest";
import { buildBeaconJs } from "@/lib/tracking-beacon";

// Pre-fix beacon (as shipped on main before fix/beacon-mobile-perf).
const OLD_BEACON =
  `(function(){var s="x",v="";function gs(){try{var k='_geo_sid',v=sessionStorage.getItem(k);if(!v){v=Math.random();sessionStorage.setItem(k,v)}return v}catch(e){return''}}function f(){var d={sid:gs()};if(navigator.sendBeacon){navigator.sendBeacon(e,d)}}function start(){f();document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'){var d={sid:gs()};navigator.sendBeacon(e,d)}})}start()})();`;

const js = buildBeaconJs("acme", "v1");

describe("beacon — slug/deployId are injected safely", () => {
  it("embeds the slug and deploy id as JSON-encoded literals", () => {
    expect(buildBeaconJs("acme-shop", "dep-9")).toContain(`var s="acme-shop",v="dep-9"`);
  });

  it("JSON-escapes a slug containing quotes (no string break-out)", () => {
    const out = buildBeaconJs('a"];evil//', "");
    expect(out).toContain(JSON.stringify('a"];evil//'));
    expect(out).not.toContain('var s="a"];evil');
  });
});

describe("condition 1 — load-time work deferred off the critical path", () => {
  it("schedules the pageview via requestIdleCallback (with a setTimeout fallback for iOS Safari)", () => {
    expect(js).toContain("requestIdleCallback");
    expect(js).toContain("setTimeout(cb,1)");
    // pageview is invoked from the deferred idle callback, not inline
    expect(js).toContain("idle(function(){if(!pvSent)f()})");
  });

  it("does NOT call f() synchronously at the top of start() (the old long-task bug)", () => {
    expect(js).not.toContain("function start(){f();");
    expect(OLD_BEACON).toContain("function start(){f();"); // proves the guard discriminates
  });
});

describe("condition 2 — no synchronous storage I/O in the mobile visibilitychange path", () => {
  it("memoizes the session id so gs() touches sessionStorage at most once", () => {
    expect(js).toContain("if(_sid!==undefined)return _sid");
  });

  it("the old beacon re-read sessionStorage on every call (no memo guard)", () => {
    expect(OLD_BEACON).not.toContain("if(_sid!==undefined)return _sid");
    expect(OLD_BEACON).toContain("sessionStorage.getItem(k)");
  });
});

describe("condition 3 — never throws without navigator.sendBeacon", () => {
  it("routes every send through a guarded helper that honors sendBeacon's return and falls back to fetch", () => {
    // guarded: only call fetch when sendBeacon is missing OR returns falsy
    expect(js).toContain("if(!(navigator.sendBeacon&&navigator.sendBeacon(e,new Blob");
    expect(js).toContain("keepalive:true");
  });

  it("the old engagement path called navigator.sendBeacon unguarded (threw in WebView browsers)", () => {
    // old hide handler invokes sendBeacon directly with no existence/return check
    expect(OLD_BEACON).toContain("navigator.sendBeacon(e,d)");
    expect(OLD_BEACON).not.toContain("if(!(navigator.sendBeacon&&");
  });
});

describe("general hardening — unchanged guarantees", () => {
  it("runs only in the top frame", () => {
    expect(js).toContain("if(window!==window.top)return");
  });

  it("is bfcache-safe (no unload/beforeunload handlers)", () => {
    expect(js).not.toContain("beforeunload");
    expect(js).not.toContain('addEventListener("unload"');
  });

  it("waits for prerendering to finish before starting", () => {
    expect(js).toContain("document.prerendering");
    expect(js).toContain("prerenderingchange");
  });

  it("still tracks SPA navigations via pushState + popstate", () => {
    expect(js).toContain("history.pushState=function()");
    expect(js).toContain('addEventListener("popstate"');
  });
});
