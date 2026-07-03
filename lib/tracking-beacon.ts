/**
 * Builds the human-path analytics beacon JS that is injected onto customer
 * pages via `<script src="https://geo.flowblinq.com/api/t/[slug]" async>`.
 *
 * This was previously an inline template string inside the route handler, which
 * meant the JS that runs on every customer page shipped completely untested —
 * the root cause of the 2026-06 mobile-jank regression slipping through (see
 * docs/research/script-injection-best-practices.md). Extracting it here makes
 * the emitted code unit-testable (__tests__/tracking-beacon.test.ts) and
 * exercisable in a mobile harness (e2e/beacon-mobile-perf.spec.ts).
 *
 * Performance + correctness contract (enforced by tests):
 *  1. The initial pageview is deferred off the load critical path via
 *     `requestIdleCallback({timeout:2000})`, falling back to `setTimeout` for
 *     iOS Safari (which has no requestIdleCallback — the device class in the
 *     original report). No cookie/sessionStorage/beacon work runs synchronously
 *     during script evaluation.
 *  2. The session id is read from sessionStorage at most once (memoized in
 *     `_sid`), so the high-frequency mobile `visibilitychange` handler performs
 *     no synchronous storage I/O.
 *  3. Every send goes through one guarded helper that honors `sendBeacon`'s
 *     boolean return value and falls back to `fetch(..., {keepalive:true})` —
 *     it never throws in browsers lacking `navigator.sendBeacon` (older in-app
 *     / WebView browsers, which are common on mobile).
 *  4. Runs only in the top frame, is bfcache-safe (no unload/beforeunload), and
 *     defers start until prerendering completes.
 */
export function buildBeaconJs(slug: string, deployId: string): string {
  const s = JSON.stringify(slug);
  const v = JSON.stringify(deployId);
  return `(function(){try{if(window!==window.top)return}catch(e){return}var s=${s},v=${v},e="https://geo.flowblinq.com/api/t/collect",_sid;function gc(n){try{var m=document.cookie.match(new RegExp("(?:^|;\\s*)"+n+"=([^;]*)"));return m?decodeURIComponent(m[1]):""}catch(e){return""}}function gs(){if(_sid!==undefined)return _sid;try{var k='_geo_sid';_sid=sessionStorage.getItem(k);if(!_sid){_sid=Math.random().toString(36).slice(2)+Date.now().toString(36);sessionStorage.setItem(k,_sid)}}catch(e){_sid=''}return _sid}function pp(){return location.pathname+location.search}function send(d){try{var b=JSON.stringify(d);if(!(navigator.sendBeacon&&navigator.sendBeacon(e,new Blob([b],{type:"text/plain"})))){fetch(e,{method:"POST",body:b,headers:{"Content-Type":"text/plain"},keepalive:true})}}catch(e){}}var pvSent=false;function f(){pvSent=true;send({s:s,u:location.href,r:document.referrer,sr:gc("_geo_ref"),vid:gc("_geo_vid"),w:screen.width,v:v,sid:gs()})}function idle(cb){if('requestIdleCallback'in window){requestIdleCallback(cb,{timeout:2000})}else{setTimeout(cb,1)}}function start(){var t=Date.now();idle(function(){if(!pvSent)f()});document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'){if(!pvSent)f();send({s:s,u:location.href,sid:gs(),tms:Date.now()-t,type:'engagement'})}});var l=pp();var p=history.pushState;history.pushState=function(){p.apply(this,arguments);var np=pp();if(np!==l){l=np;t=Date.now();f()}};window.addEventListener("popstate",function(){var np=pp();if(np!==l){l=np;t=Date.now();f()}})}if(document.prerendering){document.addEventListener('prerenderingchange',start,{once:true})}else{start()}})();`;
}
