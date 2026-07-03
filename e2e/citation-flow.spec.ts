// The definition-of-done flow: login (shared Supabase session) → create brand
// → library + custom prompts → cost preview → run debits credits → metrics
// render after the worker completes → 402 upsell when broke → unauthenticated
// redirect. All under the /citations basePath.
import { test, expect } from "@playwright/test";
import { setBalance, getBalance, completeRun, latestRunId } from "./helpers/db";
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

test("run now debits credits and completes with metrics", async ({ page }) => {
  await page.goto("/citations");
  await page.getByRole("link", { name: new RegExp(brandName) }).click();
  await page.getByRole("button", { name: /Run now/ }).click();

  await expect(page.getByText(/Run started — 8 credits/)).toBeVisible({ timeout: 15_000 }); // dev-server route compile on first hit
  await expect(page.getByText("pending").or(page.getByText("running"))).toBeVisible();
  expect(await getBalance()).toBe(12);

  // Simulate geo's worker finishing; the 5s poll should surface metrics.
  const runId = await latestRunId();
  expect(runId).toBeTruthy();
  await completeRun(runId!);
  await expect(page.getByText("complete")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Brand mentions")).toBeVisible();
  await expect(page.getByText("100%")).toBeVisible(); // brand mention rate from seeded metrics
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
