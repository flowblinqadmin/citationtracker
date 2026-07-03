// ES-087 §4 — Cursor encoding for /api/v1/page_views pagination.
//
// Cursor is a base64url-encoded JSON blob of {viewed_at, id}. Base64url avoids
// URL %-escaping. Deterministic: same input yields byte-identical output.

export interface Cursor {
  viewed_at: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  // Construct payload explicitly so key order is stable (determinism).
  const payload = JSON.stringify({ viewed_at: c.viewed_at, id: c.id });
  return Buffer.from(payload, "utf-8").toString("base64url");
}

export function decodeCursor(s: string): Cursor {
  if (!s) throw new Error("bad_cursor");
  let decoded: string;
  try {
    decoded = Buffer.from(s, "base64url").toString("utf-8");
  } catch {
    throw new Error("bad_cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("bad_cursor");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("bad_cursor");
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.viewed_at !== "string" || typeof obj.id !== "string") {
    throw new Error("bad_cursor");
  }
  // ISO-8601 shape: YYYY-MM-DDTHH:MM:SS(.fff)?Z?
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(obj.viewed_at)) {
    throw new Error("bad_cursor");
  }
  return { viewed_at: obj.viewed_at, id: obj.id };
}
