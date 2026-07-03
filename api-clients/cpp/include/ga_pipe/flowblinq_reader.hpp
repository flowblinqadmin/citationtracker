#pragma once
#include <stdexcept>
#include <string>
#include <vector>

#include "ga_pipe/auth_client.hpp"
#include "ga_pipe/config.hpp"
#include "ga_pipe/page_view.hpp"

namespace ga_pipe {

struct ReadPage {
  std::vector<PageView> rows;
  bool                  has_more{false};
  std::string           next_cursor;
};

class ReaderError : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

class FlowblinqReader {
public:
  FlowblinqReader(const Config& cfg, AuthClient& auth);
  ReadPage readPage(const std::string& cursor);

private:
  const Config& m_cfg;
  AuthClient&   m_auth;
};

} // namespace ga_pipe
