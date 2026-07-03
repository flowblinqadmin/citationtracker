#pragma once
#include <atomic>
#include <chrono>
#include <filesystem>
#include <map>
#include <memory>
#include <string>
#include <thread>

namespace ga_pipe {

struct PipeRunnerConfig {
  std::string flowblinq_base_url;
  std::string flowblinq_domain;
  std::string client_id;
  std::string client_secret;
  int         poll_interval_s{60};
  std::size_t queue_capacity{1000};
  std::filesystem::path sink_yaml;
  std::filesystem::path state_path;
  std::filesystem::path deadletter_path;
  int         malformed_response_threshold{10};
  std::chrono::seconds shutdown_deadline{std::chrono::seconds(30)};
  // Sink-specific secrets (e.g. GA4 measurement_id / api_secret). Exposed to
  // sink template as top-level Inja variables at render time.
  std::map<std::string, std::string> sink_secrets;
};

class PipeRunner {
public:
  explicit PipeRunner(PipeRunnerConfig cfg);
  ~PipeRunner();

  void start();
  void requestShutdown();
  bool waitForShutdown(std::chrono::seconds timeout);
  int  exitCode() const;

private:
  struct Impl;
  std::unique_ptr<Impl> m_impl;
};

} // namespace ga_pipe
