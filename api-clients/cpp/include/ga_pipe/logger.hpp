#pragma once
#include <nlohmann/json.hpp>
#include <ostream>
#include <string>

namespace ga_pipe {

enum class LogLevel { Trace, Debug, Info, Warn, Error, Fatal };

class Logger {
public:
  Logger(std::ostream& out, LogLevel min);

  void trace(const std::string& event, nlohmann::json fields = {});
  void debug(const std::string& event, nlohmann::json fields = {});
  void info (const std::string& event, nlohmann::json fields = {});
  void warn (const std::string& event, nlohmann::json fields = {});
  void error(const std::string& event, nlohmann::json fields = {});
  void fatal(const std::string& event, nlohmann::json fields = {});

  static nlohmann::json redact(nlohmann::json j);

private:
  void emit(LogLevel lvl, const std::string& event, nlohmann::json fields);
  std::ostream& m_out;
  LogLevel      m_min;
};

} // namespace ga_pipe
