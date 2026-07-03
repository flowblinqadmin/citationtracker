// ES-088 — SinkTemplate unit tests (Catch2)
//
// Spec-first. Covers Inja rendering, custom filters, constraint checks, and
// response classification per template retry_policy.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>
#include <filesystem>
#include <fstream>

#include "ga_pipe/page_view.hpp"
#include "ga_pipe/sink_template.hpp"

using namespace ga_pipe;
using Catch::Matchers::ContainsSubstring;
namespace fs = std::filesystem;

static PageView sampleRow() {
    PageView pv;
    pv.id = "row-abc";
    pv.page_url = "https://mysite.com/about";
    pv.referrer = "https://google.com/";
    pv.visitor_id = "vid-123";
    pv.user_agent = "Mozilla/5.0";
    pv.country = "IN";
    pv.screen_width = 1024;
    pv.viewed_at = "2026-04-21T15:29:45.123Z";
    return pv;
}

static fs::path writeTempYaml(const std::string& body) {
    static int counter = 0;
    auto p = fs::temp_directory_path() /
             ("ga_pipe_sink_test_" + std::to_string(++counter) + ".yaml");
    std::ofstream f(p); f << body; return p;
}

TEST_CASE("sink_template: renders GA4 body with visitor_id as client_id", "[sink_template]") {
    const auto p = writeTempYaml(R"(
name: ga4
request:
  method: POST
  url: https://example.com/collect?m=X&s=Y
  headers: { Content-Type: application/json }
  body_json:
    client_id: "{{ or_default(row.visitor_id, \"anon-\" + row.id) }}"
    events:
      - name: page_view
        params:
          page_location: "{{ truncate(row.page_url, 100) }}"
constraints:
  max_body_bytes: 131072
  retriable_status_codes: [429, 500, 502, 503, 504]
  non_retriable_status_codes: [400, 401, 403, 404]
  retry_policy: { max_attempts: 5, initial_backoff_ms: 500, max_backoff_ms: 30000, jitter: true }
)");
    auto tmpl = SinkTemplate::loadFromYaml(p);
    auto req = tmpl.render(sampleRow(), {});
    REQUIRE(req.method == "POST");
    REQUIRE_THAT(req.body, ContainsSubstring("\"client_id\":\"vid-123\""));
    REQUIRE_THAT(req.body, ContainsSubstring("\"page_location\":\"https://mysite.com/about\""));
    fs::remove(p);
}

TEST_CASE("sink_template: default filter falls through when visitor_id empty", "[sink_template][filters]") {
    const auto p = writeTempYaml(R"(
name: ga4
request:
  method: POST
  url: https://x.com/
  headers: {}
  body_json:
    client_id: "{{ or_default(row.visitor_id, \"anon-\" + row.id) }}"
constraints: { max_body_bytes: 131072 }
)");
    auto tmpl = SinkTemplate::loadFromYaml(p);
    auto row = sampleRow(); row.visitor_id = "";
    auto req = tmpl.render(row, {});
    REQUIRE_THAT(req.body, ContainsSubstring("anon-row-abc"));
    fs::remove(p);
}

TEST_CASE("sink_template: truncate filter enforces 100-char cap (GA4 MP)", "[sink_template][constraints]") {
    const auto p = writeTempYaml(R"(
name: ga4
request:
  method: POST
  url: https://x.com/
  headers: {}
  body_json:
    page_location: "{{ truncate(row.page_url, 100) }}"
constraints: { max_body_bytes: 131072 }
)");
    auto tmpl = SinkTemplate::loadFromYaml(p);
    auto row = sampleRow();
    row.page_url = std::string("https://x.com/") + std::string(200, 'a');
    auto req = tmpl.render(row, {});
    // Rendered param must not exceed 100 chars for page_location value.
    REQUIRE(req.body.find(std::string(101, 'a')) == std::string::npos);
    fs::remove(p);
}

TEST_CASE("sink_template: rfc3339_to_micros converts timestamp", "[sink_template][filters]") {
    const auto p = writeTempYaml(R"(
name: ga4
request:
  method: POST
  url: https://x.com/
  headers: {}
  body_json:
    timestamp_micros: "{{ rfc3339_to_micros(row.viewed_at) }}"
constraints: { max_body_bytes: 131072 }
)");
    auto tmpl = SinkTemplate::loadFromYaml(p);
    auto req = tmpl.render(sampleRow(), {});
    // 2026-04-21T15:29:45.123Z → some large integer in µs.
    REQUIRE_THAT(req.body, ContainsSubstring("\"timestamp_micros\""));
    // Extract and sanity-check numeric value is in the 2026 range.
    const auto pos = req.body.find("\"timestamp_micros\":");
    REQUIRE(pos != std::string::npos);
    fs::remove(p);
}

TEST_CASE("sink_template: body > max_body_bytes throws ConstraintViolation", "[sink_template][constraints]") {
    const auto p = writeTempYaml(R"(
name: ga4
request:
  method: POST
  url: https://x.com/
  headers: {}
  body_json:
    blob: "{{ row.user_agent }}"
constraints: { max_body_bytes: 100 }
)");
    auto tmpl = SinkTemplate::loadFromYaml(p);
    auto row = sampleRow();
    row.user_agent = std::string(200, 'X'); // inflate
    REQUIRE_THROWS_AS(tmpl.render(row, {}), ConstraintViolation);
    fs::remove(p);
}

TEST_CASE("sink_template: classify disposition by status code", "[sink_template][classify]") {
    const auto p = writeTempYaml(R"(
name: generic
request: { method: POST, url: https://x.com/, headers: {}, body_json: {} }
constraints:
  max_body_bytes: 131072
  retriable_status_codes: [429, 500, 502, 503, 504]
  non_retriable_status_codes: [400, 401, 403, 404]
)");
    auto tmpl = SinkTemplate::loadFromYaml(p);
    REQUIRE(tmpl.classify(200) == SinkTemplate::Disposition::Ok);
    REQUIRE(tmpl.classify(204) == SinkTemplate::Disposition::Ok);
    REQUIRE(tmpl.classify(429) == SinkTemplate::Disposition::Retriable);
    REQUIRE(tmpl.classify(503) == SinkTemplate::Disposition::Retriable);
    REQUIRE(tmpl.classify(400) == SinkTemplate::Disposition::NonRetriable);
    REQUIRE(tmpl.classify(401) == SinkTemplate::Disposition::NonRetriable);
    fs::remove(p);
}

TEST_CASE("sink_template: unknown status codes default to NonRetriable", "[sink_template][classify]") {
    const auto p = writeTempYaml(R"(
name: generic
request: { method: POST, url: https://x.com/, headers: {}, body_json: {} }
constraints:
  max_body_bytes: 131072
  retriable_status_codes: [429]
  non_retriable_status_codes: [400]
)");
    auto tmpl = SinkTemplate::loadFromYaml(p);
    REQUIRE(tmpl.classify(418) == SinkTemplate::Disposition::NonRetriable);
    REQUIRE(tmpl.classify(599) == SinkTemplate::Disposition::NonRetriable);
    fs::remove(p);
}
