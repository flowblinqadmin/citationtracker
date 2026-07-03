#include "ga_pipe/config.hpp"

#include <cstdlib>
#include <regex>
#include <stdexcept>
#include <yaml-cpp/yaml.h>

namespace ga_pipe {
namespace {

std::string expandEnv(const std::string& in) {
  static const std::regex re{R"(\$\{([A-Z_][A-Z0-9_]*)\})"};
  std::string out;
  std::string::const_iterator it = in.begin();
  std::smatch m;
  while (std::regex_search(it, in.cend(), m, re)) {
    out.append(m.prefix());
    const char* env = std::getenv(m[1].str().c_str());
    out.append(env ? env : "");
    it = m.suffix().first;
  }
  out.append(it, in.cend());
  return out;
}

std::string readStr(const YAML::Node& n, const char* k, bool required = true,
                    const std::string& dflt = "") {
  if (!n[k]) {
    if (required) throw std::runtime_error(std::string("missing required key: ") + k);
    return dflt;
  }
  return expandEnv(n[k].as<std::string>());
}

LogLevel parseLevel(const std::string& s) {
  if (s == "trace") return LogLevel::Trace;
  if (s == "debug") return LogLevel::Debug;
  if (s == "info")  return LogLevel::Info;
  if (s == "warn")  return LogLevel::Warn;
  if (s == "error") return LogLevel::Error;
  if (s == "fatal") return LogLevel::Fatal;
  throw std::runtime_error("invalid log level: " + s);
}

std::string xdgStateDir() {
  if (const char* v = std::getenv("XDG_STATE_HOME"); v && *v) return v;
  if (const char* h = std::getenv("HOME"); h && *h) return std::string(h) + "/.local/state";
  return "/tmp";
}

} // namespace

Config Config::load(const std::filesystem::path& p) {
  YAML::Node root = YAML::LoadFile(p.string());
  if (!root.IsMap()) throw std::runtime_error("pipe.yaml root must be a map");

  Config cfg;
  auto fb = root["flowblinq"];
  if (!fb || !fb.IsMap()) throw std::runtime_error("missing flowblinq section");
  cfg.flowblinq.base_url      = readStr(fb, "base_url");
  cfg.flowblinq.client_id     = readStr(fb, "client_id");
  cfg.flowblinq.client_secret = readStr(fb, "client_secret");
  cfg.flowblinq.domain        = readStr(fb, "domain");
  cfg.flowblinq.poll_interval_seconds =
      fb["poll_interval_seconds"] ? fb["poll_interval_seconds"].as<int>() : 60;
  if (cfg.flowblinq.poll_interval_seconds < 0)
    throw std::runtime_error("poll_interval_seconds must be >= 0");

  auto sink = root["sink"];
  if (!sink || !sink["template_path"])
    throw std::runtime_error("missing sink.template_path");
  cfg.sink.template_path = readStr(sink, "template_path");
  // Optional sink.secrets map (name -> value). Values support ${ENV_VAR}
  // substitution. Exposed to the sink template as top-level Inja variables.
  if (sink["secrets"] && sink["secrets"].IsMap()) {
    for (auto it : sink["secrets"]) {
      const auto key = it.first.as<std::string>();
      const auto raw = it.second.as<std::string>();
      cfg.sink.secrets[key] = expandEnv(raw);
    }
  }

  auto state = root["state"];
  const std::string defaultStateDir = xdgStateDir() + "/ga-pipe";
  cfg.state.path = state && state["path"]
      ? std::filesystem::path(readStr(state, "path"))
      : std::filesystem::path(defaultStateDir + "/state.json");
  cfg.state.deadletter_path = state && state["deadletter_path"]
      ? std::filesystem::path(readStr(state, "deadletter_path"))
      : std::filesystem::path(defaultStateDir + "/deadletter.ndjson");

  auto q = root["queue"];
  cfg.queue.capacity = (q && q["capacity"]) ? q["capacity"].as<std::size_t>() : 1000;

  auto lg = root["logging"];
  cfg.logging.level  = (lg && lg["level"])  ? parseLevel(lg["level"].as<std::string>()) : LogLevel::Info;
  cfg.logging.format = (lg && lg["format"]) ? lg["format"].as<std::string>() : "json";

  auto rd = root["reader"];
  if (rd && rd["malformed_response_threshold"])
    cfg.reader.malformed_response_threshold = rd["malformed_response_threshold"].as<int>();
  return cfg;
}

} // namespace ga_pipe
