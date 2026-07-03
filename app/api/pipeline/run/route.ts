import { NextRequest, NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline/runner";
import { Receiver } from "@upstash/qstash";

// Allow up to 5 minutes for the full pipeline
export const maxDuration = 300;

async function runHandler(siteId: string, domain: string): Promise<NextResponse> {
  // Always return 200 — pipeline errors are saved to DB by runPipeline().
  // Returning 500 would cause QStash to retry, re-crawling the same site.
  try {
    await runPipeline(siteId, domain);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Pipeline run error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ success: false, error: "Pipeline failed — see DB for details" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const secret = req.headers.get("authorization")?.replace("Bearer ", "");
    const isDirectCall = process.env.CRON_SECRET && secret === process.env.CRON_SECRET;
    const isQStashCall = !!req.headers.get("upstash-signature");

    if (!isDirectCall && !isQStashCall) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // For QStash requests, verify the signature manually before processing
    if (isQStashCall && !isDirectCall) {
      const signingKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
      const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
      if (!signingKey || !nextSigningKey) {
        console.error("QStash signing keys not configured — rejecting request");
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const receiver = new Receiver({ currentSigningKey: signingKey, nextSigningKey });
      const body = await req.text();
      const signature = req.headers.get("upstash-signature") ?? "";
      const url = process.env.NEXT_PUBLIC_APP_URL
        ? `${process.env.NEXT_PUBLIC_APP_URL}/api/pipeline/run`
        : `https://${req.headers.get("host")}/api/pipeline/run`;
      try {
        await receiver.verify({ signature, body, url });
      } catch {
        console.error("QStash signature verification failed");
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
      const { siteId, domain } = JSON.parse(body) as { siteId?: string; domain?: string };
      if (!siteId || !domain) return NextResponse.json({ error: "siteId and domain required" }, { status: 400 });
      return runHandler(siteId, domain);
    }

    const body = await req.json() as { siteId?: string; domain?: string };
    const { siteId, domain } = body;
    if (!siteId || !domain) return NextResponse.json({ error: "siteId and domain required" }, { status: 400 });
    return runHandler(siteId, domain);

  } catch (err) {
    console.error("Pipeline handler error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
