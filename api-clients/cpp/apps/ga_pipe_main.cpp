// ga-pipe — customer-distributable analytics forwarder (TS-088)
#include <atomic>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <string>

#include "ga_pipe/config.hpp"
#include "ga_pipe/pipe_runner.hpp"
#include "ga_pipe/signal_handler.hpp"
#include "ga_pipe/version.hpp"

int main(int argc, char** argv) {
  std::string config_path = "pipe.yaml";
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--version" || a == "-v") { std::printf("ga-pipe %s\n", ga_pipe::kVersion); return 0; }
    if (a == "--help" || a == "-h") {
      std::printf("Usage: ga-pipe [--config pipe.yaml] [--version] [--help]\n");
      return 0;
    }
    if (a == "--config" && i + 1 < argc) config_path = argv[++i];
  }

  ga_pipe::Config cfg;
  try {
    cfg = ga_pipe::Config::load(config_path);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "ga-pipe: config load failed: %s\n", e.what());
    return 2;
  }

  ga_pipe::PipeRunnerConfig rc;
  rc.flowblinq_base_url = cfg.flowblinq.base_url;
  rc.flowblinq_domain   = cfg.flowblinq.domain;
  rc.client_id          = cfg.flowblinq.client_id;
  rc.client_secret      = cfg.flowblinq.client_secret;
  rc.poll_interval_s    = cfg.flowblinq.poll_interval_seconds;
  rc.queue_capacity     = cfg.queue.capacity;
  rc.sink_yaml          = cfg.sink.template_path;
  rc.state_path         = cfg.state.path;
  rc.deadletter_path    = cfg.state.deadletter_path;
  rc.malformed_response_threshold = cfg.reader.malformed_response_threshold;
  rc.sink_secrets     = cfg.sink.secrets;

  std::atomic<bool> shutdown_flag{false};
  ga_pipe::installSignalHandlers(&shutdown_flag);

  ga_pipe::PipeRunner runner(std::move(rc));
  runner.start();

  // Main loop: wait for shutdown signal, then ask runner to drain.
  while (!shutdown_flag.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
  runner.requestShutdown();
  runner.waitForShutdown(std::chrono::seconds(30));
  return runner.exitCode();
}
