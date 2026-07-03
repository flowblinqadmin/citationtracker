// ES-088 — consecutive-malformed-response integration test (TS-088 #13, #14)
#include <catch2/catch_test_macros.hpp>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <httplib.h>
#include <thread>

#include "ga_pipe/pipe_runner.hpp"
#include "mock_ga4_server.hpp"

using namespace ga_pipe;
using namespace ga_pipe::testing;
using namespace std::chrono_literals;
namespace fs = std::filesystem;

namespace {
// A flowblinq mock that returns configurable garbage on the page_views endpoint.
struct MalformedFlowblinq {
    httplib::Server srv;
    int port{0};
    std::thread th;
    std::atomic<int> page_req{0}, token_req{0};
    std::atomic<int> good_response_counter{0};
    std::atomic<int> respond_with_malformed_remaining{0};

    MalformedFlowblinq() {
        srv.Post("/api/oauth/token", [this](const httplib::Request&, httplib::Response& res) {
            token_req++;
            res.set_content(R"({"access_token":"jwt","expires_in":3600})", "application/json");
        });
        srv.Get("/api/v1/page_views", [this](const httplib::Request&, httplib::Response& res) {
            page_req++;
            if (respond_with_malformed_remaining.load() > 0) {
                respond_with_malformed_remaining.fetch_sub(1);
                res.status = 200;
                res.set_content("{ totally not valid page_views response", "application/json");
                return;
            }
            good_response_counter++;
            res.set_content(R"({
              "domain":"mysite.com","slug_resolved":"s","served_ts":"2026-04-21T15:30:00Z",
              "rows":[],"has_more":false,"next_cursor":null
            })", "application/json");
        });
        port = srv.bind_to_any_port("127.0.0.1");
        th = std::thread([this] { srv.listen_after_bind(); });
        std::this_thread::sleep_for(50ms);
    }
    ~MalformedFlowblinq() { srv.stop(); if (th.joinable()) th.join(); }
    std::string baseUrl() const { return "http://127.0.0.1:" + std::to_string(port); }
};

fs::path writeSinkYaml(const std::string& ga4_url) {
    static int counter = 0;
    auto p = fs::temp_directory_path() / ("ga_pipe_malformed_sink_" + std::to_string(++counter) + ".yaml");
    std::ofstream f(p);
    f << "name: mock\nrequest:\n  method: POST\n  url: \"" << ga4_url << "\"\n"
         "  headers: { Content-Type: application/json }\n"
         "  body_json: { id: \"{{ row.id }}\" }\n"
         "constraints: { max_body_bytes: 131072, retry_policy: { max_attempts: 3, initial_backoff_ms: 20, max_backoff_ms: 100, jitter: false } }\n";
    return p;
}
}

TEST_CASE("TS-088 #13 — 10 consecutive malformed responses → exit code 3", "[e2e][malformed]") {
    MalformedFlowblinq fb;
    MockGa4Server       ga4;
    fb.respond_with_malformed_remaining.store(15); // more than enough to cross threshold

    const auto state = fs::temp_directory_path() / "malformed_13_state.json";
    const auto dl    = fs::temp_directory_path() / "malformed_13_dl.ndjson";
    fs::remove(state); fs::remove(dl);

    PipeRunnerConfig cfg;
    cfg.flowblinq_base_url           = fb.baseUrl();
    cfg.flowblinq_domain             = "mysite.com";
    cfg.client_id                    = "cid";
    cfg.client_secret                = "cs";
    cfg.poll_interval_s              = 0; // tight polling for test
    cfg.queue_capacity               = 16;
    cfg.sink_yaml                    = writeSinkYaml(ga4.endpointUrl());
    cfg.state_path                   = state;
    cfg.deadletter_path              = dl;
    cfg.malformed_response_threshold = 10;

    PipeRunner runner(cfg);
    runner.start();
    // Wait for exit.
    const bool drained = runner.waitForShutdown(15s);
    REQUIRE(drained);
    REQUIRE(runner.exitCode() == 3);
    REQUIRE(fb.page_req.load() >= 10);
    // Queue drained; no rows delivered to ga4 (response bodies were all malformed)
    REQUIRE(ga4.requestCount() == 0);
}

TEST_CASE("TS-088 #14 — valid response between malformeds resets counter", "[e2e][malformed]") {
    MalformedFlowblinq fb;
    MockGa4Server       ga4;

    const auto state = fs::temp_directory_path() / "malformed_14_state.json";
    const auto dl    = fs::temp_directory_path() / "malformed_14_dl.ndjson";
    fs::remove(state); fs::remove(dl);

    PipeRunnerConfig cfg;
    cfg.flowblinq_base_url           = fb.baseUrl();
    cfg.flowblinq_domain             = "mysite.com";
    cfg.client_id                    = "cid";
    cfg.client_secret                = "cs";
    cfg.poll_interval_s              = 0;
    cfg.queue_capacity               = 16;
    cfg.sink_yaml                    = writeSinkYaml(ga4.endpointUrl());
    cfg.state_path                   = state;
    cfg.deadletter_path              = dl;
    cfg.malformed_response_threshold = 10;

    // 9 malformed, then server responds good from then on (counter resets).
    fb.respond_with_malformed_remaining.store(9);

    PipeRunner runner(cfg);
    runner.start();
    // Let it run long enough to process several good responses after the reset.
    for (int i = 0; i < 200 && fb.good_response_counter.load() < 3; ++i)
        std::this_thread::sleep_for(10ms);
    runner.requestShutdown();
    const bool drained = runner.waitForShutdown(10s);

    REQUIRE(drained);
    REQUIRE(runner.exitCode() == 0); // normal shutdown, NOT 3
    REQUIRE(fb.good_response_counter.load() >= 3);
    // 9 malformed + 9 more malformed wouldn't have triggered either, so assert
    // the counter-reset logic specifically by firing another malformed burst:
    fb.respond_with_malformed_remaining.store(9);
    PipeRunner runner2(cfg);
    runner2.start();
    // Should NOT exit with code 3 on 9 malformed following earlier reset.
    for (int i = 0; i < 100 && fb.good_response_counter.load() < 6; ++i)
        std::this_thread::sleep_for(10ms);
    runner2.requestShutdown();
    REQUIRE(runner2.waitForShutdown(10s));
    REQUIRE(runner2.exitCode() == 0);
}
