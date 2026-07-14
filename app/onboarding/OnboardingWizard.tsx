"use client";

// The onboarding wizard shell — thin over lib/onboarding.ts. Owns wizard state,
// fetches the credit balance at mount, drives step navigation via canProceed,
// and exposes the commit sequence (createBrand → prompts → tracked-urls → run)
// to Step5. GeoHeader renders at layout level; this is only the wizard body.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiUrl } from "@/lib/api-url";
import { normalizeDomain } from "@/lib/domain";
import {
  buildDefaultPrompts,
  buildBrandInput,
  mergeSuggestedPrompts,
  runCost,
  canProceed,
  runSkip,
  clampStep,
  initialWizardState,
  BUY_CREDITS_FALLBACK,
  type WizardState,
  type WizardStep,
  type WizardCompetitor,
  type WizardPrompt,
} from "@/lib/onboarding";
import type { TrackerRunFrequency } from "@/lib/types/tracker";
import Step1Brand from "./Step1Brand";
import Step2Competitors from "./Step2Competitors";
import Step3Prompts from "./Step3Prompts";
import Step4TrackedUrls from "./Step4TrackedUrls";
import Step5 from "./Step5";
import { UI } from "@/app/ui";

const CARD = UI.CARD;
const BORDER = UI.BORDER_CSS;
const MUTED = UI.T2;
const ACCENT = UI.COPPER;
const ON_ACCENT = UI.ON_ACCENT;

type CommitStage = "" | "brand" | "prompts" | "tracked-urls" | "run" | "done";

// Home auto-redirects brand-less teams back here; flag the skip so that guard
// lets us out to the brand list instead of bouncing us straight back in.
function flagSkipped() {
  try {
    sessionStorage.setItem("cite-onboarding-skipped", "1");
  } catch {
    /* ignore — SSR / storage disabled */
  }
}

export default function OnboardingWizard() {
  const router = useRouter();
  const [state, setState] = useState<WizardState>(initialWizardState);
  const [balance, setBalance] = useState<number | null>(null);
  const [buyCreditsUrl, setBuyCreditsUrl] = useState<string | null>(null);

  // Commit-sequence progress (kept across retries so we resume, never re-POST).
  const [brandId, setBrandId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [committedUrls, setCommittedUrls] = useState(false);
  const [commitStage, setCommitStage] = useState<CommitStage>("");
  const [commitError, setCommitError] = useState<string | null>(null);
  // How many prompts have already POSTed OK — resume point after a mid-loop
  // failure so a Retry never re-POSTs (and re-debits) prompts 0..i-1. A ref so
  // the in-flight loop reads its own increments, and it survives re-renders.
  const committedPromptCountRef = useRef(0);
  // Whether the first-run POST has already fired — a Retry after the run started
  // must not start (and debit) a second run. The in_flight gate only catches a
  // still-pending run; this covers an already-completed one too.
  const runPostedRef = useRef(false);

  // Suggest-in-flight (step 2) — the Continue button waits on it so late
  // suggestions still reach the step-3 prompt list instead of being discarded.
  const [suggestLoading, setSuggestLoading] = useState(false);

  // Skip-in-flight — disables the Skip button while its brand create is pending
  // so a double-click can't create the brand twice.
  const [skipping, setSkipping] = useState(false);

  // Balance at mount for the credit meter.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(apiUrl("/api/teams/me"));
        if (res.ok) setBalance((await res.json()).creditBalance ?? null);
      } catch {
        /* meter degrades to hidden */
      }
    })();
  }, []);

  const patch = useCallback((p: Partial<WizardState>) => setState((s) => ({ ...s, ...p })), []);

  // Populate default prompts the first time we reach step 3 (merged with any
  // suggested prompts stashed in step 2).
  const goToStep = useCallback(
    (step: WizardStep) => {
      setState((s) => {
        if (step === 3 && s.prompts.length === 0) {
          const defaults = buildDefaultPrompts(s.brandName.trim() || "your brand");
          return { ...s, step, prompts: mergeSuggestedPrompts(s.suggestedPrompts, defaults) };
        }
        return { ...s, step };
      });
    },
    [],
  );

  const selectedPrompts = useMemo(() => state.prompts.filter((p) => p.selected), [state.prompts]);
  const cost = runCost(selectedPrompts.length).credits;
  const canAdvance = canProceed(state.step, state);

  // The single brand-creation path — POST /api/brands from the current wizard
  // state, returning the new brand id. Shared by the launch commit and Skip.
  const createBrand = useCallback(async (): Promise<string> => {
    const res = await fetch(apiUrl("/api/brands"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBrandInput(state)),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not create brand");
    return (await res.json()).brand.id as string;
  }, [state]);

  // ── Commit sequence — idempotent, resumes from the failed stage ─────────────
  const commit = useCallback(async () => {
    setCommitError(null);
    try {
      // 1. Brand (never re-POST if we already have an id).
      let clientId = brandId;
      if (!clientId) {
        setCommitStage("brand");
        clientId = await createBrand();
        setBrandId(clientId);
        // Brand now exists — the auto-redirect's "escape the empty state" guard
        // has served its purpose, so drop the skip flag (see app/page.tsx).
        try {
          sessionStorage.removeItem("cite-onboarding-skipped");
        } catch {
          /* ignore — SSR / storage disabled */
        }
      }

      // 2. Prompts — POST each selected prompt sequentially, resuming from the
      // last confirmed index so a mid-loop failure + Retry never re-POSTs (and
      // re-debits) prompts already created (createPrompt has no dedup).
      if (committedPromptCountRef.current < selectedPrompts.length) {
        setCommitStage("prompts");
        for (let i = committedPromptCountRef.current; i < selectedPrompts.length; i++) {
          const p = selectedPrompts[i];
          const res = await fetch(apiUrl(`/api/brands/${clientId}/prompts`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: p.name, category: p.category, text: p.text }),
          });
          if (!res.ok) throw new Error("Could not save a prompt");
          committedPromptCountRef.current = i + 1;
        }
      }

      // 3. Tracked URLs — skip if none.
      if (!committedUrls) {
        if (state.trackedUrls.length > 0) {
          setCommitStage("tracked-urls");
          const res = await fetch(apiUrl(`/api/brands/${clientId}/tracked-urls`), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: state.trackedUrls }),
          });
          if (!res.ok) throw new Error("Could not save tracked URLs");
        }
        setCommittedUrls(true);
      }

      // 4. Start the first run — exactly once. A Retry after the run already
      // started (or completed) must not fire a second POST: the route's
      // in_flight gate only catches a still-pending run, so a completed one
      // would be started (and debited) again.
      if (!runPostedRef.current) {
        setCommitStage("run");
        const runRes = await fetch(apiUrl(`/api/brands/${clientId}/run`), { method: "POST" });
        if (runRes.status === 402) {
          const body = await runRes.json().catch(() => ({}));
          setBuyCreditsUrl(body.buyCreditsUrl ?? BUY_CREDITS_FALLBACK);
          throw new Error("You don't have enough credits for the first run. Buy credits and retry.");
        }
        if (!runRes.ok) throw new Error("Could not start the first run");
        // The run POST succeeded (201 started, or 200 alreadyRunning) — record
        // that BEFORE parsing the body so a parse failure can't strand us into
        // re-POSTing on Retry.
        runPostedRef.current = true;
        const runBody = await runRes.json().catch(() => ({}));
        setRunId(runBody.run?.id ?? null);
      }
      setCommitStage("done");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setCommitError(message);
      toast.error(message);
    }
  }, [brandId, committedUrls, selectedPrompts, state, createBrand]);

  // Skip onboarding — but don't discard a brand the user already entered. With a
  // valid step-1 brand, create it first and land on its page; otherwise leave to
  // the (empty) brand list. A create failure surfaces the error and stays put.
  const handleSkip = useCallback(() => {
    if (skipping) return;
    setSkipping(true);
    setCommitError(null);
    void runSkip(state, {
      createBrand,
      onSuccess: (id) => {
        flagSkipped();
        router.push(`/brands/${id}`);
      },
      onDiscard: () => {
        flagSkipped();
        router.push("/");
      },
      onError: (message) => {
        setCommitError(message);
        toast.error(message);
        setSkipping(false);
      },
    });
  }, [skipping, state, createBrand, router]);

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "40px 24px" }}>
      {/* progress chips */}
      <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
        {[1, 2, 3, 4, 5].map((n) => {
          const active = state.step === n;
          const done = state.step > n;
          return (
            <span
              key={n}
              style={{ padding: "5px 12px", borderRadius: 999, fontSize: 12, border: active ? `1px solid ${ACCENT}` : BORDER, background: active || done ? UI.COPPER_BG : CARD, color: active || done ? ACCENT : MUTED, fontWeight: active ? 600 : 400 }}
            >
              {n}
            </span>
          );
        })}
      </div>

      <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: 28 }}>
        {state.step === 1 && (
          <Step1Brand
            domain={state.domain}
            brandName={state.brandName}
            onDomain={(v) => patch({ domain: v })}
            onBrandName={(v) => patch({ brandName: v })}
          />
        )}
        {state.step === 2 && (
          <Step2Competitors
            domain={state.domain}
            competitors={state.competitors}
            onCompetitors={(rows: WizardCompetitor[]) => patch({ competitors: rows })}
            onSuggestedPrompts={(prompts: string[]) => patch({ suggestedPrompts: prompts })}
            onSuggestLoading={setSuggestLoading}
          />
        )}
        {state.step === 3 && (
          <Step3Prompts
            prompts={state.prompts}
            onPrompts={(p: WizardPrompt[]) => patch({ prompts: p })}
            runFrequency={state.runFrequency}
            onFrequency={(f: TrackerRunFrequency) => patch({ runFrequency: f })}
            balance={balance}
            buyCreditsUrl={buyCreditsUrl}
          />
        )}
        {state.step === 4 && (
          <Step4TrackedUrls
            trackedUrls={state.trackedUrls}
            onTrackedUrls={(urls: string[]) => patch({ trackedUrls: urls })}
            onSkip={() => goToStep(5)}
          />
        )}
        {state.step === 5 && (
          <Step5
            brandId={brandId}
            runId={runId}
            commit={commit}
            commitStage={commitStage}
            commitError={commitError}
            cost={cost}
            brandName={state.brandName.trim()}
            brandDomain={normalizeDomain(state.domain) ?? state.domain}
            promptCount={selectedPrompts.length}
            competitorCount={state.competitors.filter((c) => c.name.trim() && normalizeDomain(c.domain)).length}
            trackedUrlCount={state.trackedUrls.length}
            frequency={state.runFrequency}
          />
        )}
      </div>

      {/* nav */}
      {state.step < 5 && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>
          <button
            onClick={() => goToStep(clampStep(state.step - 1))}
            disabled={state.step === 1}
            style={{ padding: "10px 18px", background: "transparent", border: "none", color: MUTED, fontSize: 14, cursor: state.step === 1 ? "default" : "pointer", opacity: state.step === 1 ? 0.4 : 1 }}
          >
            Back
          </button>
          {(() => {
            // Step 2 must wait for the suggest call — its late prompts feed the
            // step-3 list, which is built once on entry. Disabled label reads as
            // work, not breakage.
            const waitingOnSuggest = state.step === 2 && suggestLoading;
            const disabled =
              !canAdvance ||
              (state.step === 3 && balance !== null && cost > balance) ||
              waitingOnSuggest;
            return (
              <button
                onClick={() => goToStep(clampStep(state.step + 1))}
                disabled={disabled}
                style={{ padding: "10px 18px", background: ACCENT, color: ON_ACCENT, border: "none", borderRadius: 8, fontSize: 14, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}
              >
                {waitingOnSuggest ? "Analyzing your site…" : state.step === 4 ? "Launch" : "Continue"}
              </button>
            );
          })()}
        </div>
      )}

      {/* Skip is only offered before the launch commit begins. Once commit()
          has created a brand (brandId) or entered any stage, Skip must not fire
          a second createBrand — that would duplicate the brand and abandon the
          run the user just launched. */}
      {brandId === null && commitStage === "" && (
        <p style={{ textAlign: "center", marginTop: 24 }}>
          <button
            onClick={handleSkip}
            disabled={skipping}
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 13, cursor: skipping ? "default" : "pointer", textDecoration: "underline", opacity: skipping ? 0.5 : 1 }}
          >
            {skipping ? "Saving your brand…" : "Skip onboarding"}
          </button>
        </p>
      )}
    </main>
  );
}
