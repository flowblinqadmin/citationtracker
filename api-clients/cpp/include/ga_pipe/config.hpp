#pragma once
#include <chrono>
#include <filesystem>
#include <map>
#include <string>

#include "ga_pipe/logger.hpp"

namespace ga_pipe {

struct FlowblinqConfig {
  std::string base_url;
  std::string client_id;
  std::string client_secret;
  std::string domain;
  int poll_interval_seconds{60};
};

struct SinkConfig {
  std::filesystem::path template_path;
  // Name-to-value map passed to the sink template at render time. Lets the
  // customer put GA4 credentials (or any sink-specific secrets) in the same
  // pipe.yaml as the rest of the config. Values support ${ENV_VAR}
  // substitution for env-indirect deployments.
  std::map<std::string, std::string> secrets;
};
struct StateConfig      { std::filesystem::path path; std::filesystem::path deadletter_path; };
struct QueueConfig      { std::size_t capacity{1000}; };
struct LoggingConfig    { LogLevel level{LogLevel::Info}; std::string format{"json"}; };
struct ReaderConfig     { int malformed_response_threshold{10}; };

struct Config {
  FlowblinqConfig flowblinq;
  SinkConfig      sink;
  StateConfig     state;
  QueueConfig     queue;
  LoggingConfig   logging;
  ReaderConfig    reader;

  static Config load(const std::filesystem::path& p);
};

} // namespace ga_pipe
