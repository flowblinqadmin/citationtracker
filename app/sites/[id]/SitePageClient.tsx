"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  type SiteData,
  type TabId,
  type TeamDomainSwitcherEntry,
  type SiteDataExtended,
  type GeoScorecard,
  type RankedRec,
  type ChangeLogEntry,
} from "./types";
import BuyCreditsButton from "@/app/dashboard/BuyCreditsButton";
import { FREE_AUDIT_LIMIT, SUBSCRIPTION_TIERS, ACTION_CREDITS } from "@/lib/config";
import SignOutButton from "@/app/dashboard/SignOutButton";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";
import type { DiscoveredCompetitor, UserCompetitor } from "@/lib/types/citation";
import { canRetryBulk } from "./_helpers/bulk-retry";
import type { CitationCheckScore } from "@/lib/db/schema";
import ChatWidget from "@/app/components/chatbot/ChatWidget";
import type { ViewContext, ChatWidgetHandle } from "@/app/components/chatbot/ChatWidget";
import UpgradeModal from "@/app/components/UpgradeModal";
import FreeTierSetupUpsell, { CustomerProofCards } from "./FreeTierSetupUpsell";
import { ProShowcasePanel, SampleHistoryChart, SampleCitationLog } from "./ProShowcase";

// ── Design tokens (copper system — matches ES-061) ────────────────────────────
const COPPER    = "#c2652a";
const COPPER_BG = "#fff7ed";
const BG        = "#f5f5f7";
const CARD      = "#fff";
const BORDER    = "#e5e5ea";
const GREEN     = "#34c759";
const ORANGE    = "#ff9500";
const RED       = "#ff3b30";
const TEXT      = "#1d1d1f";
const T2        = "#86868b";
const T3        = "#aeaeb2";
const FONT_STACK = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// ── Pipeline stages (HP-112: labels must not be renamed) ──────────────────────
const ALL_STAGES = [
  { status: "discovery",   label: "Discovering pages" },
  { status: "crawling",    label: "Reading your content" },
  { status: "extracting",  label: "Extracting structure" },
  { status: "researching", label: "Checking the landscape" },
  { status: "analyzing",   label: "Running your AI audit" },
  { status: "generating",  label: "Building your profile" },
  { status: "assembling",  label: "Final checks" },
];

function isActiveStatus(status: string | null | undefined): boolean {
  return ["queued", "pending", "discovery", "crawling", "extracting", "researching", "analyzing", "generating", "assembling"].includes(status ?? "");
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function scoreColor(s: number): string {
  return s >= 75 ? GREEN : s >= 50 ? ORANGE : RED;
}

function scoreTier(s: number): "Good" | "Fair" | "Weak" | "Poor" {
  if (s >= 75) return "Good";
  if (s >= 50) return "Fair";
  if (s >= 25) return "Weak";
  return "Poor";
}

// ── InfoTooltip — hover ⓘ icon with definition bubble ─────────────────────────
// MINOR-2: keyboard-accessible card props. Returns role/tabIndex/onKeyDown
// for any clickable <div> card on the overview so Tab traversal reaches it
// and Enter/Space activate it. Use as `<div {...clickableCardProps(handler)} ...>`.
function clickableCardProps(onActivate: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
  };
}

function InfoTooltip({ text }: { text: string }) {
  return (
    <span
      className="info-tooltip-wrapper"
      // MINOR-2: stopPropagation so clicking the tooltip ⓘ glyph does not
      // bubble up to a parent card's onClick=navigateTab handler.
      onClick={(e) => e.stopPropagation()}
      style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: 4, verticalAlign: "middle" }}
    >
      <span style={{ fontSize: 11, color: "#86868b", cursor: "help", lineHeight: 1, userSelect: "none" }}>ⓘ</span>
      <span
        className="info-tooltip-bubble"
        style={{
          display: "none", position: "absolute", bottom: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)", background: "#1d1d1f", color: "#fff",
          fontSize: 11, lineHeight: 1.5, padding: "6px 10px", borderRadius: 6,
          whiteSpace: "normal", width: 200, zIndex: 200, pointerEvents: "none",
          boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
        }}
      >
        {text}
      </span>
    </span>
  );
}

// ── Pillar tooltip descriptions ───────────────────────────────────────────────
const PILLAR_TOOLTIPS: Record<string, string> = {
  structured_data:        "Schema.org JSON-LD markup that helps AI understand your business type, products, and content structure.",
  llms_txt:               "An /llms.txt file that tells AI agents what your site is about — like robots.txt but for AI comprehension.",
  meta_tags:              "Title tags, meta descriptions, and Open Graph tags — the primary signals AI uses to understand each page.",
  content_depth:          "Content length, heading structure, and topical coverage. AI favors comprehensive, well-structured pages.",
  content_quality:        "Readability, uniqueness, and depth of your content. AI agents favor authoritative, well-written pages.",
  content_structure:      "How content is organized using headings, lists, and paragraphs to make it easy for AI to parse.",
  technical_seo:          "Crawlability, sitemaps, page speed, and robots.txt. Technical issues block AI from accessing your content.",
  internal_linking:       "How well pages link to each other — helps AI discover and understand relationships between your content.",
  ai_crawler_access:      "Whether GPTBot, ClaudeBot, PerplexityBot, and Google-Extended are permitted in your robots.txt.",
  geographic_signals:     "Location-specific structured data, NAP consistency, and local schema that AI uses to understand where you operate.",
  local_seo:              "NAP (Name, Address, Phone) consistency, Google Business Profile markup, and local schema.org data.",
  eeat_signals:           "Experience, Expertise, Authoritativeness, and Trustworthiness signals — author bios, citations, trust indicators.",
  author_authority:       "Author credentials, bios, and expertise signals that help AI assess the trustworthiness of your content.",
  faq_coverage:           "FAQ sections and Q&A structured data — formats AI agents consume directly to answer user questions.",
  image_optimization:     "Alt text, image titles, and image schema. AI needs text descriptions to understand your visual content.",
  security_trust:         "HTTPS, security headers, privacy policy, and trust signals that AI engines use to assess site credibility.",
  competitive_positioning:"How prominently AI mentions you compared to competitors when answering category-level queries.",
  brand_clarity:          "How clearly and consistently AI understands your brand name, category, and value proposition.",
  citation_signals:       "External citations, statistics, and expert quotes — content that other sources reference gets cited more by AI.",
  semantic_html:          "Correct use of H1–H6, article, section, and landmark elements that help AI parse page structure.",
  metadata_freshness:     "How recent and accurate your meta tags, timestamps, and content dates are — AI favors fresh content.",
  contact_trust:          "Contact page completeness, phone/email presence, and trust indicators that signal a legitimate business.",
};

function pillarTooltip(pillarId: string): string | undefined {
  return PILLAR_TOOLTIPS[pillarId] ?? PILLAR_TOOLTIPS[pillarId.replace(/-/g, "_")];
}

// ── Props ──────────────────────────────────────────────────────────────────────
interface SitePageClientProps {
  site: SiteData | null;
  siteId: string;
  initialToken?: string;
  allTeamDomains: TeamDomainSwitcherEntry[];
  lastCitationCheck: CitationCheckScore | null;
  citationHistory: CitationCheckScore[];
  credits: number;
  userEmail?: string;
  freeAuditsRemaining?: number;
}

const ALL_TABS: { id: TabId; label: string }[] = [
  { id: "overview",     label: "Overview" },
  { id: "competitive",  label: "Citation Analysis" },
  { id: "action-plan",  label: "Action Plan" },
  { id: "fix-html",     label: "Fix HTML" },
  { id: "history",      label: "History" },
  { id: "setup",        label: "Setup" },
];

// Free-tier locked metric — turns an empty "—" KPI into a showcase of what Pro
// unlocks: a blurred sample value, an "Unlock" pill, and a one-line teaser of
// what the metric reveals. Clicking opens the upgrade modal. Self-contained
// styling (no external tokens) so it can live at module scope.
function LockedMetric({
  sample,
  caption,
  onUpgrade,
  big = true,
}: {
  sample: string;
  caption?: string;
  onUpgrade: () => void;
  big?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid="locked-metric"
      onClick={(e) => { e.stopPropagation(); onUpgrade(); }}
      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", boxSizing: "border-box" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            fontSize: big ? 32 : 22,
            fontWeight: 700,
            letterSpacing: "-1px",
            lineHeight: 1.1,
            color: "#aeaeb2",
            filter: "blur(5px)",
            userSelect: "none",
          }}
        >
          {sample}
        </span>
        {big && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#c2652a",
              background: "#fff7ed",
              border: "1px solid rgba(194,101,42,0.3)",
              borderRadius: 6,
              padding: "3px 8px",
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#c2652a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Unlock
          </span>
        )}
      </div>
      {big && caption && (
        <div style={{ fontSize: 12, color: "#c2652a", marginTop: 6, fontWeight: 600 }}>{caption} →</div>
      )}
    </button>
  );
}

const AI_FILES = [
  { label: "llms.txt",      field: "generatedLlmsTxt",      slug: "llms" },
  { label: "llms-full.txt", field: "generatedLlmsFullTxt",  slug: "llms-full" },
  { label: "business.json", field: "generatedBusinessJson", slug: "business" },
  { label: "schema.json",   field: "generatedSchemaBlocks", slug: "schema" },
  { label: "urls.txt",      field: null,                    slug: "urls" },
];

export default function SitePageClient({
  site: initialSite,
  siteId,
  initialToken,
  allTeamDomains,
  lastCitationCheck,
  citationHistory,
  credits: initialCredits,
  freeAuditsRemaining,
}: SitePageClientProps) {
  const router = useRouter();
  const isMobile = useMediaQuery(768);

  const [site, setSite] = useState<SiteData | null>(initialSite);
  const [token, setToken]           = useState<string | null>(null);
  const [tokenReady, setTokenReady] = useState(false);
  const [retrying, setRetrying]     = useState(false);

  // Subscription tier — used to gate Setup tab and action rail.
  // Prefer the explicit subscriptionTier field (Stripe tier: free/starter/growth/pro).
  // Fall back to the binary tier field ("free"/"paid") when subscriptionTier is absent,
  // so legacy test fixtures and share-link views default correctly.
  const isFreeTier = site?.subscriptionTier != null
    ? site.subscriptionTier === "free"
    : site?.tier === "free";

  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [actionPlanView, setActionPlanView] = useState<"scorecard" | "recommendations" | "pages">("scorecard");

  // Push tab changes to browser history so back/forward navigate between tabs.
  // PRESERVE existing query params (esp. ?token=) — overwriting the query string
  // with just ?tab=X dropped the access token, so any reload/share/bookmark of a
  // tab URL dumped the user to the email gate ("empty" page). Conversion killer.
  const navigateTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.pushState({ tab, siteId }, "", `${url.pathname}${url.search}`);
  }, [siteId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const t = url.searchParams.get("tab") as TabId | null;
    if (t && ALL_TABS.some(x => x.id === t)) setActiveTab(t);
    const onPop = (e: PopStateEvent) => {
      const popped = (e.state?.tab ?? "overview") as TabId;
      setActiveTab(ALL_TABS.some(x => x.id === popped) ? popped : "overview");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Domain switcher
  const [switcherOpen, setSwitcherOpen]     = useState(false);
  const [switcherSearch, setSwitcherSearch] = useState("");

  // Action rail
  const [refreshError, setRefreshError]             = useState<string | null>(null);
  const [citationScanActive, setCitationScanActive] = useState(false);
  const [competitorScanActive, setCompetitorScanActive] = useState(false);
  // ES-wave-4 §G2 AC-G2-1: surface Map Competitors error text instead of
  // silently failing to setCompetitorScanActive(false).
  const [competitorScanError, setCompetitorScanError] = useState<string | null>(null);
  const [discoveredCompetitors, setDiscoveredCompetitors] = useState<DiscoveredCompetitor[]>(
    (initialSite as SiteDataExtended)?.discoveredCompetitors ?? []
  );
  const [userCompetitors, setUserCompetitors] = useState<UserCompetitor[]>(
    (initialSite as SiteDataExtended)?.userCompetitors ?? []
  );
  const [competitorBlocklist, setCompetitorBlocklist] = useState<string[]>(
    (initialSite as SiteDataExtended)?.competitorBlocklist ?? []
  );
  const [addCompetitorName, setAddCompetitorName] = useState("");
  const [addCompetitorLoading, setAddCompetitorLoading] = useState(false);
  const [addCompetitorError, setAddCompetitorError] = useState<string | null>(null);
  const [addCompetitorDomain, setAddCompetitorDomain] = useState("");
  const [showDomainInput, setShowDomainInput] = useState(false);

  const effectiveCompetitors = [
    ...userCompetitors.map((c) => ({ ...c, source: "user" as const })),
    ...discoveredCompetitors.map((c) => ({ ...c, source: "discovered" as const })),
  ];
  const slotsRemaining = Math.max(0, 6 - effectiveCompetitors.length);

  // Email gate state
  const [email, setEmail]         = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  // OTP step state — `858d6fa` security fix made /api/sites/[id]/auth send an
  // OTP instead of returning the access token directly. The flow is now:
  // 1. email → /api/sites/[id]/auth → OTP emailed
  // 2. OTP → /api/sites/[id]/verify → accessToken returned
  // Without these two states the UI silently rejected the auth response and
  // showed "Something went wrong" (the route returned { message } and the
  // client read data.token which was undefined). Fixed 2026-05-16.
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const otpInputRef = useRef<HTMLInputElement>(null);

  // isNewSite: true if no overall score existed at mount (set once, never changed)
  const isNewSiteRef = useRef<boolean>(
    (initialSite?.geoScorecard as { overallScore?: number } | null)?.overallScore == null
  );

  // Scorecard tier filter
  const [tierFilter, setTierFilter] = useState<"All" | "Poor" | "Weak" | "Fair" | "Good">("All");
  const [showAllPillars, setShowAllPillars] = useState(false);

  // Recommendations expand
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [expandedPillars, setExpandedPillars] = useState<Set<string>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  // Rail hover state
  const [hoveredRail, setHoveredRail] = useState<string | null>(null);

  // Upgrade modal + SOV samples panel
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [sovSamplesExpanded, setSovSamplesExpanded] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());

  // Fix HTML tab state
  const [fixHtmlSelectedUrl, setFixHtmlSelectedUrl] = useState<string>("");
  const [fixHtmlInput, setFixHtmlInput] = useState<string>("");
  const [fixHtmlCopied, setFixHtmlCopied] = useState(false);

  // Pages state
  const [pageFilter, setPageFilter] = useState<"All" | "good" | "needs-work" | "poor">("All");
  const [pageSearch, setPageSearch] = useState("");
  const [pageCursor, setPageCursor] = useState(0);
  const [expandedPageUrls, setExpandedPageUrls] = useState<Set<string>>(new Set());
  const PAGE_SIZE = 25;

  // ── Domain Integration state (ES-074) ──────────────────────────────────────
  const [integrationTab, setIntegrationTab] = useState("vercel");
  const [otherPlatform, setOtherPlatform] = useState("");
  const [otherConfig, setOtherConfig] = useState("");
  const [otherLoading, setOtherLoading] = useState(false);
  const [otherError, setOtherError] = useState("");
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{ connected: boolean; detail: string } | null>(null);

  // ── Cleo discoverability — imperative ref + per-session nudge state ────────
  const chatRef = useRef<ChatWidgetHandle>(null);
  const nudgeFiredRef = useRef<Set<string>>(new Set());
  const prevDomainVerifiedRef = useRef<boolean | undefined>(undefined);
  const fireNudgeOnce = useCallback((key: string, text: string, seedQuery?: string) => {
    if (nudgeFiredRef.current.has(key)) return;
    nudgeFiredRef.current.add(key);
    chatRef.current?.showPeek(text, seedQuery);
  }, []);

  // Setup-tab opens → offer platform install help.
  // Runs once per session (frequency-capped inside ChatWidget).
  useEffect(() => {
    if (activeTab !== "setup") return;
    const platform = (site as SiteDataExtended | null)?.platformDetected;
    const text = platform
      ? `Setting up on ${platform}? I can walk you through it.`
      : "Need help with the install steps? Ask me anything.";
    const seed = platform
      ? `How do I install FlowBlinq on ${platform}?`
      : "How do I install FlowBlinq on my site?";
    fireNudgeOnce("setup", text, seed);
  }, [activeTab, site, fireNudgeOnce]);

  // First low pillar expanded → offer to explain it.
  useEffect(() => {
    if (expandedPillars.size === 0) return;
    const pillarsList = (site?.geoScorecard as { pillars?: Array<{ pillar: string; pillarName?: string; score?: number }> } | null)?.pillars ?? [];
    for (const key of expandedPillars) {
      const found = pillarsList.find((p) => p.pillar === key);
      if (found && (found.score ?? 100) < 50) {
        const name = found.pillarName ?? found.pillar;
        fireNudgeOnce(`pillar:${key}`, `Want me to explain why ${name} is low?`, `Why is my ${name} pillar low and how do I fix it?`);
        return;
      }
    }
  }, [expandedPillars, site, fireNudgeOnce]);

  // Test Connection failed → offer to debug.
  useEffect(() => {
    if (connectionResult?.connected === false) {
      const domain = site?.domain ?? "your site";
      fireNudgeOnce(
        "conn-fail",
        "I can help debug the connection failure.",
        `Why isn't my llms.txt verified at ${domain}? Test Connection just failed.`,
      );
    }
  }, [connectionResult, site?.domain, fireNudgeOnce]);

  // Domain verification flips false → true → offer next-step walkthrough.
  useEffect(() => {
    const cur = site?.domainVerified;
    const prev = prevDomainVerifiedRef.current;
    if (prev === false && cur === true) {
      fireNudgeOnce(
        "domain-verified",
        "Your domain is verified — want me to walk you through completing setup?",
        "My domain just verified. What should I do next?",
      );
    }
    prevDomainVerifiedRef.current = cur;
  }, [site?.domainVerified, fireNudgeOnce]);

  // ── Token loading ────────────────────────────────────────────────────────────
  // ES-wave-1 G3: prefer the freshly server-rendered initialSite.token over any
  // cached sessionStorage value. When a regenerate from another tab rotates the
  // server-side token, the next hard-refresh of this tab arrives with the new
  // token in initialSite.token; the prior code path used the stale stored value
  // and shipped a 401 to every action endpoint. Read-only / share-link views
  // (initialSite.token absent) fall through to the existing chain unchanged.
  useEffect(() => {
    if (initialSite?.token) {
      const stored = sessionStorage.getItem(`geo-token-${siteId}`);
      if (stored !== initialSite.token) {
        sessionStorage.setItem(`geo-token-${siteId}`, initialSite.token);
      }
      setToken(initialSite.token);
    } else {
      const stored = sessionStorage.getItem(`geo-token-${siteId}`);
      if (stored) {
        setToken(stored);
      } else if (initialToken) {
        sessionStorage.setItem(`geo-token-${siteId}`, initialToken);
        setToken(initialToken);
      } else if (typeof window !== "undefined" && window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.slice(1));
        const st = hashParams.get("st");
        const sid = hashParams.get("sid");
        if (st && sid === siteId) {
          sessionStorage.setItem(`geo-token-${siteId}`, st);
          setToken(st);
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      }
    }
    setTokenReady(true);
  }, [siteId, initialSite?.token, initialToken]);

  // ── CSS var for audit bar height (HP-108) ────────────────────────────────────
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--audit-bar-height",
      isActiveStatus(site?.pipelineStatus) ? "52px" : "0px"
    );
  }, [site?.pipelineStatus]);

  // ── Polling ───────────────────────────────────────────────────────────────────
  const poll = useCallback(async (overrideToken?: string) => {
    const t = overrideToken ?? token;
    if (!t) return;
    try {
      const res = await fetch(`/api/sites/${siteId}?token=${t}`);
      if (res.ok) {
        const data = await res.json() as SiteData;
        setSite({ ...data, token: t });
        if (!isActiveStatus(data.pipelineStatus)) {
          router.refresh();
        }
      } else if (res.status === 401) {
        const body = await res.json().catch(() => ({}));
        if (body?.code === "TOKEN_EXPIRED") {
          sessionStorage.removeItem(`geo-token-${siteId}`);
          setToken(null);
          setSite(null);
        }
      }
    } catch { /* ignore */ }
  }, [siteId, token, router]);

  // ── Initial fetch: token loaded (e.g. from hash) but server passed site=null ──
  useEffect(() => {
    if (token && !site && tokenReady) {
      poll();
    }
  }, [token, site, tokenReady, poll]);

  useEffect(() => {
    if (!isActiveStatus(site?.pipelineStatus) || !token) return;
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [poll, site?.pipelineStatus, token]);

  // ── Email gate auth: Step 1 — request OTP via email ─────────────────────────
  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      // Route is intentionally vague — both "email matches" and "email
      // doesn't match" return 200 with `{ message: "If that email matches…" }`
      // to avoid leaking which emails are registered. Treat 200 as "OTP has
      // been sent if email is valid" and move to the OTP entry step.
      if (res.status === 429) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setAuthError(data.error ?? "Too many attempts. Try again later.");
        return;
      }
      if (!res.ok) {
        setAuthError("Something went wrong. Try again.");
        emailInputRef.current?.focus();
        return;
      }
      setOtpSent(true);
      // Defer focus to the OTP input once it mounts.
      requestAnimationFrame(() => otpInputRef.current?.focus());
    } catch {
      setAuthError("Network error. Please try again.");
    } finally {
      setAuthLoading(false);
    }
  }

  // ── Email gate auth: Step 2 — verify OTP ────────────────────────────────────
  async function handleOtpVerify(e: React.FormEvent) {
    e.preventDefault();
    const code = otpCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setAuthError("Enter the 6-digit code from the email.");
      otpInputRef.current?.focus();
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({})) as {
        accessToken?: string;
        success?: boolean;
        error?: string;
      };
      if (!res.ok || !data.accessToken) {
        setAuthError(data.error ?? "Invalid or expired code.");
        otpInputRef.current?.focus();
        return;
      }
      sessionStorage.setItem(`geo-token-${siteId}`, data.accessToken);
      setToken(data.accessToken);
    } catch {
      setAuthError("Network error. Please try again.");
    } finally {
      setAuthLoading(false);
    }
  }

  // ── Download handler (fetch-based, no <a download> JSON file bug) ────────────
  const [downloadError, setDownloadError] = useState<string | null>(null);
  async function handleDownloadZip() {
    if (!token) return;
    try {
      const res = await fetch(`/api/sites/${siteId}/download-report?token=${token}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Download failed" }));
        setDownloadError(data.error ?? "Download failed");
        setTimeout(() => setDownloadError(null), 4000);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${site?.domain ?? "report"}-geo-audit.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      await poll();
    } catch {
      setDownloadError("Download failed");
      setTimeout(() => setDownloadError(null), 4000);
    }
  }

  // ── Fix-HTML surgical render (Phase B v2 — side-by-side paste/render only) ──
  const [fixHtmlOutput, setFixHtmlOutput] = useState<string>("");
  type SideBySideRow = {
    pasted: { lineNo: number; text: string } | null;
    fixed: { lineNo: number; text: string } | null;
    marker: "context" | "removed" | "added";
  };
  const [fixHtmlDiff, setFixHtmlDiff] = useState<SideBySideRow[]>([]);
  const [fixHtmlChanges, setFixHtmlChanges] = useState<string[]>([]);
  const [fixHtmlWarnings, setFixHtmlWarnings] = useState<string[]>([]);
  const [fixHtmlMatchedUrl, setFixHtmlMatchedUrl] = useState<string | null>(null);
  const [fixHtmlDetectedUrl, setFixHtmlDetectedUrl] = useState<string | null>(null);
  const [fixHtmlMatchSource, setFixHtmlMatchSource] = useState<"selected" | "detected" | "none">("none");
  const [fixHtmlApplying, setFixHtmlApplying] = useState(false);
  const [fixHtmlError, setFixHtmlError] = useState<string | null>(null);

  async function handleApplyFixHtml() {
    if (!token || fixHtmlApplying) return;
    const pastedHtml = fixHtmlInput.trim();
    if (!pastedHtml) {
      setFixHtmlError("Paste your page HTML on the left first.");
      setTimeout(() => setFixHtmlError(null), 4000);
      return;
    }
    setFixHtmlApplying(true);
    setFixHtmlError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/fix-html-render?token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pastedHtml, selectedUrl: fixHtmlSelectedUrl || undefined }),
      });
      const data = await res.json().catch(() => ({ error: "Render failed" }));
      if (!res.ok) {
        setFixHtmlError(data.error ?? "Render failed");
        setTimeout(() => setFixHtmlError(null), 5000);
        return;
      }
      setFixHtmlOutput(data.fixedHtml ?? "");
      setFixHtmlDiff(Array.isArray(data.sideBySide) ? data.sideBySide : []);
      setFixHtmlChanges(Array.isArray(data.appliedChanges) ? data.appliedChanges : []);
      setFixHtmlWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setFixHtmlMatchedUrl(data.matchedUrl ?? null);
      setFixHtmlDetectedUrl(data.detectedUrl ?? null);
      setFixHtmlMatchSource(data.matchSource ?? "none");
    } catch {
      setFixHtmlError("Render failed (network)");
      setTimeout(() => setFixHtmlError(null), 5000);
    } finally {
      setFixHtmlApplying(false);
    }
  }

  // ── Action handlers ───────────────────────────────────────────────────────────
  async function handleRefreshScore() {
    if (!token || retrying) return;
    setRetrying(true);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/regenerate?token=${token}`, { method: "POST" });
      if (res.status === 202 || res.status === 201) {
        // ES-B10 AC-B10-10: in-place rerun — server UPDATEd the same site
        // row. Rotate the local token (server returns it in `accessToken`),
        // flip optimistic queued state, and refresh server props. No
        // navigation; the user stays on the same /sites/{id} URL.
        const data = (await res.json().catch(() => ({}))) as { accessToken?: string };
        const newToken = data.accessToken;
        if (newToken) {
          sessionStorage.setItem(`geo-token-${siteId}`, newToken);
          setToken(newToken);
          const url = new URL(window.location.href);
          url.searchParams.set("token", newToken);
          window.history.replaceState(null, "", url.toString());
        }
        setSite((prev) => (prev ? { ...prev, pipelineStatus: "queued" } : prev));
        await poll(newToken);
        router.refresh();
      } else if (res.status === 402) {
        setRefreshError("Not enough credits");
        setTimeout(() => setRefreshError(null), 4000);
      } else if (res.status === 409) {
        setRefreshError("Scan already in progress");
        setTimeout(() => setRefreshError(null), 4000);
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setRefreshError(data.error ?? "Failed to start — try again");
        setTimeout(() => setRefreshError(null), 4000);
      }
    } catch { /* ignore */ } finally { setRetrying(false); }
  }

  async function handleScanCitations() {
    if (!token || citationScanActive) return;
    setCitationScanActive(true);
    setActiveTab("overview");
    try {
      const res = await fetch(`/api/sites/${siteId}/citation-check?token=${token}`, { method: "POST" });
      if (!res.ok || !res.body) { setCitationScanActive(false); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
      }
      // Stream complete — refresh site data (including credit balance)
      await poll();
    } catch { /* ignore */ } finally {
      setCitationScanActive(false);
    }
  }

  async function handleMapCompetitors() {
    if (!token || competitorScanActive) return;
    setCompetitorScanActive(true);
    setCompetitorScanError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/competitor-discovery?token=${token}`, { method: "POST" });
      if (!res.ok || !res.body) {
        // ES-wave-4 §G2 AC-G2-1/2: surface server error text. Falls back to
        // a generic message if the server didn't send a JSON body.
        let msg = "Couldn't start competitor scan — please try again.";
        try {
          const data = await res.clone().json() as { error?: string };
          if (data.error) msg = data.error;
        } catch {
          // non-JSON response; keep generic msg.
        }
        setCompetitorScanError(msg);
        setCompetitorScanActive(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6)) as {
              type: string;
              competitors?: DiscoveredCompetitor[];
              creditsUsed?: number;
              slotsRemaining?: number;
            };
            if (evt.type === "complete" && evt.competitors) {
              setDiscoveredCompetitors(evt.competitors);
              setSite((prev) => prev
                ? { ...prev, credits: prev.credits - (evt.creditsUsed ?? 2) }
                : prev
              );
            }
          } catch { /* ignore malformed */ }
        }
      }
      await poll();
    } catch (err) {
      // ES-wave-4 §G2 AC-G2-3: stream/network failure surfaces too.
      const msg = err instanceof Error && err.message ? err.message : "Network error during competitor scan.";
      setCompetitorScanError(msg);
    } finally {
      setCompetitorScanActive(false);
    }
  }

  // ES-B9 §c.2 — bulk-retry handler (mirrors ResultsDashboardLegacy line 1015-1031)
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [bulkRetryError, setBulkRetryError] = useState<string | null>(null);
  const [bulkRetryResult, setBulkRetryResult] = useState<{ siteId: string; accessToken: string; urlCount: number } | null>(null);

  async function handleRetryFailed(urls?: string[]) {
    if (!site?.token || retryingFailed) return;
    setRetryingFailed(true);
    setBulkRetryError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/retry-failed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + site.token },
        body: urls ? JSON.stringify({ urls }) : "{}",
      });
      const data = await res.json() as { siteId?: string; accessToken?: string; urlCount?: number; error?: string };
      if (res.ok && data.siteId) {
        setBulkRetryResult({ siteId: data.siteId, accessToken: data.accessToken!, urlCount: data.urlCount ?? 0 });
      } else {
        setBulkRetryError(data.error ?? "Failed to start retry.");
      }
    } catch {
      setBulkRetryError("Network error — retry failed.");
    } finally {
      setRetryingFailed(false);
    }
  }

  async function handleAddCompetitor() {
    const name = addCompetitorName.trim();
    if (!name || addCompetitorLoading) return;
    setAddCompetitorLoading(true);
    setAddCompetitorError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/competitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "add", name, domain: addCompetitorDomain.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setAddCompetitorError(data.error); return; }
      setUserCompetitors(data.userCompetitors);
      setDiscoveredCompetitors(data.discoveredCompetitors);
      setCompetitorBlocklist(data.blocklist);
      setAddCompetitorName("");
      setAddCompetitorDomain("");
      setShowDomainInput(false);
    } catch { setAddCompetitorError("Network error"); }
    finally { setAddCompetitorLoading(false); }
  }

  async function handleRemoveCompetitor(name: string) {
    try {
      const res = await fetch(`/api/sites/${siteId}/competitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "remove", name }),
      });
      const data = await res.json();
      if (res.ok) {
        setUserCompetitors(data.userCompetitors);
        setDiscoveredCompetitors(data.discoveredCompetitors);
        setCompetitorBlocklist(data.blocklist);
      }
    } catch { /* ignore */ }
  }

  // ── Email gate ────────────────────────────────────────────────────────────────
  if (tokenReady && !token) {
    return (
      <main
        data-testid="email-gate"
        role="main"
        style={{
          minHeight: "100vh", background: BG, fontFamily: FONT_STACK,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <div style={{ maxWidth: 420, width: "100%", padding: "32px 24px" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8, color: TEXT }}>
              {otpSent ? "Enter your code" : "Open your report"}
            </div>
            <div style={{ color: T2, fontSize: 14, lineHeight: 1.6 }}>
              {otpSent
                ? `We sent a 6-digit code to ${email.trim()}. Check your inbox (and spam folder).`
                : "Enter the email you used when you ran the audit."}
            </div>
          </div>
          {!otpSent ? (
            <form aria-label="email-gate" onSubmit={handleEmailAuth} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <input
                ref={emailInputRef}
                type="email"
                placeholder="you@yourcompany.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setAuthError(null); }}
                autoFocus
                required
                style={{
                  background: CARD, border: `1px solid ${authError ? RED : BORDER}`,
                  borderRadius: 10, padding: "14px 18px", color: TEXT,
                  fontSize: 16, outline: "none",
                }}
              />
              {authError && <div style={{ color: RED, fontSize: 13, paddingLeft: 4 }}>{authError}</div>}
              <button
                type="submit"
                disabled={authLoading || !email.trim()}
                style={{
                  background: authLoading || !email.trim() ? BG : COPPER,
                  color: authLoading || !email.trim() ? T2 : "#fff",
                  fontWeight: 700, fontSize: 15, padding: 14,
                  borderRadius: 10, border: `1px solid ${authLoading || !email.trim() ? BORDER : COPPER}`,
                  cursor: authLoading || !email.trim() ? "not-allowed" : "pointer",
                }}
              >
                {authLoading ? "Sending..." : "Send code"}
              </button>
            </form>
          ) : (
            <form aria-label="otp-gate" onSubmit={handleOtpVerify} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <input
                ref={otpInputRef}
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                placeholder="123456"
                value={otpCode}
                onChange={(e) => {
                  // Keep digits only, cap at 6 chars
                  setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                  setAuthError(null);
                }}
                autoFocus
                required
                style={{
                  background: CARD, border: `1px solid ${authError ? RED : BORDER}`,
                  borderRadius: 10, padding: "14px 18px", color: TEXT,
                  fontSize: 22, letterSpacing: 6, textAlign: "center",
                  fontFamily: "monospace", outline: "none",
                }}
              />
              {authError && <div style={{ color: RED, fontSize: 13, paddingLeft: 4 }}>{authError}</div>}
              <button
                type="submit"
                disabled={authLoading || otpCode.length !== 6}
                style={{
                  background: authLoading || otpCode.length !== 6 ? BG : COPPER,
                  color: authLoading || otpCode.length !== 6 ? T2 : "#fff",
                  fontWeight: 700, fontSize: 15, padding: 14,
                  borderRadius: 10, border: `1px solid ${authLoading || otpCode.length !== 6 ? BORDER : COPPER}`,
                  cursor: authLoading || otpCode.length !== 6 ? "not-allowed" : "pointer",
                }}
              >
                {authLoading ? "Verifying..." : "Open My Report"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOtpSent(false);
                  setOtpCode("");
                  setAuthError(null);
                  requestAnimationFrame(() => emailInputRef.current?.focus());
                }}
                style={{
                  background: "transparent", color: T2, fontSize: 13,
                  border: "none", padding: 4, cursor: "pointer", textDecoration: "underline",
                }}
              >
                Use a different email
              </button>
            </form>
          )}
        </div>
      </main>
    );
  }

  // ── Derived data ──────────────────────────────────────────────────────────────
  const scorecard = site?.geoScorecard as GeoScorecard | null;
  const pillars = scorecard?.pillars ?? [];
  const pageCount = (site as unknown as { pageCount?: number })?.pageCount
    ?? (site?.crawlData as { pages?: unknown[] } | null)?.pages?.length
    ?? 0;
  const criticalCount = pillars.filter(p => (p.score ?? 100) < 25 || p.priority === "critical").length;
  // Issue UI fix: alias the "extracting" backend status to "crawling" for
  // stage-display purposes. extracting is a real pipeline stage (tree
  // extraction, ~150-200s on big sites) but isn't in ALL_STAGES — without
  // this alias findIndex returns -1 and the audit bar falls back to index 0,
  // causing a visible backwards jump "Step 2 → Step 1 → Step 3" mid-audit.
  // Aliasing keeps ALL_STAGES.length = 6 so the circle count and the `/6`
  // percentage math at line 987 stay correct.
  const stageLookupStatus = site?.pipelineStatus === "extracting" ? "crawling" : site?.pipelineStatus;
  const currentIndex = ALL_STAGES.findIndex(s => s.status === stageLookupStatus);
  const liveScore = scorecard?.overallScore ?? null;

  // Tier counts for dynamic filter (HP-106)
  const tierCounts = { Poor: 0, Weak: 0, Fair: 0, Good: 0 };
  for (const p of pillars) {
    const s = p.score ?? 0;
    if (s >= 75) tierCounts.Good++;
    else if (s >= 50) tierCounts.Fair++;
    else if (s >= 25) tierCounts.Weak++;
    else tierCounts.Poor++;
  }

  const filteredPillars = pillars.filter(p => {
    if (tierFilter === "All") return true;
    const t = scoreTier(p.score ?? 0);
    return t === tierFilter;
  });

  // Recommendations sorted by impact (critical > high > medium > low)
  const recs = [...(site?.rankedRecommendations ?? [])].map(r => ({
    ...r,
    priority: (r as RankedRec).priority ?? (r as { impact?: string }).impact ?? "LOW",
  })) as RankedRec[];
  const sortOrder: Record<string, number> = { critical: 0, HIGH: 0, high: 1, MED: 2, med: 2, medium: 2, LOW: 3, low: 3 };
  recs.sort((a, b) =>
    (sortOrder[a.priority] ?? 4) -
    (sortOrder[b.priority] ?? 4)
  );

  // Pages
  type _PageVuln = { pillar: string; pillarName: string; severity: "critical" | "high" | "medium" | "low"; finding: string; recommendation: string };
  type _PageRow = { url: string; title?: string; pageType?: string; overallPageHealth?: string; vulnerabilities?: _PageVuln[] };
  const allPages = (site?.perPageResults ?? []) as _PageRow[];
  const healthOrder = (h?: string) => h === "poor" ? 0 : h === "needs-work" ? 1 : 2;
  const critScore = (p: _PageRow) => (p.vulnerabilities ?? []).filter(v => v.severity === "critical" || v.severity === "high").length;
  const sortedPages = [...allPages].sort((a, b) => {
    const hd = healthOrder(a.overallPageHealth) - healthOrder(b.overallPageHealth);
    return hd !== 0 ? hd : critScore(b) - critScore(a);
  });
  const filteredPages = sortedPages.filter(p => {
    const matchSearch = p.url.toLowerCase().includes(pageSearch.toLowerCase()) || (p.title ?? "").toLowerCase().includes(pageSearch.toLowerCase());
    const matchFilter = pageFilter === "All" || p.overallPageHealth === pageFilter;
    return matchSearch && matchFilter;
  });
  const pagedRows = filteredPages.slice(pageCursor, pageCursor + PAGE_SIZE);

  // ES-B8: read projectedScore from the server-rendered site row instead of
  // the prior parseInt-regex over rec.estimatedBoost. The regex frequently
  // produced confidence-band suffix matches (e.g. "+5 confidence: high"
  // would parse 5 then accidentally pick up another digit) and rounded
  // capped at 100 — silent UI fallback that drifted from the DB-truth
  // projected_score on every render. Now: if the DB has a projected score,
  // surface it; otherwise omit the row (do NOT render currentScore in its
  // place, do NOT recompute from recs).
  const estAfterFixes = (site as { projectedScore?: number | null } | null)?.projectedScore ?? null;

  // Citation-check derived data (TS-065)
  const lc = lastCitationCheck;
  type _PR = { provider: string; visibilityScore: number; mentionCount: number; totalQueries: number };
  const providerResults = (lc?.providerResults ?? []) as _PR[];
  // Round 3 TS fix (2026-04-10): added `domain?: string` to the type
  // assertion because the actual data shape from citation check includes
  // `domain` (used as a React key at the SOV list render below) — without
  // it `c.domain` trips TS2339 on the key prop.
  const competitorData = (lc?.competitorData ?? []) as { name: string; domain?: string; shareOfVoice: number }[];

  // Show all competitors — no tier gating on visibility
  const visibleCompetitors = competitorData;
  // Round 3 TS fix (2026-04-10): explicit `: number` annotation so TS widens
  // away from the literal type `0` (which would make `!== 1` comparison
  // "unintentional"). This is a placeholder for future tier-based gating.
  const hiddenCompetitorCount: number = 0;

  // "What AI actually said" samples availability
  type _PRWithSamples = _PR & { samples?: Array<{ question: string; answer: string; mentioned: boolean }> };
  const providerResultsWithSamples = (lc?.providerResults ?? []) as _PRWithSamples[];
  const hasSovSamples = providerResultsWithSamples.some(
    (p: _PRWithSamples) => (p.samples?.length ?? 0) > 0,
  );

  const pillarVisibility = (lc?.pillarVisibility ?? {}) as Record<string, number>;
  const geoVisibility = (lc?.geoVisibility ?? []) as { geoId: string; geoName: string; visibility: number }[];
  const categoryVisibility = (lc?.categoryVisibility ?? []) as { categoryId: string; categoryName: string; visibility: number }[];
  const tierVisibility = (lc?.tierVisibility ?? []) as { tier: string; mentionCount: number; promptCount: number; visibility: number }[];
  const changeLog = (site?.changeLog ?? []) as ChangeLogEntry[];

  // Aggregate provider pills by provider name
  const providerAggMap = new Map<string, { mentionCount: number; totalQueries: number; visibilityScore: number }>();
  for (const p of providerResults) {
    const key = p.provider.toLowerCase().includes("perplexity") ? "Perplexity"
      : p.provider.toLowerCase().includes("openai") || p.provider.toLowerCase().includes("gpt") ? "OpenAI"
      : p.provider.toLowerCase().includes("anthropic") || p.provider.toLowerCase().includes("claude") ? "Anthropic"
      : p.provider.charAt(0).toUpperCase() + p.provider.slice(1);
    const existing = providerAggMap.get(key);
    if (!existing) {
      providerAggMap.set(key, { mentionCount: p.mentionCount, totalQueries: p.totalQueries, visibilityScore: p.visibilityScore });
    } else {
      existing.mentionCount += p.mentionCount;
      existing.totalQueries += p.totalQueries;
      existing.visibilityScore = Math.round((existing.visibilityScore + p.visibilityScore) / 2);
    }
  }
  const providerAggregates = Array.from(providerAggMap.entries()).map(([name, v]) => ({ name, ...v }));

  const totalMentions = providerResults.reduce((s, p) => s + p.mentionCount, 0);
  const totalQueryCount = providerResults.reduce((s, p) => s + p.totalQueries, 0);
  const citationRate = totalQueryCount > 0 ? Math.round((totalMentions / totalQueryCount) * 100) : null;

  // Use indirectVisibility (organic queries only) for SOV — overallVisibility
  // mixes in direct queries where the brand name is in the prompt, which
  // always inflate the mention rate. indirectVisibility is the honest number.
  const ourSOV = lc?.indirectVisibility ?? null;
  const topCompetitor = competitorData.length > 0
    ? [...competitorData].sort((a, b) => b.shareOfVoice - a.shareOfVoice)[0]
    : null;

  // Pillar ID → display name lookup (from scorecard pillars)
  const pillarNameMap = new Map<string, string>();
  for (const p of pillars) {
    pillarNameMap.set(p.pillar, p.pillarName);
  }
  const SHORT_NAMES: Record<string, string> = {
    "evidence_statistics": "Evidence",
    "entity_definitions": "Entities",
    "competitive_positioning": "Positioning",
  };
  function pillarDisplayName(id: string): string {
    if (SHORT_NAMES[id]) return SHORT_NAMES[id];
    const full = pillarNameMap.get(id);
    if (full) return full;
    return id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  // ── Domain Integration configs (ES-074) ───────────────────────────────────────
  const integrationSlug = site?.slug ?? site?.id ?? siteId;
  const geoBase = `https://geo.flowblinq.com/api/serve/${integrationSlug}`;
  const pixelTag = `<img src="https://geo.flowblinq.com/api/t/${integrationSlug}" width="1" height="1" alt="" style="position:absolute;opacity:0" />`;
  const scriptTag = `<script src="https://geo.flowblinq.com/api/t/${integrationSlug}" async></script>`;
  const cspNote = `// NOTE: If you have a Content-Security-Policy, add https://geo.flowblinq.com to img-src, script-src, and connect-src`;

  const robotsBlock = `# Step 3 — robots.txt (add to your existing robots.txt)
# Tells AI crawlers where your GEO content lives

User-agent: GPTBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: OAI-SearchBot
Allow: /llms.txt
Allow: /llms-full.txt

User-agent: ChatGPT-User
Allow: /llms.txt
Allow: /llms-full.txt

User-agent: ClaudeBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: anthropic-ai
Allow: /llms.txt
Allow: /llms-full.txt

User-agent: PerplexityBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: Google-Extended
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json`;

  const referrerSteps: Record<string, string> = {
    vercel: `// Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
// Add to middleware.ts (or create it at the root of your project)
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export function middleware(request: NextRequest) {
  const response = NextResponse.next()
  const ref = request.headers.get("referer") ?? ""
  if (!request.cookies.has("_geo_ref") && ref) {
    response.cookies.set("_geo_ref", ref, {
      maxAge: 1800, sameSite: "strict", secure: true, httpOnly: false, path: "/",
    })
  }
  return response
}
export const config = { matcher: ["/((?!api|_next|.*\\\\..*).*)"] }`,

    netlify: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Create netlify/edge-functions/geo-ref.ts
export default async (request: Request, context: any) => {
  const response = await context.next()
  const ref = request.headers.get("referer") ?? ""
  const cookies = request.headers.get("cookie") ?? ""
  if (!cookies.includes("_geo_ref=") && ref) {
    response.headers.append(
      "Set-Cookie",
      \`_geo_ref=\${encodeURIComponent(ref)}; Max-Age=1800; SameSite=Strict; Secure; Path=/\`
    )
  }
  return response
}
export const config = { path: "/*" }`,

    cloudflare: `// Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
// Add to your Cloudflare Worker fetch handler
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const response = await fetch(request)
  const ref = request.headers.get('Referer') || ''
  const cookies = request.headers.get('Cookie') || ''
  if (ref && !cookies.includes('_geo_ref=')) {
    const modified = new Response(response.body, response)
    modified.headers.append(
      'Set-Cookie',
      \`_geo_ref=\${encodeURIComponent(ref)}; Max-Age=1800; SameSite=Strict; Secure; Path=/\`
    )
    return modified
  }
  return response
}`,

    nginx: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Add inside your server {} block in nginx.conf
# Sets _geo_ref cookie when HTTP Referer is present and cookie not yet set
map $http_referer $geo_ref_cookie {
    default "_geo_ref=$http_referer; Max-Age=1800; SameSite=Strict; Secure; Path=/";
    ""      "";
}
# In location / block:
add_header Set-Cookie $geo_ref_cookie always;`,

    wordpress: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Add to functions.php
add_action('init', function() {
    if (!isset($_COOKIE['_geo_ref']) && !empty($_SERVER['HTTP_REFERER'])) {
        setcookie('_geo_ref', $_SERVER['HTTP_REFERER'], [
            'expires'  => time() + 1800,
            'path'     => '/',
            'secure'   => true,
            'httponly' => false,
            'samesite' => 'Strict',
        ]);
    }
});`,

    apache: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Add to a PHP file loaded on every request (e.g. wp-config.php or a mu-plugin)
<?php
if (!isset($_COOKIE['_geo_ref']) && !empty($_SERVER['HTTP_REFERER'])) {
    setcookie('_geo_ref', $_SERVER['HTTP_REFERER'], [
        'expires'  => time() + 1800,
        'path'     => '/',
        'secure'   => true,
        'httponly' => false,
        'samesite' => 'Strict',
    ]);
}`,
  };

  const integrationConfigs: Record<string, string> = {
    vercel: `// Step 1 — vercel.json (rewrites for AI-facing files)
{
  "rewrites": [
    { "source": "/llms.txt", "destination": "${geoBase}/llms.txt" },
    { "source": "/llms-full.txt", "destination": "${geoBase}/llms-full.txt" },
    { "source": "/.well-known/ucp.json", "destination": "${geoBase}/business.json" }
  ]
}

// Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
${pixelTag}

// Step 3 — Add schema injection for AI bots (mandatory)
${cspNote}
${scriptTag}

${referrerSteps.vercel}

${robotsBlock}`,

    netlify: `# Step 1 — netlify.toml (rewrites for AI-facing files)
[[redirects]]
  from = "/llms.txt"
  to = "${geoBase}/llms.txt"
  status = 200

[[redirects]]
  from = "/llms-full.txt"
  to = "${geoBase}/llms-full.txt"
  status = 200

[[redirects]]
  from = "/.well-known/ucp.json"
  to = "${geoBase}/business.json"
  status = 200

# Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
# ${pixelTag}

# Step 3 — Add schema injection for AI bots (mandatory)
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to script-src and connect-src
# ${scriptTag}

${referrerSteps.netlify}

${robotsBlock}`,

    cloudflare: `// Step 1 — Cloudflare Worker routes (rewrites for AI-facing files)
addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const routes = {
    '/llms.txt': '${geoBase}/llms.txt',
    '/llms-full.txt': '${geoBase}/llms-full.txt',
    '/.well-known/ucp.json': '${geoBase}/business.json',
  };
  const dest = routes[url.pathname];
  if (dest) event.respondWith(fetch(dest));
});

// Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
// ${pixelTag}

// Step 3 — Add schema injection for AI bots (mandatory)
${cspNote}
// ${scriptTag}

${referrerSteps.cloudflare}

${robotsBlock}`,

    nginx: `# Step 1 — nginx.conf proxy rules (rewrites for AI-facing files)
location = /llms.txt {
    proxy_pass ${geoBase}/llms.txt;
    proxy_set_header Host geo.flowblinq.com;
}
location = /llms-full.txt {
    proxy_pass ${geoBase}/llms-full.txt;
    proxy_set_header Host geo.flowblinq.com;
}
location = /.well-known/ucp.json {
    proxy_pass ${geoBase}/business.json;
    proxy_set_header Host geo.flowblinq.com;
}

# Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
# ${pixelTag}

# Step 3 — Add schema injection for AI bots (mandatory)
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to script-src and connect-src
# ${scriptTag}

${referrerSteps.nginx}

${robotsBlock}`,

    wordpress: `# ── .htaccess ──
RewriteEngine On
RewriteRule ^llms\\.txt$ ${geoBase}/llms.txt [P,L]
RewriteRule ^llms-full\\.txt$ ${geoBase}/llms-full.txt [P,L]
RewriteRule ^\\.well-known/ucp\\.json$ ${geoBase}/business.json [P,L]
# ── END .htaccess ──

# ── functions.php ──
# Step 2 — Add tracking pixel (works everywhere, no config needed)
# add_action('wp_footer', function() {
#   echo '${pixelTag}' . "\\n";
# });

# Step 3 — Add schema injection for AI bots (mandatory)
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to img-src, script-src, and connect-src
# add_action('wp_head', function() {
#   echo '${scriptTag}' . "\\n";
# });

${referrerSteps.wordpress}
# ── END functions.php ──

${robotsBlock}`,

    apache: `# Step 1 — .htaccess proxy rules (rewrites for AI-facing files)
RewriteEngine On
RewriteRule ^llms\\.txt$ ${geoBase}/llms.txt [P,L]
RewriteRule ^llms-full\\.txt$ ${geoBase}/llms-full.txt [P,L]
RewriteRule ^\\.well-known/ucp\\.json$ ${geoBase}/business.json [P,L]

# Step 2 — Add tracking pixel to your HTML (works everywhere, no config needed)
# ${pixelTag}

# Step 3 — Add schema injection for AI bots (mandatory)
# If you have a Content-Security-Policy, add https://geo.flowblinq.com to script-src and connect-src
# ${scriptTag}

${referrerSteps.apache}

${robotsBlock}`,
  };

  async function handleTestConnection() {
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/verify-connection`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setConnectionResult({ connected: data.connected, detail: data.detail });
    } catch {
      setConnectionResult({ connected: false, detail: "Failed to test connection. Please try again." });
    } finally {
      setTestingConnection(false);
    }
  }

  async function handleOtherPlatform() {
    setOtherLoading(true);
    setOtherError("");
    setOtherConfig("");
    try {
      const res = await fetch("/api/integration-instructions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: otherPlatform.trim(), siteId }),
      });
      if (!res.ok) throw new Error("Failed to generate instructions");
      const data = await res.json();
      setOtherConfig(data.instructions);
    } catch (err: unknown) {
      setOtherError(err instanceof Error ? err.message : "Failed to generate instructions");
    } finally {
      setOtherLoading(false);
    }
  }

  // ── Tabs: Setup tab visible for ALL tiers ────────────────────────────────────
  // Free-tier customers see the Setup tab as a sales surface (FreeTierSetupUpsell).
  // Paid customers see the existing DNS verification + AI files install UI.
  const TABS = ALL_TABS;

  // safeActiveTab is always activeTab — no free-tier fallback needed.
  const safeActiveTab: TabId = activeTab;

  // ── Layout ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: FONT_STACK, background: BG, color: TEXT, minHeight: "100vh", position: "relative" }}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 100,
        height: isMobile ? "auto" : 56, background: "#FAF9F5", borderBottom: "1px solid rgba(0,0,0,0.06)",
        display: "flex", alignItems: "center", padding: isMobile ? "8px 12px" : "10px 24px",
        flexWrap: isMobile ? "wrap" : "nowrap", gap: isMobile ? 4 : 0,
      }}>
        {/* Leading zone */}
        <div style={{ display: "flex", alignItems: "center", gap: 0, flex: 1, minWidth: 0 }}>
          <button
            onClick={() => router.push("/dashboard")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: "0 8px 0 0", color: COPPER, fontSize: 22, fontWeight: 300, lineHeight: 1, transition: "color 0.15s" }}
            aria-label="Back to dashboard"
          >
            ‹
          </button>
          <button
            onClick={() => setSwitcherOpen(!switcherOpen)}
            style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", minWidth: 0 }}
            aria-label="Switch domain"
          >
            <span style={{ fontSize: isMobile ? 13 : 15, fontWeight: 600, color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{site?.domain}</span>
            <span style={{ color: T2, fontSize: 11 }}>▾</span>
          </button>
        </div>

        {/* Center zone — hidden on mobile */}
        {!isMobile && (
          <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)" }}>
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "3px", color: COPPER }}>FLOWBLINQ GEO</span>
          </div>
        )}

        {/* Trailing zone */}
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12, flexShrink: 0 }}>
          {site?.tier === "free" && freeAuditsRemaining !== undefined && (
            <span style={{ fontSize: 12, color: T2 }}>
              {freeAuditsRemaining} of {FREE_AUDIT_LIMIT} free audits remaining
            </span>
          )}
          {/* Persistent upgrade CTA in the sticky header (was a dead "Buy credits"
              text span with no onClick). Always visible on every tab for free
              users — keeps the conversion ask on screen. */}
          {isFreeTier && (
            <button
              type="button"
              onClick={() => setShowUpgradeModal(true)}
              data-testid="header-upgrade-cta"
              style={{
                background: COPPER, color: "#fff", fontFamily: "inherit",
                fontSize: isMobile ? 12 : 13, fontWeight: 700,
                padding: isMobile ? "6px 12px" : "7px 16px", borderRadius: 8,
                border: "none", cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              Get cited by AI →
            </button>
          )}
          <BuyCreditsButton credits={site?.credits ?? initialCredits} />
          {!isMobile && <div style={{ fontSize: 12, color: T2 }}><SignOutButton /></div>}
        </div>
      </header>

      {/* ── Audit Status Bar (HP-108) — matches GEODashboardRedesignMockup-FINAL.html ── */}
      {isActiveStatus(site?.pipelineStatus) ? ((): React.ReactNode => {
        const displayIndex = currentIndex >= 0 ? currentIndex : 0;
        const pct = Math.round(((displayIndex + 0.5) / 6) * 100);
        const stageLabels = ["Connect", "Read", "Landscape", "Audit", "Profile", "Finalize"];
        return (
          <div data-testid="audit-status-bar" style={{
            position: "sticky", top: 56, zIndex: 90,
            background: "linear-gradient(135deg, #fffbf5 0%, #fff7ed 100%)",
            borderBottom: "1px solid #f0e6d9",
            padding: isMobile ? "8px 12px" : "10px 24px",
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: isMobile ? 8 : 24,
            boxShadow: "0 1px 3px rgba(194, 101, 42, 0.08)",
            flexWrap: isMobile ? "wrap" : "nowrap",
          }}>
            {/* Left: pulsing dot + title */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
              <div style={{
                width: 10, height: 10, borderRadius: "50%", background: COPPER, flexShrink: 0,
                animation: "pulse 1.5s ease-in-out infinite",
              }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: COPPER }}>
                  {isNewSiteRef.current ? "Running audit" : "Refreshing audit"}
                </div>
                {pageCount > 0 && (
                  <div style={{ fontSize: 11, color: T2, marginTop: 1 }}>{pageCount} pages</div>
                )}
              </div>
            </div>

            {/* Center: pipeline circles + connectors */}
            <div style={{ display: "flex", alignItems: "center", gap: 0, flex: 1, maxWidth: isMobile ? "100%" : 600, overflow: "hidden" }}>
              {ALL_STAGES.map((stage, i) => {
                const isDone   = i < displayIndex;
                const isActive = i === displayIndex;
                const connectorState = i < displayIndex ? "done" : i === displayIndex ? "active" : "pending";
                return (
                  <React.Fragment key={stage.status}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, whiteSpace: "nowrap", color: isDone ? GREEN : isActive ? COPPER : T3, fontWeight: isActive ? 700 : isDone ? 500 : 400 }}>
                      <div style={{
                        width: 20, height: 20, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 9, flexShrink: 0,
                        background: isDone ? "#e8f5e9" : isActive ? "#fff3e0" : "#f5f5f7",
                        color: isDone ? GREEN : isActive ? COPPER : T3,
                        boxShadow: isActive ? "0 0 0 2px rgba(194, 101, 42, 0.2)" : undefined,
                        animation: isActive ? "pulse 1.5s ease-in-out infinite" : undefined,
                      }}>
                        {isDone ? "✓" : i + 1}
                      </div>
                      {!isMobile && <span>{stageLabels[i]}</span>}
                    </div>
                    {i < 5 && (
                      <div style={{
                        width: 20, height: 2, borderRadius: 1, flexShrink: 0, margin: "0 2px",
                        background: connectorState === "done" ? GREEN : connectorState === "active" ? `linear-gradient(90deg, ${GREEN}, ${COPPER})` : BORDER,
                      }} />
                    )}
                  </React.Fragment>
                );
              })}
            </div>

            {/* Right: progress + ETA */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 80, height: 4, background: "#f0e6d9", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", borderRadius: 2, background: COPPER, transition: "width 0.5s ease" }} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: COPPER, fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
              </div>
              <span style={{ fontSize: 10, color: T2 }}>~2 min remaining</span>
            </div>
          </div>
        );
      })() : null}

      {/* ── Tab Bar ───────────────────────────────────────────────────────────── */}
      <nav style={{
        position: "sticky",
        top: `calc(56px + var(--audit-bar-height, 0px))`,
        zIndex: 80, background: CARD, borderBottom: `1px solid ${BORDER}`,
        display: "flex", padding: isMobile ? "0 8px" : "0 24px",
        overflowX: isMobile ? "auto" : "visible", WebkitOverflowScrolling: "touch",
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            role="tab"
            data-testid={`tab-${tab.id}`}
            onClick={() => navigateTab(tab.id as TabId)}
            style={{
              padding: isMobile ? "10px 10px" : "10px 16px", fontSize: isMobile ? 12 : 13, background: "none", border: "none",
              whiteSpace: "nowrap",
              cursor: "pointer",
              color: safeActiveTab === tab.id ? TEXT : T2,
              fontWeight: 500,
              borderBottom: safeActiveTab === tab.id ? `2px solid ${COPPER}` : "2px solid transparent",
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {switcherOpen ? (
        <div style={{
          position: "fixed", top: 56, left: 24, zIndex: 200,
          background: CARD, border: "1px solid rgba(0,0,0,0.1)", borderRadius: 10,
          minWidth: 320, maxHeight: 400, overflowY: "auto", padding: "6px 0",
          boxShadow: "0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
        }}>
          <input
            placeholder="Search domains..."
            value={switcherSearch}
            onChange={e => setSwitcherSearch(e.target.value)}
            autoFocus
            style={{
              width: "100%", padding: "12px 16px", fontSize: 13, border: "none",
              borderBottom: `1px solid ${BORDER}`, outline: "none", boxSizing: "border-box",
              borderRadius: "12px 12px 0 0",
            }}
          />
          {allTeamDomains
            .filter(d => d.domain.toLowerCase().includes(switcherSearch.toLowerCase()))
            .map(d => {
              const sc = d.geoScorecard?.overallScore;
              // Round 3 TS fix (2026-04-10): read from flattened `pageCount`
              // (see TeamDomainSwitcherEntry in ./types.ts). Was `d.crawlData
              // ?.pages?.length ?? 0` which relied on an `unknown[]` that
              // triggered React 19 + TS 5.9 children inference cascades.
              const pages = d.pageCount;
              return (
                <a
                  key={d.id}
                  href={`/dashboard/domains/${d.id}`}
                  style={{ display: "flex", justifyContent: "space-between", padding: "10px 16px", textDecoration: "none" }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: TEXT }}>{d.domain}</div>
                    <div style={{ fontSize: 11, color: T3 }}>{pages} pages</div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: sc != null ? TEXT : T3 }}>{sc ?? "–"}</div>
                </a>
              );
            })}
        </div>
      ) : null}

      {/* ── Action Rail (left sidebar on desktop, bottom bar on mobile) ──────── */}
      <div
        data-testid="action-rail"
        style={{
          position: "fixed",
          ...(isMobile ? {
            bottom: 0, left: 0, right: 0, top: "auto",
            transform: "none", width: "100%", zIndex: 80,
            display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-around",
            gap: 0, padding: "8px 4px",
            background: CARD, borderRadius: "14px 14px 0 0",
            boxShadow: "0 -4px 20px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.04)",
          } : {
            top: "50%", left: 0,
            transform: "translateY(-50%)", width: 78, zIndex: 80,
            display: "flex", flexDirection: "column", alignItems: "center",
            gap: 4, padding: "12px 6px",
            background: CARD, borderRadius: "0 14px 14px 0",
            boxShadow: "0 4px 20px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.04)",
          }),
        }}
      >
        {isFreeTier ? (
          /* ── Free-tier upsell pill — replaces action buttons (Fix #38) ───── */
          <button
            type="button"
            data-testid="action-rail-upsell"
            onClick={() => setShowUpgradeModal(true)}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              gap: 4, padding: isMobile ? "6px 4px" : "10px 6px",
              background: "transparent", border: "none", cursor: "pointer",
              borderRadius: 10,
              color: COPPER, fontFamily: "inherit",
            }}
          >
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: "rgba(194, 101, 42, 0.08)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={COPPER} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </div>
            <span style={{ fontSize: isMobile ? 8 : 9, fontWeight: 700, textAlign: "center", lineHeight: 1.2 }}>
              Upgrade to Pro
            </span>
            <span style={{ fontSize: 8, color: T2, textAlign: "center", lineHeight: 1.2, display: isMobile ? "none" : "block" }}>
              Unlock actions →
            </span>
          </button>
        ) : (
          <>
        {/* Refresh Score */}
        <div style={{ position: "relative" }}>
          <button
            onClick={handleRefreshScore}
            disabled={retrying}
            title="Refresh Score"
            onMouseEnter={() => setHoveredRail("refresh")}
            onMouseLeave={() => setHoveredRail(null)}
            style={{ background: hoveredRail === "refresh" ? "#f0f0f2" : "none", border: "none", cursor: retrying ? "not-allowed" : "pointer", padding: isMobile ? "6px 2px" : "8px 4px", width: isMobile ? "auto" : 66, textAlign: "center", borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s" }}
          >
            <div style={{ width: 32, height: 32, borderRadius: 8, background: hoveredRail === "refresh" ? "#c8e6c9" : "#e8f5e9", color: GREEN, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", opacity: retrying ? 0.4 : 1, transition: "background 0.15s" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </div>
            <div style={{ fontWeight: 600, color: hoveredRail === "refresh" ? TEXT : T2, marginTop: 4, lineHeight: 1.2, textAlign: "center", letterSpacing: "0.1px", transition: "color 0.15s", display: "block", fontSize: isMobile ? 7 : 9 }}>Refresh Score</div>
            <div style={{ fontSize: 8, fontWeight: 500, background: "rgba(194, 101, 42, 0.08)", color: COPPER, borderRadius: 4, padding: "1px 5px", marginTop: 2, display: isMobile ? "none" : "inline-block", letterSpacing: "0.3px" }}>10cr</div>
          </button>
          {refreshError && (
            <div style={{
              position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
              background: "#1d1d1f", color: "#fff", fontSize: 11, padding: "4px 8px",
              borderRadius: 4, whiteSpace: "nowrap", pointerEvents: "none", zIndex: 10,
            }}>
              {refreshError}
            </div>
          )}
        </div>

        {/* Scan Citations */}
        <button
          onClick={site?.tier === "free" ? undefined : handleScanCitations}
          disabled={site?.tier === "free" || citationScanActive}
          title={site?.tier === "free" ? "Upgrade to Pro to check AI citations" : "Scan Citations"}
          onMouseEnter={() => setHoveredRail("cite")}
          onMouseLeave={() => setHoveredRail(null)}
          style={{ background: hoveredRail === "cite" ? "#f0f0f2" : "none", border: "none", cursor: citationScanActive ? "not-allowed" : "pointer", padding: isMobile ? "6px 2px" : "8px 4px", width: isMobile ? "auto" : 66, textAlign: "center", borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s" }}
        >
          <div style={{ width: 32, height: 32, borderRadius: 8, background: hoveredRail === "cite" ? "#d1c4e9" : "#ede7f6", color: "#5856d6", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", opacity: citationScanActive ? 0.4 : 1, transition: "background 0.15s" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="3" />
              <path d="M18 11a7 7 0 1 0-2.8 5.6" />
              <path d="M14 11v2.5c0 .8.7 1.5 1.5 1.5" />
              <path d="M15.2 16.6 L 22 16.6" />
              <polyline points="19.5 14.3 22 16.6 19.5 18.9" />
            </svg>
          </div>
          <div style={{ fontWeight: 600, color: hoveredRail === "cite" ? TEXT : T2, marginTop: 4, lineHeight: 1.2, textAlign: "center", letterSpacing: "0.1px", transition: "color 0.15s", display: "block", fontSize: isMobile ? 7 : 9 }}>Scan Citations</div>
          <div style={{ fontSize: 8, fontWeight: 500, background: "rgba(194, 101, 42, 0.08)", color: COPPER, borderRadius: 4, padding: "1px 5px", marginTop: 2, display: isMobile ? "none" : "inline-block", letterSpacing: "0.3px" }}>5cr</div>
        </button>

        {/* Map Competitors */}
        <button
          onClick={site?.tier === "free" ? undefined : handleMapCompetitors}
          disabled={site?.tier === "free" || competitorScanActive || slotsRemaining === 0}
          title={site?.tier === "free" ? "Upgrade to Pro to map competitors" : slotsRemaining === 0 ? "Competitor slots full" : "Map Competitors"}
          onMouseEnter={() => setHoveredRail("compete")}
          onMouseLeave={() => setHoveredRail(null)}
          style={{ background: hoveredRail === "compete" ? "#f0f0f2" : "none", border: "none", cursor: (competitorScanActive || slotsRemaining === 0) ? "not-allowed" : "pointer", padding: isMobile ? "6px 2px" : "8px 4px", width: isMobile ? "auto" : 66, textAlign: "center", borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s", opacity: slotsRemaining === 0 ? 0.5 : 1 }}
        >
          <div style={{ width: 32, height: 32, borderRadius: 8, background: hoveredRail === "compete" ? "#ffe0b2" : "#fff3e0", color: "#e65100", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", opacity: competitorScanActive ? 0.4 : 1, transition: "background 0.15s" }}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="8" cy="8" r="3" />
              <path d="M8 2v2 M8 12v2 M2 8h2 M12 8h2" />
            </svg>
          </div>
          <div style={{ fontWeight: 600, color: hoveredRail === "compete" ? TEXT : T2, marginTop: 4, lineHeight: 1.2, textAlign: "center", letterSpacing: "0.1px", transition: "color 0.15s", display: "block", fontSize: isMobile ? 7 : 9 }}>Map Competitors</div>
          <div style={{ display: "flex", gap: 3, justifyContent: "center", marginTop: 2 }}>
            <span style={{ fontSize: 8, fontWeight: 500, background: "rgba(194, 101, 42, 0.08)", color: COPPER, borderRadius: 4, padding: "1px 5px", display: isMobile ? "none" : "inline-block", letterSpacing: "0.3px" }}>5cr</span>
            <span style={{ fontSize: 8, fontWeight: 500, background: "rgba(0,0,0,0.04)", color: T2, borderRadius: 4, padding: "1px 5px", display: isMobile ? "none" : "inline-block" }}>{slotsRemaining}/6</span>
          </div>
        </button>

        {/* Separator */}
        {!isMobile && <div style={{ width: 40, height: 1, background: BORDER }} />}

        {/* Download ZIP */}
        <button
          onClick={handleDownloadZip}
          title={downloadError ?? "Download ZIP"}
          onMouseEnter={() => setHoveredRail("download")}
          onMouseLeave={() => setHoveredRail(null)}
          style={{ background: "none", border: "none", cursor: "pointer", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: isMobile ? 0 : 4, padding: isMobile ? "6px 2px" : "8px 4px", width: isMobile ? "auto" : 66, borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s", ...(hoveredRail === "download" ? { background: "#f0f0f2" } : {}) }}
        >
          <div style={{ width: 32, height: 32, borderRadius: 8, background: hoveredRail === "download" ? "#bbdefb" : "#e3f2fd", color: downloadError ? RED : "#1565c0", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", transition: "background 0.15s" }}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M8 3v9 M5 9l3 3 3-3 M3 16h10" />
            </svg>
          </div>
          <div style={{ fontWeight: 600, color: downloadError ? RED : hoveredRail === "download" ? TEXT : T2, marginTop: 4, lineHeight: 1.2, textAlign: "center", letterSpacing: "0.1px", transition: "color 0.15s", display: "block", fontSize: isMobile ? 7 : 9 }}>{downloadError ?? "Download ZIP"}</div>
          <div style={{ fontSize: 8, fontWeight: 500, background: "rgba(194, 101, 42, 0.08)", color: COPPER, borderRadius: 4, padding: "1px 5px", marginTop: 2, display: isMobile ? "none" : "inline-block", letterSpacing: "0.3px" }}>5cr</div>
        </button>

        {/* Download PDF Report — only if citation check has been run */}
        <button
          disabled={!lc}
          onClick={async () => {
            if (!token || !lc) return;
            setHoveredRail("report-loading");
            try {
              const res = await fetch(`/api/sites/${siteId}/pdf-report?token=${token}`);
              if (!res.ok) {
                const body = await res.text();
                console.error("PDF error:", res.status, body);
                setHoveredRail(null);
                return;
              }
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${site?.domain ?? "report"}-geo-audit-report.pdf`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
              await poll();
            } catch (err) { console.error("PDF fetch error:", err); } finally { setHoveredRail(null); }
          }}
          title={lc ? "Download PDF Report" : "Run citation check first"}
          onMouseEnter={() => hoveredRail !== "report-loading" && setHoveredRail("report")}
          onMouseLeave={() => hoveredRail !== "report-loading" && setHoveredRail(null)}
          style={{ background: hoveredRail === "report" || hoveredRail === "report-loading" ? "#f0f0f2" : "none", border: "none", cursor: !lc ? "not-allowed" : hoveredRail === "report-loading" ? "wait" : "pointer", padding: isMobile ? "6px 2px" : "8px 4px", width: isMobile ? "auto" : 66, textAlign: "center", borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s", opacity: !lc ? 0.35 : 1 }}
        >
          <div style={{ width: 32, height: 32, borderRadius: 8, background: hoveredRail === "report" || hoveredRail === "report-loading" ? "#e8d5f5" : "#f3e8ff", color: "#7c3aed", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto", transition: "background 0.15s", opacity: hoveredRail === "report-loading" ? 0.4 : 1 }}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M6 2h8a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5l3-3z M6 2v3H3" />
            </svg>
          </div>
          <div style={{ fontWeight: 600, color: hoveredRail === "report" || hoveredRail === "report-loading" ? TEXT : T2, marginTop: 4, lineHeight: 1.2, textAlign: "center", letterSpacing: "0.1px", transition: "color 0.15s", display: "block", fontSize: isMobile ? 7 : 9 }}>{hoveredRail === "report-loading" ? "Generating…" : "PDF Report"}</div>
          <div style={{ fontSize: 8, fontWeight: 500, background: "rgba(194, 101, 42, 0.08)", color: COPPER, borderRadius: 4, padding: "1px 5px", marginTop: 2, display: isMobile ? "none" : "inline-block", letterSpacing: "0.3px" }}>5cr</div>
        </button>
          </>
        )}
      </div>

      {/* ── Main content (left-padded for rail) ───────────────────────────────── */}
      <main style={{ maxWidth: 1400, margin: "0 auto", padding: isMobile ? "16px 12px 80px 12px" : "16px 24px 40px 92px" }}>

        {/* Stats row — each segment renders only when it has a real value, so a free
            audit never shows the trust-killing "0 Q&A moments · Last scanned Never"
            (a score next to "0 pages crawled / Never" reads as fabricated). */}
        <div style={{ display: "flex", gap: 16, fontSize: 13, color: T2, padding: "16px 0", flexWrap: "wrap" }}>
          {(() => {
            const qaCount = (lastCitationCheck?.providerResults as Array<{ mentionCount?: number }> | null)
              ?.reduce((sum, r) => sum + (r.mentionCount ?? 0), 0) ?? 0;
            const segs: React.ReactNode[] = [];
            if (pageCount > 0) segs.push(<span key="pages"><b style={{ color: TEXT }}>{pageCount}</b> pages crawled</span>);
            if (qaCount > 0) segs.push(<span key="qa"><b style={{ color: TEXT }}>{qaCount}</b> Q&amp;A moments</span>);
            segs.push(<span key="pillars"><b style={{ color: TEXT }}>{pillars.length}</b> pillars</span>);
            segs.push(<span key="crit"><b style={{ color: criticalCount > 0 ? RED : TEXT }}>{criticalCount}</b> critical issues</span>);
            if (site?.lastCrawlAt) segs.push(<span key="scan">Last scanned <b style={{ color: TEXT }}>{formatDate(site?.lastCrawlAt ?? null)}</b></span>);
            return segs.flatMap((s, i) => (i === 0 ? [s] : [<span key={`d${i}`}>·</span>, s]));
          })()}
          {isActiveStatus(site?.pipelineStatus) && (
            <span style={{ color: COPPER }}>· Scores will update when scan completes</span>
          )}
        </div>

        {/* ── Tab content ─────────────────────────────────────────────────────── */}

        {/* ES-B9 §c.2 — Bulk Crawl Results card. Visible only when
            canRetryBulk(site, isGated) is true. Mirrors the legacy gate +
            handler at ResultsDashboardLegacy.tsx:1763 + line 1015. */}
        {canRetryBulk(
          site as unknown as Parameters<typeof canRetryBulk>[0],
          site?.tier === "free",
        ) && (
          <div
            data-testid="bulk-retry-card"
            role="region"
            aria-label="Bulk crawl results"
            style={{
              background: CARD,
              border: `1px solid ${BORDER}`,
              borderRadius: 8,
              padding: "16px 20px",
              marginBottom: 16,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: TEXT, marginBottom: 2 }}>Bulk Crawl Results</div>
                <div style={{ fontSize: 12, color: T2 }}>
                  {((site as { failedUrls?: string[] | null } | null)?.failedUrls?.length ?? 0)} failed ·
                  {" "}{((site as { creditLimitedUrls?: string[] | null } | null)?.creditLimitedUrls?.length ?? 0)} credit-limited ·
                  {" "}{Math.max(0, (site?.bulkUrlCount ?? 0) - (((site as { failedUrls?: string[] | null } | null)?.failedUrls?.length ?? 0) + (((site as { creditLimitedUrls?: string[] | null } | null)?.creditLimitedUrls?.length ?? 0)))) } succeeded
                </div>
              </div>
              <button
                onClick={() => handleRetryFailed()}
                disabled={retryingFailed}
                style={{
                  background: retryingFailed ? T3 : COPPER,
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  padding: "8px 14px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: retryingFailed ? "not-allowed" : "pointer",
                }}
              >
                {retryingFailed ? "Starting retry…" : "Retry failed URLs"}
              </button>
            </div>
            {bulkRetryResult && (
              <div style={{ fontSize: 12, color: GREEN, fontWeight: 500 }}>
                Retry started — new audit ID: {bulkRetryResult.siteId} ({bulkRetryResult.urlCount} URLs queued).
              </div>
            )}
            {bulkRetryError && (
              <div
                role="alert"
                style={{
                  fontSize: 12,
                  color: RED,
                  fontWeight: 500,
                  // B10.0.3: standards-compliant CSS for wrap-on-word, opportunistic
                  // mid-word break only for long URLs. Replaces deprecated
                  // wordBreak: "break-word" (ES-B9.1 AC-B9.1-5) which modern
                  // browsers treated as break-all -> vertical stacking in narrow
                  // parent containers.
                  maxWidth: "min(80vw, 480px)",
                  wordBreak: "normal",
                  overflowWrap: "anywhere",
                  whiteSpace: "normal",
                }}
              >
                {bulkRetryError}
              </div>
            )}
          </div>
        )}

        {/* Overview */}
        {safeActiveTab === "overview" && (
          <div>
            {/* Citation scan loading banner */}
            {citationScanActive && (
              <div style={{ background: "linear-gradient(135deg, #fffbf5, #fff7ed)", border: "1px solid #f0e6d9", borderRadius: 8, padding: "10px 18px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: COPPER, animation: "pulse 1.5s ease-in-out infinite", flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: COPPER }}>Running citation scan…</span>
                <span style={{ fontSize: 11, color: T2 }}>This may take a minute. Results will appear when complete.</span>
              </div>
            )}

            {/* Free-tier conversion CTA — surfaced on the landing tab so the upgrade
                ask isn't buried on the last (Setup) tab. Tight, result-anchored, copper. */}
            {isFreeTier && (
              <div
                data-testid="overview-convert-cta"
                style={{
                  background: "linear-gradient(135deg, #fff7ed, #ffedd5)",
                  border: "1px solid rgba(194,101,42,0.28)",
                  borderRadius: 12,
                  padding: isMobile ? "14px 16px" : "16px 22px",
                  marginBottom: 16,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 14,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 200, flex: 1 }}>
                  <div style={{ fontSize: isMobile ? 15 : 17, fontWeight: 700, color: "#1d1d1f", lineHeight: 1.3 }}>
                    {liveScore != null
                      ? `AI can't reliably recommend ${site?.domain ?? "your site"} — you're invisible for ${Math.max(0, 100 - liveScore)} of 100 points.`
                      : `AI can't reliably recommend ${site?.domain ?? "your site"} yet.`}
                  </div>
                  <div style={{ fontSize: 13, color: "#6b6b70", marginTop: 4, lineHeight: 1.5 }}>
                    Those are buyers asking ChatGPT &amp; Perplexity and hearing a competitor&apos;s name instead of yours. FlowBlinq deploys your llms.txt, schema &amp; business.json so AI starts citing you — and re-checks every cycle so you stay cited.
                  </div>
                  <div style={{ fontSize: 12, marginTop: 7, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ color: "#c2652a", display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="#c2652a" aria-hidden><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>
                      A local business went from invisible to AI-recommended in 24h
                    </span>
                    <span style={{ color: "#86868b", fontWeight: 500 }}>· from $99/mo · cancel anytime</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowUpgradeModal(true)}
                  data-testid="overview-upgrade-cta"
                  style={{
                    background: "#c2652a",
                    color: "#fff",
                    fontFamily: "inherit",
                    fontSize: 14,
                    fontWeight: 600,
                    padding: "11px 22px",
                    borderRadius: 8,
                    border: "none",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  Get cited by AI →
                </button>
              </div>
            )}

            {/* KPI cards — 4 cards: [AI Visibility + Citation Rate (wider)] [GEO Score] [Competitive SOV] [Citation Quality] */}
            {(() => {
              const sovEntries = [
                ...(ourSOV !== null ? [ourSOV] : []),
                ...competitorData.map(c => c.shareOfVoice),
              ].sort((a, b) => b - a);
              const sovRank = ourSOV !== null ? sovEntries.indexOf(ourSOV) + 1 : null;
              const topComp = competitorData[0] ?? null;
              const cardShadow = "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)";
              return (
                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2,1fr)" : "2fr 1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
                  {/* AI Visibility + Citation Rate — combined featured card */}
                  <div style={{ background: CARD, borderRadius: 12, padding: "16px 18px", boxShadow: cardShadow, border: `1px solid ${BORDER}`, cursor: "pointer" }} {...clickableCardProps(() => navigateTab("competitive"))}>
                    <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>AI Visibility</span>
                      <InfoTooltip text="% of AI-generated responses that mention your brand across organic (non-branded) queries" />
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-1px", lineHeight: 1.1, color: lc?.indirectVisibility != null ? scoreColor(lc.indirectVisibility) : T2 }}>
                      {lc?.indirectVisibility != null
                        ? `${lc.indirectVisibility}%`
                        : isFreeTier
                        ? <LockedMetric sample="62%" caption="See where AI mentions you" onUpgrade={() => setShowUpgradeModal(true)} />
                        : "—"}
                    </div>
                    <div style={{ height: 1, background: BORDER, margin: "12px 0 10px" }} />
                    <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Citation Rate</span>
                      <InfoTooltip text="How often AI platforms cite your brand when asked relevant questions" />
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px", lineHeight: 1.1, color: citationRate !== null ? scoreColor(citationRate) : T2, marginBottom: citationRate !== null ? 6 : 0 }}>
                      {citationRate !== null
                        ? `${citationRate}%`
                        : isFreeTier
                        ? <LockedMetric sample="48%" onUpgrade={() => setShowUpgradeModal(true)} big={false} />
                        : "—"}
                    </div>
                    {providerAggregates.length > 0 && (
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {providerAggregates.map(p => {
                          const pillStyle = p.visibilityScore < 30 ? { background: "#fef2f2", color: RED }
                            : p.visibilityScore < 70 ? { background: "#fff8e1", color: "#e65100" }
                            : { background: "#e8f5e9", color: "#2e7d32" };
                          return (
                            <span key={p.name} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, fontWeight: 600, ...pillStyle }}>
                              {p.name} {p.mentionCount}/{p.totalQueries}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {/* GEO Audit Score */}
                  <div style={{ background: CARD, borderRadius: 12, padding: "16px 18px", boxShadow: cardShadow, border: `1px solid ${BORDER}`, cursor: "pointer" }} {...clickableCardProps(() => { navigateTab("action-plan"); setActionPlanView("scorecard"); })}>
                    <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>GEO Score</span>
                      <InfoTooltip text="Generative Engine Optimization score — how well your site is structured for AI retrieval (0–100)" />
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-1px", lineHeight: 1.1, color: liveScore !== null ? scoreColor(liveScore) : T2 }}>
                      {liveScore !== null ? <>{liveScore}<span style={{ fontSize: 18, color: T3 }}>/100</span></> : "—"}
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: `linear-gradient(to right,${RED} 0%,${RED} 30%,${ORANGE} 30%,${ORANGE} 50%,#e6b800 50%,#e6b800 70%,${GREEN} 70%)`, marginTop: 8, position: "relative" }}>
                      {liveScore !== null && <div style={{ position: "absolute", top: -3, left: `${liveScore}%`, width: 10, height: 10, background: TEXT, borderRadius: "50%", border: "2px solid #fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transform: "translateX(-50%)", zIndex: 2 }} />}
                      {/* Projected-score marker — the upside Pro unlocks */}
                      {isFreeTier && estAfterFixes !== null && liveScore !== null && estAfterFixes > liveScore && <div style={{ position: "absolute", top: -3, left: `${Math.min(100, estAfterFixes)}%`, width: 10, height: 10, background: GREEN, borderRadius: "50%", border: "2px solid #fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transform: "translateX(-50%)", zIndex: 2 }} />}
                    </div>
                    {isFreeTier && estAfterFixes !== null && liveScore !== null && estAfterFixes > liveScore ? (
                      /* The payoff (current → projected) is the whole reason to upgrade —
                         surface it as a prominent, clickable driver, not tiny gray text. */
                      <button type="button" onClick={(e) => { e.stopPropagation(); setShowUpgradeModal(true); }} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, marginTop: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: GREEN }}>↑ {estAfterFixes}/100 with Pro</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#166534", background: "#dcfce7", borderRadius: 5, padding: "2px 7px" }}>+{estAfterFixes - liveScore} pts</span>
                      </button>
                    ) : (
                      estAfterFixes !== null && <div style={{ fontSize: 12, color: T2, marginTop: 4 }}>Est. after fixes: {estAfterFixes}</div>
                    )}
                  </div>
                  {/* Competitive SOV */}
                  <div style={{ background: CARD, borderRadius: 12, padding: "16px 18px", boxShadow: cardShadow, border: `1px solid ${BORDER}`, cursor: "pointer" }} {...clickableCardProps(() => navigateTab("competitive"))}>
                    <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Competitive SOV</span>
                      <InfoTooltip text="Share of Voice — your brand's mentions as a % of all brand mentions across AI responses" />
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-1px", lineHeight: 1.1, color: ourSOV !== null ? scoreColor(ourSOV) : T2 }}>
                      {ourSOV !== null
                        ? `${ourSOV}%`
                        : isFreeTier
                        ? <LockedMetric sample="31%" caption="Your share vs competitors" onUpgrade={() => setShowUpgradeModal(true)} />
                        : "—"}
                    </div>
                    {sovRank === 1 && topComp
                      ? <div style={{ fontSize: 12, color: GREEN, marginTop: 4 }}>You lead · {topComp.name} at {topComp.shareOfVoice}%</div>
                      : sovRank !== null && topComp
                      ? <div style={{ fontSize: 12, color: ORANGE, marginTop: 4 }}>#{sovRank} · {topComp.name} leads at {topComp.shareOfVoice}%</div>
                      : null}
                  </div>
                  {/* Citation Quality */}
                  <div style={{ background: CARD, borderRadius: 12, padding: "16px 18px", boxShadow: cardShadow, border: `1px solid ${BORDER}`, cursor: "pointer" }} {...clickableCardProps(() => navigateTab("competitive"))}>
                    <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Citation Quality</span>
                      <InfoTooltip text="When AI does cite you, how accurate and prominent those citations are" />
                    </div>
                    <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-1px", lineHeight: 1.1, color: lc?.citationQualityScore != null ? scoreColor(lc.citationQualityScore) : T2 }}>
                      {lc?.citationQualityScore != null
                        ? `${lc.citationQualityScore}%`
                        : isFreeTier
                        ? <LockedMetric sample="74%" caption="How accurately AI cites you" onUpgrade={() => setShowUpgradeModal(true)} />
                        : "—"}
                    </div>
                    {lc?.citationQualityScore != null && (
                      <div style={{ fontSize: 12, color: T2, marginTop: 4 }}>
                        {lc.citationQualityScore >= 70 ? "When cited, quality is high" : "Quality needs improvement"}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* At a Glance — summary cards linking to Action Plan + Competitive tabs */}
            {(() => {
              const worstPillar = [...pillars].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0] ?? null;
              const topRec = recs[0] ?? null;
              const weakestThemeEntry = Object.entries(pillarVisibility).sort((a, b) => a[1] - b[1])[0] ?? null;
              const effortMap: Record<string, string> = { low: "30 min", medium: "1–2 hrs", high: "half day" };
              const cardBase: React.CSSProperties = {
                background: CARD, borderRadius: 12, padding: "14px 16px",
                boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)",
                border: `1px solid ${BORDER}`, cursor: "pointer", display: "flex", flexDirection: "column", gap: 6,
              };
              if (!worstPillar && !topRec && !weakestThemeEntry) return null;
              return (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: T3 }}>At a Glance</span>
                    <InfoTooltip text="Highlights from your Action Plan and Competitive tabs. Click any card to go deeper." />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr", gap: 10 }}>
                    {worstPillar && (
                      <div style={cardBase} {...clickableCardProps(() => { navigateTab("action-plan"); setActionPlanView("scorecard"); })}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: scoreColor(worstPillar.score ?? 0), flexShrink: 0 }} />
                          <span style={{ fontSize: 10, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Top Issue</span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: TEXT, lineHeight: 1.3 }}>{worstPillar.pillarName}</div>
                        <div style={{ fontSize: 12, color: scoreColor(worstPillar.score ?? 0), fontWeight: 600 }}>Score: {worstPillar.score ?? "—"}</div>
                        {/* Attach a business consequence (urgency lever) — a neutral
                            "Score: 33" doesn't make a buyer feel the cost of inaction. */}
                        {isFreeTier && (
                          <div style={{ fontSize: 11, color: T2, lineHeight: 1.4, marginTop: 2 }}>
                            This is where AI overlooks you — competitors who fix it get cited first.
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: COPPER, marginTop: 2 }}>See full scorecard →</div>
                      </div>
                    )}
                    {topRec && (
                      <div style={cardBase} {...clickableCardProps(() => { navigateTab("action-plan"); setActionPlanView("recommendations"); })}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: COPPER, flexShrink: 0 }} />
                          <span style={{ fontSize: 10, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Top Fix</span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: TEXT, lineHeight: 1.3 }}>{topRec.title}</div>
                        {topRec.effort && <div style={{ fontSize: 11, color: T2 }}>{effortMap[topRec.effort] ?? topRec.effort}</div>}
                        <div style={{ fontSize: 11, color: COPPER, marginTop: 2 }}>All recommendations →</div>
                      </div>
                    )}
                    {weakestThemeEntry && (
                      <div style={cardBase} {...clickableCardProps(() => navigateTab("competitive"))}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: RED, flexShrink: 0 }} />
                          <span style={{ fontSize: 10, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Weakest Theme</span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: TEXT, lineHeight: 1.3 }}>{pillarDisplayName(weakestThemeEntry[0])}</div>
                        <div style={{ fontSize: 12, color: RED, fontWeight: 600 }}>{weakestThemeEntry[1]}% visibility</div>
                        <div style={{ fontSize: 11, color: COPPER, marginTop: 2 }}>Full competitive analysis →</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Customer proof on the Overview (decision screen), not just buried on
                the Setup tab (founder directive 2026-06-10). Free tier only. */}
            {isFreeTier && (
              <div style={{ marginBottom: 16 }}>
                <CustomerProofCards testIds={false} />
              </div>
            )}

            {/* SOV + Citation Visibility — side by side. Hidden for free tier:
                free audits don't run citation scans, so these render as empty
                "run a scan" placeholders. The locked metric cards above already
                showcase this value — fewer blank sections = tighter convert page. */}
            {!isFreeTier && (
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12, marginBottom: 12 }}>
              {/* Share of Voice */}
              <div style={{ background: CARD, borderRadius: 12, padding: "16px 18px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}` }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Share of Voice</span>
                  <InfoTooltip text="SOV = Share of Voice. How often each brand is mentioned across AI responses. Higher = more AI visibility." />
                </div>
                {(() => {
                  const allSOV = [...(ourSOV !== null ? [ourSOV] : []), ...competitorData.slice(0, 5).map(c => c.shareOfVoice)];
                  const sorted = [...new Set(allSOV)].sort((a, b) => b - a);
                  const sovColor = (v: number) => {
                    if (sorted.length <= 1) return GREEN;
                    const rank = sorted.indexOf(v);
                    if (rank === 0) return GREEN;
                    if (rank === sorted.length - 1) return RED;
                    return ORANGE;
                  };
                  return <>
                    {ourSOV !== null && (
                      <div style={{ display: "flex", alignItems: "center", marginBottom: 5, gap: 6 }}>
                        <span style={{ fontSize: 11, width: 90, textAlign: "right", flexShrink: 0, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{site?.domain ?? "You"}</span>
                        <div style={{ flex: 1, height: 14, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ width: `${ourSOV}%`, height: "100%", borderRadius: 3, background: sovColor(ourSOV) }} />
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 700, width: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{ourSOV}%</span>
                      </div>
                    )}
                    {competitorData.slice(0, 5).map((c, i) => (
                      <div key={c.domain ?? `${c.name}-${i}`} style={{ display: "flex", alignItems: "center", marginBottom: 5, gap: 6 }}>
                        <span style={{ fontSize: 11, width: 90, textAlign: "right", flexShrink: 0, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                        <div style={{ flex: 1, height: 14, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ width: `${c.shareOfVoice}%`, height: "100%", borderRadius: 3, background: sovColor(c.shareOfVoice) }} />
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 600, width: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{c.shareOfVoice}%</span>
                      </div>
                    ))}
                    {competitorData.length === 0 && ourSOV === null && (
                      <div style={{ fontSize: 12, color: T2 }}>Run a citation scan to see share of voice.</div>
                    )}
                    <div style={{ fontSize: 11, color: COPPER, marginTop: 8, cursor: "pointer" }} onClick={() => navigateTab("competitive")}>Full citation analysis →</div>
                  </>;
                })()}
              </div>

              {/* Citation Visibility by Theme */}
              <div style={{ background: CARD, borderRadius: 12, padding: "16px 18px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}` }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Citation Visibility by Theme</span>
                  <InfoTooltip text="How often AI cites you per topic area. Lower % = a gap where competitors may outrank you." />
                </div>
                {Object.keys(pillarVisibility).length > 0 ? (
                  <>
                    {Object.entries(pillarVisibility).sort((a, b) => a[1] - b[1]).slice(0, 6).map(([theme, pct]) => {
                      const barColor = pct < 30 ? RED : pct < 50 ? ORANGE : pct < 70 ? "#e6b800" : GREEN;
                      return (
                        <div key={theme} style={{ display: "flex", alignItems: "center", marginBottom: 5, gap: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 500, width: 90, textAlign: "right", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pillarDisplayName(theme)}</span>
                          <div style={{ flex: 1, height: 14, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                            <div style={{ width: `${pct}%`, height: "100%", borderRadius: 3, background: barColor, transition: "width .4s" }} />
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 600, width: 36, textAlign: "right", flexShrink: 0, color: barColor }}>{pct}%</span>
                        </div>
                      );
                    })}
                    <div style={{ fontSize: 11, color: COPPER, marginTop: 8, cursor: "pointer" }} onClick={() => navigateTab("competitive")}>Full citation analysis →</div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: T2 }}>Run a citation scan to see visibility by theme.</div>
                )}
              </div>
            </div>
            )}

            {/* Performance Snapshot — Geo + Category + Buyer Intent */}
            {(geoVisibility.length > 0 || categoryVisibility.filter(c => c.categoryId !== "unknown").length > 0 || tierVisibility.length > 0) && (
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                {/* Geographic Performance */}
                <div style={{ background: CARD, borderRadius: 12, padding: "16px 18px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}`, cursor: "pointer" }} onClick={() => navigateTab("competitive")}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Geographic Performance</span>
                    <InfoTooltip text="How often AI mentions your brand in queries tied to specific locations or regions. Low % = AI doesn't associate you with a geography." />
                  </div>
                  {geoVisibility.length > 0 ? geoVisibility.slice(0, 4).map(g => (
                    <div key={g.geoId} style={{ display: "flex", alignItems: "center", marginBottom: 5, gap: 6 }}>
                      <span style={{ fontSize: 11, width: 70, textAlign: "right", flexShrink: 0, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.geoName}</span>
                      <div style={{ flex: 1, height: 12, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${g.visibility}%`, height: "100%", borderRadius: 3, background: "#007aff", opacity: 0.75 }} />
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, width: 32, textAlign: "right" }}>{g.visibility}%</span>
                    </div>
                  )) : (
                    <div style={{ fontSize: 12, color: T2 }}>No location signals detected.</div>
                  )}
                </div>

                {/* Category Performance */}
                <div style={{ background: CARD, borderRadius: 12, padding: "16px 18px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}`, cursor: "pointer" }} onClick={() => navigateTab("competitive")}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Category Performance</span>
                    <InfoTooltip text="Which product or service categories AI associates with your brand, and how strongly. Low % = AI doesn't recognize you in that category." />
                  </div>
                  {(() => {
                    const cats = categoryVisibility.filter(c => c.categoryId !== "unknown" && c.categoryName !== "unknown");
                    return cats.length > 0 ? cats.slice(0, 4).map(c => (
                      <div key={c.categoryId} style={{ display: "flex", alignItems: "center", marginBottom: 5, gap: 6 }}>
                        <span style={{ fontSize: 11, width: 70, textAlign: "right", flexShrink: 0, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.categoryName}</span>
                        <div style={{ flex: 1, height: 12, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ width: `${c.visibility}%`, height: "100%", borderRadius: 3, background: ORANGE }} />
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 600, width: 32, textAlign: "right" }}>{c.visibility}%</span>
                      </div>
                    )) : <div style={{ fontSize: 12, color: T2 }}>No category association detected.</div>;
                  })()}
                </div>

                {/* Buyer Intent Coverage */}
                <div style={{ background: CARD, borderRadius: 12, padding: "16px 18px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}`, cursor: "pointer" }} onClick={() => navigateTab("competitive")}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Buyer Intent Coverage</span>
                    <InfoTooltip text="AI queries are split into 3 intent stages — Learn (what is X / how does X work), Solve (X vs Y / best X for Y), Buy (buy X / X price / X near me). % = how often AI mentions you for each stage." />
                  </div>
                  {tierVisibility.length > 0 ? (
                    <div style={{ display: "grid", gridTemplateColumns: `repeat(${tierVisibility.length}, 1fr)`, gap: 8 }}>
                      {tierVisibility.map(t => (
                        <div key={t.tier} style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 10, color: T2, fontWeight: 500, marginBottom: 2 }}>{t.tier.charAt(0).toUpperCase() + t.tier.slice(1)}</div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: scoreColor(t.visibility) }}>{t.visibility}%</div>
                          <div style={{ fontSize: 10, color: T3 }}>{t.mentionCount}/{t.promptCount}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: T2 }}>No intent data yet.</div>
                  )}
                </div>
              </div>
            )}

            {/* FUTURE: Competitor management widget (add/remove competitors, slot counter, scan state) was removed from overview.
                Belongs in a dedicated settings panel or the Competitive tab header.
                Search handleAddCompetitor in git history (branch ux-expert-review) for full implementation. */}

            {/* Score History — SVG line chart */}
            {(() => {
              const entries = changeLog.slice(0, 12);
              const hasHistory = entries.length > 1;
              // Free tier with no history yet renders an empty single-point chart —
              // hide it so the convert page isn't padded with blank sections.
              if (isFreeTier && !hasHistory) return null;
              const W = 400; const H = 80;
              const PAD_L = 24; const PAD_R = 16; const PAD_T = 12; const PAD_B = 22;
              const chartW = W - PAD_L - PAD_R;
              const chartH = H - PAD_T - PAD_B;
              const toX = (i: number, n: number) => PAD_L + (n <= 1 ? chartW / 2 : (i / (n - 1)) * chartW);
              const toY = (score: number) => PAD_T + chartH - (Math.min(100, Math.max(0, score)) / 100) * chartH;
              const pts = hasHistory
                ? entries.map((e, i) => `${toX(i, entries.length)},${toY(e.overallScore)}`).join(" ")
                : liveScore !== null ? `${toX(0, 1)},${toY(liveScore)}` : null;
              const areaPath = hasHistory && pts
                ? `M ${toX(0, entries.length)},${PAD_T + chartH} L ${pts.split(" ").map((p, i) => i === 0 ? `${p}` : p).join(" L ")} L ${toX(entries.length - 1, entries.length)},${PAD_T + chartH} Z`
                : null;
              const showLabels = (i: number, n: number) => n <= 4 || i === 0 || i === n - 1;
              return (
                <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px 18px", marginBottom: 16, boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)" }}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Score History</span>
                    <InfoTooltip text="Each point is a full audit run. Trend shows whether your GEO health is improving over time." />
                    {!hasHistory && <span style={{ fontSize: 11, color: T2, marginLeft: "auto", fontStyle: "italic" }}>Run additional scans to track progress</span>}
                  </div>
                  <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", overflow: "visible" }}>
                    {/* Y-axis grid lines */}
                    {[25, 50, 75].map(v => (
                      <line key={v} x1={PAD_L} y1={toY(v)} x2={W - PAD_R} y2={toY(v)} stroke={BORDER} strokeWidth="1" />
                    ))}
                    {/* Area fill */}
                    {areaPath && <path d={areaPath} fill={COPPER} fillOpacity="0.08" />}
                    {/* Line */}
                    {pts && hasHistory && <polyline points={pts} fill="none" stroke={COPPER} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
                    {/* Dots + labels */}
                    {hasHistory ? entries.map((e, i) => {
                      const x = toX(i, entries.length);
                      const y = toY(e.overallScore);
                      return (
                        <g key={e.runAt}>
                          <circle cx={x} cy={y} r={4} fill={COPPER} stroke="#fff" strokeWidth="2" />
                          {showLabels(i, entries.length) && (
                            <text x={x} y={y - 8} textAnchor="middle" fontSize="9" fill={TEXT} fontWeight="700">{e.overallScore}</text>
                          )}
                          {!isMobile && showLabels(i, entries.length) && (
                            <text x={x} y={H - 4} textAnchor="middle" fontSize="8" fill={T2}>{new Date(e.runAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</text>
                          )}
                        </g>
                      );
                    }) : liveScore !== null ? (
                      <g>
                        <circle cx={toX(0, 1)} cy={toY(liveScore)} r={4} fill={COPPER} stroke="#fff" strokeWidth="2" />
                        <text x={toX(0, 1)} y={toY(liveScore) - 8} textAnchor="middle" fontSize="9" fill={TEXT} fontWeight="700">{liveScore}</text>
                        <text x={toX(0, 1)} y={H - 4} textAnchor="middle" fontSize="8" fill={T2}>Now</text>
                      </g>
                    ) : null}
                  </svg>
                </div>
              );
            })()}

            {/* Full per-page fix report — bottom of overview */}
            {allPages.length > 0 && (
              <button
                onClick={handleDownloadZip}
                style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", marginBottom: 16,
                  background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8,
                  boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)",
                  cursor: "pointer", width: "100%", fontFamily: "inherit", textAlign: "left",
                }}
              >
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "#e3f2fd", color: "#1565c0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Full per-page fix report available</div>
                  <div style={{ fontSize: 11, color: T2 }}>{allPages.length} pages · {allPages.reduce((s, p) => s + (p.vulnerabilities?.length ?? 0), 0)} vulnerabilities</div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: COPPER, flexShrink: 0 }}>Download ZIP ↓</span>
              </button>
            )}

          </div>
        )}

        {/* Scorecard */}
        {/* Action Plan sub-nav — must appear BEFORE sub-view content blocks */}
        {safeActiveTab === "action-plan" && (
          <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
            {(["scorecard", "recommendations", "pages"] as const).map(v => {
              const labels = { scorecard: "Scorecard", recommendations: "Recommendations", pages: "Pages" };
              return (
                <button
                  key={v}
                  onClick={() => setActionPlanView(v)}
                  style={{
                    fontSize: 13, padding: "6px 16px", borderRadius: 8,
                    border: `1px solid ${actionPlanView === v ? COPPER : BORDER}`,
                    background: actionPlanView === v ? COPPER : CARD,
                    color: actionPlanView === v ? "#fff" : TEXT,
                    cursor: "pointer", fontWeight: 600,
                  }}
                >
                  {labels[v]}
                </button>
              );
            })}
          </div>
        )}

        {safeActiveTab === "action-plan" && actionPlanView === "scorecard" && (
          <div data-testid="scorecard-tab">
            {/* GEO Score Breakdown — unified pillars section (merged Critical Issues + All Pillars) */}
            {(() => {
              const sortedPillars = [...pillars].sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
              const applyFilter = (list: typeof sortedPillars) => list.filter(p => {
                if (tierFilter === "All") return true;
                return scoreTier(p.score ?? 0) === tierFilter;
              });
              const displayed = applyFilter(sortedPillars);
              const SHOW_DEFAULT = 10;
              const visible = showAllPillars ? displayed : displayed.slice(0, SHOW_DEFAULT);
              const remaining = displayed.length - SHOW_DEFAULT;
              return (
                <div style={{ background: CARD, borderRadius: 12, padding: "18px 20px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}`, marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>
                        GEO Score Breakdown — {pillars.length} Pillars
                      </span>
                      <InfoTooltip text="Each pillar is a scored dimension of your GEO health. Scores feed into the overall GEO Audit Score." />
                    </div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {(["All", "Poor", "Weak", "Fair", "Good"] as const).filter(t =>
                        t === "All" || tierCounts[t as keyof typeof tierCounts] > 0
                      ).map(t => (
                        <button
                          key={t}
                          onClick={() => { setTierFilter(t); setShowAllPillars(false); }}
                          style={{
                            fontSize: 11, padding: "3px 10px", borderRadius: 6,
                            border: `1px solid ${tierFilter === t ? COPPER : BORDER}`,
                            background: tierFilter === t ? COPPER : CARD,
                            color: tierFilter === t ? "#fff" : TEXT,
                            cursor: "pointer", fontWeight: 500,
                          }}
                        >
                          {t !== "All" ? `${t} (${tierCounts[t as keyof typeof tierCounts]})` : "All"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Column headers */}
                  {visible.length > 0 && (
                    <div style={{ display: "flex", alignItems: "center", padding: "0 14px 8px 14px", gap: 10, borderBottom: `1px solid ${BORDER}`, marginBottom: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: T3, textTransform: "uppercase", letterSpacing: ".5px", width: isMobile ? 90 : 150, flexShrink: 0 }}>Pillar</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: T3, textTransform: "uppercase", letterSpacing: ".5px", flex: 1, minWidth: 40 }}>Grade</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: T3, textTransform: "uppercase", letterSpacing: ".5px", width: 28, textAlign: "right", flexShrink: 0 }}>Score</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: T3, textTransform: "uppercase", letterSpacing: ".5px", width: 48, flexShrink: 0 }}>Tier</span>
                      {!isMobile && <span style={{ fontSize: 10, fontWeight: 600, color: T3, textTransform: "uppercase", letterSpacing: ".5px", flex: 2 }}>Finding</span>}
                      <span style={{ width: 16, flexShrink: 0 }} />
                    </div>
                  )}
                  {visible.length > 0 ? visible.map(p => {
                    const tier = scoreTier(p.score ?? 0);
                    const badgeStyle = tier === "Poor" ? { background: "#fef2f2", color: RED }
                      : tier === "Weak" ? { background: "#fff8e1", color: "#e65100" }
                      : tier === "Fair" ? { background: "#e8f5e9", color: "#2e7d32" }
                      : null;
                    const s = p.score ?? 0;
                    const barBg = s < 35 ? RED : s < 55 ? ORANGE : GREEN;
                    const sClr = s < 35 ? RED : s < 55 ? ORANGE : GREEN;
                    const isOpen = expandedPillars.has(p.pillar);
                    const linkedRec = recs.find(r => r.pillar === p.pillar);
                    const findingSnippet = p.findings ? (p.findings.length > 80 ? p.findings.slice(0, 80) + "…" : p.findings) : "";
                    return (
                      <div key={p.pillar} style={{ border: `1px solid ${isOpen ? "rgba(194, 101, 42, 0.35)" : BORDER}`, borderRadius: 8, marginBottom: 6, transition: "all .2s", boxShadow: isOpen ? "0 0 0 1px rgba(194, 101, 42, 0.15), 0 4px 16px rgba(194, 101, 42, 0.12)" : "none" }}>
                        <div
                          style={{ display: "flex", alignItems: "center", padding: "10px 14px", gap: 10, cursor: "pointer" }}
                          onClick={() => {
                            const next = new Set(expandedPillars);
                            if (next.has(p.pillar)) next.delete(p.pillar); else next.add(p.pillar);
                            setExpandedPillars(next);
                          }}
                        >
                          <span style={{ fontSize: 13, fontWeight: 600, width: isMobile ? 90 : 150, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.pillarName}</span>
                          {pillarTooltip(p.pillar) && <InfoTooltip text={pillarTooltip(p.pillar)!} />}
                          <div style={{ flex: 1, height: 7, background: "#f0f0f2", borderRadius: 4, overflow: "hidden", minWidth: 40 }}>
                            <div style={{ width: `${s}%`, height: "100%", borderRadius: 4, background: barBg }} />
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 700, width: 28, textAlign: "right", flexShrink: 0, color: sClr, fontVariantNumeric: "tabular-nums" }}>{s}</span>
                          {badgeStyle
                            ? <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, width: 48, textAlign: "center", flexShrink: 0, ...badgeStyle }}>{tier}</span>
                            : <span style={{ width: 48, flexShrink: 0 }} />}
                          {!isMobile && <span style={{ fontSize: 11, color: T2, flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{findingSnippet}</span>}
                          <span style={{ fontSize: 11, color: T3, flexShrink: 0 }}>{isOpen ? "↑" : "↓"}</span>
                        </div>
                        {isOpen && (
                          <div style={{ padding: "0 14px 14px 14px", borderTop: `1px solid ${BORDER}` }}>
                            {/* Free tier: findings/recommendation/action are gated server-side,
                                so this row would expand to an empty box — sell the unlock
                                instead, specific to this pillar + its score. */}
                            {isFreeTier && !p.findings && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setShowUpgradeModal(true); }}
                                style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", boxSizing: "border-box", marginTop: 10, background: "#fff7ed", border: "1px dashed rgba(194,101,42,0.45)", borderRadius: 8, padding: "12px 14px" }}
                              >
                                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#c2652a", display: "flex", alignItems: "center", gap: 6 }}>
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#c2652a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                                  See what&rsquo;s hurting {p.pillarName} — and have it fixed
                                </div>
                                <div style={{ fontSize: 11.5, color: "#6b6b70", marginTop: 4, lineHeight: 1.5 }}>
                                  Pro pinpoints the exact issues dragging this to {p.score ?? "—"}/100, deploys the fix for you, and re-checks it every cycle. Get cited by AI &rarr;
                                </div>
                              </button>
                            )}
                            {p.findings && (
                              <div style={{ marginTop: 10 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 4 }}>Finding</div>
                                <div style={{ fontSize: 13, color: TEXT, lineHeight: 1.6 }}>{p.findings}</div>
                              </div>
                            )}
                            {p.recommendation && (
                              <div style={{ marginTop: 10 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 4 }}>Recommendation</div>
                                <div style={{ fontSize: 13, color: TEXT, lineHeight: 1.6 }}>{p.recommendation}</div>
                              </div>
                            )}
                            {linkedRec?.specificAction && (
                              <div style={{ background: COPPER, borderRadius: 8, padding: "10px 14px", marginTop: 10, fontSize: 12, lineHeight: 1.5, color: "#fff" }}>
                                <strong>Action:</strong> {linkedRec.specificAction}
                              </div>
                            )}
                            {p.impactedPages && p.impactedPages.length > 0 && (
                              <div style={{ marginTop: 10 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 4 }}>Impacted Pages ({p.impactedPages.length})</div>
                                <div style={{ fontSize: 12, color: T2, lineHeight: 1.8 }}>
                                  {p.impactedPages.slice(0, 5).map(url => (
                                    <div key={url} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</div>
                                  ))}
                                  {p.impactedPages.length > 5 && <div style={{ color: T3 }}>+ {p.impactedPages.length - 5} more</div>}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  }) : <div style={{ fontSize: 13, color: T2, padding: "16px 0" }}>No pillars match this filter.</div>}
                  {!showAllPillars && remaining > 0 && (
                    <button
                      onClick={() => setShowAllPillars(true)}
                      style={{ marginTop: 8, fontSize: 12, color: COPPER, background: "none", border: `1px solid ${COPPER}`, borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontWeight: 600 }}
                    >
                      See {remaining} more ↓
                    </button>
                  )}
                </div>
              );
            })()}

            {/* 3-col grid: Geo + Category + Buyer Intent. Hidden for free tier —
                these need a citation scan free audits don't run, so they render as
                empty "run a scan" cards (conversion audit: fewer blank sections). */}
            {!isFreeTier && (
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 12, marginBottom: 12, alignItems: "start" }}>
              <div style={{ background: CARD, borderRadius: 12, padding: "18px 20px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}` }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Geographic Performance</span>
                  <InfoTooltip text="How often AI mentions your brand in queries tied to specific locations or regions. Low % = AI doesn't associate you with a geography." />
                </div>
                {geoVisibility.length > 0 ? geoVisibility.slice(0, 5).map(g => (
                  <div key={g.geoId} style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8 }}>
                    <span style={{ fontSize: 12, width: 80, textAlign: "right", flexShrink: 0, fontWeight: 500 }}>{g.geoName}</span>
                    <div style={{ flex: 1, height: 14, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${g.visibility}%`, height: "100%", borderRadius: 3, background: "#007aff", opacity: 0.7 }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, width: 36, textAlign: "right" }}>{g.visibility}%</span>
                  </div>
                )) : lc ? (
                  <div style={{ fontSize: 13, color: T2, lineHeight: 1.5 }}>
                    AI agents mentioned {site?.domain} without any location-specific context — no geographic signal was detected across {(lc.providerResults as Array<{ totalQueries?: number }>)?.reduce((s, p) => s + (p.totalQueries ?? 0), 0) || "all"} queries.
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: T2 }}>Run a citation scan to see how AI agents mention you by region.</div>
                )}
              </div>
              <div style={{ background: CARD, borderRadius: 12, padding: "18px 20px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}` }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Category Performance</span>
                  <InfoTooltip text="Which product or service categories AI associates with your brand, and how strongly. Low % = AI doesn't recognize you in that category." />
                </div>
                {(() => {
                  const knownCategories = categoryVisibility.filter(c => c.categoryId !== "unknown" && c.categoryName !== "unknown");
                  if (knownCategories.length > 0) {
                    return knownCategories.slice(0, 5).map(c => (
                      <div key={c.categoryId} style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8 }}>
                        <span style={{ fontSize: 12, width: 80, textAlign: "right", flexShrink: 0, fontWeight: 500 }}>{c.categoryName}</span>
                        <div style={{ flex: 1, height: 14, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ width: `${c.visibility}%`, height: "100%", borderRadius: 3, background: ORANGE }} />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, width: 36, textAlign: "right" }}>{c.visibility}%</span>
                      </div>
                    ));
                  }
                  if (lc) return <div style={{ fontSize: 13, color: T2, lineHeight: 1.5 }}>AI agents didn&apos;t associate {site?.domain} with a recognizable product category.</div>;
                  return <div style={{ fontSize: 13, color: T2 }}>Run a citation scan to see how AI agents categorize you.</div>;
                })()}
              </div>
              <div style={{ background: CARD, borderRadius: 12, padding: "18px 20px", boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", border: `1px solid ${BORDER}` }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Buyer Intent Coverage</span>
                  <InfoTooltip text="AI queries are split into 3 intent stages — Learn (what is X / how does X work), Solve (X vs Y / best X for Y), Buy (buy X / X price / X near me). % = how often AI mentions you for each stage." />
                </div>
                {tierVisibility.length > 0 ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 8 }}>
                    {tierVisibility.map(t => (
                      <div key={t.tier} style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 11, color: T2, fontWeight: 500 }}>{t.tier.charAt(0).toUpperCase() + t.tier.slice(1)}</div>
                        <div style={{ fontSize: 20, fontWeight: 700, margin: "2px 0", color: scoreColor(t.visibility) }}>{t.visibility}%</div>
                        <div style={{ fontSize: 10, color: T3 }}>{t.mentionCount}/{t.promptCount} prompts</div>
                      </div>
                    ))}
                  </div>
                ) : lc ? (
                  <div style={{ fontSize: 13, color: T2 }}>No buyer intent data detected in this citation scan.</div>
                ) : (
                  <div style={{ fontSize: 13, color: T2 }}>Run a citation scan to see intent coverage.</div>
                )}
              </div>
            </div>
            )}

          </div>
        )}

        {/* Citation Analysis — SOV + Citation Visibility by Theme moved to Overview; this tab shows the full AI query log */}
        {safeActiveTab === "competitive" && (
          <div>
            {/* AI Query & Response Log — uses pillarQA (indirect/organic queries only) */}
            {(() => {
              type _PQASample = { question: string; answer: string | null; mentioned: boolean; provider: string; sentiment: string | null; accuracyLabel?: "accurate" | "partial" | "inaccurate" | null; accuracyNote?: string | null };
              type _PillarQA = { samples: _PQASample[]; topCompetitor: string | null };
              const pillarQA = (lc?.pillarQA ?? {}) as Record<string, _PillarQA>;

              // Collect indirect pillar samples only — skip __direct__ (brand-named queries)
              type PillarGroup = { pillarId: string; pillarLabel: string; samples: _PQASample[] };
              const groups: PillarGroup[] = Object.entries(pillarQA)
                .filter(([pillarId, pqa]) => pillarId !== "__direct__" && (pqa.samples?.length ?? 0) > 0)
                .map(([pillarId, pqa]) => ({
                  pillarId,
                  pillarLabel: pillarDisplayName(pillarId),
                  samples: pqa.samples,
                }));

              const totalSamples = groups.reduce((s, g) => s + g.samples.length, 0);
              const competitorNames = competitorData.map(c => c.name).filter(Boolean);

              // Strip markdown and citation refs from answer text
              function cleanAnswer(raw: string): string {
                let t = raw;
                t = t.replace(/\[\d+(?:[,\s]*\d+)*\]/g, "");
                t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
                t = t.replace(/\(https?:\/\/[^\s)]+\)/g, "");
                t = t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*\*\S*/g, "").replace(/\*(.+?)\*/g, "$1");
                t = t.replace(/__(.+?)__/g, "$1").replace(/_(.+?)_/g, "$1");
                return t;
              }

              function applyHighlights(text: string, salt: string): React.ReactNode {
                if (!text || competitorNames.length === 0) return text;
                const pattern = new RegExp(`(${competitorNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
                return text.split(pattern).map((part, i) =>
                  competitorNames.some(n => n.toLowerCase() === part.toLowerCase())
                    ? <mark key={`${salt}-${i}`} style={{ background: "#fff3cd", color: "#92400e", borderRadius: 3, padding: "0 2px", fontWeight: 600 }}>{part}</mark>
                    : part
                );
              }

              function parseBlocks(raw: string, hl: (t: string, s: string) => React.ReactNode): React.ReactNode[] {
                const text = cleanAnswer(raw);
                const lines = text.split(/\n/);
                const blocks: React.ReactNode[] = [];
                let para: string[] = [];
                let paraKey = 0;

                function flushPara() {
                  const joined = para.join(" ").trim();
                  para = [];
                  if (!joined) return;
                  blocks.push(<p key={`p-${paraKey++}`} style={{ margin: "0 0 8px", fontSize: 12, color: TEXT, lineHeight: 1.65 }}>{hl(joined, `p${paraKey}`)}</p>);
                }

                lines.forEach((line, li) => {
                  const headingMatch = line.match(/^#{1,3}\s+(.+)/);
                  const numberedMatch = line.match(/^(\d+)\.\s+(.*)/);
                  const bulletMatch = line.match(/^[-*]\s(.*)/);
                  if (headingMatch) {
                    flushPara();
                    blocks.push(<div key={`h-${li}`} style={{ fontSize: 11, fontWeight: 700, color: T2, textTransform: "uppercase", letterSpacing: ".4px", margin: "10px 0 4px" }}>{hl(headingMatch[1], `h${li}`)}</div>);
                  } else if (line.trim() === "") {
                    flushPara();
                  } else if (bulletMatch) {
                    flushPara();
                    const item = bulletMatch[1].trim();
                    if (item) blocks.push(<div key={`b-${li}`} style={{ fontSize: 12, color: TEXT, lineHeight: 1.6, paddingLeft: 12, marginBottom: 3 }}>• {hl(item, `b${li}`)}</div>);
                  } else if (numberedMatch) {
                    flushPara();
                    const item = numberedMatch[2].trim();
                    if (item) blocks.push(<div key={`n-${li}`} style={{ fontSize: 12, color: TEXT, lineHeight: 1.6, paddingLeft: 12, marginBottom: 3 }}>{numberedMatch[1]}. {hl(item, `n${li}`)}</div>);
                  } else {
                    para.push(line);
                  }
                });
                flushPara();
                return blocks;
              }

              function AnswerBlock({ raw }: { raw: string }) {
                const trimmed = raw.trimEnd();
                // RM-MAJOR-3: tightened truncation detector. The prior signal
                // `!/[.!?"]$/.test(trimmed)` falsely flagged ANY answer not
                // ending in `. ! ? "` — including legitimate endings like
                // closing parens, brackets, em-dashes, colons, ellipses,
                // currency, single quotes, list closers. L2-rebuild quantified
                // 68/72 false positives on real provider output. New signal:
                // (a) answer is at/near the storage cap (2000 chars); AND
                // (b) ends mid-word (no terminal punctuation in last 4 chars,
                //     last whitespace-split token < 3 chars). Both must hold.
                const ANSWER_STORAGE_CAP = 2000;
                const nearCap = trimmed.length >= ANSWER_STORAGE_CAP - 10;
                const tail = trimmed.slice(-4);
                // Broader terminal-punctuation set: ., !, ?, ", ', ), ], }, :, ;, …, —, –
                const hasTerminalPunct = /[.!?"')\]}:;…—–]/.test(tail);
                const lastToken = trimmed.split(/\s+/).pop() ?? "";
                const endsMidWord = lastToken.length > 0 && lastToken.length < 3 && !hasTerminalPunct;
                const truncated = trimmed.length > 0 && nearCap && endsMidWord;
                const blocks = parseBlocks(raw, applyHighlights);
                return (
                  <>
                    {blocks}
                    {truncated && (
                      <span style={{ fontSize: 11, color: T3, fontStyle: "italic" }}>
                        … response truncated
                      </span>
                    )}
                  </>
                );
              }

              // Direct-query samples for brand accuracy panel.
              // New scans store them in pillarQA.__direct__; fall back to providerResults[].samples
              // for older records that pre-date that field.
              // RM-MAJOR-1: SHALLOW-CLONE the source array before the legacy-fallback push()
              // below. Without the spread, the conditional push mutated the prop array
              // (pillarQA.__direct__.samples) at render time — under React.StrictMode the
              // double-render appended duplicates, and any parent that retained the prop
              // reference observed grown arrays across renders.
              const directSamples: _PQASample[] = [...((pillarQA["__direct__"] as _PillarQA | undefined)?.samples ?? [])];
              if (directSamples.length === 0 && providerResultsWithSamples.length > 0) {
                // Legacy fallback: grab up to 2 samples across providers
                const seen = new Set<string>();
                for (const pr of providerResultsWithSamples) {
                  for (const s of (pr.samples ?? [])) {
                    if (seen.size >= 2) break;
                    if (!seen.has(s.question)) {
                      seen.add(s.question);
                      directSamples.push({ question: s.question, answer: s.answer ?? null, mentioned: s.mentioned, provider: pr.provider, sentiment: null });
                    }
                  }
                  if (seen.size >= 2) break;
                }
              }

              // Free tier has no citation data, so this tab would render empty. Show a
              // product showcase instead so the page sells (founder directive: every
              // free tab previews the paid product). Paid with no data still returns null.
              if (groups.length === 0 && directSamples.length === 0 && !lc) {
                return isFreeTier ? (
                  <ProShowcasePanel
                    onUpgrade={() => setShowUpgradeModal(true)}
                    title="See exactly what AI says when buyers ask about you"
                    body="Pro asks ChatGPT, Perplexity & Gemini the real questions your buyers ask — and shows you, verbatim, when AI recommends a competitor instead of you. This is the gap that costs you customers."
                  >
                    <SampleCitationLog domain={site?.domain ?? ""} />
                  </ProShowcasePanel>
                ) : null;
              }

              const ACCURACY_STYLE: Record<string, { bg: string; color: string }> = {
                accurate:   { bg: "#dcfce7", color: "#166534" },
                partial:    { bg: "#fef9c3", color: "#713f12" },
                inaccurate: { bg: "#fef2f2", color: "#991b1b" },
              };

              return (
                <>
                  {/* ── Brand accuracy panel (direct brand-named queries) — shown first ── */}
                  {lc && (
                    <div style={{ background: CARD, borderRadius: 12, border: `1px solid ${BORDER}`, boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", marginBottom: 16, overflow: "hidden" }}>
                      <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${BORDER}` }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>Brand Accuracy Check</div>
                        <div style={{ fontSize: 12, color: T2, marginTop: 4 }}>
                          How accurately AI describes your brand vs what your site actually says
                        </div>
                      </div>
                      {directSamples.length === 0 ? (
                        <div style={{ padding: "16px 20px", fontSize: 13, color: T2 }}>
                          Re-run your citation check to generate brand accuracy data. The next scan will compare each AI response against your crawled content.
                        </div>
                      ) : directSamples.map((s, idx) => (
                        <div key={idx} style={{ padding: "16px 20px", borderBottom: idx < directSamples.length - 1 ? `1px solid ${BORDER}` : "none" }}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: COPPER, background: COPPER_BG, borderRadius: 4, padding: "2px 7px", flexShrink: 0, marginTop: 2, textTransform: "uppercase", letterSpacing: ".3px" }}>Q</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: TEXT, lineHeight: 1.45 }}>{s.question}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: s.answer ? 10 : 0, paddingLeft: 32 }}>
                            <span style={{ fontSize: 11, color: T3, textTransform: "capitalize" }}>{s.provider}</span>
                            <span style={{ fontSize: 11, color: T3 }}>·</span>
                            {s.accuracyLabel ? (
                              <span style={{
                                fontSize: 11, fontWeight: 600, borderRadius: 4, padding: "1px 7px",
                                background: (ACCURACY_STYLE[s.accuracyLabel] ?? { bg: "#f3f4f6" }).bg,
                                color: (ACCURACY_STYLE[s.accuracyLabel] ?? { color: "#374151" }).color,
                              }}>
                                {s.accuracyLabel.charAt(0).toUpperCase() + s.accuracyLabel.slice(1)}
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: T3, fontStyle: "italic" }}>accuracy not yet checked</span>
                            )}
                            {s.accuracyNote && (
                              <>
                                <span style={{ fontSize: 11, color: T3 }}>·</span>
                                <span style={{ fontSize: 11, color: T2 }}>{s.accuracyNote}</span>
                              </>
                            )}
                          </div>
                          {s.answer && (
                            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, paddingLeft: 32 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", background: "#f0f0f2", borderRadius: 4, padding: "2px 7px", flexShrink: 0, marginTop: 3, textTransform: "uppercase", letterSpacing: ".3px" }}>A</span>
                              <div style={{ flex: 1 }}><AnswerBlock raw={s.answer} /></div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ── Organic Q&A samples ────────────────────────── */}
                  <div style={{ background: CARD, borderRadius: 12, border: `1px solid ${BORDER}`, boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", marginBottom: 16, overflow: "hidden" }}>
                    <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${BORDER}` }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>AI Response Samples</div>
                      <div style={{ fontSize: 12, color: T2, marginTop: 4 }}>
                        {groups.length > 0
                          ? <>{totalSamples} organic queries across {groups.length} topics · competitor mentions <mark style={{ background: "#fff3cd", color: "#92400e", borderRadius: 3, padding: "0 3px", fontWeight: 600, fontSize: 11 }}>highlighted</mark></>
                          : "Run a citation scan to see how AI responds to organic queries about your space."
                        }
                      </div>
                    </div>

                    {groups.length === 0 ? (
                      <div style={{ padding: "16px 20px", fontSize: 13, color: T2 }}>
                        No organic query samples recorded. These are generated on paid citation scans.
                      </div>
                    ) : groups.map((group) => (
                      <div key={group.pillarId}>
                        <div style={{ padding: "10px 20px", background: BG, borderBottom: `1px solid ${BORDER}`, borderTop: `1px solid ${BORDER}` }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>{group.pillarLabel}</span>
                        </div>
                        {group.samples.map((s, idx) => (
                          <div key={idx} style={{ padding: "16px 20px", borderBottom: idx < group.samples.length - 1 ? `1px solid ${BORDER}` : "none" }}>
                            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: COPPER, background: COPPER_BG, borderRadius: 4, padding: "2px 7px", flexShrink: 0, marginTop: 2, textTransform: "uppercase", letterSpacing: ".3px" }}>Q</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: TEXT, lineHeight: 1.45 }}>{s.question}</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: s.answer ? 10 : 0, paddingLeft: 32 }}>
                              <span style={{ fontSize: 11, color: T3, textTransform: "capitalize" }}>{s.provider}</span>
                              <span style={{ fontSize: 11, color: T3 }}>·</span>
                              <span style={{
                                fontSize: 11, fontWeight: 600, borderRadius: 4, padding: "1px 7px",
                                background: s.mentioned ? "#dcfce7" : "#fef2f2",
                                color: s.mentioned ? "#166534" : "#991b1b",
                              }}>
                                {s.mentioned ? "Brand cited" : "Not cited"}
                              </span>
                            </div>
                            {s.answer && (
                              <div style={{ display: "flex", alignItems: "flex-start", gap: 10, paddingLeft: 32 }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", background: "#f0f0f2", borderRadius: 4, padding: "2px 7px", flexShrink: 0, marginTop: 3, textTransform: "uppercase", letterSpacing: ".3px" }}>A</span>
                                <div style={{ flex: 1 }}><AnswerBlock raw={s.answer} /></div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>

                </>
              );
            })()}
          </div>
        )}

        {/* Recommendations */}
        {safeActiveTab === "action-plan" && actionPlanView === "recommendations" && (
          <div data-testid="recommendations-tab">
            {(() => {
              const hiCount = recs.filter(r => ["HIGH", "high"].includes(r.priority)).length;
              const medCount = recs.filter(r => ["MED", "med"].includes(r.priority)).length;
              const lowCount = recs.filter(r => ["LOW", "low"].includes(r.priority)).length;
              return (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T2, textTransform: "uppercase", letterSpacing: ".5px" }}>
                    {recs.length} Recommendations — sorted by priority
                  </div>
                  <div style={{ fontSize: 12, color: T2 }}>
                    {[hiCount > 0 && `${hiCount} HIGH`, medCount > 0 && `${medCount} MED`, lowCount > 0 && `${lowCount} LOW`].filter(Boolean).join(" · ")}
                  </div>
                </div>
              );
            })()}
            {recs.length > 0 ? recs.map((r, i) => {
              const isOpen = expanded.has(i);
              const pStyle = ["critical"].includes(r.priority)
                ? { background: "#fef2f2", color: RED }
                : ["HIGH", "high"].includes(r.priority)
                ? { background: "#fff3e0", color: "#e65100" }
                : ["MED", "med", "medium"].includes(r.priority)
                ? { background: "#fffde7", color: "#f57f17" }
                : { background: "#f0f0f2", color: T2 };
              const effortMap: Record<string, string> = { low: "30 min", medium: "1–2 hrs", high: "half day" };
              const timeStr = r.effort ? (effortMap[r.effort] ?? r.effort) : null;
              return (
                <div key={r.title + i} style={{ background: CARD, borderRadius: 12, border: `1px solid ${isOpen ? "rgba(194, 101, 42, 0.35)" : BORDER}`, boxShadow: isOpen ? "0 0 0 1px rgba(194, 101, 42, 0.15), 0 4px 16px rgba(194, 101, 42, 0.12)" : "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", marginBottom: 8, overflow: "hidden", transition: "all .2s" }}>
                  <div
                    style={{ display: "flex", alignItems: "center", padding: "14px 18px", gap: 12, cursor: "pointer" }}
                    onClick={() => {
                      const next = new Set(expanded);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      setExpanded(next);
                    }}
                  >
                    <div style={{ width: 18, height: 18, border: `2px solid ${BORDER}`, borderRadius: "50%", flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: T3, width: 20, textAlign: "center", flexShrink: 0 }}>{i + 1}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, flexShrink: 0, width: 48, textAlign: "center", ...pStyle }}>
                      {r.priority === "critical" ? "CRIT" : r.priority === "medium" ? "MED" : (r.priority ?? "low").toUpperCase()}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{r.title}</span>
                    {timeStr && <span style={{ fontSize: 11, color: T2, flexShrink: 0 }}>{timeStr}</span>}
                    <span style={{ fontSize: 11, color: T3 }}>{isOpen ? "↑" : "↓"}</span>
                  </div>
                  {isOpen && (
                    <div style={{ padding: "0 18px 16px 62px", fontSize: 13, color: T2, lineHeight: 1.6 }}>
                      {r.description && <div>{r.description}</div>}
                      {r.estimatedBoost && (
                        <div style={{ fontSize: 11, color: GREEN, fontWeight: 600, marginTop: 8, textTransform: "uppercase" }}>
                          Boost: {r.estimatedBoost}
                        </div>
                      )}
                      {isFreeTier ? (
                        /* Free always shows the locked fix (specificAction is stripped
                           server-side for free): the problem + boost are visible above,
                           the exact deploy-ready fix is gated — otherwise savvy buyers
                           take the to-do list and self-serve. Paid gets the action. */
                        <button
                          type="button"
                          onClick={() => setShowUpgradeModal(true)}
                          style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", boxSizing: "border-box", background: "#fff7ed", border: "1px dashed rgba(194,101,42,0.45)", borderRadius: 8, padding: "10px 14px", marginTop: 8 }}
                        >
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#c2652a", display: "flex", alignItems: "center", gap: 6 }}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#c2652a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                            The exact fix + 1-click deploy is included with Pro
                          </div>
                          <div style={{ fontSize: 11, color: "#86868b", marginTop: 3 }}>We write it and push it live for you — then re-check it every cycle so it stays. Get cited by AI →</div>
                        </button>
                      ) : r.specificAction ? (
                        <div style={{ background: COPPER, borderRadius: 8, padding: "10px 14px", marginTop: 8, fontSize: 12, lineHeight: 1.5, color: "#fff" }}>
                          <strong>Action:</strong> {r.specificAction}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            }) : <div style={{ fontSize: 13, color: T2 }}>Run a GEO audit to see recommendations.</div>}
          </div>
        )}

        {/* Pages */}
        {safeActiveTab === "action-plan" && actionPlanView === "pages" && (
          <div data-testid="pages-tab">
            {site?.perPageResults == null ? (
              <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: T2 }}>Upgrade to see per-page analysis.</div>
            ) : (
              <>
                {/* Download bar */}
                <button
                  onClick={handleDownloadZip}
                  style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", marginBottom: 16,
                    background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8,
                    boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)",
                    textDecoration: "none", transition: "border-color 0.15s", cursor: "pointer", width: "100%", fontFamily: "inherit", textAlign: "left",
                  }}
                >
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: "#e3f2fd", color: "#1565c0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Download full fix report</div>
                    <div style={{ fontSize: 11, color: T2 }}>
                      Per-page vulnerabilities, suggested fixes, schema blocks, and zone recommendations
                    </div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: COPPER, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}>
                    Download ZIP ↓
                  </span>
                </button>

                {/* Pages card */}
                <div style={{ background: CARD, borderRadius: 12, border: `1px solid ${BORDER}`, boxShadow: "0 2px 6px rgba(194, 101, 42, 0.1), 0 8px 24px rgba(194, 101, 42, 0.08)", overflow: "hidden" }}>
                  {/* Card header: summary strip + controls */}
                  <div style={{ padding: "16px 20px 0" }}>
                    {/* Health summary bar */}
                    {(() => {
                      const goodCount = allPages.filter(p => p.overallPageHealth === "good").length;
                      const needsCount = allPages.filter(p => p.overallPageHealth === "needs-work").length;
                      const poorCount = allPages.filter(p => p.overallPageHealth === "poor").length;
                      const total = allPages.length;
                      const totalVulns = allPages.reduce((s, p) => s + (p.vulnerabilities?.length ?? 0), 0);
                      return (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                            <span style={{ fontSize: 14, fontWeight: 700 }}>{total} pages</span>
                            <span style={{ fontSize: 12, color: T2 }}>{totalVulns} vulnerabilities</span>
                          </div>
                          {/* Proportional health bar */}
                          <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "#f0f0f2" }}>
                            {goodCount > 0 && <div style={{ width: `${(goodCount / total) * 100}%`, background: GREEN, transition: "width .3s" }} />}
                            {needsCount > 0 && <div style={{ width: `${(needsCount / total) * 100}%`, background: ORANGE, transition: "width .3s" }} />}
                            {poorCount > 0 && <div style={{ width: `${(poorCount / total) * 100}%`, background: RED, transition: "width .3s" }} />}
                          </div>
                          {/* Legend */}
                          <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
                            {goodCount > 0 && <span style={{ fontSize: 11, color: T2, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: GREEN, flexShrink: 0 }} />{goodCount} Good</span>}
                            {needsCount > 0 && <span style={{ fontSize: 11, color: T2, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: ORANGE, flexShrink: 0 }} />{needsCount} Needs Work</span>}
                            {poorCount > 0 && <span style={{ fontSize: 11, color: T2, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: RED, flexShrink: 0 }} />{poorCount} Poor</span>}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Controls row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", paddingBottom: 12, borderBottom: `1px solid ${BORDER}` }}>
                      <div style={{ display: "flex", gap: 4 }}>
                        {(["All", "good", "needs-work", "poor"] as const).map(f => {
                          const label = f === "All" ? "All" : f === "needs-work" ? "Needs Work" : f.charAt(0).toUpperCase() + f.slice(1);
                          const count = f === "All" ? allPages.length : allPages.filter(p => p.overallPageHealth === f).length;
                          if (f !== "All" && count === 0) return null;
                          return (
                            <button
                              key={f}
                              onClick={() => { setPageFilter(f); setPageCursor(0); }}
                              style={{
                                fontSize: 12, padding: "4px 12px", borderRadius: 6,
                                border: `1px solid ${pageFilter === f ? COPPER : BORDER}`,
                                background: pageFilter === f ? COPPER : "transparent",
                                color: pageFilter === f ? "#fff" : TEXT,
                                cursor: "pointer", fontWeight: 500,
                              }}
                            >
                              {f === "All" ? label : `${label} (${count})`}
                            </button>
                          );
                        })}
                      </div>
                      <input
                        type="text"
                        placeholder="Search pages..."
                        value={pageSearch}
                        onChange={e => { setPageSearch(e.target.value); setPageCursor(0); }}
                        style={{ width: 240, padding: "6px 12px", fontSize: 13, border: `1px solid ${BORDER}`, borderRadius: 8, outline: "none", background: "transparent" }}
                      />
                    </div>
                  </div>

                  {/* Page rows */}
                  <div>
                    {pagedRows.map((p, i) => {
                      const health = p.overallPageHealth;
                      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
                      const vulns = (p.vulnerabilities ?? [])
                        .filter(v => !v.finding.startsWith("Flagged by site-level GEO analysis"))
                        .sort((a, b) => (sevOrder[a.severity] ?? 4) - (sevOrder[b.severity] ?? 4));
                      const fixCount = vulns.length;
                      const critCount = vulns.filter(v => v.severity === "critical" || v.severity === "high").length;
                      const medCount = vulns.filter(v => v.severity === "medium").length;
                      const lowCount = fixCount - critCount - medCount;
                      const healthDot = health === "good" ? GREEN : health === "needs-work" ? ORANGE : RED;
                      const healthLabel = health === "good" ? "Good" : health === "needs-work" ? "Needs Work" : "Poor";
                      const urlPath = (() => {
                        try {
                          const u = new URL(p.url);
                          return u.pathname === "/" ? u.hostname + "/" : u.pathname;
                        } catch { return p.url; }
                      })();
                      const isExpanded = expandedPageUrls.has(p.url);
                      const pageTypeLabel = p.pageType ? p.pageType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : null;
                      const sevColor = (s: string) => s === "critical" || s === "high" ? RED : s === "medium" ? ORANGE : "#b0b0b8";
                      const sevLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
                      const pillarLabel = (name: string) => name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
                      return (
                        <div
                          key={p.url + i}
                          data-testid="page-row"
                          data-status={health}
                          style={{ borderBottom: i < pagedRows.length - 1 ? `1px solid #f5f5f7` : "none" }}
                        >
                          {/* Summary row — clickable */}
                          <div
                            onClick={() => setExpandedPageUrls(prev => {
                              const next = new Set(prev);
                              isExpanded ? next.delete(p.url) : next.add(p.url);
                              return next;
                            })}
                            style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", cursor: fixCount > 0 ? "pointer" : "default" }}
                          >
                            <span style={{ width: 7, height: 7, borderRadius: "50%", background: healthDot, flexShrink: 0, marginTop: 1 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                {p.title && <span style={{ fontSize: 13, fontWeight: 600, color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>}
                                {pageTypeLabel && <span style={{ fontSize: 10, fontWeight: 700, color: "#b45309", background: "#fef3e2", padding: "1px 6px", borderRadius: 4, flexShrink: 0, textTransform: "uppercase", letterSpacing: ".4px" }}>{pageTypeLabel}</span>}
                              </div>
                              <div style={{ fontSize: 11, color: T3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{urlPath}</div>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                              {fixCount > 0 ? (
                                <>
                                  <div style={{ display: "flex", height: 4, width: 48, borderRadius: 2, overflow: "hidden", background: "#f0f0f2" }}>
                                    {critCount > 0 && <div style={{ width: `${(critCount / fixCount) * 100}%`, background: RED }} />}
                                    {medCount > 0 && <div style={{ width: `${(medCount / fixCount) * 100}%`, background: ORANGE }} />}
                                    {lowCount > 0 && <div style={{ width: `${(lowCount / fixCount) * 100}%`, background: "#e6b800" }} />}
                                  </div>
                                  <span style={{ fontSize: 12, fontWeight: 600, color: critCount > 0 ? RED : medCount > 0 ? ORANGE : T2, fontVariantNumeric: "tabular-nums", minWidth: 16, textAlign: "right" }}>{fixCount}</span>
                                  <span style={{ fontSize: 11, color: T3 }}>{isExpanded ? "▲" : "▼"}</span>
                                </>
                              ) : (
                                <span style={{ fontSize: 11, color: GREEN, fontWeight: 600 }}>{healthLabel}</span>
                              )}
                            </div>
                          </div>
                          {/* Expanded vulnerability list */}
                          {isExpanded && fixCount > 0 && (
                            <div style={{ background: "#f9f9fb", borderTop: `1px solid #f0f0f2`, padding: "14px 20px 16px" }}>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
                                {vulns.map((v, vi) => (
                                  <div key={vi} style={{ background: "#fff", border: `1px solid #ebebef`, borderLeft: `3px solid ${sevColor(v.severity)}`, borderRadius: 8, padding: "10px 12px" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                                      <span style={{ fontSize: 10, fontWeight: 700, color: sevColor(v.severity), textTransform: "uppercase", letterSpacing: ".4px" }}>{sevLabel(v.severity)}</span>
                                      <span style={{ fontSize: 10, color: T3 }}>·</span>
                                      <span style={{ fontSize: 11, fontWeight: 600, color: T2 }}>{pillarLabel(v.pillarName)}</span>
                                    </div>
                                    <div style={{ fontSize: 12, color: TEXT, marginBottom: 6, lineHeight: 1.4 }}>{v.finding}</div>
                                    {v.pillar === "structured_data" && site?.domainVerified ? (
                                      <div style={{ fontSize: 12, color: GREEN, display: "flex", gap: 4, lineHeight: 1.4, fontWeight: 500 }}>
                                        <span style={{ flexShrink: 0 }}>✓</span>
                                        <span>Your GEO integration is active — JSON-LD schema is automatically injected on this page.</span>
                                      </div>
                                    ) : v.pillar === "structured_data" && !site?.domainVerified ? (
                                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                        <div style={{ fontSize: 12, color: COPPER, display: "flex", gap: 4, lineHeight: 1.4 }}>
                                          <span style={{ flexShrink: 0 }}>→</span>
                                          <span>{v.recommendation}</span>
                                        </div>
                                        <div style={{ fontSize: 11, color: T2, lineHeight: 1.4 }}>
                                          Or complete the setup tab — GEO will inject schema automatically once your integration is verified.
                                        </div>
                                      </div>
                                    ) : (
                                      <div style={{ fontSize: 12, color: COPPER, display: "flex", gap: 4, lineHeight: 1.4 }}>
                                        <span style={{ flexShrink: 0 }}>→</span>
                                        <span>{v.recommendation}</span>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Pagination inside card */}
                  {filteredPages.length > PAGE_SIZE && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", padding: "12px 20px", borderTop: `1px solid ${BORDER}` }}>
                      <button
                        onClick={() => setPageCursor(Math.max(0, pageCursor - PAGE_SIZE))}
                        disabled={pageCursor === 0}
                        style={{
                          fontSize: 12, padding: "4px 12px", borderRadius: 6,
                          border: `1px solid ${BORDER}`, background: "transparent", color: TEXT,
                          cursor: pageCursor === 0 ? "not-allowed" : "pointer",
                          opacity: pageCursor === 0 ? 0.4 : 1, fontWeight: 500,
                        }}
                      >
                        ← Prev
                      </button>
                      <span style={{ fontSize: 12, color: T2, fontVariantNumeric: "tabular-nums" }}>
                        {pageCursor + 1}–{Math.min(pageCursor + PAGE_SIZE, filteredPages.length)} of {filteredPages.length}
                      </span>
                      <button
                        onClick={() => setPageCursor(pageCursor + PAGE_SIZE)}
                        disabled={pageCursor + PAGE_SIZE >= filteredPages.length}
                        style={{
                          fontSize: 12, padding: "4px 12px", borderRadius: 6,
                          border: `1px solid ${BORDER}`, background: "transparent", color: TEXT,
                          cursor: pageCursor + PAGE_SIZE >= filteredPages.length ? "not-allowed" : "pointer",
                          opacity: pageCursor + PAGE_SIZE >= filteredPages.length ? 0.4 : 1, fontWeight: 500,
                        }}
                      >
                        Next →
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Fix HTML */}
        {safeActiveTab === "fix-html" && (
          <div data-testid="fix-html-tab">
            {(() => {
              const pages = allPages.map(p => ({ url: p.url, issueCount: (p.vulnerabilities ?? []).length }));
              const totalFixes = allPages.reduce((s, p) => s + (p.vulnerabilities ?? []).length, 0);
              const selectedUrl = fixHtmlSelectedUrl || allPages[0]?.url || "";
              const setSelectedUrl = setFixHtmlSelectedUrl;
              const inputHtml = fixHtmlInput;
              const setInputHtml = setFixHtmlInput;
              const copied = fixHtmlCopied;

              const SAMPLE_OUTPUT = `<!DOCTYPE html>
<html lang="en" itemscope itemtype="https://schema.org/WebPage">
  <head>
    <title>${site?.domain} — optimised for AI visibility</title>
    <meta name="description" content="[AI-expanded description added]">
    <meta property="og:title" content="${site?.domain}">
    <meta property="og:type" content="website">
    <link rel="alternate" type="text/plain" href="/llms.txt">
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "${site?.domain}",
      "url": "https://${site?.domain}"
    }
    </script>
  </head>
  <body>
    <!-- your existing body content with fixes applied -->
  </body>
</html>`;

              function handleCopy() {
                const toCopy = fixHtmlOutput || SAMPLE_OUTPUT;
                navigator.clipboard.writeText(toCopy).then(() => {
                  setFixHtmlCopied(true);
                  setTimeout(() => setFixHtmlCopied(false), 1800);
                });
              }

              const FIX_CHIPS = [
                { label: "Schema blocks added", color: "#fee2e2", text: "#991b1b" },
                { label: "img alt text filled",  color: "#fef9c3", text: "#713f12" },
                { label: "Meta description expanded", color: "#fef9c3", text: "#713f12" },
                { label: "Heading hierarchy fixed",   color: "#dbeafe", text: "#1e40af" },
                { label: "Open Graph tags added",     color: "#dbeafe", text: "#1e40af" },
                { label: "llms.txt hint injected",    color: "#dbeafe", text: "#1e40af" },
              ];

              const DIFF_LINES: Array<{ type: "add" | "del" | "ctx" | "sep"; text: string }> = [
                { type: "ctx", text: "<!DOCTYPE html>" },
                { type: "del", text: '<html lang="en">' },
                { type: "add", text: '<html lang="en" itemscope itemtype="https://schema.org/WebPage">' },
                { type: "ctx", text: "  <head>" },
                { type: "del", text: `    <title>${site?.domain}</title>` },
                { type: "add", text: `    <title>${site?.domain} — AI-optimised title with primary keyword</title>` },
                { type: "del", text: '    <meta name="description" content="Short description.">' },
                { type: "add", text: '    <meta name="description" content="[AI-expanded: 150-char description with entity context added]">' },
                { type: "add", text: '    <meta property="og:title" content="[Added]">' },
                { type: "add", text: '    <meta property="og:description" content="[Added]">' },
                { type: "add", text: '    <meta property="og:type" content="website">' },
                { type: "add", text: '    <link rel="alternate" type="text/plain" href="/llms.txt">' },
                { type: "sep", text: "  ··· unchanged lines ···" },
                { type: "add", text: '    <script type="application/ld+json">' },
                { type: "add", text: '    { "@context": "https://schema.org", "@type": "WebSite", ... }' },
                { type: "add", text: '    </script>' },
                { type: "ctx", text: "  </head>" },
                { type: "ctx", text: "  <body>" },
                { type: "del", text: '    <h1>Welcome</h1>' },
                { type: "add", text: `    <h1>${site?.domain} — [keyword-enriched h1]</h1>` },
                { type: "del", text: '    <img src="/hero.png">' },
                { type: "add", text: '    <img src="/hero.png" alt="[Descriptive alt text added]">' },
                { type: "ctx", text: "  </body>" },
                { type: "ctx", text: "</html>" },
              ];

              const DIFF_STYLES: Record<string, { background: string; color: string; textDecoration?: string }> = {
                add: { background: "#dcfce7", color: "#166534" },
                del: { background: "#fee2e2", color: "#991b1b", textDecoration: "line-through" },
                ctx: { background: "transparent", color: "#6b7280" },
                sep: { background: "transparent", color: "#9ca3af" },
              };

              return (
                <div>
                  {/* Header */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: TEXT, marginBottom: 4 }}>Apply Your GEO Fixes</div>
                    <div style={{ fontSize: 13, color: T2 }}>
                      Paste any page&rsquo;s HTML on the left. We apply your <span style={{ color: COPPER, fontWeight: 600 }}>{totalFixes > 0 ? `${totalFixes} recommended fixes` : "recommended fixes"}</span> and return clean, AI-optimised HTML ready to deploy.
                    </div>
                  </div>

                  {/* Fix type summary */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
                    {[
                      { dot: "#ef4444", label: "12 critical — missing schema" },
                      { dot: "#f59e0b", label: "47 high — llms.txt gaps" },
                      { dot: "#3b82f6", label: "135 medium — heading / meta / alt" },
                    ].map(({ dot, label }) => (
                      <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600, color: T2 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0, display: "inline-block" }} />
                        {label}
                      </div>
                    ))}
                  </div>

                  {/* Free tier: the interactive tool needs credits free users don't have,
                      so EXPLAIN the feature with a real before→after sample (renders the
                      DIFF_LINES that were defined but never shown). Founder directive:
                      every free tab showcases the paid product. */}
                  {isFreeTier && (
                    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 14, overflow: "hidden", background: CARD, marginBottom: 16 }}>
                      <div style={{ padding: "16px 20px 12px", borderBottom: `1px solid ${BORDER}` }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: COPPER, marginBottom: 8 }}>Preview · what Pro does to your HTML</div>
                        <div style={{ fontSize: 17, fontWeight: 700, color: TEXT, marginBottom: 6 }}>We rewrite each page so AI can read it — then deploy it for you</div>
                        <div style={{ fontSize: 13, color: T2, lineHeight: 1.55 }}>FlowBlinq adds the schema, llms.txt links, metadata and alt text AI assistants look for before recommending a business — and pushes it live via CDN. Here&rsquo;s a real example of the change:</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "14px 20px 0" }}>
                        {FIX_CHIPS.map(c => (
                          <span key={c.label} style={{ fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 5, background: c.color, color: c.text }}>{c.label}</span>
                        ))}
                      </div>
                      <pre style={{ margin: "12px 0 0", padding: "8px 20px 16px", fontSize: 12, lineHeight: 1.7, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflowX: "auto" }}>
                        {DIFF_LINES.map((l, i) => (
                          <div key={i} style={{ ...DIFF_STYLES[l.type], padding: "0 6px", whiteSpace: "pre" }}>
                            <span style={{ opacity: 0.5, userSelect: "none" }}>{l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}</span>{l.text}
                          </div>
                        ))}
                      </pre>
                      <div style={{ padding: "14px 20px 16px", borderTop: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", background: "#fff7ed" }}>
                        <div style={{ fontSize: 12.5, color: T2 }}>Pro applies this to every page and re-checks it every cycle — no copy-paste. From $99/mo · cancel anytime.</div>
                        <button type="button" onClick={() => setShowUpgradeModal(true)} style={{ background: COPPER, color: "#fff", fontFamily: "inherit", fontSize: 13.5, fontWeight: 600, padding: "10px 20px", borderRadius: 8, border: "none", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>Get cited by AI →</button>
                      </div>
                    </div>
                  )}

                  {/* Two-panel layout — interactive tool, paid only (free sees the sample above) */}
                  {!isFreeTier && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 40px 1fr", alignItems: "stretch", height: 580, marginBottom: 16 }}>

                    {/* Left — paste input */}
                    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, boxShadow: "0 2px 6px rgba(194,101,42,.10)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                      <div style={{ padding: "14px 18px 12px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 28, height: 28, borderRadius: 8, background: "#f0f0f2", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>📄</div>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: TEXT, textTransform: "uppercase", letterSpacing: ".5px" }}>Your Current HTML</div>
                          <div style={{ fontSize: 11, color: T3, marginTop: 2 }}>Paste the source of any page on your site</div>
                        </div>
                      </div>
                      {fixHtmlDiff.length > 0 ? (
                        <div data-testid="diff-left" style={{ flex: 1, minHeight: 0, overflow: "auto", fontFamily: '"SF Mono","Fira Code","Courier New",monospace', fontSize: 11, lineHeight: 1.55, background: "#fafaf9", borderBottom: `1px solid ${BORDER}` }}>
                          {fixHtmlDiff.map((row, i) => {
                            const text = row.pasted?.text ?? "";
                            const lineNo = row.pasted?.lineNo ?? null;
                            const bg = row.marker === "removed" ? "#fee2e2" : "transparent";
                            const color = row.marker === "removed" ? "#991b1b" : "#374151";
                            return (
                              <div key={i} style={{ display: "flex", background: bg, borderLeft: row.marker === "removed" ? "3px solid #ef4444" : "3px solid transparent" }}>
                                <span style={{ flexShrink: 0, width: 36, padding: "0 6px", color: T3, fontSize: 10, textAlign: "right", borderRight: `1px solid ${BORDER}`, lineHeight: "inherit", userSelect: "none" }}>
                                  {lineNo ?? ""}
                                </span>
                                <span style={{ flex: 1, padding: "0 8px", color, whiteSpace: "pre", overflowX: "auto" }}>
                                  {text || (row.marker !== "context" ? "\u00a0" : "")}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <textarea
                          value={inputHtml}
                          onChange={e => setInputHtml(e.target.value)}
                          placeholder={"<!DOCTYPE html>\n<html lang=\"en\">\n  <head>\n    <title>Your page title</title>\n    ...\n  </head>\n  <body>\n    ...\n  </body>\n</html>\n\nPaste your full page HTML here."}
                          style={{ flex: 1, minHeight: 0, border: "none", outline: "none", resize: "none", fontFamily: '"SF Mono","Fira Code","Courier New",monospace', fontSize: 12, lineHeight: 1.6, color: "#374151", background: "#fafaf9", padding: "14px 16px", borderBottom: `1px solid ${BORDER}`, overflowY: "auto" }}
                        />
                      )}
                      <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                        <button onClick={() => { setInputHtml(""); setFixHtmlOutput(""); setFixHtmlDiff([]); setFixHtmlChanges([]); setFixHtmlWarnings([]); setFixHtmlMatchedUrl(null); setFixHtmlDetectedUrl(null); setFixHtmlError(null); }} style={{ fontSize: 12, fontWeight: 600, background: BG, border: `1px solid ${BORDER}`, borderRadius: 7, padding: "6px 12px", cursor: "pointer", color: T2, fontFamily: "inherit" }}>Clear</button>
                        <span style={{ fontSize: 11, color: T3, marginLeft: "auto" }}>{inputHtml.length} chars</span>
                      </div>
                    </div>

                    {/* Arrow — clickable Apply Fixes button */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6 }}>
                      <button
                        onClick={handleApplyFixHtml}
                        disabled={fixHtmlApplying || !fixHtmlInput.trim()}
                        title={!fixHtmlInput.trim() ? "Paste your page HTML on the left first" : `Apply fixes (${ACTION_CREDITS.fixHtmlRender} cr)`}
                        style={{
                          width: 40, height: 40, borderRadius: "50%", background: COPPER, color: "#fff",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 18, boxShadow: "0 2px 8px rgba(194,101,42,.3)", flexShrink: 0,
                          border: "none",
                          cursor: fixHtmlApplying || !fixHtmlInput.trim() ? "not-allowed" : "pointer",
                          opacity: fixHtmlApplying || !fixHtmlInput.trim() ? 0.55 : 1,
                          fontFamily: "inherit",
                        }}
                      >
                        {fixHtmlApplying ? "…" : "→"}
                      </button>
                      <div style={{ fontSize: 10, fontWeight: 600, color: T2, textAlign: "center", lineHeight: 1.2 }}>
                        {fixHtmlApplying ? "Applying…" : `${ACTION_CREDITS.fixHtmlRender} cr`}
                      </div>
                      {fixHtmlError ? (
                        <div style={{ fontSize: 10, color: RED, textAlign: "center", maxWidth: 120 }}>{fixHtmlError}</div>
                      ) : null}
                    </div>

                    {/* Right — fixed output */}
                    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, boxShadow: "0 2px 6px rgba(194,101,42,.10)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                      <div style={{ padding: "14px 18px 12px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 28, height: 28, borderRadius: 8, background: "#dcfce7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>✅</div>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: TEXT, textTransform: "uppercase", letterSpacing: ".5px" }}>Fixed HTML</div>
                          <div style={{ fontSize: 11, color: T3, marginTop: 2 }}>Fixes applied · copy or download</div>
                        </div>
                      </div>
                      {/* Applied-changes chips (real, from API) — placeholder before first apply */}
                      <div style={{ padding: "10px 14px", borderBottom: `1px solid ${BORDER}`, display: "flex", gap: 6, flexWrap: "wrap", minHeight: 36, alignItems: "center" }}>
                        {fixHtmlChanges.length > 0 ? (
                          fixHtmlChanges.map((c, i) => (
                            <span key={i} title={c} style={{ fontSize: 11, fontWeight: 600, borderRadius: 4, padding: "2px 7px", background: "#dcfce7", color: "#166534", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {c.length > 38 ? c.slice(0, 35) + "…" : c}
                            </span>
                          ))
                        ) : (
                          <span style={{ fontSize: 11, color: T3, fontStyle: "italic" }}>Applied fixes will appear here after you click the arrow</span>
                        )}
                      </div>
                      {/* Rendered diff (right side) or empty-state placeholder */}
                      {fixHtmlDiff.length > 0 ? (
                        <div data-testid="diff-right" style={{ flex: 1, minHeight: 0, overflow: "auto", fontFamily: '"SF Mono","Fira Code","Courier New",monospace', fontSize: 11, lineHeight: 1.55, background: "#fafaf9", borderBottom: `1px solid ${BORDER}` }}>
                          {fixHtmlDiff.map((row, i) => {
                            const text = row.fixed?.text ?? "";
                            const lineNo = row.fixed?.lineNo ?? null;
                            const bg = row.marker === "added" ? "#dcfce7" : "transparent";
                            const color = row.marker === "added" ? "#166534" : "#374151";
                            return (
                              <div key={i} style={{ display: "flex", background: bg, borderLeft: row.marker === "added" ? "3px solid #16a34a" : "3px solid transparent" }}>
                                <span style={{ flexShrink: 0, width: 36, padding: "0 6px", color: T3, fontSize: 10, textAlign: "right", borderRight: `1px solid ${BORDER}`, lineHeight: "inherit", userSelect: "none" }}>
                                  {lineNo ?? ""}
                                </span>
                                <span style={{ flex: 1, padding: "0 8px", color, whiteSpace: "pre", overflowX: "auto" }}>
                                  {text || (row.marker !== "context" ? "\u00a0" : "")}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px", fontFamily: '"SF Mono","Fira Code","Courier New",monospace', fontSize: 12, lineHeight: 1.65, background: "#fafaf9", borderBottom: `1px solid ${BORDER}` }}>
                          <div style={{ color: T3, fontStyle: "italic", fontFamily: "inherit", textAlign: "center", padding: "60px 20px" }}>
                            Paste your HTML on the left, then click the orange → arrow to apply the fixes for this page.
                          </div>
                        </div>
                      )}
                      <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                        <button onClick={handleCopy} disabled={!fixHtmlOutput} style={{ fontSize: 12, fontWeight: 600, background: BG, border: `1px solid ${BORDER}`, borderRadius: 7, padding: "6px 12px", cursor: fixHtmlOutput ? "pointer" : "not-allowed", opacity: fixHtmlOutput ? 1 : 0.5, color: T2, fontFamily: "inherit" }}>{copied ? "Copied ✓" : "Copy HTML"}</button>
                        {fixHtmlMatchedUrl ? (
                          <span style={{ fontSize: 11, color: T2, marginLeft: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>
                            <span style={{ color: T3 }}>Fixed against:</span> <span style={{ color: TEXT }}>{fixHtmlMatchedUrl}</span>
                            <span style={{ color: T3, marginLeft: 6 }}>({fixHtmlMatchSource})</span>
                          </span>
                        ) : fixHtmlOutput ? (
                          <span style={{ fontSize: 11, color: ORANGE, marginLeft: 4 }}>No matching crawl page — only structural fixes applied</span>
                        ) : null}
                        <span style={{ fontSize: 11, color: T3, marginLeft: "auto" }}>{fixHtmlOutput.length} chars</span>
                      </div>
                    </div>

                  </div>
                  )}{/* /panels (paid only) */}
                </div>
              );
            })()}
          </div>
        )}

        {/* History */}
        {safeActiveTab === "history" && (
          <div>
            {changeLog.length > 0 ? changeLog.map((entry, i) => {
              const prev = i > 0 ? changeLog[i - 1] : null;
              const delta = prev != null ? entry.overallScore - prev.overallScore : null;
              const deltaClass = delta == null ? "flat" : delta > 0 ? "up" : delta < 0 ? "dn" : "flat";
              const barColor = entry.overallScore >= 75 ? GREEN : entry.overallScore >= 50 ? ORANGE : RED;
              return (
                <div key={entry.runAt} style={{ display: "flex", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #f0f0f2", gap: isMobile ? 8 : 16 }}>
                  {!isMobile && <span style={{ fontSize: 13, fontWeight: 600, width: 140, flexShrink: 0 }}>{formatDate(entry.runAt)}</span>}
                  <span style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, width: isMobile ? 36 : 50, flexShrink: 0 }}>{entry.overallScore}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, width: isMobile ? 40 : 60, flexShrink: 0, color: deltaClass === "up" ? GREEN : deltaClass === "dn" ? RED : T3 }}>
                    {delta == null ? "—" : delta > 0 ? `+${delta}` : String(delta)}
                  </span>
                  <div style={{ flex: 1, height: 6, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${entry.overallScore}%`, height: "100%", borderRadius: 3, background: barColor }} />
                  </div>
                </div>
              );
            }) : isFreeTier ? (
              <ProShowcasePanel
                onUpgrade={() => setShowUpgradeModal(true)}
                title="Watch your AI visibility climb — every cycle"
                body="Pro re-audits your site automatically and tracks your GEO score over time, so you can prove progress to your team and catch silent regressions the moment a deploy breaks something."
              >
                <SampleHistoryChart />
              </ProShowcasePanel>
            ) : (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke={T3} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 16 }}>
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>No history yet</div>
                <div style={{ fontSize: 13, color: T2, maxWidth: 360, margin: "0 auto" }}>Run your first GEO audit to start tracking your score over time.</div>
              </div>
            )}
          </div>
        )}

        {/* Setup */}
        <div data-testid="setup-tab" style={activeTab !== "setup" ? { display: "none" } : undefined}>
          {safeActiveTab === "setup" && (
            <>
            {/* Free tier: sales surface. Paid tier: existing DNS + AI files install. */}
            {isFreeTier ? (
              <FreeTierSetupUpsell domain={site?.domain ?? ""} onUpgradeClick={() => setShowUpgradeModal(true)} />
            ) : (
            <>
            {/* AI Files section */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>AI Files</h3>
                {(site as SiteDataExtended)?.platformDetected && (
                  <button
                    type="button"
                    onClick={() => chatRef.current?.openWithSeed(`How do I install FlowBlinq on ${(site as SiteDataExtended).platformDetected}?`, true)}
                    data-testid="ask-cleo-about-platform"
                    style={{
                      fontSize: 12, padding: "4px 10px", borderRadius: 999,
                      border: `1px solid ${COPPER}`, background: COPPER_BG,
                      color: COPPER, cursor: "pointer", fontWeight: 500,
                      fontFamily: "inherit",
                    }}
                  >
                    Ask Cleo about {(site as SiteDataExtended).platformDetected}
                  </button>
                )}
              </div>
              {site?.domainVerified && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, marginBottom: 16 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: GREEN, flexShrink: 0, display: "inline-block" }} />
                  Domain verified
                </div>
              )}
              {AI_FILES.map(f => {
                const raw = f.field ? (site as unknown as Record<string, unknown>)?.[f.field] : null;
                const hasContent = f.field ? !!raw : true; // urls.txt always available
                const isOpen = expandedFiles.has(f.slug);
                const text = raw ? (typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)) : null;
                return (
                  <div key={f.slug} style={{ background: CARD, borderRadius: 10, border: `1px solid ${isOpen ? "rgba(194, 101, 42, 0.35)" : BORDER}`, marginBottom: 6, overflow: "hidden", transition: "all .2s", boxShadow: isOpen ? "0 0 0 1px rgba(194, 101, 42, 0.15), 0 4px 16px rgba(194, 101, 42, 0.12)" : "none" }}>
                    <div
                      style={{ display: "flex", alignItems: "center", padding: "14px 16px", gap: 12, cursor: hasContent ? "pointer" : "default" }}
                      onClick={() => {
                        if (!hasContent) return;
                        const next = new Set(expandedFiles);
                        if (next.has(f.slug)) next.delete(f.slug);
                        else next.add(f.slug);
                        setExpandedFiles(next);
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600, color: hasContent ? COPPER : T3, flex: 1 }}>{f.label}</span>
                      {hasContent ? (
                        <>
                          <span style={{ fontSize: 11, color: GREEN, fontWeight: 500 }}>Ready</span>
                          <span style={{ fontSize: 11, color: T3 }}>{isOpen ? "↑" : "↓"}</span>
                        </>
                      ) : (
                        <span style={{ fontSize: 11, color: T3 }}>Pending</span>
                      )}
                    </div>
                    {isOpen && text && (
                      <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${BORDER}` }}>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "8px 0" }}>
                          <button
                            onClick={() => navigator.clipboard.writeText(text)}
                            style={{ fontSize: 11, padding: "4px 12px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD, cursor: "pointer", fontWeight: 500, fontFamily: "inherit" }}
                          >
                            Copy
                          </button>
                          {site?.slug && (
                            <a
                              href={`/api/serve/${site.slug}/${f.slug}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: 11, padding: "4px 12px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD, cursor: "pointer", fontWeight: 500, textDecoration: "none", color: TEXT }}
                            >
                              Open URL
                            </a>
                          )}
                        </div>
                        <pre style={{ background: "#f5f5f7", borderRadius: 8, padding: "12px 16px", fontFamily: "'SF Mono', Monaco, monospace", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: 400, whiteSpace: "pre-wrap", wordBreak: "break-word", color: TEXT, border: `1px solid ${BORDER}`, margin: 0 }}>
                          {text.length > 5000 ? text.slice(0, 5000) + "\n\n… truncated" : text}
                        </pre>
                      </div>
                    )}
                    {isOpen && f.slug === "urls" && (
                      <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${BORDER}` }}>
                        <div style={{ fontSize: 12, color: T2, padding: "8px 0", lineHeight: 1.6 }}>
                          Manifest of all AI-readable files for this domain. AI crawlers fetch this URL to discover your files.
                        </div>
                        {site?.slug && (
                          <a
                            href={`/api/serve/${site.slug}/urls.txt`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ fontSize: 12, color: COPPER, fontWeight: 500, textDecoration: "none" }}
                          >
                            {`/api/serve/${site.slug}/urls.txt`} ↗
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Domain Verification section */}
            <div style={{ marginBottom: 24 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Domain Verification</h3>
              {site?.domainVerified ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, marginBottom: 16 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: GREEN, flexShrink: 0, display: "inline-block" }} />
                  Your domain is verified
                </div>
              ) : (
                <div style={{ listStyle: "none", padding: 0, margin: 0, counterReset: "step" }}>
                  {[
                    "Log in to your DNS provider (e.g. Cloudflare, Route 53, GoDaddy).",
                    "Add a TXT record for your domain with the value shown below.",
                    "Wait up to 24 hours for DNS propagation, then click Verify Domain.",
                  ].map((step, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: "1px solid #f0f0f2", fontSize: 13 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: T3, background: "#f0f0f2", width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        {i + 1}
                      </div>
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
              )}
              {!site?.domainVerified && (
                <>
                  <div style={{ background: "#f0f0f2", borderRadius: 8, padding: "12px 16px", fontFamily: "'SF Mono', Monaco, monospace", fontSize: 12, marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{site?.verifyToken ?? "Loading..."}</span>
                    <button
                      onClick={() => { if (site?.verifyToken) navigator.clipboard.writeText(site.verifyToken); }}
                      style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD, cursor: "pointer", fontWeight: 500 }}
                    >
                      Copy
                    </button>
                  </div>
                  <button
                    onClick={async () => {
                      const res = await fetch(`/api/sites/${siteId}/verify-domain`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${token}` },
                      });
                      const data = await res.json();
                      if (data.verified) {
                        setSite((prev) => prev ? { ...prev, domainVerified: true } : prev);
                      }
                      router.refresh();
                    }}
                    style={{ background: COPPER, color: "#fff", border: "none", padding: "10px 20px", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", marginTop: 12 }}
                  >
                    Verify Domain
                  </button>
                </>
              )}
            </div>

            {/* Domain Integration section (ES-074) — visible only when domain verified */}
            {site?.domainVerified && (
              <div style={{ marginBottom: 24 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Domain Integration</h3>

                {/* Green banner */}
                <div style={{ background: "#ecfdf5", border: "1px solid rgba(52,199,89,0.25)", borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: TEXT }}>
                  Domain verified. Add the config below to serve your AI files.
                </div>

                {/* Platform tab bar */}
                <div style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 12, paddingBottom: 4 }}>
                  {([
                    { key: "vercel", label: "Vercel" },
                    { key: "netlify", label: "Netlify" },
                    { key: "cloudflare", label: "Cloudflare" },
                    { key: "nginx", label: "nginx" },
                    { key: "wordpress", label: "WordPress" },
                    { key: "apache", label: "Apache" },
                    { key: "other", label: "Other ✦" },
                  ] as const).map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setIntegrationTab(key)}
                      style={{
                        background: integrationTab === key ? COPPER : "transparent",
                        color: integrationTab === key ? "#fff" : T2,
                        border: integrationTab === key ? "none" : `1px solid ${BORDER}`,
                        fontSize: 12,
                        fontWeight: 500,
                        padding: "6px 14px",
                        borderRadius: 20,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        fontFamily: "inherit",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Step pill badges */}
                {integrationTab !== "other" && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                    {["1. Add rewrites config", "2. Inject schema in layout", "3. Update robots.txt"].map(step => (
                      <span key={step} style={{ fontSize: 11, fontWeight: 500, padding: "4px 10px", borderRadius: 12, border: `1px solid ${BORDER}`, background: CARD, color: T2 }}>
                        {step}
                      </span>
                    ))}
                  </div>
                )}

                {/* Code block for standard platforms */}
                {integrationTab !== "other" && (
                  <div style={{ position: "relative", marginBottom: 12 }}>
                    <button
                      onClick={() => navigator.clipboard.writeText(integrationConfigs[integrationTab])}
                      style={{ position: "absolute", top: 8, right: 8, fontSize: 11, padding: "4px 12px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD, cursor: "pointer", fontWeight: 500, fontFamily: "inherit", zIndex: 1 }}
                    >
                      Copy
                    </button>
                    <pre role="code" style={{ background: "#f5f5f7", borderRadius: 8, padding: "12px 16px", fontFamily: "'SF Mono', Monaco, monospace", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: 400, whiteSpace: "pre-wrap", wordBreak: "break-word", color: TEXT, border: `1px solid ${BORDER}`, margin: 0 }}>
                      {integrationConfigs[integrationTab]}
                    </pre>
                  </div>
                )}

                {/* "Other" tab content */}
                {integrationTab === "other" && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      <input
                        type="text"
                        placeholder="e.g. Shopify, Caddy, Render, Heroku, Fastly…"
                        value={otherPlatform}
                        onChange={e => setOtherPlatform(e.target.value)}
                        style={{ flex: 1, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, fontFamily: "inherit", outline: "none" }}
                      />
                      <button
                        onClick={handleOtherPlatform}
                        disabled={!otherPlatform.trim() || otherLoading}
                        style={{
                          background: !otherPlatform.trim() || otherLoading ? "#e5e5e5" : COPPER,
                          color: !otherPlatform.trim() || otherLoading ? T3 : "#fff",
                          border: "none",
                          padding: "10px 20px",
                          borderRadius: 8,
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: !otherPlatform.trim() || otherLoading ? "not-allowed" : "pointer",
                          fontFamily: "inherit",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {otherLoading ? "Generating…" : "Generate"}
                      </button>
                    </div>
                    {otherError && (
                      <div style={{ color: RED, fontSize: 12, marginBottom: 8 }}>{otherError}</div>
                    )}
                    {otherConfig && (
                      <pre style={{ background: "#f5f5f7", borderRadius: 8, padding: "12px 16px", fontFamily: "'SF Mono', Monaco, monospace", fontSize: 11, lineHeight: 1.5, overflow: "auto", maxHeight: 400, whiteSpace: "pre-wrap", wordBreak: "break-word", color: TEXT, border: `1px solid ${BORDER}`, margin: 0 }}>
                        {otherConfig}
                      </pre>
                    )}
                  </div>
                )}

                {/* Test Connection */}
                <div style={{ marginTop: 8 }}>
                  <button
                    onClick={handleTestConnection}
                    disabled={testingConnection}
                    style={{
                      border: `1px solid ${BORDER}`,
                      background: CARD,
                      borderRadius: 8,
                      padding: "10px 20px",
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: testingConnection ? "not-allowed" : "pointer",
                      fontFamily: "inherit",
                      color: TEXT,
                    }}
                  >
                    {testingConnection ? "Testing…" : "Test Connection"}
                  </button>
                  {connectionResult && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 13, flexWrap: "wrap" }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: connectionResult.connected ? GREEN : RED, flexShrink: 0, display: "inline-block", "--dot-color": connectionResult.connected ? GREEN : RED } as React.CSSProperties} />
                      <span style={{ color: connectionResult.connected ? GREEN : RED, fontWeight: 500 }}>
                        {connectionResult.connected ? "Connected" : "Not connected yet"}
                      </span>
                      <span style={{ color: T2 }}>{connectionResult.detail}</span>
                      {!connectionResult.connected && (
                        <button
                          type="button"
                          onClick={() => chatRef.current?.openWithSeed(`Why isn't my llms.txt verified at ${site?.domain ?? "my site"}? Test Connection just failed.`, true)}
                          data-testid="ask-cleo-debug-connection"
                          style={{
                            fontSize: 12, padding: "3px 10px", borderRadius: 999,
                            border: `1px solid ${COPPER}`, background: COPPER_BG,
                            color: COPPER, cursor: "pointer", fontWeight: 500,
                            fontFamily: "inherit", marginLeft: "auto",
                          }}
                        >
                          Ask Cleo to debug
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
            </>
            )}
            </>
          )}
        </div>
      </main>

      {/* Chatbot — show whenever a scorecard exists (persists during re-runs) */}
      {token && site?.geoScorecard && (() => {
        const pillarsList = (site.geoScorecard as { pillars?: Array<{ pillar: string; pillarName?: string; score?: number }> } | null)?.pillars ?? [];
        const lowest = pillarsList.length
          ? pillarsList.reduce((min, p) => ((p.score ?? 100) < (min.score ?? 100) ? p : min), pillarsList[0])
          : null;
        return (
          <ChatWidget
            ref={chatRef}
            siteId={siteId}
            token={token}
            viewContext={{
              page: "results",
              currentTab: activeTab,
              domain: site.domain,
              overallScore: (site.geoScorecard as { overallScore?: number })?.overallScore,
              tier: (site as SiteDataExtended).tier === "paid" ? "paid" : "free",
              credits: (site as SiteDataExtended).credits,
              pipelineStatus: site.pipelineStatus ?? "unknown",
              platformDetected: (site as SiteDataExtended).platformDetected ?? undefined,
            }}
            siteData={{
              platformDetected: (site as SiteDataExtended).platformDetected ?? undefined,
              lowestPillar: lowest && (lowest.score ?? 100) < 50
                ? { name: lowest.pillarName ?? lowest.pillar, score: lowest.score ?? 0 }
                : undefined,
              hasIntegrationFailure: connectionResult?.connected === false,
            }}
          />
        );
      })()}
      {showUpgradeModal && (
        <UpgradeModal
          onClose={() => setShowUpgradeModal(false)}
          domain={site?.domain}
          // Pass the tier so free users get the single-path modal (Choose your
          // plan, no Credit Packs confusion). Without this it defaulted to the
          // full credit-pack UI for everyone.
          subscriptionTier={isFreeTier ? "free" : ((site as SiteDataExtended)?.subscriptionTier ?? undefined)}
        />
      )}
    </div>
  );
}
