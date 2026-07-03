// ES-088 — retry/backoff unit tests (Catch2)
//
// Spec-first. Exponential backoff with full jitter; Retry-After header overrides.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include "ga_pipe/sink.hpp"  // RetryPolicy + backoffMs lives here per ES-088 §6

using namespace ga_pipe;

TEST_CASE("backoff: no jitter → deterministic doubling up to max", "[backoff]") {
    RetryPolicy p;
    p.max_attempts = 10;
    p.initial_backoff_ms = 500;
    p.max_backoff_ms = 30000;
    p.jitter = false;

    REQUIRE(backoffMs(0, p) == 500);
    REQUIRE(backoffMs(1, p) == 1000);
    REQUIRE(backoffMs(2, p) == 2000);
    REQUIRE(backoffMs(3, p) == 4000);
    REQUIRE(backoffMs(4, p) == 8000);
    REQUIRE(backoffMs(5, p) == 16000);
    // Caps at max_backoff_ms
    REQUIRE(backoffMs(6, p) == 30000);
    REQUIRE(backoffMs(9, p) == 30000);
}

TEST_CASE("backoff: with jitter → bounded by computed base", "[backoff]") {
    RetryPolicy p;
    p.initial_backoff_ms = 500;
    p.max_backoff_ms = 30000;
    p.jitter = true;

    for (int trial = 0; trial < 100; ++trial) {
        int b = backoffMs(3, p);
        REQUIRE(b >= 0);
        REQUIRE(b <= 4000); // base = 500 << 3 = 4000
    }
    for (int trial = 0; trial < 100; ++trial) {
        int b = backoffMs(10, p);
        REQUIRE(b >= 0);
        REQUIRE(b <= 30000); // capped
    }
}

TEST_CASE("backoff: Retry-After header overrides computed backoff", "[backoff]") {
    // Per ES-088 §6: if sink response includes Retry-After, use that instead.
    RetryPolicy p;
    p.initial_backoff_ms = 500;
    p.max_backoff_ms = 30000;
    p.jitter = false;

    const auto picked = pickBackoffMs(/*attempt=*/2, p, /*retry_after_s=*/std::optional<int>{15});
    REQUIRE(picked == 15000); // Retry-After in seconds → ms
}

TEST_CASE("backoff: Retry-After missing falls through to computed", "[backoff]") {
    RetryPolicy p;
    p.initial_backoff_ms = 500;
    p.max_backoff_ms = 30000;
    p.jitter = false;

    const auto picked = pickBackoffMs(2, p, std::nullopt);
    REQUIRE(picked == 2000);
}

TEST_CASE("retry: max_attempts exhausted returns non-retriable disposition", "[retry]") {
    // If after max_attempts the sink still fails retriably, the writer must
    // deadletter the row (per ES-088 §5 retry budget).
    RetryPolicy p;
    p.max_attempts = 3;
    REQUIRE(isWithinBudget(0, p));
    REQUIRE(isWithinBudget(2, p));
    REQUIRE_FALSE(isWithinBudget(3, p));
    REQUIRE_FALSE(isWithinBudget(999, p));
}
