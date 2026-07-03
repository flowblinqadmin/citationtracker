// Fire-and-forget logger for the track-slug handler.
//
// Ported from geo/lib/log-crawl.ts. Substitutions per plan:
//   - drop NextRequest import; accept Web Request + parsed pathname
//   - replace cf-ipcountry / x-vercel-ip-country with caller-supplied country
//     (the handler runs geo-enrich and passes the result in)
//   - `nanoid` via npm: specifier; relative imports for db / schema / parser
//   - retry-once pattern preserved (covers cold pgbouncer connections)

import { nanoid } from "npm:nanoid@5.1.11";
import { db } from "./db.ts";
import { geoCrawlLogs } from "./schema.ts";
import { parseBotName } from "./bot-parser.ts";

type FileType =
  | "llms_txt"
  | "llms_full_txt"
  | "business_json"
  | "schema_json"
  | "schema_js"
  | "schema_page"
  | "head_html"
  // TS-082 / 503 telemetry: emitted when the serve route has nothing to
  // return because assets were not generated. Tracked so we can alert on
  // empty-generation regressions before customers notice.
  | "llms_txt_empty"
  | "llms_full_txt_empty";

export interface LogCrawlInput {
  req: Request;
  pathname: string;
  siteId: string;
  slug: string;
  fileType: FileType;
  ip: string | null;
  ipHash: string | null;
  country: string | null;
}

export async function logCrawl(input: LogCrawlInput): Promise<void> {
  const ua = input.req.headers.get("user-agent");

  const row = {
    id: nanoid(),
    siteId: input.siteId,
    slug: input.slug,
    fileType: input.fileType,
    requestPath: input.pathname,
    userAgent: ua,
    botName: parseBotName(ua),
    ip: input.ip,
    ipHash: input.ipHash,
    country: input.country,
    requestedAt: new Date(),
  };

  try {
    await db.insert(geoCrawlLogs).values(row);
  } catch {
    // Retry once — covers cold pooler connections.
    try {
      await db.insert(geoCrawlLogs).values({ ...row, id: nanoid() });
    } catch (err) {
      console.error("logCrawl error (retry failed):", err);
    }
  }
}
