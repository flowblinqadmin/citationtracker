// Onboarding wizard end-to-end: the first-run flow a brand-less team hits when
// it lands on /citations. Step 1 (brand identity) → Step 2 (competitors, which
// degrade to empty here because there are no provider keys) → Step 3 (the 15
// curated prompts + the honest credit meter) → Step 4 (tracked URLs) → Step 5
// (commit sequence → REAL in-repo runner executes with fake providers → ready
// modal + punch list → brand page with the getting-started checklist).
//
// What is REAL vs stubbed: same seam as citation-flow.spec — E2E_FAKE_PROVIDERS
// stubs the four provider queryFns + the sentiment classifier + redirect
// resolver. Everything else (brand/prompt/tracked-url creation, the debit, the
// worker + runner, polling, punch-list derivation) is the production path.
import { test, expect } from "@playwright/test";
import { setBalance as setBalanceFor, getBalance as getBalanceFor } from "./helpers/db";
import { E2E_ONBOARDING } from "./helpers/global-setup";

// This file runs on its OWN seeded team (E2E_ONBOARDING): it rewrites the
// balance and creates brands, which would race citation-flow.spec's pristine
// 20-credit team in a parallel worker.
const setBalance = (credits: number) => setBalanceFor(credits, E2E_ONBOARDING.teamId);
const getBalance = () => getBalanceFor(E2E_ONBOARDING.teamId);

test.use({ storageState: E2E_ONBOARDING.storageState });
test.describe.configure({ mode: "serial" });

// Ample balance so the 150-credit first run clears and the meter math is known.
const START_BALANCE = 200;
const domain = "acme-onboard-e2e.com";
const brandNameExpected = "Acme-onboard-e2e"; // brandFromDomain: first label, capitalized

test.describe("onboarding wizard — full first-run flow", () => {
  test("empty team lands on the wizard, walks all 5 steps, runs, and reaches the brand report", async ({ page }) => {
    // Full journey: ~20 sequential API calls in the commit sequence plus a
    // 14-prompt × 4-platform engine run — the 30s default test budget is only
    // enough on an idle dev server.
    test.setTimeout(180_000);
    await setBalance(START_BALANCE);

    // (1) A team with credits and 0 brands hitting /citations is redirected to
    // the onboarding wizard (the brand list replaces to /onboarding on empty).
    await page.goto("/citations");
    await expect(page).toHaveURL(/\/citations\/onboarding/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /let.?s set up your brand/i })).toBeVisible();

    // (2) Step 1 — type the domain; on blur the brand name auto-fills; Next.
    // Wait for the valid-domain hint (re-render committed) BEFORE blurring so the
    // blur handler's closure sees the normalized domain — otherwise a fill+blur
    // in the same tick can race the state commit and skip the auto-fill.
    await page.getByPlaceholder("acme.com").fill(domain);
    await expect(page.getByText("We found your brand", { exact: false })).toBeVisible();
    await page.getByPlaceholder("acme.com").blur();
    await expect(page.getByPlaceholder("Acme", { exact: true })).toHaveValue(brandNameExpected);
    await page.getByRole("button", { name: "Continue" }).click();

    // (3) Step 2 — the suggest call degrades gracefully in this env (no provider
    // keys → empty competitors). Add one competitor manually, then Next.
    await expect(page.getByRole("heading", { name: "Your brand competitors" })).toBeVisible();
    await page.getByRole("button", { name: "+ Add competitor" }).click();
    await page.getByPlaceholder("Competitor name").fill("Rival Co");
    await page.getByPlaceholder("rival.com").fill("rival-onboard-e2e.com");
    await page.getByRole("button", { name: "Continue" }).click();

    // (4) Step 3 — 15 pre-checked curated prompts + the honest credit meter.
    await expect(page.getByRole("heading", { name: /Review .* select prompts/i })).toBeVisible();
    const checkboxes = page.getByRole("checkbox");
    await expect(checkboxes).toHaveCount(15);
    // Every default is pre-selected.
    expect(await checkboxes.evaluateAll((els) => els.every((e) => (e as HTMLInputElement).checked))).toBe(true);
    await expect(page.getByText("15/15 prompts selected")).toBeVisible();

    // Credit meter: 15 × 10 = 150, and the after-first-run balance.
    await expect(page.getByText("15 prompts × 10 credits = 150 credits per run")).toBeVisible();
    await expect(page.getByText(`Balance: ${START_BALANCE} → after first run: ${START_BALANCE - 150}`)).toBeVisible();

    // Deselect one prompt → meter recomputes to 14 × 10 = 140.
    await checkboxes.first().uncheck();
    await expect(page.getByText("14/15 prompts selected")).toBeVisible();
    await expect(page.getByText("14 prompts × 10 credits = 140 credits per run")).toBeVisible();

    // Keep frequency "manual" so the post-onboarding getting-started checklist
    // has an outstanding item ("Schedule set") and stays rendered on the brand
    // page — a fully-completed checklist unmounts the card entirely.
    await page.getByRole("combobox").selectOption("manual");
    await page.getByRole("button", { name: "Continue" }).click();

    // (5) Step 4 — paste one publicity URL, then Launch.
    await expect(page.getByRole("heading", { name: /Where are you doing publicity/i })).toBeVisible();
    await page.getByRole("textbox").fill("https://outlet.example/acme-feature");
    await expect(page.getByText("1/50 URLs")).toBeVisible();
    await page.getByRole("button", { name: "Launch" }).click();

    // (6) Step 5 — the pre-commit summary + CTA showing the cost. 14 selected → 140.
    await expect(page.getByRole("heading", { name: "Ready to launch" })).toBeVisible();
    const cta = page.getByRole("button", { name: /Run my first report \(140 credits\)/ });
    await expect(cta).toBeVisible();

    const before = await getBalance();
    expect(before).toBe(START_BALANCE);

    await cta.click();

    // Commit stages run, then the processing copy is visible while the REAL
    // runner executes (14 prompts × 4 platforms, fake providers).
    await expect(page.getByText("Welcome aboard!")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/processing live AI answers/i)).toBeVisible();

    // The fake-provider run completes → the ready modal.
    await expect(page.getByRole("heading", { name: "Your brand report is ready!" })).toBeVisible({ timeout: 90_000 });

    // The debit actually happened: balance dropped by exactly the run cost (140).
    expect(await getBalance()).toBe(START_BALANCE - 140);

    // The punch list renders (fixture output → at least the coverage grid).
    await expect(page.getByText("What to fix next")).toBeVisible();

    // View my brand report → lands on the brand page with the getting-started
    // checklist visible.
    await page.getByRole("link", { name: "View my brand report" }).click();
    await expect(page).toHaveURL(/\/citations\/brands\//, { timeout: 15_000 });
    await expect(page.getByText("Getting started", { exact: true })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("onboarding wizard — broke team", () => {
  test("0 credits: step 3 shows the credits-short state and the step-5 CTA is disabled", async ({ page }) => {
    await setBalance(0);

    // The first spec already created a brand for this shared team, so /citations
    // no longer auto-redirects (redirect is gated on 0 brands). Reach the wizard
    // via the "Add brand" link so it arrives client-side-navigated and fully
    // hydrated (a raw goto to /onboarding can run fill() before hydration and
    // drop the controlled-input onChange).
    await page.goto("/citations");
    await page.getByRole("link", { name: "Add brand" }).click();
    await expect(page.getByRole("heading", { name: /let.?s set up your brand/i })).toBeVisible({ timeout: 15_000 });

    // Step 1.
    await page.getByPlaceholder("acme.com").fill("broke-onboard-e2e.com");
    // Wait for the valid-domain hint (state committed) before blurring — see the
    // full-flow spec for why. Auto-fill then supplies the brand name.
    await expect(page.getByText("We found your brand", { exact: false })).toBeVisible();
    await page.getByPlaceholder("acme.com").blur();
    const step1Continue = page.getByRole("button", { name: "Continue" });
    await expect(step1Continue).toBeEnabled();
    await step1Continue.click();

    // Step 2 → straight through (competitors optional, none added).
    await expect(page.getByRole("heading", { name: "Your brand competitors" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 3 — 150-credit run against a 0 balance surfaces the inline
    // "credits short" state with a Buy credits link, and Continue is disabled.
    await expect(page.getByText("15 prompts × 10 credits = 150 credits per run")).toBeVisible();
    await expect(page.getByText(/You.?re 150 credits short/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Buy credits" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();

    // Restore for any later runs.
    await setBalance(START_BALANCE);
  });
});
