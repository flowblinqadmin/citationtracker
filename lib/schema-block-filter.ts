/**
 * Shared helpers for filtering and grouping schema blocks by page target.
 * Used by the per-page schema API route and the schema.js builder.
 */

import { matchesPageTarget } from "@/lib/serve-utils";

export interface SchemaBlock {
  name: string;
  type: string;
  jsonLd: Record<string, unknown>;
  instructions: string;
  pageTarget: string;
}

export const SITEWIDE_TYPES = new Set([
  "Organization",
  "WebSite",
  "BreadcrumbList",
  "DefinedTerm",
  "SpeakableSpecification",
]);
export const SITEWIDE_TARGETS = new Set(["all pages"]);
const SKIP_TYPES = new Set(["RobotsTxt"]);

export function isSitewideBlock(block: SchemaBlock): boolean {
  return (
    SITEWIDE_TYPES.has(block.type) ||
    SITEWIDE_TARGETS.has(block.pageTarget?.trim().toLowerCase() ?? "")
  );
}

export function isHomepageBlock(block: SchemaBlock): boolean {
  return block.pageTarget?.trim().toLowerCase() === "homepage";
}

export function groupSchemaBlocks(blocks: SchemaBlock[]): {
  sitewide: SchemaBlock[];
  homepage: SchemaBlock[];
  pages: Record<string, SchemaBlock[]>;
} {
  const sitewide: SchemaBlock[] = [];
  const homepage: SchemaBlock[] = [];
  const pages: Record<string, SchemaBlock[]> = {};

  for (const block of blocks) {
    if (SKIP_TYPES.has(block.type)) continue;
    if (isSitewideBlock(block)) {
      sitewide.push(block);
    } else if (isHomepageBlock(block)) {
      homepage.push(block);
    } else {
      const key = block.pageTarget ?? "unknown";
      if (!pages[key]) pages[key] = [];
      pages[key].push(block);
    }
  }

  return { sitewide, homepage, pages };
}

export function filterBlocksForPage(
  blocks: SchemaBlock[],
  requestPath: string
): {
  pageBlocks: SchemaBlock[];
  sitewideBlocks: SchemaBlock[];
} {
  const pageBlocks: SchemaBlock[] = [];
  const sitewideBlocks: SchemaBlock[] = [];

  for (const block of blocks) {
    if (SKIP_TYPES.has(block.type)) continue;
    if (isSitewideBlock(block)) {
      sitewideBlocks.push(block);
    } else if (matchesPageTarget(block.pageTarget ?? "", requestPath)) {
      pageBlocks.push(block);
    }
  }

  return { pageBlocks, sitewideBlocks };
}

export function buildScriptTag(blocks: SchemaBlock[]): string {
  const jsonLds = blocks.map((b) => b.jsonLd);
  if (jsonLds.length === 0) return "";
  const raw =
    jsonLds.length === 1 ? JSON.stringify(jsonLds[0]) : JSON.stringify(jsonLds);
  const safe = raw.replace(/<\//g, "<\\/");
  return `<script type="application/ld+json">${safe}</script>`;
}
