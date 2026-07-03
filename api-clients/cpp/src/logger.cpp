#include "ga_pipe/logger.hpp"

#include <chrono>
#include <ctime>
#include <regex>
#include <string>

namespace ga_pipe {
namespace {

constexpr const char* kLevelStr[] = {"trace", "debug", "info", "warn", "error", "fatal"};
const char* levelStr(LogLevel l) { return kLevelStr[static_cast<int>(l)]; }

const std::regex kSecretKeyRe{
    R"(^(client_secret|api_secret|password|bearer|authorization|signing_secret)$)",
    std::regex::icase
};

std::string nowIso() {
  auto now = std::chrono::system_clock::now();
  auto t = std::chrono::system_clock::to_time_t(now);
  auto us = std::chrono::duration_cast<std::chrono::microseconds>(now.time_since_epoch()).count() % 1000000;
  char buf[64];
  std::tm tm{};
  gmtime_r(&t, &tm);
  std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%06ldZ",
                tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                tm.tm_hour, tm.tm_min, tm.tm_sec, us);
  return buf;
}

} // namespace

nlohmann::json Logger::redact(nlohmann::json j) {
  if (j.is_object()) {
    for (auto it = j.begin(); it != j.end(); ++it) {
      if (std::regex_match(it.key(), kSecretKeyRe)) {
        it.value() = "[REDACTED]";
      } else {
        it.value() = redact(it.value());
      }
    }
  } else if (j.is_array()) {
    for (auto& el : j) el = redact(el);
  }
  return j;
}

Logger::Logger(std::ostream& out, LogLevel min) : m_out(out), m_min(min) {}

void Logger::emit(LogLevel lvl, const std::string& event, nlohmann::json fields) {
  if (static_cast<int>(lvl) < static_cast<int>(m_min)) return;
  nlohmann::json record = {
    {"ts", nowIso()},
    {"level", levelStr(lvl)},
    {"event", event},
  };
  if (!fields.is_null()) {
    auto safe = redact(std::move(fields));
    if (safe.is_object()) {
      for (auto it = safe.begin(); it != safe.end(); ++it) {
        record[it.key()] = it.value();
      }
    } else {
      record["data"] = safe;
    }
  }
  m_out << record.dump() << '\n';
  m_out.flush();
}

void Logger::trace(const std::string& e, nlohmann::json f) { emit(LogLevel::Trace, e, std::move(f)); }
void Logger::debug(const std::string& e, nlohmann::json f) { emit(LogLevel::Debug, e, std::move(f)); }
void Logger::info (const std::string& e, nlohmann::json f) { emit(LogLevel::Info,  e, std::move(f)); }
void Logger::warn (const std::string& e, nlohmann::json f) { emit(LogLevel::Warn,  e, std::move(f)); }
void Logger::error(const std::string& e, nlohmann::json f) { emit(LogLevel::Error, e, std::move(f)); }
void Logger::fatal(const std::string& e, nlohmann::json f) { emit(LogLevel::Fatal, e, std::move(f)); }

} // namespace ga_pipe
