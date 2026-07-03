#include "ga_pipe/auth_client.hpp"

#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <sstream>
#include <stdexcept>
#include <thread>

namespace ga_pipe {
namespace {

std::size_t writeCb(void* ptr, std::size_t size, std::size_t nmemb, void* userdata) {
  auto* s = static_cast<std::string*>(userdata);
  s->append(static_cast<char*>(ptr), size * nmemb);
  return size * nmemb;
}

struct CurlResult {
  long status{0};
  std::string body;
};

CurlResult httpPostForm(const std::string& url, const std::string& body) {
  CURL* c = curl_easy_init();
  if (!c) throw std::runtime_error("curl_easy_init failed");
  std::string resp;
  curl_easy_setopt(c, CURLOPT_URL, url.c_str());
  curl_easy_setopt(c, CURLOPT_POST, 1L);
  curl_easy_setopt(c, CURLOPT_POSTFIELDS, body.c_str());
  curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, writeCb);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, &resp);
  curl_easy_setopt(c, CURLOPT_TIMEOUT, 30L);
  struct curl_slist* h = nullptr;
  h = curl_slist_append(h, "Content-Type: application/x-www-form-urlencoded");
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
  CURLcode rc = curl_easy_perform(c);
  long status = 0;
  curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
  curl_slist_free_all(h);
  curl_easy_cleanup(c);
  if (rc != CURLE_OK) throw std::runtime_error(curl_easy_strerror(rc));
  return {status, std::move(resp)};
}

} // namespace

AuthClient::AuthClient(AuthClientParams p) : m_p(std::move(p)) {
  curl_global_init(CURL_GLOBAL_DEFAULT);
}

std::string AuthClient::fetchToken() {
  const auto url = m_p.base_url + "/api/oauth/token";
  const std::string body =
      "grant_type=client_credentials&client_id=" + m_p.client_id +
      "&client_secret=" + m_p.client_secret;

  // Retry on 5xx + transient errors.
  const int max_attempts = 5;
  for (int attempt = 0; attempt < max_attempts; ++attempt) {
    CurlResult r;
    try {
      r = httpPostForm(url, body);
    } catch (const std::exception&) {
      if (attempt == max_attempts - 1) throw;
      std::this_thread::sleep_for(std::chrono::milliseconds(100 * (1 << attempt)));
      continue;
    }
    if (r.status >= 200 && r.status < 300) {
      auto j = nlohmann::json::parse(r.body, nullptr, false);
      if (j.is_discarded() || !j.contains("access_token") || !j.contains("expires_in")) {
        throw AuthFatal("bad OAuth response shape");
      }
      m_token  = j["access_token"].get<std::string>();
      const int expires = j["expires_in"].get<int>();
      m_expiry = std::chrono::system_clock::now() + std::chrono::seconds(expires);
      return m_token;
    }
    if (r.status == 401 || r.status == 403) {
      throw AuthFatal("OAuth " + std::to_string(r.status) + ": " + r.body);
    }
    if (attempt == max_attempts - 1) {
      throw std::runtime_error("OAuth non-2xx after retries: " + std::to_string(r.status));
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100 * (1 << attempt)));
  }
  throw std::runtime_error("unreachable");
}

std::string AuthClient::bearer() {
  std::lock_guard<std::mutex> lk(m_mx);
  const auto now = std::chrono::system_clock::now();
  const auto skew = std::chrono::seconds(m_p.refresh_skew_seconds);
  if (m_token.empty() || now + skew >= m_expiry) {
    return fetchToken();
  }
  return m_token;
}

void AuthClient::forceRefresh() {
  std::lock_guard<std::mutex> lk(m_mx);
  m_token.clear();
  m_expiry = std::chrono::system_clock::time_point{};
}

} // namespace ga_pipe
