"use client";

// "What to fix next" — fetched once when the first run completes, rendered from
// the pure buildPunchList over the run's responses. Shown above the ready-modal
// CTA so the user leaves onboarding with concrete next actions.
import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api-url";
import { buildPunchList, type PunchResponse, type PunchList as PunchListData, type QuoteItem } from "@/lib/punch-list";
import { UI } from "@/app/ui";

const CARD = UI.CARD;
const BORDER = UI.BORDER_CSS;
const MUTED = UI.T2;
const GREEN = UI.GREEN;
const RED = UI.RED;
const ACCENT = UI.COPPER;

function sentimentColor(sentiment: string | null): string {
  if (sentiment === "positive") return GREEN;
  if (sentiment === "negative") return RED;
  return MUTED;
}

/** A verbatim quote card with an in-place Show more toggle when the preview was trimmed. */
function QuoteCard({ item }: { item: QuoteItem }) {
  const [expanded, setExpanded] = useState(false);
  const color = sentimentColor(item.sentiment);
  const truncated = item.quoteFull.length > item.quote.length;
  return (
    <div style={{ borderLeft: `3px solid ${color}`, background: UI.REPLY_BG, borderRadius: 6, padding: "8px 12px" }}>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>
        {item.platformLabel}
        {item.sentiment ? <span style={{ color, fontWeight: 600 }}> · {item.sentiment}</span> : null}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>“{expanded ? item.quoteFull : item.quote}”</div>
      {truncated && (
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{ marginTop: 4, background: "none", border: "none", padding: 0, color: ACCENT, fontSize: 11, cursor: "pointer" }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export default function PunchList({
  brandId,
  runId,
  brandName,
  brandDomain,
}: {
  brandId: string;
  runId: string;
  brandName: string;
  brandDomain: string;
}) {
  const [data, setData] = useState<PunchListData | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(apiUrl(`/api/brands/${brandId}/runs/${runId}/responses`));
        if (!res.ok) {
          if (!cancelled) setLoaded(true);
          return;
        }
        const body = (await res.json()) as { responses: PunchResponse[] };
        if (cancelled) return;
        setData(buildPunchList(body.responses ?? [], { brandName, brandDomain }));
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brandId, runId, brandName, brandDomain]);

  if (!loaded || !data || data.items.length === 0) return null;

  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: "16px 18px", marginBottom: 20, textAlign: "left" }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>What to fix next</div>
      <div style={{ display: "grid", gap: 12 }}>
        {data.items.map((item, i) => {
          if (item.kind === "coverage") {
            return (
              <div key={i}>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Which engines mention {brandName}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                  {item.platforms.map((p) => (
                    <div key={p.platform} style={{ border: BORDER, borderRadius: 8, padding: "8px 10px", textAlign: "center", background: p.mentioned ? UI.GREEN_BG : UI.REPLY_BG }}>
                      <div style={{ fontSize: 12, color: MUTED }}>{p.platformLabel}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: p.mentioned ? GREEN : MUTED }}>{p.mentioned ? "✓" : "—"}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          if (item.kind === "quote") {
            return <QuoteCard key={i} item={item} />;
          }
          if (item.kind === "gap") {
            return (
              <div key={i}>
                <div style={{ fontSize: 13 }}>
                  <strong>{item.platformLabel}</strong> didn&apos;t mention you for {item.missedPrompts} prompt{item.missedPrompts === 1 ? "" : "s"}
                  {item.topDomains.length > 0 ? " — the sources it cited instead:" : "."}
                </div>
                {item.topDomains.length > 0 && (
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{item.topDomains.join(" · ")}</div>
                )}
              </div>
            );
          }
          // none
          return (
            <div key={i}>
              <div style={{ fontSize: 13 }}>
                AI engines aren&apos;t mentioning <strong>{brandName}</strong> yet — here&apos;s who they cite instead:
              </div>
              {item.topDomains.length > 0 && (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{item.topDomains.join(" · ")}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
