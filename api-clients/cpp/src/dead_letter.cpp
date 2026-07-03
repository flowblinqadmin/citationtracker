#include "ga_pipe/dead_letter.hpp"

#include <fstream>
#include <nlohmann/json.hpp>

namespace ga_pipe {

DeadLetter::DeadLetter(std::filesystem::path p) : m_path(std::move(p)) {
  if (m_path.has_parent_path()) {
    std::filesystem::create_directories(m_path.parent_path());
  }
}

void DeadLetter::append(const PageView& row, const std::string& reason) {
  std::lock_guard<std::mutex> lk(m_mx);
  nlohmann::json j = {
    {"id", row.id}, {"page_url", row.page_url}, {"viewed_at", row.viewed_at},
    {"bot_name", row.bot_name}, {"reason", reason},
  };
  std::ofstream f(m_path, std::ios::app);
  f << j.dump() << '\n';
}

} // namespace ga_pipe
