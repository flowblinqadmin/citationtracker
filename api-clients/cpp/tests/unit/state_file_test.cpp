// ES-088 — StateFile unit tests (Catch2)
//
// Spec-first. Covers atomic-write guarantee (tmp+fsync+rename), corruption
// detection via hand-crafted fixture, missing-file default, schema versioning.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>
#include <filesystem>
#include <fstream>

#include "ga_pipe/state_file.hpp"

using namespace ga_pipe;
namespace fs = std::filesystem;

static fs::path tempPath() {
    static int counter = 0;
    return fs::temp_directory_path() / ("ga_pipe_state_test_" + std::to_string(++counter) + ".json");
}

TEST_CASE("state: load returns default when file absent", "[state]") {
    auto p = tempPath();
    fs::remove(p);
    StateFile sf(p);
    auto s = sf.load();
    REQUIRE(s.schema_version == 1);
    REQUIRE_FALSE(s.cursor.has_value());
    REQUIRE(s.served_count_total == 0);
    REQUIRE(s.deadletter_count_total == 0);
}

TEST_CASE("state: persist then load round-trips", "[state]") {
    auto p = tempPath();
    StateFile sf(p);
    PipeState s;
    s.cursor = Cursor{"2026-04-21T15:29:45.123Z", "nano-xyz"};
    s.served_count_total = 1234;
    s.deadletter_count_total = 5;
    s.last_successful_sink_ts = "2026-04-21T15:30:00Z";
    sf.persist(s);

    auto loaded = sf.load();
    REQUIRE(loaded.cursor.has_value());
    REQUIRE(loaded.cursor->viewed_at == s.cursor->viewed_at);
    REQUIRE(loaded.cursor->id == s.cursor->id);
    REQUIRE(loaded.served_count_total == 1234);
    REQUIRE(loaded.deadletter_count_total == 5);
    fs::remove(p);
}

TEST_CASE("state: persist is atomic — no .tmp left behind on success", "[state][atomicity]") {
    auto p = tempPath();
    StateFile sf(p);
    PipeState s;
    s.served_count_total = 7;
    sf.persist(s);
    REQUIRE(fs::exists(p));
    REQUIRE_FALSE(fs::exists(fs::path(p).replace_extension(".tmp")));
    REQUIRE_FALSE(fs::exists(p.string() + ".tmp"));
    fs::remove(p);
}

TEST_CASE("state: corrupt file throws StateCorrupt (no silent heal)", "[state][safety]") {
    auto p = tempPath();
    {
        std::ofstream f(p);
        f << "{ this is not valid json";
    }
    StateFile sf(p);
    REQUIRE_THROWS_AS(sf.load(), StateCorrupt);
    fs::remove(p);
}

TEST_CASE("state: truncated file throws StateCorrupt", "[state][safety]") {
    auto p = tempPath();
    {
        std::ofstream f(p);
        f << "{\"schema_version\":1,\"cursor\":{\"viewed_at\":\"202";
    }
    StateFile sf(p);
    REQUIRE_THROWS_AS(sf.load(), StateCorrupt);
    fs::remove(p);
}

TEST_CASE("state: unknown schema_version throws", "[state][safety]") {
    auto p = tempPath();
    {
        std::ofstream f(p);
        f << "{\"schema_version\":999,\"cursor\":null,\"served_count_total\":0,"
             "\"deadletter_count_total\":0,\"last_successful_sink_ts\":\"\"}";
    }
    StateFile sf(p);
    REQUIRE_THROWS(sf.load());
    fs::remove(p);
}

TEST_CASE("state: repeated persist overwrites cleanly (no partial writes)", "[state][atomicity]") {
    auto p = tempPath();
    StateFile sf(p);
    for (uint64_t i = 0; i < 50; ++i) {
        PipeState s;
        s.served_count_total = i;
        sf.persist(s);
        auto loaded = sf.load();
        REQUIRE(loaded.served_count_total == i);
    }
    fs::remove(p);
}
