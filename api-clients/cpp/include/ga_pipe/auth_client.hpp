#pragma once
#include <chrono>
#include <mutex>
#include <stdexcept>
#include <string>

namespace ga_pipe {

struct AuthClientParams {
  std::string base_url;
  std::string client_id;
  std::string client_secret;
  int refresh_skew_seconds{60};
};

class AuthFatal : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

class AuthClient {
public:
  explicit AuthClient(AuthClientParams params);

  std::string bearer();
  void        forceRefresh();

private:
  AuthClientParams m_p;
  std::string      m_token;
  std::chrono::system_clock::time_point m_expiry;
  std::mutex       m_mx;

  std::string fetchToken();
};

} // namespace ga_pipe
