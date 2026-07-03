// ES-088 — AuthClient unit tests (Catch2)
//
// Spec-first. Covers JWT fetch, refresh-before-expiry, retry on 401.
// Uses cpp-httplib mock server on an ephemeral port.
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <httplib.h>
#include <thread>

#include "ga_pipe/auth_client.hpp"

using namespace ga_pipe;
using namespace std::chrono_literals;

namespace {
struct MockOauth {
    httplib::Server srv;
    int port{0};
    std::thread th;
    std::atomic<int> token_requests{0};

    MockOauth() {
        srv.Post("/api/oauth/token", [this](const httplib::Request&, httplib::Response& res) {
            token_requests++;
            res.set_content(
                "{\"access_token\":\"jwt-" + std::to_string(token_requests.load()) +
                "\",\"expires_in\":3600}", "application/json");
        });
        port = srv.bind_to_any_port("127.0.0.1");
        th = std::thread([this] { srv.listen_after_bind(); });
        std::this_thread::sleep_for(50ms);
    }
    ~MockOauth() { srv.stop(); if (th.joinable()) th.join(); }
    std::string url() const { return "http://127.0.0.1:" + std::to_string(port); }
};
}

TEST_CASE("auth: first call fetches JWT", "[auth]") {
    MockOauth mock;
    AuthClient auth({ .base_url = mock.url(), .client_id = "cid", .client_secret = "cs" });
    auto tok = auth.bearer();
    REQUIRE(tok.find("jwt-") == 0);
    REQUIRE(mock.token_requests.load() == 1);
}

TEST_CASE("auth: cached JWT is reused within TTL", "[auth]") {
    MockOauth mock;
    AuthClient auth({ .base_url = mock.url(), .client_id = "cid", .client_secret = "cs" });
    auto a = auth.bearer();
    auto b = auth.bearer();
    auto c = auth.bearer();
    REQUIRE(a == b);
    REQUIRE(b == c);
    REQUIRE(mock.token_requests.load() == 1);
}

TEST_CASE("auth: explicit refresh re-fetches", "[auth]") {
    MockOauth mock;
    AuthClient auth({ .base_url = mock.url(), .client_id = "cid", .client_secret = "cs" });
    auto a = auth.bearer();
    auth.forceRefresh();
    auto b = auth.bearer();
    REQUIRE(a != b);
    REQUIRE(mock.token_requests.load() == 2);
}

TEST_CASE("auth: refresh occurs near expiry (configurable skew)", "[auth]") {
    MockOauth mock;
    AuthClient auth({
        .base_url = mock.url(),
        .client_id = "cid",
        .client_secret = "cs",
        .refresh_skew_seconds = 3600, // force immediate re-fetch
    });
    auto a = auth.bearer();
    auto b = auth.bearer(); // skew >= expires_in → every call refreshes
    REQUIRE(a != b);
    REQUIRE(mock.token_requests.load() == 2);
}

TEST_CASE("auth: OAuth endpoint 5xx triggers retry", "[auth][retry]") {
    httplib::Server srv;
    std::atomic<int> calls{0};
    srv.Post("/api/oauth/token", [&](const httplib::Request&, httplib::Response& res) {
        int n = ++calls;
        if (n < 3) { res.status = 503; return; }
        res.set_content("{\"access_token\":\"jwt-ok\",\"expires_in\":3600}", "application/json");
    });
    int port = srv.bind_to_any_port("127.0.0.1");
    std::thread th([&] { srv.listen_after_bind(); });
    std::this_thread::sleep_for(50ms);

    AuthClient auth({
        .base_url = "http://127.0.0.1:" + std::to_string(port),
        .client_id = "cid", .client_secret = "cs",
    });
    auto tok = auth.bearer();
    REQUIRE(tok == "jwt-ok");
    REQUIRE(calls.load() == 3);

    srv.stop(); if (th.joinable()) th.join();
}

TEST_CASE("auth: bad credentials (401) do NOT retry endlessly", "[auth][retry]") {
    httplib::Server srv;
    std::atomic<int> calls{0};
    srv.Post("/api/oauth/token", [&](const httplib::Request&, httplib::Response& res) {
        calls++;
        res.status = 401;
        res.set_content("{\"error\":\"invalid_credentials\"}", "application/json");
    });
    int port = srv.bind_to_any_port("127.0.0.1");
    std::thread th([&] { srv.listen_after_bind(); });
    std::this_thread::sleep_for(50ms);

    AuthClient auth({
        .base_url = "http://127.0.0.1:" + std::to_string(port),
        .client_id = "bad", .client_secret = "bad",
    });
    REQUIRE_THROWS_AS(auth.bearer(), AuthFatal);
    REQUIRE(calls.load() == 1); // no retry on non-retriable

    srv.stop(); if (th.joinable()) th.join();
}
