#include "ga_pipe/sink.hpp"

#include <algorithm>
#include <random>

namespace ga_pipe {
namespace {
thread_local std::mt19937 tls_rng{std::random_device{}()};
}

int backoffMs(int attempt, const RetryPolicy& p) {
  long base = static_cast<long>(p.initial_backoff_ms) * (1L << attempt);
  if (base > p.max_backoff_ms) base = p.max_backoff_ms;
  if (!p.jitter) return static_cast<int>(base);
  std::uniform_int_distribution<int> d(0, static_cast<int>(base));
  return d(tls_rng);
}

int pickBackoffMs(int attempt, const RetryPolicy& p,
                  std::optional<int> retry_after_s) {
  if (retry_after_s.has_value()) return *retry_after_s * 1000;
  return backoffMs(attempt, p);
}

bool isWithinBudget(int attempt, const RetryPolicy& p) {
  return attempt < p.max_attempts;
}

} // namespace ga_pipe
