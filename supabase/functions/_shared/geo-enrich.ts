// IP → geo enrichment helper for Supabase Edge Functions.
//
// Vercel/Cloudflare edge headers (cf-ipcountry, x-vercel-ip-country,
// x-vercel-ip-city, x-vercel-ip-region-code) do NOT exist on Supabase Edge.
// To preserve the country/city/region analytics dimension we call out to
// ipinfo.io's free tier with two cost-control levers:
//
//   1. Sampling — default 10% (GEO_SAMPLE_RATE env). With ~3M monthly
//      beacons we'd blow the 50k/mo free tier without sampling.
//   2. Fail-open — any failure (network, 4xx/5xx, malformed JSON) returns
//      null so the beacon insert proceeds with country/city/region NULL.
//      The geo dimension goes dark for that row; the analytics record
//      lives. Beacon SLO > geo SLO.
//
// Pre-deploy: set IPINFO_TOKEN via `supabase secrets set` (free token from
// ipinfo.io dashboard). Set GEO_SAMPLE_RATE to override the 10% default.

export interface GeoEnrichment {
  country: string | null;
  city: string | null;
  region: string | null;
}

/**
 * @internal — exported for testability. Returns true with probability `rate`.
 */
export function _shouldSample(rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

function parseRate(raw: string | undefined): number {
  if (!raw) return 0.1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Return country/city/region for `ip`, or null when:
 *   - ip is empty
 *   - the sample roll says skip
 *   - IPINFO_TOKEN is unset
 *   - the vendor returns non-200 OR throws
 */
export async function enrichGeo(ip: string | null): Promise<GeoEnrichment | null> {
  if (!ip) return null;

  const rate = parseRate(Deno.env.get("GEO_SAMPLE_RATE"));
  if (!_shouldSample(rate)) return null;

  const token = Deno.env.get("IPINFO_TOKEN");
  if (!token) {
    // Operational warning only — don't fail the beacon. Once IPINFO_TOKEN
    // is set in project secrets this stops firing.
    console.warn(
      "[geo-enrich] IPINFO_TOKEN is not set — geo enrichment disabled",
    );
    return null;
  }

  try {
    const url = `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) {
      // ipinfo returns 429 once the free quota is hit — log it as a warning
      // so dashboards surface the depletion event, but don't fail the
      // beacon.
      console.warn(`[geo-enrich] vendor returned ${res.status}`);
      return null;
    }
    const data = await res.json() as Record<string, unknown>;
    return {
      country: typeof data.country === "string" ? data.country : null,
      city: typeof data.city === "string" ? data.city : null,
      region: typeof data.region === "string" ? data.region : null,
    };
  } catch (err) {
    // Never propagate — the beacon insert must proceed.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[geo-enrich] fail-open: ${msg}`);
    return null;
  }
}
