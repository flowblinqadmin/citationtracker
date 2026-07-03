#pragma once
#include <atomic>

namespace ga_pipe {

void installSignalHandlers(std::atomic<bool>* flag);

} // namespace ga_pipe
