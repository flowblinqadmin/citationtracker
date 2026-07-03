// ES-088 — response_validator unit tests (Catch2)
//
// Spec-first. Validator enforces flowblinq page_views response shape.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include "ga_pipe/response_validator.hpp"

using namespace ga_pipe;
using Catch::Matchers::ContainsSubstring;

static const char* const GOOD = R"({
  "domain": "mysite.com",
  "slug_resolved": "mysite-slug",
  "served_ts": "2026-04-21T15:30:00Z",
  "rows": [
    {"id":"row-1","page_url":"https://mysite.com/a","viewed_at":"2026-04-21T15:29:45Z"}
  ],
  "has_more": false,
  "next_cursor": null
})";

TEST_CASE("validator: accepts valid response", "[validator]") {
    auto page = validatePageViewsResponse(GOOD);
    REQUIRE(page.rows.size() == 1);
    REQUIRE(page.has_more == false);
}

TEST_CASE("validator: rejects bad JSON", "[validator]") {
    REQUIRE_THROWS_AS(validatePageViewsResponse("{ this is not json"), ValidationError);
}

TEST_CASE("validator: rejects missing top-level key", "[validator]") {
    const std::string body = R"({"domain":"x","slug_resolved":"s","served_ts":"t","rows":[]})";
    // missing has_more + next_cursor
    try {
        validatePageViewsResponse(body);
        FAIL("expected throw");
    } catch (const ValidationError& e) {
        REQUIRE(e.reason == MalformedReason::MissingKey);
    }
}

TEST_CASE("validator: rejects bad type on top-level field", "[validator]") {
    // has_more must be bool; provide string.
    const std::string body = R"({"domain":"x","slug_resolved":"s","served_ts":"t","rows":[],"has_more":"yes","next_cursor":null})";
    try {
        validatePageViewsResponse(body);
        FAIL("expected throw");
    } catch (const ValidationError& e) {
        REQUIRE(e.reason == MalformedReason::BadType);
    }
}

TEST_CASE("validator: rejects row missing id", "[validator]") {
    const std::string body = R"({
      "domain":"x","slug_resolved":"s","served_ts":"t",
      "rows":[{"page_url":"u","viewed_at":"t"}],
      "has_more":false,"next_cursor":null
    })";
    try {
        validatePageViewsResponse(body);
        FAIL("expected throw");
    } catch (const ValidationError& e) {
        REQUIRE(e.reason == MalformedReason::MissingRowKey);
    }
}

TEST_CASE("validator: rejects row with non-string id", "[validator]") {
    const std::string body = R"({
      "domain":"x","slug_resolved":"s","served_ts":"t",
      "rows":[{"id":42,"page_url":"u","viewed_at":"t"}],
      "has_more":false,"next_cursor":null
    })";
    try {
        validatePageViewsResponse(body);
        FAIL("expected throw");
    } catch (const ValidationError& e) {
        REQUIRE(e.reason == MalformedReason::BadRowType);
    }
}

TEST_CASE("validator: body_excerpt truncated to 256 bytes", "[validator]") {
    const std::string longBody = std::string("{\"rubbish\":\"") + std::string(500, 'X') + "\"}";
    try {
        validatePageViewsResponse(longBody);
        FAIL("expected throw");
    } catch (const ValidationError& e) {
        REQUIRE(e.body_excerpt.size() <= 256);
    }
}

TEST_CASE("validator: empty rows array is valid", "[validator]") {
    const std::string body = R"({
      "domain":"x","slug_resolved":"s","served_ts":"t",
      "rows":[],"has_more":false,"next_cursor":null
    })";
    auto page = validatePageViewsResponse(body);
    REQUIRE(page.rows.empty());
}

TEST_CASE("validator: optional fields may be absent", "[validator]") {
    // referrer, visitor_id, user_agent, ip, country, screen_width are optional
    const std::string body = R"({
      "domain":"x","slug_resolved":"s","served_ts":"t",
      "rows":[{"id":"r","page_url":"u","viewed_at":"t"}],
      "has_more":false,"next_cursor":null
    })";
    auto page = validatePageViewsResponse(body);
    REQUIRE(page.rows.size() == 1);
    REQUIRE(page.rows[0].id == "r");
}

TEST_CASE("validator: optional field with wrong type rejected", "[validator]") {
    // screen_width must be number if present
    const std::string body = R"({
      "domain":"x","slug_resolved":"s","served_ts":"t",
      "rows":[{"id":"r","page_url":"u","viewed_at":"t","screen_width":"wide"}],
      "has_more":false,"next_cursor":null
    })";
    REQUIRE_THROWS_AS(validatePageViewsResponse(body), ValidationError);
}
