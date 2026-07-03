import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Phase 3 correction Q5: PDF assertions via pdf-parse (binding decision).
test.describe("FI-035 — Download PDF report (content assertion)", () => {
  test.fixme(true, "Requires paid tier + credits; pdf-parse dev dep");
  test("pdf download contains expected sections (scorecard, recommendations)", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    const dlPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /download.*pdf/i }).click();
    const dl = await dlPromise;
    const tmp = path.join(os.tmpdir(), dl.suggestedFilename());
    await dl.saveAs(tmp);
    const pdfParse = (await import("pdf-parse")).default as (b: Buffer) => Promise<{ text: string }>;
    const buf = fs.readFileSync(tmp);
    const { text } = await pdfParse(buf);
    expect(text.toLowerCase()).toMatch(/scorecard|recommend/i);
    // @scope-question FI-035: confirm exact section headers in generated PDF
  });
});
