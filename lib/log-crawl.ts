import { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { geoCrawlLogs } from "@/lib/db/schema";
import { parseBotName } from "@/lib/bot-parser";

// FIND-034: when both insert attempts fail, the crawl-log row is dropped. Track
// the cumulative count in-process (same observability convention as
// getLlmParseFailureCount in content-generator.ts) so a sustained DB regression
// surfaces as a rising count rather than scattered single-line errors.
let droppedCrawlLogCount = 0;
export function getDroppedCrawlLogCount(): number {
  return droppedCrawlLogCount;
}
export function resetDroppedCrawlLogCount(): void {
  droppedCrawlLogCount = 0;
}

type FileType =
  | "llms_txt"
  | "llms_full_txt"
  | "business_json"
  | "schema_json"
  | "schema_js"
  | "schema_page"
  | "head_html"
  // TS-082 / 503 telemetry: emitted when the serve route has nothing to return
  // because assets were not generated (empty llms.txt in crawl_data). Tracked
  // so we can alert on the empty-generation regression before customers notice.
  | "llms_txt_empty"
  | "llms_full_txt_empty";

export async function logCrawl(
  req: NextRequest,
  siteId: string,
  slug: string,
  fileType: FileType
): Promise<void> {
  const ua = req.headers.get("user-agent");
  const country =
    req.headers.get("cf-ipcountry") ??
    req.headers.get("x-vercel-ip-country") ??
    null;
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;

  const row = {
    id: nanoid(),
    siteId,
    slug,
    fileType,
    requestPath: req.nextUrl.pathname,
    userAgent: ua,
    botName: parseBotName(ua),
    ip,
    country,
    requestedAt: new Date(),
  };

  try {
    await db.insert(geoCrawlLogs).values(row);
  } catch {
    // Retry once — covers cold pooler connections
    try {
      await db.insert(geoCrawlLogs).values({ ...row, id: nanoid() });
    } catch (err) {
      droppedCrawlLogCount += 1;
      console.error(JSON.stringify({
        event: "log_crawl_persistent_failure",
        siteId,
        slug,
        fileType,
        cumulative_count: droppedCrawlLogCount,
        err: err instanceof Error ? err.message : String(err),
      }));
    }
  }
}
