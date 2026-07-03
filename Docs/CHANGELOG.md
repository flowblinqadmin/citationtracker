# Changelog

Notable changes to the GEO audit platform. Newest first.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Each entry records **what changed**, and — where customer-visible output can
shift — **why scores could move**, so a future reader can explain a score delta
without re-deriving it from the diff.

---

## 2026-06-10 — LLM model modernization (Gemini 2.5 → 3.x)

**Branch:** `fix/audit-incremental-on-main` (PR #193)

### Changed
- **All Gemini call sites bumped a generation:**
  - `gemini-2.5-flash` → **`gemini-3.5-flash`** (current frontier flash) in:
    `geo-analyzer.ts` (scorecard, both flash + large-crawl tier),
    `claude.ts` (Gemini fallback), `geo-crawler.ts` (URL ranking),
    `citation-prompt-generator.ts`, `competitor-discovery.ts`,
    `commerce/sov-checker.ts`, `citation-checker.ts` (brand-citation measurement).
  - `gemini-2.5-flash-lite` → **`gemini-3.1-flash-lite`** in `citation-narrative`.
  - `gemini-2.5-pro` (large-crawl tier) → **`gemini-3.5-flash`**. There is **no
    stable Gemini 3.x Pro** (`gemini-3-pro-preview` returns 404 "no longer
    available"); 3.5-flash is frontier-class AND ~2× faster than 2.5-pro in JSON
    mode, which is strictly better for the timeout-bound large crawls the Pro
    tier existed to serve. The Flash→Pro threshold + `GEMINI_PRO_CHAR_LIMIT`
    backstop are retained so a real Pro tier can return cheaply when a stable
    Gemini 3.x Pro ships.
- **Output budgets raised** where `gemini-3.5-flash`'s heavier "thinking" token
  usage (≈601 vs ≈370 thought tokens for 2.5-flash, measured) could starve the
  visible JSON — the same failure class as the 2026-06-10 live incident
  (flowblinq.com real score 72 → shown 0):
  - `geo-analyzer.ts` local-LLM branch: `16000` → `32768` (mirrors prod).
  - `geo-crawler.ts` URL ranking: `4096` → `8192`.
  - `claude.ts` Gemini fallback: floored at `max(maxTokens, 8192)`.
- **OpenAI (`gpt-5.4`, `gpt-5.4-mini`) and Claude (`claude-sonnet-4-6`)
  unchanged** — both current per their model cards as of 2026-06-10.

### ⚠️ Why citation/visibility scores may move after this deploy
`citation-checker.ts` is the model that **simulates** "does an AI assistant cite
this brand?" Changing its Google provider from `gemini-2.5-flash` to
`gemini-3.5-flash` means the **measurement instrument changed**, so a site's
Google citation/visibility numbers can shift between an audit run before this
change and one after — **even with no change to the site itself.** This is
expected and is *more* representative (3.5-flash is closer to what Gemini users
actually get today), but it is a genuine baseline shift:
- Affects: the `google` provider rows in citation checks, share-of-voice
  (`sov-checker`), and competitor discovery (`competitor-discovery`).
- Does **not** affect: the deterministic geographic scoring, OpenAI/Anthropic/
  Perplexity provider rows, or any non-LLM pillar.
- If a customer asks "why did my Gemini visibility change?", this entry is the
  answer: the underlying measurement model was modernized on 2026-06-10.

The other 8 sites are generation-side (they produce prompts/content/scorecards),
so they improve quality without re-baselining a customer-facing metric.

### Verified
- Live API calls against all new model IDs with production keys (exact SDK/REST
  patterns the code uses): `gemini-3.5-flash` (SDK @32768, SDK default, REST
  @8192), `gemini-3.1-flash-lite`, `gpt-5.4`, `gpt-5.4-mini`, `claude-sonnet-4-6`
  — all returned parseable output.
- Full Docker test suite: 4112 passed / 0 failed.
