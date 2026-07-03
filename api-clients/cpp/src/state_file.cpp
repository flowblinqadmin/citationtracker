#include "ga_pipe/state_file.hpp"

#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <fstream>
#include <nlohmann/json.hpp>
#include <sstream>
#include <string>
#include <system_error>
#include <unistd.h>

namespace ga_pipe {

nlohmann::json PipeState::toJson() const {
  nlohmann::json j = {
    {"schema_version", schema_version},
    {"served_count_total", served_count_total},
    {"deadletter_count_total", deadletter_count_total},
    {"last_successful_sink_ts", last_successful_sink_ts},
    {"last_error", last_error.has_value() ? nlohmann::json(*last_error) : nlohmann::json(nullptr)},
  };
  if (cursor.has_value()) {
    j["cursor"] = { {"viewed_at", cursor->viewed_at}, {"id", cursor->id} };
  } else {
    j["cursor"] = nullptr;
  }
  return j;
}

PipeState PipeState::fromJson(const nlohmann::json& j) {
  PipeState s;
  if (!j.contains("schema_version") || !j["schema_version"].is_number_integer()) {
    throw StateCorrupt("missing schema_version");
  }
  s.schema_version = j["schema_version"].get<int>();
  if (s.schema_version != 1) {
    throw StateCorrupt("unsupported schema_version " + std::to_string(s.schema_version));
  }
  if (j.contains("cursor") && !j["cursor"].is_null()) {
    const auto& c = j["cursor"];
    if (!c.contains("viewed_at") || !c["viewed_at"].is_string() ||
        !c.contains("id") || !c["id"].is_string()) {
      throw StateCorrupt("bad cursor shape");
    }
    s.cursor = Cursor{c["viewed_at"].get<std::string>(), c["id"].get<std::string>()};
  }
  if (j.contains("served_count_total") && j["served_count_total"].is_number_unsigned())
    s.served_count_total = j["served_count_total"].get<uint64_t>();
  if (j.contains("deadletter_count_total") && j["deadletter_count_total"].is_number_unsigned())
    s.deadletter_count_total = j["deadletter_count_total"].get<uint64_t>();
  if (j.contains("last_successful_sink_ts") && j["last_successful_sink_ts"].is_string())
    s.last_successful_sink_ts = j["last_successful_sink_ts"].get<std::string>();
  if (j.contains("last_error") && j["last_error"].is_string())
    s.last_error = j["last_error"].get<std::string>();
  return s;
}

StateFile::StateFile(std::filesystem::path p) : m_path(std::move(p)) {}

PipeState StateFile::load() const {
  if (!std::filesystem::exists(m_path)) return PipeState{};
  std::ifstream f(m_path);
  if (!f) throw StateCorrupt("cannot open " + m_path.string());
  std::stringstream ss; ss << f.rdbuf();
  auto parsed = nlohmann::json::parse(ss.str(), nullptr, /*allow_exceptions=*/false);
  if (parsed.is_discarded()) throw StateCorrupt("invalid json in state file");
  return PipeState::fromJson(parsed);
}

void StateFile::persist(const PipeState& s) const {
  const auto tmp = m_path.string() + ".tmp";
  std::filesystem::create_directories(m_path.parent_path());
  {
    // Write + fsync on the temp file before rename.
    int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) throw StateWriteError("open tmp: " + std::string(std::strerror(errno)));
    const auto body = s.toJson().dump();
    const char* p = body.data();
    std::size_t left = body.size();
    while (left) {
      ssize_t n = ::write(fd, p, left);
      if (n < 0) { ::close(fd); throw StateWriteError("write: " + std::string(std::strerror(errno))); }
      p += n; left -= static_cast<std::size_t>(n);
    }
    ::fsync(fd);
    ::close(fd);
  }
  if (std::rename(tmp.c_str(), m_path.string().c_str()) != 0) {
    throw StateWriteError("rename: " + std::string(std::strerror(errno)));
  }
}

} // namespace ga_pipe
