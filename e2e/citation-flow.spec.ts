// The definition-of-done flow: login (shared Supabase session) → create brand
// → library + custom prompts → cost preview → run debits credits → the
// IN-REPO engine executes the run for real (E2E_FAKE_PROVIDERS stubs the four
// providers; everything else — worker auth, runner, matching, sentiment,
// metrics — is the production path) → results render → 402 upsell when broke
// → unauthenticated redirect. All under the /citations basePath.
import { test, expect } from "@playwright/test";
import { setBalance, getBalance } from "./helpers/db";
import { E2E } from "./helpers/global-setup";

test.use({ storageState: E2E.storageState });
test.describe.configure({ mode: "serial" });

const brandName = `E2E Brand ${Date.now()}`;

test("basePath smoke: app serves under /citations with a valid session", async ({ page }) => {
  await page.goto("/citations");
  await expect(page).toHaveURL(/\/citations/);
  await expect(page.getByRole("heading", { name: "Citations" })).toBeVisible();
  await expect(page.getByText("20 credits")).toBeVisible();
});

test("create brand → add prompts → cost preview", async ({ page }) => {
  await page.goto("/citations");
  await page.getByPlaceholder("Brand name (e.g. Acme)").fill(brandName);
  await page.getByPlaceholder("Domain (e.g. acme.com)").fill("acme-e2e.com");
  await page.getByRole("button", { name: "Add brand" }).click();
  await page.getByRole("link", { name: new RegExp(brandName) }).click();

  // One library prompt (token filled with the brand name) + one custom.
  await page.getByRole("button", { name: "+ Add from library" }).click();
  await page.getByRole("button", { name: "What is the company" }).click();
  await expect(page.getByText(`What is ${brandName} and what does the company do?`)).toBeVisible();

  await page.getByPlaceholder(/write your own prompt/).fill("Which citation trackers do PR teams use?");
  await page.getByRole("button", { name: "Add custom" }).click();
  await expect(page.getByText("Which citation trackers do PR teams use?")).toBeVisible();

  // 1 credit per prompt per model: 2 prompts × 4 models → 8 credits.
  await expect(page.getByRole("button", { name: /Run now · 8 credits/ })).toBeVisible();
});

test("run now debits credits; the in-repo engine executes and completes the run", async ({ page }) => {
  await page.goto("/citations");
  await page.getByRole("link", { name: new RegExp(brandName) }).click();
  await page.getByRole("button", { name: /Run now/ }).click();

  await expect(page.getByText(/Run started — 8 credits/)).toBeVisible({ timeout: 15_000 }); // dev-server route compile on first hit
  expect(await getBalance()).toBe(12);

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

  // Sentiment: classified 'positive' for every brand-mentioned reply by the
  // e2e classifier stub — the Overview split shows a non-zero positive bucket.
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
  const soavCard = page.getByText("Share of AI voice", { exact: true }).locator("..");
  await expect(soavCard.getByText("100%")).toBeVisible();

  await page.getByRole("button", { name: "+ Add competitor" }).click();
  await page.getByPlaceholder("Competitor name (e.g. Apollo)").fill("Third Party");
  await page.getByPlaceholder("Domain (e.g. apollo.com)").fill("thirdparty.example");
  await page.getByRole("button", { name: "Save competitors" }).click();
  await expect(page.getByText(/Competitors saved/)).toBeVisible({ timeout: 10_000 });

  // Persisted across reload, and the ALREADY-completed run's citations now
  // split brand vs competitor (fixture cites one of each per reply → 50%).
  await page.reload();
  await expect(page.getByPlaceholder("Domain (e.g. apollo.com)")).toHaveValue("thirdparty.example");
  const soavAfter = page.getByText("Share of AI voice", { exact: true }).locator("..");
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
