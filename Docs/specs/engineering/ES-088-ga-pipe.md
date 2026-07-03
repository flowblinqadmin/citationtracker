# ES-088 — `ga-pipe` engineering spec

**Status:** DRAFT (authored 2026-04-21 by Shastri, companion to TS-088).
**TS anchor:** `docs/specs/technical/TS-088-ga-pipe.md`.
**Scope:** C++ binary only. Server-side API is in TS-087 / ES-087.
**Code location:** `geo/api-clients/cpp/` in the `api/pageviews-read` worktree.

## 1. Repo layout

```
geo/api-clients/cpp/
├── CMakeLists.txt                    — top-level CMake, C++17, -Wall -Wextra -Werror
├── README.md                         — customer-facing: build, configure, run
├── cmake/
│   └── Deps.cmake                    — FetchContent for libcurl, nlohmann/json, yaml-cpp, inja, Catch2
├── include/ga_pipe/
│   ├── config.hpp                    — Config loader (pipe.yaml)
│   ├── auth_client.hpp               — OAuth2 JWT fetch/refresh
│   ├── flowblinq_reader.hpp          — GET /api/v1/page_views paginator
│   ├── response_validator.hpp        — validates flowblinq JSON against expected schema
│   ├── page_view.hpp                 — PageView POD + JSON parse
│   ├── page_view_queue.hpp           — bounded SPSC queue
│   ├── sink_template.hpp             — Inja template + constraints
│   ├── sink.hpp                      — HTTP POST sink with retry
│   ├── state_file.hpp                — atomic persist, schema-versioned
│   ├── dead_letter.hpp               — ndjson append-only
│   ├── logger.hpp                    — structured JSON log, secret redaction
│   ├── signal_handler.hpp            — SIGTERM/SIGINT shutdown flag
│   └── version.hpp                   — embedded semver
├── src/
│   └── *.cpp                         — one implementation per header
├── apps/
│   └── ga_pipe_main.cpp              — binary entry (arg parse, thread orchestration)
├── sinks/
│   ├── ga4.yaml                      — GA4 Measurement Protocol v2 template
│   └── webhook.yaml                  — generic HMAC-signed webhook template
├── tests/
│   ├── unit/
│   │   ├── config_test.cpp
│   │   ├── auth_client_test.cpp
│   │   ├── queue_test.cpp
│   │   ├── sink_template_test.cpp
│   │   ├── state_file_test.cpp
│   │   ├── retry_backoff_test.cpp
│   │   ├── logger_redaction_test.cpp
│   │   └── response_validator_test.cpp
│   ├── integration/
│   │   ├── mock_flowblinq_server.hpp — httplib-based mock
│   │   ├── mock_ga4_server.hpp       — httplib-based mock
│   │   ├── end_to_end_test.cpp       — full reader→queue→writer flow
│   │   ├── restart_resume_test.cpp   — kill + relaunch, no dup/gap
│   │   ├── sigterm_drain_test.cpp
│   │   └── malformed_response_test.cpp  — consecutive-malformed threshold → exit 3
│   └── fixtures/
│       ├── manipal_100rows.json      — replay fixture from production CSV
│       └── state_corrupt.json        — hand-crafted for recovery test
└── .github/workflows/ci.yml          — GitHub Actions: linux + mac; cmake build + ctest
```

Build produces a single static-linked binary `ga-pipe` in `build/apps/`. Linker flags statically link glibc where possible; dynamic libcurl allowed (customer machines have it).

Excluded from the `geo` Next.js build via `.vercelignore` entry `api-clients/` and from TypeScript via `tsconfig.json` `exclude` addition.

## 2. Class model

```
┌──────────────┐     ┌─────────────────┐     ┌───────────────┐
│  Config      │     │  AuthClient     │     │ FlowblinqReader│
│  (load once) │──▶──│ (JWT cache +    │──▶──│ (HTTP GET +   │
│              │     │  auto-refresh)  │     │  paginate)    │
└──────────────┘     └─────────────────┘     └───────┬───────┘
                                                     │ push rows
                                                     ▼
                                             ┌───────────────┐
                                             │ PageViewQueue │ bounded, SPSC
                                             │ (mutex+2 cv)  │ block-on-full/empty
                                             └───────┬───────┘
                                                     │ pop rows
                                                     ▼
┌──────────────┐     ┌─────────────────┐     ┌───────────────┐
│ SinkTemplate │     │  Sink           │     │  Writer loop  │
│ (Inja compile│──▶──│ (HTTP POST +    │──◀──│ (main in      │
│  + constraint│     │  retry backoff) │     │   writer thr) │
│  checks)     │     └─────────────────┘     └───────┬───────┘
└──────────────┘                                     │ on ok
                                                     ▼
                                             ┌───────────────┐
                                             │  StateFile    │
                                             │ (atomic write,│
                                             │  fsync'd)     │
                                             └───────────────┘
```

Thread ownership:
- **main thread:** owns `Config`, `SignalHandler`. Reads state once to seed cursor. Spawns reader + writer. Joins on shutdown.
- **reader thread:** owns `AuthClient`, `FlowblinqReader`. Only producer into `PageViewQueue`.
- **writer thread:** owns `SinkTemplate`, `Sink`, `StateFile`, `DeadLetter`. Only consumer from queue. Only mutator of state file.

## 3. Core interfaces (headers)

### 3.1 `page_view.hpp`

```cpp
struct PageView {
    std::string id;
    std::string page_url;
    std::string referrer;        // may be empty
    std::string visitor_id;      // may be empty
    std::string user_agent;
    std::string ip;
    std::string country;
    int         screen_width;
    std::string viewed_at;       // RFC3339 UTC, e.g. "2026-04-21T15:29:45.123Z"

    static PageView fromJson(const nlohmann::json& j);
};
```

### 3.2 `page_view_queue.hpp`

```cpp
class PageViewQueue {
public:
    explicit PageViewQueue(size_t capacity);

    // Blocking push. Returns false only if queue is closed.
    bool push(PageView v);

    // Blocking pop. Returns std::nullopt only if queue is closed and empty.
    std::optional<PageView> pop();

    // Signal shutdown: unblock all waiters; subsequent pushes fail; pops drain until empty.
    void close();

    size_t size() const;

private:
    const size_t m_capacity;
    std::deque<PageView> m_q;
    mutable std::mutex   m_mx;
    std::condition_variable m_not_full;
    std::condition_variable m_not_empty;
    bool m_closed = false;
};
```

**Invariants:**
- `m_q.size() <= m_capacity` at all times (enforced by `m_not_full` wait in `push`).
- `push` holds `m_mx` only across `m_q.push_back` + `m_not_empty.notify_one` — never across I/O.
- `pop` identical pattern.
- `close` flips `m_closed`, then `notify_all` on both cvs. After close, `push` returns false immediately; `pop` drains remaining items then returns `nullopt`.

### 3.2.1 `response_validator.hpp`

```cpp
enum class MalformedReason {
    BadJson, MissingKey, BadType, MissingRowKey, BadRowType
};

struct ValidationError {
    MalformedReason reason;
    std::string     detail;       // key name or type hint; truncated to 128 bytes
    std::string     body_excerpt; // first 256 bytes of raw response body
};

// Throws ValidationError on any schema mismatch; returns parsed ReadPage on success.
ReadPage validatePageViewsResponse(const std::string& raw_body);
```

Required top-level keys: `domain`, `slug_resolved`, `served_ts`, `rows`, `has_more`, `next_cursor`.
Per-row required keys: `id`, `page_url`, `viewed_at`. Validator is strict on type (string/number/bool); optional fields may be absent or null but must match expected type when present.

### 3.3 `flowblinq_reader.hpp`

```cpp
struct ReadPage {
    std::vector<PageView> rows;
    bool        has_more;
    std::string next_cursor;     // empty if !has_more
};

class FlowblinqReader {
public:
    FlowblinqReader(const Config& cfg, AuthClient& auth);

    // Fetch one page from API. Caller supplies cursor (empty on first call).
    // Throws ReaderError on non-retriable error (4xx except 401/429).
    // Blocks and retries internally on 401 (refresh+retry), 429 (honor Retry-After), 5xx (expo backoff).
    ReadPage readPage(const std::string& cursor);

private:
    CURL* m_curl;
    const Config& m_cfg;
    AuthClient&  m_auth;
};
```

### 3.4 `sink_template.hpp`

```cpp
struct RenderedRequest {
    std::string method;                               // POST
    std::string url;
    std::map<std::string, std::string> headers;
    std::string body;                                 // serialized JSON
};

class SinkTemplate {
public:
    static SinkTemplate loadFromYaml(const std::filesystem::path& p);

    // Render one PageView into an HTTP request per the template.
    // Runs post-render constraint checks; throws ConstraintViolation if body too large, etc.
    RenderedRequest render(const PageView& pv, const std::map<std::string,std::string>& env) const;

    // Classify an HTTP response status per template retry_policy.
    enum class Disposition { Ok, Retriable, NonRetriable };
    Disposition classify(int http_status) const;

    const RetryPolicy& retryPolicy() const;

private:
    inja::Environment m_env;
    inja::Template    m_tmpl;
    Constraints       m_constraints;
    RetryPolicy       m_retry;
    std::set<int>     m_retriable, m_non_retriable;
};
```

### 3.5 `state_file.hpp`

```cpp
struct PipeState {
    int schema_version = 1;
    std::optional<Cursor> cursor;         // {viewed_at, id}; nullopt on fresh install
    uint64_t served_count_total = 0;
    uint64_t deadletter_count_total = 0;
    std::string last_successful_sink_ts;
    std::optional<std::string> last_error;

    nlohmann::json toJson() const;
    static PipeState fromJson(const nlohmann::json& j);
};

class StateFile {
public:
    explicit StateFile(std::filesystem::path p);

    // Read state from disk. If missing → default PipeState. If corrupt → throw StateCorrupt.
    PipeState load() const;

    // Atomic persist: write to <path>.tmp, fsync, rename <path>.tmp → <path>.
    // Throws StateWriteError on any I/O failure (caller may deadletter the row).
    void persist(const PipeState& s) const;

private:
    std::filesystem::path m_path;
};
```

**Atomicity proof:** POSIX guarantees `rename` is atomic on same filesystem. `fsync` on the temp file before rename ensures durability. Reader thread never touches state file; only writer thread calls `persist`. Single-writer means no lock needed.

**Corruption recovery:** on `load` throwing `StateCorrupt`, main logs an ERROR and halts (exit 2). Customer manually deletes `state.json` to restart from `now-72h`. We deliberately do NOT auto-heal — silent re-delivery of 72h of events could double-bill the customer's analytics.

## 4. Reader loop (pseudocode)

```cpp
void readerLoop(FlowblinqReader& reader, PageViewQueue& q, std::atomic<bool>& shutdown,
                const std::optional<Cursor>& seed_cursor, int poll_interval_s,
                int malformed_threshold, std::atomic<int>& exit_code) {
    std::string cursor = seed_cursor ? encodeCursor(*seed_cursor) : "";
    int consecutive_malformed = 0;
    while (!shutdown.load()) {
        ReadPage page;
        try {
            page = reader.readPage(cursor);
            consecutive_malformed = 0;  // any valid response resets
        } catch (const ReaderError& e) {
            logger::error("reader.fatal", {{"err", e.what()}});
            shutdown.store(true);
            exit_code.store(1);
            break;
        } catch (const ValidationError& v) {
            logger::error("reader.malformed_response", {
                {"reason", malformedReasonToStr(v.reason)},
                {"detail", v.detail},
                {"body_excerpt", v.body_excerpt},
                {"consecutive", ++consecutive_malformed},
            });
            if (consecutive_malformed >= malformed_threshold) {
                std::fprintf(stderr,
                    "ga-pipe: received %d consecutive malformed responses from flowblinq; "
                    "shutting down. Likely causes: API version mismatch, upstream outage, "
                    "or wrong base_url in pipe.yaml.\n", consecutive_malformed);
                shutdown.store(true);
                exit_code.store(3);
                break;
            }
            // Skip the page; do NOT advance cursor; try again next tick.
            interruptibleSleep(poll_interval_s, shutdown);
            continue;
        }
        for (auto& row : page.rows) {
            if (!q.push(std::move(row))) break;  // queue closed
        }
        cursor = page.next_cursor;
        if (!page.has_more) {
            interruptibleSleep(poll_interval_s, shutdown);
        }
    }
    q.close();
}
```

**Burst vs idle:** when `has_more=true`, reader loops without sleeping — API's 120/hr rate limit bounds burst rate server-side. When `has_more=false`, reader sleeps `poll_interval_s` (default 60). This is the sole pacing mechanism on the pipe side.

## 5. Writer loop (pseudocode)

```cpp
void writerLoop(SinkTemplate& tmpl, Sink& sink, PageViewQueue& q, StateFile& state,
                DeadLetter& dl, std::atomic<bool>& shutdown) {
    PipeState s = state.load();
    const auto env = buildEnvMap();  // exposes FLOWBLINQ_DOMAIN etc. to templates

    while (auto row_opt = q.pop()) {
        const PageView& row = *row_opt;
        RenderedRequest req;
        try {
            req = tmpl.render(row, env);
        } catch (const ConstraintViolation& e) {
            dl.append(row, /*reason=*/e.what());
            s.deadletter_count_total++;
            advanceCursor(s, row);
            state.persist(s);
            continue;
        }

        const auto disposition = postWithRetry(sink, tmpl, req, shutdown);
        if (disposition == Disposition::Ok) {
            s.served_count_total++;
            s.last_successful_sink_ts = nowIso();
            advanceCursor(s, row);
            state.persist(s);
        } else {  // NonRetriable or retry budget exhausted
            dl.append(row, /*reason=*/dispositionToStr(disposition));
            s.deadletter_count_total++;
            advanceCursor(s, row);
            state.persist(s);
        }
    }
    // Queue closed; flush one last state write and exit.
    state.persist(s);
}
```

## 6. Retry backoff

Exponential with full jitter (AWS style):

```cpp
int backoff_ms(int attempt, const RetryPolicy& p) {
    const int base = std::min(p.max_backoff_ms, p.initial_backoff_ms * (1 << attempt));
    if (!p.jitter) return base;
    std::uniform_int_distribution<> d(0, base);
    return d(rng);
}
```

Honors `Retry-After` header when present (overrides computed backoff).

## 7. Error taxonomy

| Source | Error | Action | Retriable? |
|---|---|---|---|
| Network (connect/timeout) on flowblinq | libcurl CURLE_* | Expo backoff up to `max_attempts=5`; then shutdown | yes (within budget) |
| Flowblinq 401 | token_expired | AuthClient refresh + retry same request | yes (1 shot) |
| Flowblinq 429 | rate_limit | Sleep `Retry-After`; retry | yes |
| Flowblinq 5xx | server_error | Expo backoff | yes (within budget) |
| Flowblinq 4xx (except 401/429) | client_error | Log FATAL, shutdown | no |
| Template render failure | missing key / bad filter | Deadletter row with reason; advance cursor | no |
| Flowblinq response validation failure | missing_key / bad_type / bad_json | Log `reader.malformed_response`, increment consecutive counter, skip page, do NOT advance cursor; on threshold breach → exit 3 | yes (within budget) |
| Constraint violation (body too big etc.) | oversize / field_overflow | Deadletter row with reason; advance cursor | no |
| Sink 2xx | ok | Advance cursor, persist state | — |
| Sink retriable (per template) | retry | Expo backoff up to retry budget | yes (within budget) |
| Sink non-retriable (per template) | deadletter | Deadletter row, advance cursor | no |
| State write failure | disk_full / permission | Log ERROR, keep row in flight, sleep, retry | yes |

## 8. Shutdown semantics

SIGTERM/SIGINT → `signal_handler` sets `shutdown` atomic flag.

1. Main thread observes flag, sets `q.close()` indirectly by signalling reader.
2. Reader observes `shutdown`, exits its loop, calls `q.close()`.
3. Writer pops remaining queue items, processes each; when `q.pop()` returns `nullopt`, writer exits.
4. Main joins both threads, flushes final state, closes logger, exits 0.

**Hard deadline:** 30 seconds. If writer hasn't drained in 30s (stuck on a non-retriable sink with long retry budget), main force-closes queue, logs the backlog count, exits 1. Customer can inspect state file to see how far it got.

**Exit codes:**

| Code | Trigger |
|---|---|
| 0 | Normal shutdown (SIGTERM/SIGINT drained cleanly) |
| 1 | Force-close after shutdown hard deadline, or reader fatal (non-validation) |
| 2 | State file corrupt on load — manual intervention required |
| 3 | Consecutive malformed flowblinq responses exceeded `reader.malformed_response_threshold` |

## 9. Complexity

**Per-row time:**
- Queue push: O(1) amortized (deque).
- Reader render: N/A (reader doesn't render; writer does).
- Template render: O(template_size + row_size) ≈ O(1) with Inja's compiled template (template pre-compiled at startup).
- HTTP POST: dominated by RTT.
- State persist: O(state_size) ≈ O(1) — state.json is tiny (<1 KB).
- fsync: ~1 ms on SSD, ~5 ms on spinning disk. This is the hot-path bottleneck at high throughput.

**Memory:**
- Queue: O(queue_capacity × sizeof(PageView)) ≈ 1000 × 1 KB = 1 MB steady-state.
- libcurl HTTP buffers: O(page_size) ≈ O(1 MB) per in-flight GET/POST.
- Template env (Inja): O(template_size) one-time.
- Total RSS target: <50 MB steady-state, <200 MB burst.

**Throughput expectation:**
- Reader: bounded by flowblinq 120 req/hr = 120k rows/hr = ~33 rows/s.
- Writer: bounded by sink RTT. GA4 MP is ~100-200 ms; so ~5-10 rows/s per pipe without batching. Below reader ceiling; queue drains faster than it fills in steady state.
- Result: at sustained >10 rows/s generation, queue backpressure engages and reader naturally throttles.

## 10. Observability

Structured JSON to stdout (default); one log line per event. Levels: `trace|debug|info|warn|error|fatal`.

**Canonical event names (grepable):**
- `pipe.start`, `pipe.shutdown`
- `reader.page_fetched` (rows_count, has_more, duration_ms)
- `reader.auth_refresh`, `reader.rate_limited`
- `writer.sink_ok` (row_id, duration_ms, retries)
- `writer.sink_retry` (row_id, attempt, backoff_ms, http_status)
- `writer.deadletter` (row_id, reason)
- `state.persisted` (served_total, deadletter_total)
- `queue.pressure` (depth, emitted every 30s if depth > 80% capacity)

**Secret redaction:** log formatter walks each record; any key matching `/^(client_secret|api_secret|password|bearer|authorization)$/i` (case-insensitive) is replaced with `"[REDACTED]"`. Unit test asserts raw secret string never appears in captured log output (see `logger_redaction_test.cpp`).

## 11. Test plan

Maps to TS-088 §5 success criteria 1:1.

| TS # | Test file | Test name |
|---|---|---|
| 1 | `end_to_end_test.cpp` | `fresh_install_no_state_uses_72h_default` |
| 2 | `restart_resume_test.cpp` | `resume_from_state_no_duplicates` |
| 3 | `end_to_end_test.cpp` | `sink_500_retries_expo_backoff` |
| 4 | `end_to_end_test.cpp` | `sink_400_deadletters_and_advances` |
| 5 | `end_to_end_test.cpp` | `flowblinq_429_honors_retry_after` |
| 6 | `end_to_end_test.cpp` | `flowblinq_401_refreshes_jwt_no_loss` |
| 7 | `sink_template_test.cpp` + `end_to_end_test.cpp` | `oversize_body_deadletters_before_post` |
| 8 | `sigterm_drain_test.cpp` | `sigterm_drains_queue_within_30s` |
| 9 | `restart_resume_test.cpp` | `cursor_determinism_across_restarts` |
| 10 | `sink_template_test.cpp` | `template_swap_same_row_different_request` |
| 11 | `end_to_end_test.cpp` | `72h_boundary_rows_forwarded_ga4_silently_drops` |
| 12 | `end_to_end_test.cpp` | `multiple_instances_isolated_state_files` |
| 13 | `malformed_response_test.cpp` | `ten_consecutive_malformed_triggers_exit_3` |
| 14 | `malformed_response_test.cpp` | `valid_response_resets_consecutive_malformed_counter` |

**Unit coverage targets:**
- `queue_test.cpp` — push/pop contention, capacity enforcement, close-wakes-waiters, SPSC invariants (ThreadSanitizer + AddressSanitizer enabled).
- `state_file_test.cpp` — atomic write verified by injecting a crash between `fsync` and `rename` (via fault injection fd); corruption detection via truncated file fixture.
- `retry_backoff_test.cpp` — distribution of computed backoffs; `Retry-After` override precedence; max budget exhaustion.
- `logger_redaction_test.cpp` — every known secret key redacted across log levels; fuzz on random JSON structures.

**Integration harness:** `mock_flowblinq_server` and `mock_ga4_server` are cpp-httplib-based (header-only) servers that Catch2 fixtures spin up on ephemeral ports. Tests inject specific failure modes (inject 500 on Nth call, delay response by 5s, drop connection) via test-only endpoints.

**Sanitizers:** CI builds with `-fsanitize=thread,address,undefined` on linux debug build. Release build drops sanitizers for performance.

## 12. Build + CI

```bash
# Local build
cd geo/api-clients/cpp
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j$(nproc)
ctest --test-dir build --output-on-failure
```

**GitHub Actions matrix:**
- `ubuntu-22.04`, `macos-13`
- Debug + Release
- TSan/ASan/UBSan on Debug linux only (sanitizer combinations are mutually exclusive on some toolchains)

**Path filter:** workflow triggers only on `api-clients/**` changes — server-side TypeScript PRs don't spin up the C++ matrix. Conversely, the existing geo CI gets a path-exclude on `api-clients/**` so C++ commits don't re-run Vercel previews.

**Release artifacts:** `ga-pipe-<semver>-linux-x86_64`, `ga-pipe-<semver>-macos-arm64` tarballs containing the binary + default `pipe.yaml` + `sinks/*.yaml` + README. Published via GitHub Releases on a `ga-pipe-vX.Y.Z` tag. Signing/notarization deferred to v1.1.

## 13. Rollout

1. Ratify ES (this doc) → ES-088 READY
2. Scaffold project (Task #16)
3. Author unit tests (subset of Task #14)
4. Implement modules bottom-up: Config → Logger → State → AuthClient → Reader → Queue → SinkTemplate → Sink → main (Tasks #17, #18)
5. Author integration tests (Task #14)
6. End-to-end dry-run on desktop with mock servers + Manipal CSV replay (Task #19)
7. End-to-end live-run against flowblinq preview + Aditya's test GA4 property (Task #20)
8. Tag `ga-pipe-v0.1.0`; publish tarballs; pilot with Manipal domain

## 14. Ratified decisions (formerly open questions)

Resolved with Aditya 2026-04-21:

1. **State file default = `${XDG_STATE_HOME:-$HOME/.local/state}/ga-pipe/state.json`** (user-space, no root needed). Overridable via `state.path` in `pipe.yaml`. Codified in §1 layout and TS-088 §4.3 config example.
2. **Docker image: deferred.** v1 ships native linux-x86_64 + macos-arm64 tarballs only. Revisit if customer feedback indicates glibc version friction.
3. **Prometheus `/metrics` endpoint: deferred.** v1 is log-only (consistent with ES-087 §10). Graduate when a second observability consumer materializes.

---
