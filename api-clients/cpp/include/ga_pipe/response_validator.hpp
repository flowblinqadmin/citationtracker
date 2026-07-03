#pragma once
#include <stdexcept>
#include <string>

#include "ga_pipe/flowblinq_reader.hpp"

namespace ga_pipe {

enum class MalformedReason {
  BadJson, MissingKey, BadType, MissingRowKey, BadRowType
};

const char* malformedReasonToStr(MalformedReason r);

struct ValidationErrorData {
  MalformedReason reason{MalformedReason::BadJson};
  std::string     detail;
  std::string     body_excerpt;
};

class ValidationError : public std::runtime_error, public ValidationErrorData {
public:
  explicit ValidationError(const ValidationErrorData& d);
};

ReadPage validatePageViewsResponse(const std::string& raw_body);

} // namespace ga_pipe
