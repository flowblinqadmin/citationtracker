#include "ga_pipe/flowblinq_reader.hpp"

#include <chrono>
#include <curl/curl.h>
#include <stdexcept>
#include <thread>

#include "ga_pipe/response_validator.hpp"

namespace ga_pipe {
namespace {

std::size_t writeCb(void* ptr, std::size_t size, std::size_t nmemb, void* userdata) {
  auto* s = static_cast<std::string*>(userdata);
  s->append(static_cast<char*>(ptr), size * nmemb);
  return size * nmemb;
}

std::size_t headerCb(char* buf, std::size_t size, std::size_t n, void* userdata) {
  auto* h = static_cast<std::string*>(userdata);
  h->append(buf, size * n);
  return size * n;
}

int parseRetryAfter(const std::string& headers) {
  // naive parse; look for "Retry-After: <n>"
  const std::string key = "Retry-After:";
  auto pos = headers.find(key);
  if (pos == std::string::npos) return 0;
  pos += key.size();
  while (pos < headers.size() && (headers[pos] == ' ' || headers[pos] == '\t')) ++pos;
  int n = 0;
  while (pos < headers.size() && std::isdigit(headers[pos])) { n = n*10 + (headers[pos]-'0'); ++pos; }
  return n;
}

} // namespace

FlowblinqReader::FlowblinqReader(const Config& cfg, AuthClient& auth)
  : m_cfg(cfg), m_auth(auth) {}

ReadPage FlowblinqReader::readPage(const std::string& cursor) {
  const std::string base = m_cfg.flowblinq.base_url + "/api/v1/page_views";
  std::string url = base + "?domain=" + m_cfg.flowblinq.domain + "&limit=1000";
  if (!cursor.empty()) url += "&cursor=" + cursor;

  const int max_attempts = 5;
  for (int attempt = 0; attempt < max_attempts; ++attempt) {
    CURL* c = curl_easy_init();
    if (!c) throw ReaderError("curl_easy_init failed");
    std::string body, hdrs;
    std::string bearer = m_auth.bearer();
    struct curl_slist* h = nullptr;
    const std::string authHeader = "Authorization: Bearer " + bearer;
    h = curl_slist_append(h, authHeader.c_str());
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, writeCb);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &body);
    curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, headerCb);
    curl_easy_setopt(c, CURLOPT_HEADERDATA, &hdrs);
    curl_easy_setopt(c, CURLOPT_TIMEOUT, 30L);
    CURLcode rc = curl_easy_perform(c);
    long status = 0;
    curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(h);
    curl_easy_cleanup(c);

    if (rc != CURLE_OK) {
      if (attempt == max_attempts - 1) throw ReaderError(curl_easy_strerror(rc));
      std::this_thread::sleep_for(std::chrono::milliseconds(200 * (1 << attempt)));
      continue;
    }
    if (status >= 200 && status < 300) {
      return validatePageViewsResponse(body);
    }
    if (status == 401) {
      m_auth.forceRefresh();
      continue;  // retry with fresh token
    }
    if (status == 429) {
      int wait_s = parseRetryAfter(hdrs);
      if (wait_s <= 0) wait_s = 1;
      std::this_thread::sleep_for(std::chrono::seconds(wait_s));
      continue;
    }
    if (status >= 500 && status < 600) {
      if (attempt == max_attempts - 1) throw ReaderError("5xx after retries: " + std::to_string(status));
      std::this_thread::sleep_for(std::chrono::milliseconds(200 * (1 << attempt)));
      continue;
    }
    // 4xx non-retriable
    throw ReaderError("client error " + std::to_string(status) + ": " + body.substr(0, 256));
  }
  throw ReaderError("unreachable");
}

} // namespace ga_pipe
