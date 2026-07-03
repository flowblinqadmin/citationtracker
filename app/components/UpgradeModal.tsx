"use client";

import { useState, useRef } from "react";
import { toast } from "sonner";
import { SUBSCRIPTION_TIERS, UPFRONT_PRICES, CREDITS_PER_PACK, CREDITS_PRICE_USD, PAGES_PER_CREDIT, BillingInterval } from "@/lib/config";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";

type Tab = "plans" | "credits";

// Spotlight Starter, not Growth (conversion audit 2026-06-10): the problem is
// getting the FIRST conversion, not ARPU. Highlighting $249 made the $99 entry
// feel stripped-down. Lead each tier with an OUTCOME, not "pages/mo".
const PLAN_TIERS = [
  { key: "starter" as const, ...SUBSCRIPTION_TIERS.starter, popular: true,  badge: "Best to start", tagline: "Get cited by AI — done for you" },
  { key: "growth" as const,  ...SUBSCRIPTION_TIERS.growth,  popular: false, badge: null,            tagline: "Win AI answers vs competitors" },
  { key: "pro" as const,     ...SUBSCRIPTION_TIERS.pro,     popular: false, badge: null,            tagline: "Multi-site & agency scale" },
];

const ACCENT = "#b45309";
const TEXT = "#1c1917";
const TEXT_2 = "#78716c";
const TEXT_3 = "#a8a29e";
const BORDER = "rgba(0,0,0,0.07)";
const GREEN = "#16a34a";

export default function UpgradeModal({
  credits,
  domain,
  sitePages,
  returnTo,
  onClose,
  subscriptionTier,
}: {
  credits?: number;
  domain?: string;
  sitePages?: number;
  returnTo?: string;
  onClose: () => void;
  /** If "free", credit-pack tab shows an upsell to /pricing instead of the quantity slider. */
  subscriptionTier?: string | null;
}) {
  // Show upsell ONLY when subscriptionTier is explicitly "free" (not when absent/null).
  // Callers that don't pass subscriptionTier get the normal credit-pack slider.
  const isFreeSubscription = subscriptionTier === "free";
  const isMobile = useMediaQuery(768);
  const [activeTab, setActiveTab] = useState<Tab>("plans");
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("monthly");
  const [subscribingPlan, setSubscribingPlan] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Credit pack state
  const recommendedPacks = sitePages && sitePages > 0
    ? Math.max(1, Math.ceil(sitePages / (CREDITS_PER_PACK * PAGES_PER_CREDIT)))
    : 1;
  const [packs, setPacks] = useState(recommendedPacks);
  const [creditLoading, setCreditLoading] = useState(false);

  const totalCredits = packs * CREDITS_PER_PACK;
  const totalPages = totalCredits * PAGES_PER_CREDIT;
  const totalPrice = packs * CREDITS_PRICE_USD;
  const fallbackReturnTo = typeof window !== "undefined"
    ? window.location.pathname + window.location.search
    : "/dashboard";

  function handlePackChange(val: number) {
    setPacks(Math.max(1, Math.min(50, val)));
  }

  async function handleSubscribe(plan: string) {
    setSubscribingPlan(plan);
    try {
      const r = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, interval: billingInterval, returnTo: returnTo ?? fallbackReturnTo }),
      });
      if (r.status === 401 || r.status === 409) {
        window.location.href = `/auth/login?redirectTo=${encodeURIComponent(returnTo ?? fallbackReturnTo)}`;
        return;
      }
      const d = await r.json() as { checkoutUrl?: string; error?: string };
      if (d.checkoutUrl) window.location.href = d.checkoutUrl;
      else toast.error(d.error ?? "Failed to start checkout.");
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSubscribingPlan(null);
    }
  }

  async function handleCreditCheckout() {
    setCreditLoading(true);
    try {
      const r = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnTo: returnTo ?? fallbackReturnTo, quantity: packs }),
      });
      if (r.status === 401 || r.status === 409) {
        window.location.href = `/auth/login?redirectTo=${encodeURIComponent(returnTo ?? fallbackReturnTo)}`;
        return;
      }
      const d = await r.json() as { checkoutUrl?: string; error?: string };
      if (d.checkoutUrl) window.location.href = d.checkoutUrl;
      else toast.error(d.error ?? "Failed to start checkout.");
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setCreditLoading(false);
    }
  }

  function getPlanPrice(planKey: "starter" | "growth" | "pro"): { amount: number | null; label: string; savings: string | null } {
    const monthly = SUBSCRIPTION_TIERS[planKey].price;
    if (billingInterval === "quarterly") {
      const q = UPFRONT_PRICES[planKey].quarterly;
      if (q !== null) {
        const saved = monthly * 3 - q;
        return { amount: q, label: "/ quarter", savings: `Save $${saved}` };
      }
      return { amount: null, label: "Not available", savings: null };
    }
    if (billingInterval === "annual") {
      const a = UPFRONT_PRICES[planKey].annual;
      if (a !== null) {
        const saved = monthly * 12 - a;
        return { amount: a, label: "/ year", savings: `Save $${saved}` };
      }
      return { amount: null, label: "Not available", savings: null };
    }
    return { amount: monthly, label: "/month", savings: null };
  }

  const tabStyle = (tab: Tab): React.CSSProperties => ({
    flex: 1,
    padding: "10px 16px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    borderBottom: activeTab === tab ? `2px solid ${ACCENT}` : `2px solid transparent`,
    background: "none",
    color: activeTab === tab ? TEXT : TEXT_3,
    transition: "color 0.15s, border-color 0.15s",
  });

  return (
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{
        background: "#fff", borderRadius: "16px", padding: "0",
        maxWidth: "640px", width: "90%", position: "relative",
        boxShadow: "0 25px 50px rgba(0,0,0,0.25)",
        // Cap height + scroll so the (now vertically-stacked on mobile) tiers
        // don't overflow the viewport and get clipped.
        maxHeight: "92vh", overflowY: "auto", overflowX: "hidden",
      }}>
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: "absolute", top: "16px", right: "16px",
            background: "none", border: "none", fontSize: "20px",
            cursor: "pointer", color: "#999", lineHeight: 1, zIndex: 10,
          }}
        >×</button>

        {/* Tabs — Credit Packs hidden for free users (conversion audit 2026-06-10):
            two pricing models side-by-side at the decision moment causes "which do
            I even buy?" paralysis. Free users see one path: a subscription. */}
        <div style={{ display: "flex", borderBottom: `1px solid ${BORDER}` }}>
          <button style={tabStyle("plans")} onClick={() => setActiveTab("plans")}>
            {isFreeSubscription ? "Choose your plan" : "Monthly Plans"}
          </button>
          {!isFreeSubscription && (
            <button style={tabStyle("credits")} onClick={() => setActiveTab("credits")}>
              Credit Packs
            </button>
          )}
        </div>

        {/* Tab Content */}
        <div style={{ padding: "24px 28px 32px" }}>
          {activeTab === "plans" ? (
            <>
              {/* 3-state billing toggle */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", marginBottom: "20px" }}>
                {(["monthly", "quarterly", "annual"] as BillingInterval[]).map((interval) => (
                  <button
                    key={interval}
                    onClick={() => setBillingInterval(interval)}
                    style={{
                      padding: "8px 14px",
                      borderRadius: "8px",
                      border: billingInterval === interval ? `2px solid ${ACCENT}` : "2px solid transparent",
                      background: billingInterval === interval ? "#fef3e2" : "none",
                      color: billingInterval === interval ? ACCENT : TEXT_2,
                      fontSize: "13px",
                      fontWeight: 600,
                      cursor: "pointer",
                      textTransform: "capitalize" as const,
                    }}
                  >
                    {interval.charAt(0).toUpperCase() + interval.slice(1)}
                  </button>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: "12px" }}>
                {PLAN_TIERS.map((plan) => {
                  const { amount, label, savings } = getPlanPrice(plan.key);
                  const tier = SUBSCRIPTION_TIERS[plan.key];

                  return (
                    <div
                      key={plan.key}
                      data-plan={plan.key}
                      style={{
                        border: plan.popular ? `2px solid ${ACCENT}` : `1px solid ${BORDER}`,
                        borderRadius: "12px",
                        padding: "20px 16px",
                        textAlign: "center",
                        position: "relative",
                      }}
                    >
                      {plan.badge && (
                        <div style={{
                          position: "absolute", top: "-10px", left: "50%",
                          transform: "translateX(-50%)",
                          background: ACCENT, color: "#fff",
                          fontSize: "9px", fontWeight: 700, padding: "3px 10px",
                          borderRadius: "100px", textTransform: "uppercase" as const,
                          letterSpacing: "0.05em", whiteSpace: "nowrap",
                        }}>
                          {plan.badge}
                        </div>
                      )}
                      <div style={{ fontSize: "13px", fontWeight: 600, color: plan.popular ? ACCENT : TEXT_2, textTransform: "uppercase" as const, marginBottom: "8px" }}>
                        {plan.name}
                      </div>
                      <div style={{ fontSize: amount !== null ? "32px" : "20px", fontWeight: 800, color: amount !== null ? TEXT : TEXT_3, marginBottom: "2px" }}>
                        {amount !== null ? `$${amount.toLocaleString()}` : "—"}
                      </div>
                      <div style={{ fontSize: "12px", color: amount !== null ? TEXT_2 : TEXT_3, marginBottom: savings ? "4px" : "12px" }}>{label}</div>
                      {savings && (
                        <div style={{ fontSize: "11px", color: GREEN, fontWeight: 600, marginBottom: "8px" }}>
                          {savings}
                        </div>
                      )}
                      <div style={{ fontSize: "12px", fontWeight: 600, color: plan.popular ? ACCENT : TEXT, marginBottom: "12px", minHeight: 30, lineHeight: 1.3 }}>
                        {plan.tagline}
                      </div>
                      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 10px", textAlign: "left" }}>
                        <li style={{ fontSize: 11, color: TEXT_2, marginBottom: 5 }}>✓ llms.txt, schema &amp; business.json deployed for you</li>
                        <li style={{ fontSize: 11, color: TEXT_2, marginBottom: 5 }}>✓ Re-checked &amp; re-deployed every cycle so you stay cited</li>
                        <li style={{ fontSize: 11, color: TEXT_2, marginBottom: 5 }}>
                          ✓ Track {tier.maxCompetitors} competitor{(tier.maxCompetitors as number) !== 1 ? "s" : ""} in AI answers
                        </li>
                      </ul>
                      <div style={{ fontSize: 10, color: TEXT_3, marginBottom: 12 }}>
                        {plan.pages.toLocaleString()} pages/mo · {tier.maxAuditPages === null ? "unlimited" : tier.maxAuditPages} pages/audit
                      </div>
                      <button
                        onClick={() => amount !== null && handleSubscribe(plan.key)}
                        disabled={subscribingPlan !== null || amount === null}
                        style={{
                          width: "100%",
                          padding: "10px",
                          borderRadius: "8px",
                          border: "none",
                          background: amount === null ? "#e5e5e5" : subscribingPlan === plan.key ? "#d4d4d4" : ACCENT,
                          color: amount === null ? TEXT_3 : "#fff",
                          fontSize: "13px",
                          fontWeight: 700,
                          cursor: subscribingPlan !== null || amount === null ? "not-allowed" : "pointer",
                        }}
                      >
                        {subscribingPlan === plan.key ? "Redirecting..." : amount === null ? "Not available" : "Subscribe"}
                      </button>
                    </div>
                  );
                })}
              </div>
              {/* Risk-reversal — the subscribe screen is the highest-commitment moment
                  and previously had zero reassurance (conversion audit 2026-06-10).
                  Only unambiguously-true claims here; a money-back guarantee would help
                  further but needs business sign-off before adding. */}
              <div style={{ textAlign: "center", fontSize: "12px", color: TEXT_3, marginTop: "16px", display: "flex", justifyContent: "center", gap: "16px", flexWrap: "wrap" }}>
                <span>✓ Cancel anytime</span>
                <span>✓ Secured by Stripe</span>
                <span>✓ No setup fees</span>
              </div>
            </>
          ) : isFreeSubscription ? (
            /* Fix #39: free-tier teams see an upsell to /pricing instead of the credit-pack slider */
            <div
              data-testid="upgrade-modal-credits-upsell"
              style={{ textAlign: "center", padding: "12px 0 8px" }}
            >
              <div style={{ fontSize: "40px", marginBottom: "12px" }}>&#11088;</div>
              <h2 style={{ fontSize: "20px", fontWeight: 800, margin: "0 0 8px", color: TEXT }}>
                Credit Packs require a subscription
              </h2>
              <p style={{ fontSize: "14px", color: TEXT_2, margin: "0 0 28px", lineHeight: 1.6 }}>
                Upgrade to Starter or higher to purchase credit packs and unlock full audit capabilities.
              </p>
              <button
                type="button"
                onClick={() => setActiveTab("plans")}
                style={{
                  display: "inline-block", width: "100%", padding: "14px", borderRadius: "10px",
                  background: ACCENT, color: "#fff", fontSize: "15px", fontWeight: 700,
                  border: "none", cursor: "pointer", boxSizing: "border-box" as const,
                }}
              >
                See plans &#8594;
              </button>
              <p style={{ fontSize: "12px", color: TEXT_3, textAlign: "center", marginTop: "12px", marginBottom: 0 }}>
                Plans start at $99/month. No commitment required.
              </p>
            </div>
          ) : (
            <>
              <h2 style={{ fontSize: "20px", fontWeight: 800, margin: "0 0 4px", color: TEXT }}>
                {credits != null && credits > 0 ? "Buy Credits" : "Upgrade to Pro"}
              </h2>
              <p style={{ fontSize: "14px", color: TEXT_2, margin: "0 0 24px" }}>
                {domain
                  ? <>Unlock the full report for <strong style={{ color: TEXT }}>{domain}</strong></>
                  : credits != null
                    ? <>You currently have <strong style={{ color: TEXT }}>{credits}</strong> credits</>
                    : "Purchase credits to run audits"
                }
              </p>

              {/* Recommendation */}
              {sitePages != null && sitePages > 0 && (
                <div style={{
                  background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "10px",
                  padding: "12px 16px", marginBottom: "20px", fontSize: "13px", color: "#92400e",
                }}>
                  Your site has <strong>{sitePages.toLocaleString()} pages</strong> — we recommend{" "}
                  <strong>{recommendedPacks} {recommendedPacks === 1 ? "pack" : "packs"}</strong> to cover a full audit.
                </div>
              )}

              {/* Pack selector */}
              <div style={{ marginBottom: "20px" }}>
                <label style={{ fontSize: "13px", fontWeight: 600, color: TEXT_2, display: "block", marginBottom: "8px" }}>
                  Credit packs
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <button
                    onClick={() => handlePackChange(packs - 1)}
                    disabled={packs <= 1}
                    style={{
                      width: "36px", height: "36px", borderRadius: "8px",
                      border: "1px solid #e5e5e5", background: packs <= 1 ? "#f5f5f5" : "#fff",
                      fontSize: "18px", fontWeight: 700, cursor: packs <= 1 ? "not-allowed" : "pointer",
                      color: packs <= 1 ? "#ccc" : TEXT,
                    }}
                  >&minus;</button>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={packs}
                    onChange={(e) => handlePackChange(parseInt(e.target.value) || 1)}
                    style={{
                      width: "64px", textAlign: "center", fontSize: "18px", fontWeight: 700,
                      border: "1px solid #e5e5e5", borderRadius: "8px", padding: "6px",
                      color: TEXT, outline: "none",
                    }}
                  />
                  <button
                    onClick={() => handlePackChange(packs + 1)}
                    disabled={packs >= 50}
                    style={{
                      width: "36px", height: "36px", borderRadius: "8px",
                      border: "1px solid #e5e5e5", background: packs >= 50 ? "#f5f5f5" : "#fff",
                      fontSize: "18px", fontWeight: 700, cursor: packs >= 50 ? "not-allowed" : "pointer",
                      color: packs >= 50 ? "#ccc" : TEXT,
                    }}
                  >+</button>
                </div>
              </div>

              {/* Summary */}
              <div style={{
                background: "#fafaf9", borderRadius: "10px", padding: "16px",
                marginBottom: "24px", display: "flex", flexDirection: "column", gap: "8px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px" }}>
                  <span style={{ color: TEXT_2 }}>Credits</span>
                  <span style={{ fontWeight: 700, color: TEXT }}>{totalCredits.toLocaleString()}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px" }}>
                  <span style={{ color: TEXT_2 }}>Pages</span>
                  <span style={{ fontWeight: 700, color: TEXT }}>up to {totalPages.toLocaleString()}</span>
                </div>
                <div style={{ borderTop: "1px solid #e5e5e5", marginTop: "4px", paddingTop: "8px", display: "flex", justifyContent: "space-between", fontSize: "16px" }}>
                  <span style={{ fontWeight: 700, color: TEXT }}>Total</span>
                  <span style={{ fontWeight: 800, color: ACCENT, fontSize: "20px" }}>${totalPrice}</span>
                </div>
              </div>

              {/* CTA */}
              <button
                onClick={handleCreditCheckout}
                disabled={creditLoading}
                style={{
                  width: "100%", padding: "14px", borderRadius: "10px", border: "none",
                  background: creditLoading ? "#d4d4d4" : ACCENT, color: "#fff",
                  fontSize: "15px", fontWeight: 700, cursor: creditLoading ? "not-allowed" : "pointer",
                }}
              >
                {creditLoading ? "Redirecting..." : `Pay $${totalPrice} \u2192`}
              </button>

              <p style={{ fontSize: "12px", color: TEXT_3, textAlign: "center", marginTop: "12px", marginBottom: 0 }}>
                Secure payment via Stripe. Credits never expire.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
