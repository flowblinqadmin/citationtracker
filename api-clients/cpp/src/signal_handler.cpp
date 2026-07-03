#include "ga_pipe/signal_handler.hpp"

#include <csignal>

namespace ga_pipe {
namespace {
std::atomic<bool>* g_flag = nullptr;
void onSignal(int) { if (g_flag) g_flag->store(true); }
} // namespace

void installSignalHandlers(std::atomic<bool>* flag) {
  g_flag = flag;
  std::signal(SIGINT,  onSignal);
  std::signal(SIGTERM, onSignal);
}

} // namespace ga_pipe
