#pragma once
#include <filesystem>
#include <inja/inja.hpp>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <yaml-cpp/yaml.h>

#include "ga_pipe/page_view.hpp"
#include "ga_pipe/sink.hpp"

namespace ga_pipe {

struct RenderedRequest {
  std::string method;
  std::string url;
  std::map<std::string, std::string> headers;
  std::string body;
};

struct Constraints {
  std::size_t max_events_per_request{25};
  std::size_t max_params_per_event{25};
  std::size_t max_param_value_bytes{100};
  std::size_t max_body_bytes{131072};
};

class ConstraintViolation : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

class SinkTemplate {
public:
  enum class Disposition { Ok, Retriable, NonRetriable };

  static SinkTemplate loadFromYaml(const std::filesystem::path& p);

  RenderedRequest render(const PageView& pv,
                         const std::map<std::string,std::string>& env) const;
  Disposition     classify(int http_status) const;
  const RetryPolicy& retryPolicy() const { return m_retry; }

private:
  mutable inja::Environment m_env;
  inja::Template m_tmpl_url;
  std::string    m_method;
  std::map<std::string, inja::Template> m_tmpl_headers;
  YAML::Node     m_body_yaml;    // rendered leaf-by-leaf in render()
  Constraints    m_constraints;
  RetryPolicy    m_retry;
  std::set<int>  m_retriable;
  std::set<int>  m_non_retriable;
};

} // namespace ga_pipe
