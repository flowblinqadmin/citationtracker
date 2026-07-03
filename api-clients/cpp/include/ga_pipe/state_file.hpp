#pragma once
#include <cstdint>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <optional>
#include <stdexcept>
#include <string>

#include "ga_pipe/page_view.hpp"

namespace ga_pipe {

struct PipeState {
  int schema_version{1};
  std::optional<Cursor> cursor;
  uint64_t served_count_total{0};
  uint64_t deadletter_count_total{0};
  std::string last_successful_sink_ts;
  std::optional<std::string> last_error;

  nlohmann::json toJson() const;
  static PipeState fromJson(const nlohmann::json& j);
};

class StateCorrupt : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};
class StateWriteError : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

class StateFile {
public:
  explicit StateFile(std::filesystem::path p);
  PipeState load() const;
  void      persist(const PipeState& s) const;

private:
  std::filesystem::path m_path;
};

} // namespace ga_pipe
