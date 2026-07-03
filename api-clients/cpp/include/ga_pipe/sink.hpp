#pragma once
#include <cstdint>
#include <optional>

namespace ga_pipe {

struct RetryPolicy {
  int  max_attempts{5};
  int  initial_backoff_ms{500};
  int  max_backoff_ms{30000};
  bool jitter{true};
};

int  backoffMs(int attempt, const RetryPolicy& p);
int  pickBackoffMs(int attempt, const RetryPolicy& p,
                   std::optional<int> retry_after_s);
bool isWithinBudget(int attempt, const RetryPolicy& p);

} // namespace ga_pipe
