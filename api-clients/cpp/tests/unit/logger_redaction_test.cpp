// ES-088 — logger secret redaction tests (Catch2)
//
// Spec-first. Secret-key names must never appear verbatim in log output.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>
#include <nlohmann/json.hpp>
#include <sstream>

#include "ga_pipe/logger.hpp"

using namespace ga_pipe;
using Catch::Matchers::ContainsSubstring;

static const char* const SECRETS_MAGIC = "s3cr3t-MAGIC-token-not-a-real-secret";

TEST_CASE("logger: client_secret is redacted", "[logger][security]") {
    std::ostringstream out;
    Logger log(out, LogLevel::Info);
    log.info("auth.attempt", {{"client_secret", SECRETS_MAGIC}, {"client_id", "pub-id"}});
    const auto s = out.str();
    REQUIRE_THAT(s, !ContainsSubstring(SECRETS_MAGIC));
    REQUIRE_THAT(s, ContainsSubstring("[REDACTED]"));
    REQUIRE_THAT(s, ContainsSubstring("pub-id")); // non-secret field preserved
}

TEST_CASE("logger: api_secret is redacted (case-insensitive key)", "[logger][security]") {
    std::ostringstream out;
    Logger log(out, LogLevel::Debug);
    log.debug("sink.request", {{"API_SECRET", SECRETS_MAGIC}});
    REQUIRE_THAT(out.str(), !ContainsSubstring(SECRETS_MAGIC));
}

TEST_CASE("logger: bearer token is redacted", "[logger][security]") {
    std::ostringstream out;
    Logger log(out, LogLevel::Info);
    log.info("reader.request", {{"authorization", "Bearer " + std::string(SECRETS_MAGIC)}});
    REQUIRE_THAT(out.str(), !ContainsSubstring(SECRETS_MAGIC));
}

TEST_CASE("logger: password is redacted", "[logger][security]") {
    std::ostringstream out;
    Logger log(out, LogLevel::Warn);
    log.warn("auth.fail", {{"password", SECRETS_MAGIC}});
    REQUIRE_THAT(out.str(), !ContainsSubstring(SECRETS_MAGIC));
}

TEST_CASE("logger: nested JSON with secret key is redacted recursively", "[logger][security]") {
    std::ostringstream out;
    Logger log(out, LogLevel::Info);
    nlohmann::json payload = {
        {"meta", {{"client_secret", SECRETS_MAGIC}}},
        {"id",   "row-xyz"},
    };
    log.info("sink.payload", payload);
    REQUIRE_THAT(out.str(), !ContainsSubstring(SECRETS_MAGIC));
    REQUIRE_THAT(out.str(), ContainsSubstring("row-xyz"));
}

TEST_CASE("logger: fuzz — random secret injection across log levels never leaks", "[logger][security][fuzz]") {
    std::ostringstream out;
    Logger log(out, LogLevel::Trace);
    for (int i = 0; i < 200; ++i) {
        const auto key = (i % 4 == 0) ? "client_secret" :
                          (i % 4 == 1) ? "api_secret"     :
                          (i % 4 == 2) ? "authorization"  : "password";
        log.info("fuzz.event", {{key, SECRETS_MAGIC}});
        log.debug("fuzz.event", {{key, SECRETS_MAGIC}});
        log.warn("fuzz.event", {{key, SECRETS_MAGIC}});
        log.error("fuzz.event", {{key, SECRETS_MAGIC}});
    }
    REQUIRE_THAT(out.str(), !ContainsSubstring(SECRETS_MAGIC));
}
