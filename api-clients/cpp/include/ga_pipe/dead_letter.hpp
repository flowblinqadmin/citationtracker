#pragma once
#include <filesystem>
#include <mutex>
#include <string>

#include "ga_pipe/page_view.hpp"

namespace ga_pipe {

class DeadLetter {
public:
  explicit DeadLetter(std::filesystem::path p);
  void append(const PageView& row, const std::string& reason);

private:
  std::filesystem::path m_path;
  std::mutex            m_mx;
};

} // namespace ga_pipe
