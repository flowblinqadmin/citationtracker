// ES-088 — Config loader unit tests (Catch2)
//
// Spec-first. YAML parsing, env substitution, validation errors, defaults.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>
#include <cstdlib>
#include <filesystem>
#include <fstream>

#include "ga_pipe/config.hpp"

using namespace ga_pipe;
namespace fs = std::filesystem;

static fs::path writeTempYaml(const std::string& body) {
    static int counter = 0;
    auto p = fs::temp_directory_path() /
             ("ga_pipe_cfg_test_" + std::to_string(++counter) + ".yaml");
    std::ofstream f(p); f << body; return p;
}

TEST_CASE("config: full happy-path yaml loads", "[config]") {
    const auto p = writeTempYaml(R"(
flowblinq:
  base_url: https://geo.flowblinq.com
  client_id: cid-abc
  client_secret: cs-xyz
  domain: www.mysite.com
  poll_interval_seconds: 30
sink:
  template_path: sinks/ga4.yaml
state:
  path: /tmp/state.json
  deadletter_path: /tmp/dl.ndjson
queue:
  capacity: 500
logging:
  level: info
  format: json
)");
    auto cfg = Config::load(p);
    REQUIRE(cfg.flowblinq.base_url == "https://geo.flowblinq.com");
    REQUIRE(cfg.flowblinq.client_id == "cid-abc");
    REQUIRE(cfg.flowblinq.client_secret == "cs-xyz");
    REQUIRE(cfg.flowblinq.domain == "www.mysite.com");
    REQUIRE(cfg.flowblinq.poll_interval_seconds == 30);
    REQUIRE(cfg.queue.capacity == 500);
    REQUIRE(cfg.logging.level == LogLevel::Info);
    fs::remove(p);
}

TEST_CASE("config: missing required field throws", "[config][validation]") {
    const auto p = writeTempYaml(R"(
flowblinq:
  base_url: https://geo.flowblinq.com
  # missing client_id + client_secret + domain
sink: { template_path: sinks/ga4.yaml }
)");
    REQUIRE_THROWS(Config::load(p));
    fs::remove(p);
}

TEST_CASE("config: env substitution resolves $ENV_VAR", "[config][env]") {
    setenv("GA_PIPE_TEST_SECRET", "env-value-123", 1);
    const auto p = writeTempYaml(R"(
flowblinq:
  base_url: https://geo.flowblinq.com
  client_id: cid
  client_secret: ${GA_PIPE_TEST_SECRET}
  domain: x.com
sink: { template_path: s.yaml }
)");
    auto cfg = Config::load(p);
    REQUIRE(cfg.flowblinq.client_secret == "env-value-123");
    unsetenv("GA_PIPE_TEST_SECRET");
    fs::remove(p);
}

TEST_CASE("config: defaults fill in missing optional fields", "[config][defaults]") {
    const auto p = writeTempYaml(R"(
flowblinq:
  base_url: https://geo.flowblinq.com
  client_id: cid
  client_secret: cs
  domain: x.com
sink: { template_path: s.yaml }
)");
    auto cfg = Config::load(p);
    REQUIRE(cfg.flowblinq.poll_interval_seconds == 60); // default
    REQUIRE(cfg.queue.capacity == 1000);                // default
    REQUIRE(cfg.logging.level == LogLevel::Info);        // default
    // state path defaults to $XDG_STATE_HOME/ga-pipe/state.json
    REQUIRE(cfg.state.path.string().find("ga-pipe") != std::string::npos);
    fs::remove(p);
}

TEST_CASE("config: invalid log level rejected", "[config][validation]") {
    const auto p = writeTempYaml(R"(
flowblinq: { base_url: x, client_id: a, client_secret: b, domain: x.com }
sink: { template_path: s.yaml }
logging: { level: loud }
)");
    REQUIRE_THROWS(Config::load(p));
    fs::remove(p);
}

TEST_CASE("config: negative poll_interval_seconds rejected", "[config][validation]") {
    const auto p = writeTempYaml(R"(
flowblinq:
  base_url: x
  client_id: a
  client_secret: b
  domain: x.com
  poll_interval_seconds: -1
sink: { template_path: s.yaml }
)");
    REQUIRE_THROWS(Config::load(p));
    fs::remove(p);
}

TEST_CASE("config: sink.secrets map parses + env substitution", "[config][secrets]") {
    setenv("GA_PIPE_TEST_SECRET_X", "env-value-xyz", 1);
    const auto p = writeTempYaml(R"(
flowblinq:
  base_url: https://geo.flowblinq.com
  client_id: cid
  client_secret: cs
  domain: x.com
sink:
  template_path: sinks/ga4.yaml
  secrets:
    measurement_id: G-TN8E0V8JQ6
    api_secret: ${GA_PIPE_TEST_SECRET_X}
    literal_value: abc123
)");
    auto cfg = Config::load(p);
    REQUIRE(cfg.sink.secrets.size() == 3);
    REQUIRE(cfg.sink.secrets.at("measurement_id") == "G-TN8E0V8JQ6");
    REQUIRE(cfg.sink.secrets.at("api_secret") == "env-value-xyz");    // env-substituted
    REQUIRE(cfg.sink.secrets.at("literal_value") == "abc123");
    unsetenv("GA_PIPE_TEST_SECRET_X");
    fs::remove(p);
}

TEST_CASE("config: sink.secrets optional — omitting it is fine", "[config][secrets]") {
    const auto p = writeTempYaml(R"(
flowblinq: { base_url: x, client_id: a, client_secret: b, domain: x.com }
sink: { template_path: s.yaml }
)");
    auto cfg = Config::load(p);
    REQUIRE(cfg.sink.secrets.empty());
    fs::remove(p);
}
