#pragma once
#include <nlohmann/json.hpp>
#include <string>

namespace ga_pipe {

struct PageView {
  std::string id;
  std::string page_url;
  std::string referrer;
  std::string visitor_id;
  std::string user_agent;
  std::string bot_name;
  std::string ip;
  std::string country;
  int         screen_width{0};
  std::string viewed_at;
  std::string type;            // 'pageview' | 'engagement' | 'event' (default 'pageview')
  int         time_on_page_ms{0};
  std::string session_id;

  static PageView fromJson(const nlohmann::json& j);
};

struct Cursor {
  std::string viewed_at;
  std::string id;
};

std::string encodeCursor(const Cursor& c);
Cursor      decodeCursor(const std::string& s);

} // namespace ga_pipe
