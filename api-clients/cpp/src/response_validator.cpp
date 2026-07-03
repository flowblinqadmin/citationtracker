#include "ga_pipe/response_validator.hpp"

#include <algorithm>
#include <nlohmann/json.hpp>

namespace ga_pipe {

const char* malformedReasonToStr(MalformedReason r) {
  switch (r) {
    case MalformedReason::BadJson:       return "bad_json";
    case MalformedReason::MissingKey:    return "missing_key";
    case MalformedReason::BadType:       return "bad_type";
    case MalformedReason::MissingRowKey: return "missing_row_key";
    case MalformedReason::BadRowType:    return "bad_row_type";
  }
  return "unknown";
}

ValidationError::ValidationError(const ValidationErrorData& d)
  : std::runtime_error(d.detail), ValidationErrorData(d) {}

static std::string excerpt(const std::string& s) {
  return s.substr(0, std::min<std::size_t>(256, s.size()));
}

ReadPage validatePageViewsResponse(const std::string& raw) {
  auto j = nlohmann::json::parse(raw, nullptr, false);
  if (j.is_discarded()) {
    throw ValidationError({MalformedReason::BadJson, "parse failed", excerpt(raw)});
  }
  auto requireKey = [&](const char* k) {
    if (!j.contains(k)) {
      throw ValidationError({MalformedReason::MissingKey, k, excerpt(raw)});
    }
  };
  auto requireType = [&](const char* k, bool ok, const char* expected) {
    if (!ok) throw ValidationError({MalformedReason::BadType,
                                     std::string(k) + " expected " + expected, excerpt(raw)});
  };
  for (const char* k : {"domain", "slug_resolved", "served_ts", "rows", "has_more", "next_cursor"}) {
    requireKey(k);
  }
  requireType("domain",       j["domain"].is_string(),       "string");
  requireType("slug_resolved",j["slug_resolved"].is_string(),"string");
  requireType("served_ts",    j["served_ts"].is_string(),    "string");
  requireType("rows",         j["rows"].is_array(),          "array");
  requireType("has_more",     j["has_more"].is_boolean(),    "bool");
  requireType("next_cursor",  j["next_cursor"].is_string() || j["next_cursor"].is_null(),
                              "string-or-null");
  ReadPage page;
  page.has_more    = j["has_more"].get<bool>();
  page.next_cursor = j["next_cursor"].is_string() ? j["next_cursor"].get<std::string>() : "";
  for (const auto& row : j["rows"]) {
    for (const char* rk : {"id", "page_url", "viewed_at"}) {
      if (!row.contains(rk)) {
        throw ValidationError({MalformedReason::MissingRowKey, rk, excerpt(raw)});
      }
      if (!row[rk].is_string()) {
        throw ValidationError({MalformedReason::BadRowType,
                               std::string(rk) + " not string", excerpt(raw)});
      }
    }
    // Optional typed fields
    if (row.contains("screen_width") && !row["screen_width"].is_null()
        && !row["screen_width"].is_number()) {
      throw ValidationError({MalformedReason::BadRowType, "screen_width not number", excerpt(raw)});
    }
    page.rows.push_back(PageView::fromJson(row));
  }
  return page;
}

} // namespace ga_pipe
