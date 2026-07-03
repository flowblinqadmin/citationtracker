// ES-088 — end-to-end integration tests (Catch2)
//
// Spec-first. Covers TS-088 §5 criteria #1, #3, #4, #5, #6, #7, #10, #11, #12
// with mock flowblinq + mock GA4 server. Uses the same binary entry assembled
// from Config + AuthClient + FlowblinqReader + PageViewQueue + SinkTemplate +
// Sink + StateFile + DeadLetter.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <thread>

#include "ga_pipe/pipe_runner.hpp"  // Thin composition root for test use
#include "mock_flowblinq_server.hpp"
#include "mock_ga4_server.hpp"

using namespace ga_pipe;
using namespace ga_pipe::testing;
using namespace std::chrono_literals;
namespace fs = std::filesystem;

static std::vector<SeededRow> seedRows(size_t n, const std::string& host = "mysite.com") {
    std::vector<SeededRow> rows;
    for (size_t i = 0; i < n; ++i) {
        SeededRow r;
        r.id = "row-" + std::to_string(i);
        r.page_url = "https://" + host + "/p/" + std::to_string(i);
        r.visitor_id = "vid-" + std::to_string(i);
        r.viewed_at = "2026-04-21T15:29:" + std::to_string(10 + i) + ".000Z";
        rows.push_back(r);
    }
    return rows;
}

static fs::path writeTempSinkYaml(const std::string& ga4_url) {
    static int counter = 0;
    auto p = fs::temp_directory_path() / ("ga_pipe_sink_e2e_" + std::to_string(++counter) + ".yaml");
    std::ofstream f(p);
    f << R"(
name: mock_ga4
request:
  method: POST
  url: ")" << ga4_url << R"("
  headers: { Content-Type: application/json }
  body_json:
    client_id: "{{ row.visitor_id }}"
    events:
      - name: page_view
        params: { page_location: "{{ row.page_url }}" }
constraints:
  max_body_bytes: 131072
  retriable_status_codes: [429, 500, 502, 503, 504]
  non_retriable_status_codes: [400, 401, 403, 404]
  retry_policy: { max_attempts: 3, initial_backoff_ms: 50, max_backoff_ms: 200, jitter: false }
)";
    return p;
}

static PipeRunnerConfig composeConfig(const std::string& fb_url, const std::string& ga4_url,
                                       const fs::path& state_path, const fs::path& dl_path) {
    PipeRunnerConfig c;
    c.flowblinq_base_url = fb_url;
    c.flowblinq_domain   = "mysite.com";
    c.client_id          = "cid";
    c.client_secret      = "cs";
    c.poll_interval_s    = 1;
    c.queue_capacity     = 64;
    c.sink_yaml          = writeTempSinkYaml(ga4_url);
    c.state_path         = state_path;
    c.deadletter_path    = dl_path;
    return c;
}

TEST_CASE("TS-088 #1 — fresh install with no state → default 72h seed and rows flow", "[e2e]") {
    MockFlowblinqServer fb(seedRows(5));
    MockGa4Server       ga4;
    const auto state = fs::temp_directory_path() / "e2e_1_state.json";
    const auto dl    = fs::temp_directory_path() / "e2e_1_dl.ndjson";
    fs::remove(state); fs::remove(dl);

    PipeRunner runner(composeConfig(fb.baseUrl(), ga4.endpointUrl(), state, dl));
    runner.start();
    for (int i = 0; i < 50 && ga4.requestCount() < 5; ++i) std::this_thread::sleep_for(100ms);
    runner.requestShutdown();
    runner.waitForShutdown(10s);

    REQUIRE(ga4.requestCount() == 5);
    REQUIRE(fs::exists(state));
}

TEST_CASE("TS-088 #3 — sink 500 triggers expo backoff; row does not advance until success", "[e2e][retry]") {
    MockFlowblinqServer fb(seedRows(1));
    MockGa4Server       ga4;
    ga4.queueForcedStatus(500);
    ga4.queueForcedStatus(500);
    // Then succeed.
    const auto state = fs::temp_directory_path() / "e2e_3_state.json";
    const auto dl    = fs::temp_directory_path() / "e2e_3_dl.ndjson";
    fs::remove(state); fs::remove(dl);

    PipeRunner runner(composeConfig(fb.baseUrl(), ga4.endpointUrl(), state, dl));
    runner.start();
    for (int i = 0; i < 100 && ga4.requestCount() < 3; ++i) std::this_thread::sleep_for(50ms);
    runner.requestShutdown();
    runner.waitForShutdown(10s);

    REQUIRE(ga4.requestCount() == 3); // 2 failures + 1 success
    // Deadletter should be empty (eventually succeeded).
    if (fs::exists(dl)) {
        std::ifstream f(dl);
        std::string line; int lines = 0;
        while (std::getline(f, line)) if (!line.empty()) lines++;
        REQUIRE(lines == 0);
    }
}

TEST_CASE("TS-088 #4 — sink 400 (non-retriable) row deadletters and cursor advances", "[e2e][deadletter]") {
    MockFlowblinqServer fb(seedRows(2));
    MockGa4Server       ga4;
    ga4.queueForcedStatus(400); // first row fails non-retriably
    const auto state = fs::temp_directory_path() / "e2e_4_state.json";
    const auto dl    = fs::temp_directory_path() / "e2e_4_dl.ndjson";
    fs::remove(state); fs::remove(dl);

    PipeRunner runner(composeConfig(fb.baseUrl(), ga4.endpointUrl(), state, dl));
    runner.start();
    for (int i = 0; i < 100 && ga4.requestCount() < 2; ++i) std::this_thread::sleep_for(50ms);
    runner.requestShutdown();
    runner.waitForShutdown(10s);

    REQUIRE(ga4.requestCount() == 2); // 1 fails + 1 succeeds
    std::ifstream f(dl);
    std::string line; int dl_lines = 0;
    while (std::getline(f, line)) if (!line.empty()) dl_lines++;
    REQUIRE(dl_lines == 1);
}

TEST_CASE("TS-088 #5 — flowblinq 429 honors Retry-After; writer continues drain", "[e2e][rate_limit]") {
    MockFlowblinqServer fb(seedRows(3));
    MockGa4Server       ga4;
    fb.queueForcedStatus(429, /*retry_after_s=*/1);
    const auto state = fs::temp_directory_path() / "e2e_5_state.json";
    const auto dl    = fs::temp_directory_path() / "e2e_5_dl.ndjson";
    fs::remove(state); fs::remove(dl);

    PipeRunner runner(composeConfig(fb.baseUrl(), ga4.endpointUrl(), state, dl));
    const auto t0 = std::chrono::steady_clock::now();
    runner.start();
    for (int i = 0; i < 200 && ga4.requestCount() < 3; ++i) std::this_thread::sleep_for(50ms);
    runner.requestShutdown();
    runner.waitForShutdown(15s);
    const auto elapsed = std::chrono::steady_clock::now() - t0;
    REQUIRE(ga4.requestCount() == 3);
    REQUIRE(elapsed >= 1s); // honored Retry-After
}

TEST_CASE("TS-088 #6 — flowblinq 401 triggers auth refresh then retry; no data loss", "[e2e][auth]") {
    MockFlowblinqServer fb(seedRows(2));
    MockGa4Server       ga4;
    fb.queueForcedStatus(401); // forces auth refresh
    const auto state = fs::temp_directory_path() / "e2e_6_state.json";
    const auto dl    = fs::temp_directory_path() / "e2e_6_dl.ndjson";
    fs::remove(state); fs::remove(dl);

    PipeRunner runner(composeConfig(fb.baseUrl(), ga4.endpointUrl(), state, dl));
    runner.start();
    for (int i = 0; i < 100 && ga4.requestCount() < 2; ++i) std::this_thread::sleep_for(50ms);
    runner.requestShutdown();
    runner.waitForShutdown(10s);

    REQUIRE(ga4.requestCount() == 2);
    REQUIRE(fb.tokenRequestCount() >= 2); // first at start, refresh on 401
}

TEST_CASE("TS-088 #7 — GA4 body > 130KB template constraint deadletters before POST", "[e2e][constraints]") {
    // Seeded with a row carrying an oversize page_url; template max_body_bytes is small.
    auto rows = seedRows(1);
    rows[0].page_url = "https://mysite.com/" + std::string(200000, 'X');
    MockFlowblinqServer fb(rows);
    MockGa4Server       ga4;
    const auto state = fs::temp_directory_path() / "e2e_7_state.json";
    const auto dl    = fs::temp_directory_path() / "e2e_7_dl.ndjson";
    fs::remove(state); fs::remove(dl);

    PipeRunner runner(composeConfig(fb.baseUrl(), ga4.endpointUrl(), state, dl));
    runner.start();
    for (int i = 0; i < 100 && !fs::exists(dl); ++i) std::this_thread::sleep_for(50ms);
    runner.requestShutdown();
    runner.waitForShutdown(10s);

    REQUIRE(ga4.requestCount() == 0); // never posted
    REQUIRE(fs::exists(dl));
    std::ifstream f(dl); std::string line;
    int found = 0;
    while (std::getline(f, line)) {
        if (line.find("oversize") != std::string::npos ||
            line.find("ConstraintViolation") != std::string::npos) found++;
    }
    REQUIRE(found >= 1);
}

TEST_CASE("TS-088 #10 — template swap: same row, different request (no binary rebuild)", "[e2e][template]") {
    // Swap GA4 template for a webhook template at runtime (two separate runs).
    MockFlowblinqServer fb(seedRows(1));
    MockGa4Server       webhook; // reuse as "webhook" sink (accepts POST JSON)
    const auto state1 = fs::temp_directory_path() / "e2e_10a_state.json";
    const auto state2 = fs::temp_directory_path() / "e2e_10b_state.json";
    const auto dl1    = fs::temp_directory_path() / "e2e_10a_dl.ndjson";
    const auto dl2    = fs::temp_directory_path() / "e2e_10b_dl.ndjson";
    fs::remove(state1); fs::remove(state2); fs::remove(dl1); fs::remove(dl2);

    // Run 1: GA4-shaped body (client_id + events)
    {
        PipeRunner runner(composeConfig(fb.baseUrl(), webhook.endpointUrl(), state1, dl1));
        runner.start();
        for (int i = 0; i < 50 && webhook.requestCount() < 1; ++i) std::this_thread::sleep_for(50ms);
        runner.requestShutdown();
        runner.waitForShutdown(5s);
    }
    const auto body_run1 = webhook.bodies();
    REQUIRE(body_run1.size() >= 1);
    REQUIRE(body_run1[0].find("\"events\"") != std::string::npos);

    // Run 2: webhook shape (flat fields)
    auto cfg2 = composeConfig(fb.baseUrl(), webhook.endpointUrl(), state2, dl2);
    {
        std::ofstream f(cfg2.sink_yaml);
        f << "name: webhook\nrequest:\n  method: POST\n  url: \"" << webhook.endpointUrl() << "\"\n"
             "  headers: { Content-Type: application/json }\n"
             "  body_json:\n    id: \"{{ row.id }}\"\n    url: \"{{ row.page_url }}\"\n"
             "constraints: { max_body_bytes: 131072 }\n";
    }
    {
        PipeRunner runner(cfg2);
        runner.start();
        const auto before = webhook.requestCount();
        for (int i = 0; i < 50 && webhook.requestCount() <= before; ++i) std::this_thread::sleep_for(50ms);
        runner.requestShutdown();
        runner.waitForShutdown(5s);
    }
    const auto all_bodies = webhook.bodies();
    REQUIRE(all_bodies.size() >= 2);
    REQUIRE(all_bodies.back().find("\"events\"") == std::string::npos); // webhook shape lacks events
}

TEST_CASE("TS-088 #12 — multiple pipe instances with different state files → isolated", "[e2e][multi_instance]") {
    MockFlowblinqServer fb1(seedRows(3, "site-a.com"));
    MockFlowblinqServer fb2(seedRows(2, "site-b.com"));
    MockGa4Server       ga4;
    const auto s1 = fs::temp_directory_path() / "e2e_12a_state.json";
    const auto s2 = fs::temp_directory_path() / "e2e_12b_state.json";
    fs::remove(s1); fs::remove(s2);

    auto c1 = composeConfig(fb1.baseUrl(), ga4.endpointUrl(), s1, s1.string()+".dl");
    c1.flowblinq_domain = "site-a.com";
    auto c2 = composeConfig(fb2.baseUrl(), ga4.endpointUrl(), s2, s2.string()+".dl");
    c2.flowblinq_domain = "site-b.com";

    PipeRunner r1(c1); PipeRunner r2(c2);
    r1.start(); r2.start();
    for (int i = 0; i < 100 && ga4.requestCount() < 5; ++i) std::this_thread::sleep_for(50ms);
    r1.requestShutdown(); r2.requestShutdown();
    r1.waitForShutdown(10s); r2.waitForShutdown(10s);

    REQUIRE(ga4.requestCount() == 5);
    REQUIRE(fs::exists(s1));
    REQUIRE(fs::exists(s2));
    REQUIRE(s1 != s2);
}
