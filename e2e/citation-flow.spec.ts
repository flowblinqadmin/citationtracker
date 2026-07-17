// The definition-of-done flow: login (shared Supabase session) → create brand
// → library + custom prompts → cost preview → run debits credits → the
// IN-REPO engine executes the run for real → results render → 402 upsell when
// broke → unauthenticated redirect. All under the /citations basePath.
//
// What is REAL vs stubbed here: E2E_FAKE_PROVIDERS stubs the four provider
// queryFns, the redirect resolver, AND the sentiment classifier (a fixed
// 'positive'). So worker auth, the runner/worklist, URL matching, metrics,
// billing, persistence, and polling are the production path; the Gemini
// sentiment CLASSIFIER and redirect resolution are NOT exercised — the
// sentiment assertion below verifies the classifier's result PROPAGATES to the
// UI, not that classification is correct (that's covered by unit tests of
// parseSentiment + the org-gating wiring).
import { test, expect } from "@playwright/test";
import { setBalance, getBalance } from "./helpers/db";
import { E2E } from "./helpers/global-setup";

test.use({ storageState: E2E.storageState });
test.describe.configure({ mode: "serial" });

const brandName = `E2E Brand ${Date.now()}`;

test("basePath smoke: app serves under /citations with a valid session", async ({ page }) => {
  await page.goto("/citations");
  // A brand-less team is routed straight into the onboarding wizard — that IS
  // the landing experience now; the brand list renders only once brands exist.
  await expect(page).toHaveURL(/\/citations\/onboarding/);
  await expect(page.getByRole("heading", { name: /let.?s set up your brand/i })).toBeVisible();
  // Credits live in the shared global header chip (geo look-alike), rendered
  // at layout level — visible on the wizard too.
  await expect(page.getByText("20 credits")).toBeVisible();

  // Global header makes geo + citations look like one product: the FLOWBLINQ
  // GEO wordmark, an Audits link pointing at geo's dashboard (plain path, no
  // /citations basePath prefix), and the signed-in user's email.
  await expect(page.getByText("FLOWBLINQ GEO")).toBeVisible();
  await expect(page.getByRole("link", { name: "Audits" })).toHaveAttribute("href", "/dashboard");
  await expect(page.getByText(E2E.email)).toBeVisible();
});

test("create brand → add prompts → cost preview", async ({ page }) => {
  // Brand creation UI is now the onboarding wizard (covered end-to-end by
  // onboarding.spec.ts). This suite seeds its brand through the API — the
  // same endpoint the wizard's commit sequence calls — and focuses on the
  // brand-detail management surface.
  const created = await page.request.post("/citations/api/brands", {
    data: { name: brandName, domain: "acme-e2e.com" },
  });
  expect(created.status()).toBe(201);

  await page.goto("/citations");
  await page.getByRole("link", { name: new RegExp(brandName) }).click();

  // One library prompt (token filled with the brand name) + one custom.
  await page.getByRole("button", { name: "+ Add from library" }).click();
  await page.getByRole("button", { name: "What is the company" }).click();
  await expect(page.getByText(`What is ${brandName} and what does the company do?`)).toBeVisible();

  await page.getByPlaceholder(/write your own prompt/).fill("Which citation trackers do PR teams use?");
  await page.getByRole("button", { name: "Add custom" }).click();
  await expect(page.getByText("Which citation trackers do PR teams use?")).toBeVisible();

  // Per prompt × per model (ChatGPT/Perplexity/Gemini 2, Claude 4): 2 prompts × 4 models → 20 credits.
  await expect(page.getByRole("button", { name: /Run now · 20 credits/ })).toBeVisible();
});

test("run now debits credits; the in-repo engine executes and completes the run", async ({ page }) => {
  await page.goto("/citations");
  await page.getByRole("link", { name: new RegExp(brandName) }).click();
  await page.getByRole("button", { name: /Run now/ }).click();

  await expect(page.getByText(/Run started — 20 credits/)).toBeVisible({ timeout: 15_000 }); // dev-server route compile on first hit
  expect(await getBalance()).toBe(0);

  // The REAL worker + runner execute on this dev server (2 prompts × 4
  // platforms, fake providers). The 5s poll surfaces completion + metrics.
  await expect(page.getByText("complete")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Brand mentions").first()).toBeVisible();
  // The library prompt echoes the brand name through the provider fixture; the
  // custom prompt doesn't → brand mention rate is exactly 1/2.
  await expect(page.getByText("50%").first()).toBeVisible();
});

test("engine results surface: sentiment split and actual replies", async ({ page }) => {
  await page.goto("/citations");
  await page.getByRole("link", { name: new RegExp(brandName) }).click();

  // Sentiment PROPAGATION: the stubbed classifier returns 'positive' for every
  // brand-mentioned reply, and the Overview split surfaces a non-zero positive
  // bucket — proving the classifier result flows through persistence into the
  // UI (not that the real Gemini classifier is correct).
  await expect(page.getByText(/\d+ positive/).first()).toBeVisible({ timeout: 15_000 });

  // Replies live on the Runs tab: the stored text is the provider fixture output.
  await page.getByRole("button", { name: /Runs \(\d+\)/ }).click();
  await page.getByRole("button", { name: "View replies" }).first().click();
  await expect(page.getByText(/e2e provider fixture/).first()).toBeVisible();
});

test("competitor editor: saved competitors persist and SoAV lights up retroactively", async ({ page }) => {
  await page.goto("/citations");
  await page.getByRole("link", { name: new RegExp(brandName) }).click();

  // Without competitors the brand wins every citation it has: 8/(8+0) = 100%.
  const soavCard = page.getByText("Tracked-prompt share", { exact: false }).locator("..");
  await expect(soavCard.getByText("100%")).toBeVisible();

  await page.getByRole("button", { name: "+ Add competitor" }).click();
  await page.getByPlaceholder("Competitor name (e.g. Apollo)").fill("Third Party");
  await page.getByPlaceholder("Domain (e.g. apollo.com)").fill("thirdparty.example");
  await page.getByRole("button", { name: "Save competitors" }).click();
  await expect(page.getByText(/Competitors saved/)).toBeVisible({ timeout: 10_000 });

  // Persisted across reload, and the ALREADY-completed run's citations now
  // split brand vs competitor (fixture cites one of each per reply → 50%).
  await page.reload();
  // 15s like the run test: a full document reload can hit the dev server's
  // on-demand recompile (slow on symlinked-node_modules worktrees).
  await expect(page.getByPlaceholder("Domain (e.g. apollo.com)")).toHaveValue("thirdparty.example", { timeout: 15_000 });
  const soavAfter = page.getByText("Tracked-prompt share", { exact: false }).locator("..");
  await expect(soavAfter.getByText("50%")).toBeVisible();
});

test("insufficient credits → 402 upsell, no charge", async ({ page }) => {
  await setBalance(0);
  await page.goto("/citations");
  await page.getByRole("link", { name: new RegExp(brandName) }).click();
  await page.getByRole("button", { name: /Run now/ }).click();
  await expect(page.getByText(/Not enough credits/)).toBeVisible({ timeout: 15_000 });
  expect(await getBalance()).toBe(0);
  await setBalance(20);
});

test("unauthenticated page hit redirects to geo login", async ({ browser }) => {
  const context = await browser.newContext({ storageState: undefined }); // strip the inherited auth state
  const page = await context.newPage();
  const response = await page.goto("/citations");
  // GEO_ORIGIN points at this same server in e2e; the redirect lands on a
  // non-existent /auth/login there — asserting the URL is enough.
  expect(page.url()).toContain("/auth/login");
  expect(page.url()).toContain(encodeURIComponent("/citations"));
  expect(response).not.toBeNull();
  await context.close();
});
