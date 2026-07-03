// Page-aware JSON-LD schema injection JS builder.
//
// Ported from geo/lib/schema-js-builder.ts. Substitutions per plan:
//   - Inline SITEWIDE_TYPES + SITEWIDE_TARGETS from lib/schema-block-filter
//     (the only two symbols imported) so we don't drag the full filter module
//     and its @/lib/serve-utils transitive dep into the Deno bundle.
//
// Behavior preserved: emits a single self-invoking JS string that injects
// sitewide JSON-LD unconditionally and page-specific JSON-LD only when
// window.location.pathname matches.

// Inlined from geo/lib/schema-block-filter.ts:
const SITEWIDE_TYPES = new Set([
  "Organization",
  "WebSite",
  "BreadcrumbList",
  "DefinedTerm",
  "SpeakableSpecification",
]);
const SITEWIDE_TARGETS = new Set(["all pages"]);
const SKIP_TYPES = new Set(["RobotsTxt"]);

interface SchemaBlock {
  type?: string;
  pageTarget?: string;
  jsonLd: Record<string, unknown>;
}

/** Escape U+2028/U+2029 which are valid in JSON but are JS line terminators */
function safeStringify(val: unknown): string {
  return JSON.stringify(val)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildSchemaInjectionJs(blocks: SchemaBlock[]): string {
  const sitewideBlocks: SchemaBlock[] = [];
  const pageBlocks: SchemaBlock[] = [];

  for (const block of blocks) {
    if (SKIP_TYPES.has(block.type ?? "")) continue;
    if (
      SITEWIDE_TYPES.has(block.type ?? "") ||
      SITEWIDE_TARGETS.has(block.pageTarget ?? "")
    ) {
      sitewideBlocks.push(block);
    } else {
      pageBlocks.push(block);
    }
  }

  // Build page-target map: pathname → JSON-LD array
  const pageMap: Record<string, string[]> = {};
  const homepageBlocks: SchemaBlock[] = [];
  for (const block of pageBlocks) {
    if (!block.pageTarget) {
      sitewideBlocks.push(block);
      continue;
    }
    if (block.pageTarget.trim().toLowerCase() === "homepage") {
      homepageBlocks.push(block);
      continue;
    }
    try {
      const pathname = new URL(block.pageTarget).pathname;
      if (!pageMap[pathname]) pageMap[pathname] = [];
      pageMap[pathname].push(JSON.stringify(block.jsonLd));
    } catch {
      sitewideBlocks.push(block);
    }
  }

  const injectFn = `function _fbInject(json) {
  var el = document.createElement('script');
  el.type = 'application/ld+json';
  el.textContent = json;
  document.head.appendChild(el);
}`;

  const sitewideInjections = sitewideBlocks
    .map((b) => `_fbInject(${safeStringify(JSON.stringify(b.jsonLd))});`)
    .join("\n");

  const homepageInjection = homepageBlocks.length > 0
    ? `if (p === "/" || p === "/index") {\n${
      homepageBlocks
        .map((b) => `  _fbInject(${safeStringify(JSON.stringify(b.jsonLd))});`)
        .join("\n")
    }\n}`
    : "";

  const pageInjections = Object.entries(pageMap)
    .map(([pathname, jsons]) => {
      const injections = jsons
        .map((j) => `  _fbInject(${safeStringify(j)});`)
        .join("\n");
      return `if (p === ${safeStringify(pathname)}) {\n${injections}\n}`;
    })
    .join(" else ");

  const allPageInjections = [homepageInjection, pageInjections]
    .filter(Boolean)
    .join(" else ");

  return `/* FlowBlinq GEO Schema — auto-generated, do not edit */
(function() {
${injectFn}
var p = window.location.pathname.replace(/\\/$/, '') || '/';
${sitewideInjections}
${allPageInjections}
})();`;
}
