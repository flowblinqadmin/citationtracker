# Free-Audit Conversion Audit — why free audits don't convert to signups

**Date:** 2026-06-10 · **Method:** 5 parallel buyer-psychology review agents (trust,
value/pricing, motivation/urgency, friction, aha/free-paid-balance) reviewing the
real rendered funnel (home → free results → Setup → pricing modal) + the code.

**Symptom:** many free audits, ~zero signups. Premier sales channel not converting.

---

## The core finding (4 of 5 agents, independently): the free/paid line is BACKWARDS

The funnel **hides the threat and gives away the fix** — the exact inverse of what a
free→paid wedge needs:

- **Hidden (should be shown):** the alarming, motivating proof — AI Visibility,
  Competitive SOV, Citation Quality — is **blurred behind "Unlock"** locks. The one
  thing that would scare a buyer into paying is paywalled, so the buyer never feels
  the wound. A blur reads as "marketing upsell," not "danger."
- **Given away (should be gated):** the Action Plan renders the full recommendation
  **`specificAction` + `estimatedBoost` with no `isFreeTier` gate** — a complete,
  self-implementable to-do list. Savvy buyers take the list and have their dev paste
  the files; there's no reason to pay.

**The fix:** flip it. Reveal the **diagnosis/threat** (you're invisible; competitors
are cited; here's the real number) for free; gate the **deployment/solution** (the
exact action, auto-deploy, continuous re-checks).

## Consensus problems, ranked by conversion impact

| # | Problem | Agents | Sev |
|---|---------|--------|-----|
| 1 | Free/paid line backwards (hide threat / give away fix) | Value, Motivation, Friction, Aha | HIGH |
| 2 | "64/100" frames the result as a **passing grade** → rewards inaction. No loss, no $ anchor, no urgency | Value, Motivation | HIGH |
| 3 | "**0 pages crawled · Last scanned Never**" next to a real score → the whole audit reads as **fabricated** (trust killer) | Trust, Friction, Aha | HIGH |
| 4 | Pricing sells **mechanism/volume** ("1,000 pages/mo", "competitors tracked") not **outcome** ("get cited by ChatGPT") | Value, Aha | HIGH/MED |
| 5 | **Decision paralysis**: 3 tiers × 3 billing terms × Credit Packs tab; disabled "Not available" cards; defaults to most expensive recurring option | Value, Friction | MED/HIGH |
| 6 | No **dollar/value anchor** — $99 floats against nothing | Value, Motivation | MED |
| 7 | CTA sells a **chore** ("install fixes", "Upgrade to Pro"), not the buyer's win | Value, Motivation, Friction | MED |
| 8 | Social proof is **anonymized + unverifiable + buried on Setup tab** (not at the decision point) | Trust, Motivation, Aha | MED |
| 9 | **No risk-reversal** on the subscribe screen (no guarantee / cancel-anytime / Stripe-secure) | Trust | MED |
| 10 | **OTP email round-trip** kills momentum; jarring black modal vs warm marketing | Friction | MED |
| 11 | Home form mixes free trial with **enterprise bulk-CSV** ("501 URLs") → muddies "Free, no card" | Trust, Friction | LOW/MED |
| 12 | Brand inconsistency — two accent oranges (`#b45309` vs `#c2652a`), wordmark casing | Trust | LOW |

## The single highest-ROI change (unanimous)

**Turn the free result from a reassuring score into a quantified LOSS, and fix the
"0 pages / Never" trust-killer** — at the Overview decision screen. Same data we
already compute; only the *frame* changes: lead with the gap (100−score) as customers
going to whoever AI names instead of you, show a real alarming number un-blurred, put
proof + price right there. Everything else amplifies this.

---

## Remediation roadmap (loop) — STATUS

**✅ Iteration 1 — reframe the decision screen + checkout trust (DONE):**
- Overview banner: grade → **loss framing** ("invisible for N of 100 points") + outcome CTA ("Get cited by AI →") + inline proof point.
- Fixed the trust-killing header strip for free (segments render only with real values — no "0 pages / Q&A / Never").
- Risk-reversal on the upgrade modal (✓ Cancel anytime · ✓ Secured by Stripe · ✓ No setup fees).

**✅ Iteration 2 — flip the free/paid gating (DONE):**
- Action Plan: free shows the problem + boost potential; the deploy-ready `specificAction` is **gated** behind a "the exact fix + 1-click deploy is included with Pro" CTA.

**✅ De-blanking ("too many blank pages") (DONE):**
- Hid empty SOV / Citation-Visibility / Score-History (Overview) and Geo/Category/Intent (Action Plan) cards for free; empty KPI cards turned into locked **showcases**.

**✅ Iteration 3 — pricing & modal (DONE):**
- Tiers re-specced around **outcomes** (taglines + benefit bullets), volume → fine print; **Starter $99 spotlighted** ("Best to start", was Growth/$249); Credit Packs tab hidden for free users.

**✅ Iteration 4 — funnel friction & trust polish (DONE):**
- Home form: bulk-CSV hidden behind an "Auditing multiple sites?" disclosure (clean cold entry).
- Legitimacy footer: Terms · Privacy · Contact + "FlowBlinq Inc. — a Canadian federal corporation".

**✅ Iteration 5 — verify (DONE):** all change-relevant test files green (96/101, 5 skipped); affected UI files pass in isolation + together. (Full-suite "failures" were local Supabase connection saturation on a constrained machine — random scatter across unrelated subsystems, 54 timeout errors, identical-code clean run earlier — not the conversion code.)

## Optional future polish (not blocking; some need a business decision)
- Reveal ONE real AI-mention/citation result for free (needs a product call on running a free citation probe — cost).
- "What you get" home grid: reframe DIY artifacts → outcomes + done-for-you.
- Money-back guarantee on the modal (needs business sign-off — only true claims shipped).
- Unify the two accent oranges (`#b45309` vs `#c2652a`) + wordmark casing.
- Sourced stats on home ("12.4%", "2.3×" → cite the source).
