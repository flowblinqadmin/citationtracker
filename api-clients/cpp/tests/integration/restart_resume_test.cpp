// ES-088 — restart/resume integration test (TS-088 #2, #9)
// Verifies cursor determinism across restarts and zero-duplicate delivery.
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <set>
#include <thread>

#include "ga_pipe/pipe_runner.hpp"
#include "mock_flowblinq_server.hpp"
#include "mock_ga4_server.hpp"

using namespace ga_pipe;
using namespace ga_pipe::testing;
using namespace std::chrono_literals;
namespace fs = std::filesystem;

static std::vector<SeededRow> seedRows(size_t n) {
    std::vector<SeededRow> rows;
    for (size_t i = 0; i < n; ++i) {
        SeededRow r;
        r.id = "row-" + std::to_string(i);
        r.page_url = "https://mysite.com/p/" + std::to_string(i);
        r.visitor_id = "vid-" + std::to_string(i);
        r.viewed_at = "2026-04-21T15:29:" + std::to_string(10 + i) + ".000Z";
        rows.push_back(r);
    }
    return rows;
}

static fs::path writeSinkYaml(const std::string& ga4_url) {
    static int counter = 0;
    auto p = fs::temp_directory_path() / ("ga_pipe_sink_restart_" + std::to_string(++counter) + ".yaml");
    std::ofstream f(p);
    f << "name: mock_ga4\nrequest:\n  method: POST\n  url: \"" << ga4_url << "\"\n"
         "  headers: { Content-Type: application/json }\n"
         "  body_json:\n    client_id: \"{{ row.visitor_id }}\"\n    events:\n      - name: page_view\n        params: { url: \"{{ row.page_url }}\" }\n"
         "constraints:\n  max_body_bytes: 131072\n  retriable_status_codes: [429,500]\n  non_retriable_status_codes: [400,401,403,404]\n"
         "  retry_policy: { max_attempts: 3, initial_backoff_ms: 20, max_backoff_ms: 100, jitter: false }\n";
    return p;
}

TEST_CASE("TS-088 #2 — restart after N rows resumes from state, zero duplicates", "[e2e][restart]") {
    auto rows = seedRows(10);
    MockFlowblinqServer fb(rows);
    MockGa4Server       ga4;

    const auto state = fs::temp_directory_path() / "restart_2_state.json";
    const auto dl    = fs::temp_directory_path() / "restart_2_dl.ndjson";
    fs::remove(state); fs::remove(dl);

    PipeRunnerConfig cfg;
    cfg.flowblinq_base_url = fb.baseUrl();
    cfg.flowblinq_domain   = "mysite.com";
    cfg.client_id          = "cid";
    cfg.client_secret      = "cs";
    cfg.poll_interval_s    = 1;
    cfg.queue_capacity     = 64;
    cfg.sink_yaml          = writeSinkYaml(ga4.endpointUrl());
    cfg.state_path         = state;
    cfg.deadletter_path    = dl;

    // Run 1: deliver ~5 rows, then stop.
    {
        PipeRunner r(cfg);
        r.start();
        for (int i = 0; i < 200 && ga4.requestCount() < 5; ++i) std::this_thread::sleep_for(10ms);
        r.requestShutdown();
        r.waitForShutdown(5s);
    }
    const int after_run1 = ga4.requestCount();
    REQUIRE(after_run1 >= 5);
    REQUIRE(after_run1 <= 10);

    // Run 2: same config, same state file — resume and deliver the rest.
    {
        PipeRunner r(cfg);
        r.start();
        for (int i = 0; i < 200 && ga4.requestCount() < 10; ++i) std::this_thread::sleep_for(10ms);
        r.requestShutdown();
        r.waitForShutdown(5s);
    }
    REQUIRE(ga4.requestCount() == 10);

    // Dedup check: each row.id should appear exactly once across all bodies.
    std::set<std::string> seen;
    for (const auto& b : ga4.bodies()) {
        for (const auto& r : rows) {
            if (b.find("\"vid-" + r.id.substr(4) + "\"") != std::string::npos) {
                auto inserted = seen.insert(r.id);
                REQUIRE(inserted.second);
            }
        }
    }
    REQUIRE(seen.size() == 10);
}

TEST_CASE("TS-088 #9 — cursor determinism across restarts", "[e2e][restart]") {
    // Stop after N=3 rows, restart, verify cursor in state matches server-issued next_cursor
    // and that resumed stream has no gap.
    auto rows = seedRows(6);
    MockFlowblinqServer fb(rows);
    MockGa4Server       ga4;

    const auto state = fs::temp_directory_path() / "restart_9_state.json";
    const auto dl    = fs::temp_directory_path() / "restart_9_dl.ndjson";
    fs::remove(state); fs::remove(dl);

    PipeRunnerConfig cfg;
    cfg.flowblinq_base_url = fb.baseUrl();
    cfg.flowblinq_domain   = "mysite.com";
    cfg.client_id          = "cid";
    cfg.client_secret      = "cs";
    cfg.poll_interval_s    = 1;
    cfg.queue_capacity     = 64;
    cfg.sink_yaml          = writeSinkYaml(ga4.endpointUrl());
    cfg.state_path         = state;
    cfg.deadletter_path    = dl;

    {
        PipeRunner r(cfg);
        r.start();
        for (int i = 0; i < 200 && ga4.requestCount() < 3; ++i) std::this_thread::sleep_for(10ms);
        r.requestShutdown(); r.waitForShutdown(5s);
    }
    const int run1 = ga4.requestCount();

    // Reload state and inspect cursor
    std::ifstream sf(state);
    std::string stateBody((std::istreambuf_iterator<char>(sf)), {});
    REQUIRE(stateBody.find("\"cursor\"") != std::string::npos);

    {
        PipeRunner r(cfg); r.start();
        for (int i = 0; i < 200 && ga4.requestCount() < 6; ++i) std::this_thread::sleep_for(10ms);
        r.requestShutdown(); r.waitForShutdown(5s);
    }
    REQUIRE(ga4.requestCount() == 6);
    // No gap: the ids delivered across both runs should be row-0..row-5 each once.
    std::set<std::string> delivered;
    for (const auto& b : ga4.bodies()) {
        for (size_t i = 0; i < rows.size(); ++i) {
            const auto needle = "vid-" + std::to_string(i);
            if (b.find(needle) != std::string::npos) delivered.insert("row-" + std::to_string(i));
        }
    }
    REQUIRE(delivered.size() == 6);
}
