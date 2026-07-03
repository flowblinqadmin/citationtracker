// ── Geographic Tree ──────────────────────────────────────────────

export type GeoNodeLevel = "global" | "country" | "state" | "city";

export type GeoNode = {
  id: string;           // e.g. "in", "in-ka", "in-ka-blr"
  name: string;         // e.g. "India", "Karnataka", "Bangalore"
  level: GeoNodeLevel;
  children: GeoNode[];
  pageCount: number;    // how many crawled pages reference this location
  evidence: string[];   // sample URLs that reference this location (max 3)
};

export type GeoTree = {
  root: GeoNode;        // level: "global", always present
  leafCount: number;    // total city-level nodes (0 for pure-digital)
  extractedAt: string;  // ISO-8601
};

// ── Category Tree ────────────────────────────────────────────────

export type CategoryNode = {
  id: string;           // e.g. "healthcare", "healthcare-oncology"
  name: string;         // e.g. "Healthcare", "Oncology"
  level: number;        // depth in tree (0 = root)
  children: CategoryNode[];
  pageCount: number;    // how many crawled pages reference this category
  evidence: string[];   // sample URLs (max 3)
};

export type CategoryTree = {
  root: CategoryNode;   // top-level industry node
  leafCount: number;    // total leaf-level service/product nodes
  extractedAt: string;  // ISO-8601
};

// ── Sparse Mapping ───────────────────────────────────────────────

export type GeoCategoryStrength = "strong" | "moderate" | "inferred";

export type GeoCategoryEntry = {
  geoId: string;        // references GeoNode.id (city-level preferred)
  categoryId: string;   // references CategoryNode.id (leaf-level preferred)
  strength: GeoCategoryStrength;
  evidence: string[];   // sample URLs (max 2)
};

export type GeoCategoryMapping = {
  entries: GeoCategoryEntry[];
  totalEntries: number;
  extractedAt: string;  // ISO-8601
};

// ── Extraction Result (returned by tree-extractor) ───────────────

export type TreeExtractionResult = {
  geoTree: GeoTree;
  categoryTree: CategoryTree;
  mapping: GeoCategoryMapping;
};

// ── Empty Trees (factory functions — compute extractedAt at call time) ─────

export function emptyGeoTree(): GeoTree {
  return {
    root: { id: "global", name: "Global", level: "global", children: [], pageCount: 0, evidence: [] },
    leafCount: 0,
    extractedAt: new Date().toISOString(),
  };
}

export function emptyCategoryTree(): CategoryTree {
  return {
    root: { id: "root", name: "Unknown", level: 0, children: [], pageCount: 0, evidence: [] },
    leafCount: 0,
    extractedAt: new Date().toISOString(),
  };
}

export function emptyMapping(): GeoCategoryMapping {
  return {
    entries: [],
    totalEntries: 0,
    extractedAt: new Date().toISOString(),
  };
}
