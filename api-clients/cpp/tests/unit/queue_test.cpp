// ES-088 — PageViewQueue unit tests (Catch2)
//
// Spec-first (RED until src/page_view_queue.cpp lands).
// Covers: bounded capacity, block-on-full, block-on-empty, close-wakes-waiters,
// SPSC invariants. ThreadSanitizer + AddressSanitizer enabled in debug CI.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers.hpp>
#include <chrono>
#include <future>
#include <thread>

#include "ga_pipe/page_view.hpp"
#include "ga_pipe/page_view_queue.hpp"

using namespace ga_pipe;
using namespace std::chrono_literals;

static PageView makeRow(const std::string& id) {
    PageView pv;
    pv.id = id;
    pv.page_url = "https://x.com/" + id;
    pv.viewed_at = "2026-04-21T15:29:45.123Z";
    return pv;
}

TEST_CASE("queue: push/pop preserves FIFO order (SPSC)", "[queue]") {
    PageViewQueue q(10);
    for (int i = 0; i < 5; ++i) REQUIRE(q.push(makeRow("id-" + std::to_string(i))));
    for (int i = 0; i < 5; ++i) {
        auto r = q.pop();
        REQUIRE(r.has_value());
        REQUIRE(r->id == "id-" + std::to_string(i));
    }
}

TEST_CASE("queue: push blocks when full, unblocks on pop", "[queue][concurrency]") {
    PageViewQueue q(2);
    REQUIRE(q.push(makeRow("a")));
    REQUIRE(q.push(makeRow("b")));
    REQUIRE(q.size() == 2);

    std::atomic<bool> pushed{false};
    std::thread producer([&] {
        q.push(makeRow("c")); // should block
        pushed.store(true);
    });
    std::this_thread::sleep_for(50ms);
    REQUIRE_FALSE(pushed.load()); // still blocked

    auto r = q.pop();
    producer.join();
    REQUIRE(pushed.load());
    REQUIRE(r->id == "a");
}

TEST_CASE("queue: pop blocks when empty, unblocks on push", "[queue][concurrency]") {
    PageViewQueue q(4);
    std::promise<std::optional<PageView>> got;
    auto fut = got.get_future();
    std::thread consumer([&] { got.set_value(q.pop()); });
    std::this_thread::sleep_for(50ms);
    REQUIRE(fut.wait_for(0ms) == std::future_status::timeout); // still blocked
    REQUIRE(q.push(makeRow("z")));
    consumer.join();
    REQUIRE(fut.get()->id == "z");
}

TEST_CASE("queue: close wakes all waiters; subsequent push fails", "[queue][shutdown]") {
    PageViewQueue q(2);
    REQUIRE(q.push(makeRow("a")));
    REQUIRE(q.push(makeRow("b")));

    std::atomic<bool> pusher_returned{false};
    std::thread pusher([&] {
        bool ok = q.push(makeRow("c"));
        REQUIRE_FALSE(ok);
        pusher_returned.store(true);
    });
    std::this_thread::sleep_for(50ms);
    q.close();
    pusher.join();
    REQUIRE(pusher_returned.load());

    // Already-queued items drain
    auto a = q.pop(); REQUIRE((a && a->id == "a"));
    auto b = q.pop(); REQUIRE((b && b->id == "b"));
    // Then pop returns nullopt
    REQUIRE_FALSE(q.pop().has_value());
    // push after close returns false immediately
    REQUIRE_FALSE(q.push(makeRow("d")));
}

TEST_CASE("queue: capacity invariant holds under concurrent push/pop", "[queue][concurrency][stress]") {
    PageViewQueue q(100);
    constexpr int N = 10000;
    std::atomic<int> max_observed{0};
    std::thread producer([&] {
        for (int i = 0; i < N; ++i) {
            q.push(makeRow("id-" + std::to_string(i)));
            int s = static_cast<int>(q.size());
            int prev = max_observed.load();
            while (s > prev && !max_observed.compare_exchange_weak(prev, s));
        }
    });
    std::thread consumer([&] {
        for (int i = 0; i < N; ++i) q.pop();
    });
    producer.join();
    consumer.join();
    REQUIRE(max_observed.load() <= 100);
    REQUIRE(q.size() == 0);
}
