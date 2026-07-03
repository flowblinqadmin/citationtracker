#include "ga_pipe/page_view.hpp"

#include <array>
#include <cctype>
#include <cstdint>
#include <regex>
#include <stdexcept>

namespace ga_pipe {
namespace {

// RFC 4648 §5 base64url alphabet
constexpr const char* kB64U =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

std::string b64urlEncode(const std::string& in) {
  std::string out;
  out.reserve(((in.size() + 2) / 3) * 4);
  for (std::size_t i = 0; i < in.size(); i += 3) {
    std::uint32_t n = static_cast<std::uint8_t>(in[i]) << 16;
    if (i + 1 < in.size()) n |= static_cast<std::uint8_t>(in[i + 1]) << 8;
    if (i + 2 < in.size()) n |= static_cast<std::uint8_t>(in[i + 2]);
    out.push_back(kB64U[(n >> 18) & 0x3F]);
    out.push_back(kB64U[(n >> 12) & 0x3F]);
    if (i + 1 < in.size()) out.push_back(kB64U[(n >> 6) & 0x3F]);
    if (i + 2 < in.size()) out.push_back(kB64U[n & 0x3F]);
  }
  return out;
}

int b64urlCharValue(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}

std::string b64urlDecode(const std::string& in) {
  std::string out;
  out.reserve((in.size() / 4) * 3);
  std::uint32_t buf = 0;
  int bits = 0;
  for (char c : in) {
    int v = b64urlCharValue(c);
    if (v < 0) throw std::runtime_error("bad_cursor");
    buf = (buf << 6) | static_cast<std::uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<char>((buf >> bits) & 0xFF));
    }
  }
  return out;
}

const std::regex kIsoRe{R"(^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$)"};

} // namespace

PageView PageView::fromJson(const nlohmann::json& j) {
  PageView pv;
  auto strOr = [&](const char* k) -> std::string {
    if (!j.contains(k) || j[k].is_null()) return "";
    if (j[k].is_string()) return j[k].get<std::string>();
    return j[k].dump();
  };
  pv.id          = strOr("id");
  pv.page_url    = strOr("page_url");
  pv.referrer    = strOr("referrer");
  pv.visitor_id  = strOr("visitor_id");
  pv.user_agent  = strOr("user_agent");
  pv.bot_name    = strOr("bot_name");
  pv.ip          = strOr("ip");
  pv.country     = strOr("country");
  pv.viewed_at   = strOr("viewed_at");
  pv.screen_width = (j.contains("screen_width") && j["screen_width"].is_number())
      ? j["screen_width"].get<int>() : 0;
  pv.type        = strOr("type");
  pv.time_on_page_ms = (j.contains("time_on_page_ms") && j["time_on_page_ms"].is_number())
      ? j["time_on_page_ms"].get<int>() : 0;
  pv.session_id  = strOr("session_id");
  return pv;
}

std::string encodeCursor(const Cursor& c) {
  // Stable JSON: explicit key order
  std::string payload = R"({"viewed_at":")" + c.viewed_at + R"(","id":")" + c.id + R"("})";
  return b64urlEncode(payload);
}

Cursor decodeCursor(const std::string& s) {
  if (s.empty()) throw std::runtime_error("bad_cursor");
  std::string raw = b64urlDecode(s);
  auto parsed = nlohmann::json::parse(raw, nullptr, false);
  if (parsed.is_discarded()) throw std::runtime_error("bad_cursor");
  if (!parsed.is_object()) throw std::runtime_error("bad_cursor");
  if (!parsed.contains("viewed_at") || !parsed["viewed_at"].is_string())
    throw std::runtime_error("bad_cursor");
  if (!parsed.contains("id") || !parsed["id"].is_string())
    throw std::runtime_error("bad_cursor");
  Cursor c{parsed["viewed_at"].get<std::string>(), parsed["id"].get<std::string>()};
  if (!std::regex_match(c.viewed_at, kIsoRe)) throw std::runtime_error("bad_cursor");
  return c;
}

} // namespace ga_pipe
