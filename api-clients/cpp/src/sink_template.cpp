#include "ga_pipe/sink_template.hpp"

#include <chrono>
#include <ctime>
#include <nlohmann/json.hpp>
#include <sstream>
#include <stdexcept>
#include <yaml-cpp/yaml.h>

namespace ga_pipe {
namespace {

std::int64_t rfc3339ToMicros(const std::string& s) {
  // Parse "YYYY-MM-DDTHH:MM:SS[.fff]Z"
  std::tm tm{};
  int year=0, mon=0, day=0, h=0, m=0, sec=0;
  double frac = 0;
  char sep1, sep2, T, c1, c2;
  std::istringstream is(s);
  is >> year >> sep1 >> mon >> sep2 >> day >> T >> h >> c1 >> m >> c2 >> sec;
  if (is.peek() == '.') {
    is.get();
    std::string fracStr;
    while (std::isdigit(is.peek())) fracStr.push_back(static_cast<char>(is.get()));
    if (!fracStr.empty()) frac = std::stod("0." + fracStr);
  }
  tm.tm_year = year - 1900;
  tm.tm_mon  = mon - 1;
  tm.tm_mday = day;
  tm.tm_hour = h;
  tm.tm_min  = m;
  tm.tm_sec  = sec;
  auto t = timegm(&tm);
  std::int64_t us = static_cast<std::int64_t>(t) * 1'000'000 +
                    static_cast<std::int64_t>(frac * 1'000'000);
  return us;
}

nlohmann::json pageViewToJson(const PageView& pv) {
  return {
    {"id", pv.id}, {"page_url", pv.page_url}, {"referrer", pv.referrer},
    {"visitor_id", pv.visitor_id}, {"user_agent", pv.user_agent},
    {"bot_name", pv.bot_name}, {"ip", pv.ip}, {"country", pv.country},
    {"screen_width", pv.screen_width}, {"viewed_at", pv.viewed_at},
    {"type", pv.type}, {"time_on_page_ms", pv.time_on_page_ms},
    {"session_id", pv.session_id},
  };
}

std::string nodeToString(const YAML::Node& n) {
  if (n.IsScalar()) return n.as<std::string>();
  std::stringstream ss; ss << n; return ss.str();
}

} // namespace

SinkTemplate SinkTemplate::loadFromYaml(const std::filesystem::path& p) {
  SinkTemplate t;
  YAML::Node root = YAML::LoadFile(p.string());

  // Custom callbacks on the inja environment
  t.m_env.add_callback("truncate", 2, [](inja::Arguments& args) -> nlohmann::json {
    const auto s = args[0]->is_string() ? args[0]->get<std::string>() : args[0]->dump();
    const auto n = args[1]->get<std::size_t>();
    return s.substr(0, std::min(n, s.size()));
  });
  t.m_env.add_callback("or_default", 2, [](inja::Arguments& args) -> nlohmann::json {
    if (args[0]->is_null()) return *args[1];
    if (args[0]->is_string() && args[0]->get<std::string>().empty()) return *args[1];
    return *args[0];
  });
  t.m_env.add_callback("rfc3339_to_micros", 1, [](inja::Arguments& args) -> nlohmann::json {
    return rfc3339ToMicros(args[0]->get<std::string>());
  });

  auto req = root["request"];
  if (!req) throw std::runtime_error("sink template: missing 'request'");
  t.m_method = req["method"] ? req["method"].as<std::string>() : "POST";
  t.m_tmpl_url = t.m_env.parse(req["url"].as<std::string>());
  if (req["headers"]) {
    for (auto it : req["headers"]) {
      t.m_tmpl_headers[it.first.as<std::string>()] =
          t.m_env.parse(it.second.as<std::string>());
    }
  }
  // body_json: store the YAML node verbatim; render walks the tree at request
  // time, Inja-renders each scalar, and assembles JSON directly. Avoids
  // double-escaping Inja expressions through JSON string encoding.
  if (req["body_json"]) {
    t.m_body_yaml = YAML::Clone(req["body_json"]);
  }

  auto cs = root["constraints"];
  if (cs) {
    auto rd = [&](const char* k, std::size_t d) {
      return cs[k] ? cs[k].as<std::size_t>() : d;
    };
    t.m_constraints.max_events_per_request = rd("max_events_per_request", 25);
    t.m_constraints.max_params_per_event   = rd("max_params_per_event", 25);
    t.m_constraints.max_param_value_bytes  = rd("max_param_value_bytes", 100);
    t.m_constraints.max_body_bytes         = rd("max_body_bytes", 131072);
    if (cs["retriable_status_codes"]) {
      for (auto n : cs["retriable_status_codes"]) t.m_retriable.insert(n.as<int>());
    }
    if (cs["non_retriable_status_codes"]) {
      for (auto n : cs["non_retriable_status_codes"]) t.m_non_retriable.insert(n.as<int>());
    }
    if (cs["retry_policy"]) {
      auto rp = cs["retry_policy"];
      if (rp["max_attempts"])       t.m_retry.max_attempts       = rp["max_attempts"].as<int>();
      if (rp["initial_backoff_ms"]) t.m_retry.initial_backoff_ms = rp["initial_backoff_ms"].as<int>();
      if (rp["max_backoff_ms"])     t.m_retry.max_backoff_ms     = rp["max_backoff_ms"].as<int>();
      if (rp["jitter"])             t.m_retry.jitter             = rp["jitter"].as<bool>();
    }
  }
  return t;
}

namespace {

// Try to coerce a rendered string into a typed JSON value:
// integer / number / bool / null, falling back to string.
nlohmann::json coerceScalar(const std::string& s) {
  if (s == "null") return nullptr;
  if (s == "true") return true;
  if (s == "false") return false;
  // integer?
  if (!s.empty()) {
    bool is_int = true;
    std::size_t start = (s[0] == '-') ? 1 : 0;
    if (start == s.size()) is_int = false;
    for (std::size_t i = start; i < s.size() && is_int; ++i)
      if (!std::isdigit(static_cast<unsigned char>(s[i]))) is_int = false;
    if (is_int) {
      try { return std::stoll(s); } catch (...) {}
    }
  }
  return s;
}

} // namespace

RenderedRequest SinkTemplate::render(const PageView& pv,
                                      const std::map<std::string,std::string>& env) const {
  nlohmann::json ctx;
  ctx["row"] = pageViewToJson(pv);
  ctx["env"] = nlohmann::json::object();
  for (const auto& [k, v] : env) {
    ctx["env"][k] = v;   // env.VAR_NAME accessors still work
    ctx[k]        = v;   // top-level {{ var_name }} also resolves — needed
                         // for sink.secrets from pipe.yaml to match template
                         // placeholders like {{ measurement_id }}.
  }

  RenderedRequest req;
  req.method = m_method;
  req.url    = m_env.render(m_tmpl_url, ctx);
  for (const auto& [k, tmpl] : m_tmpl_headers) {
    req.headers[k] = m_env.render(tmpl, ctx);
  }

  // Walk body_yaml; Inja-render each scalar against ctx; build JSON object.
  std::function<nlohmann::json(const YAML::Node&)> walk =
      [&](const YAML::Node& n) -> nlohmann::json {
    if (n.IsMap()) {
      nlohmann::json j = nlohmann::json::object();
      for (auto it : n) j[it.first.as<std::string>()] = walk(it.second);
      return j;
    }
    if (n.IsSequence()) {
      nlohmann::json j = nlohmann::json::array();
      for (auto it : n) j.push_back(walk(it));
      return j;
    }
    if (n.IsScalar()) {
      const auto raw = n.as<std::string>();
      const auto rendered = m_env.render(m_env.parse(raw), ctx);
      return coerceScalar(rendered);
    }
    return nullptr;
  };

  if (m_body_yaml) {
    req.body = walk(m_body_yaml).dump();
  }

  if (req.body.size() > m_constraints.max_body_bytes) {
    throw ConstraintViolation("oversize body: " + std::to_string(req.body.size()) +
                              " > " + std::to_string(m_constraints.max_body_bytes));
  }
  return req;
}

SinkTemplate::Disposition SinkTemplate::classify(int code) const {
  if (code >= 200 && code < 300) return Disposition::Ok;
  if (m_retriable.count(code))   return Disposition::Retriable;
  return Disposition::NonRetriable;
}

} // namespace ga_pipe
