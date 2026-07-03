// ES-088 — Mock flowblinq API server for integration tests.
// Implements a minimal /api/oauth/token + /api/v1/page_views endpoint over
// cpp-httplib on an ephemeral port. Test controls inject failure modes:
//   - forceStatusOnNth(n, status) → next n-th request returns specified status
//   - setHasMoreBatches(k) → k pages of rows then has_more=false
//   - inject429WithRetryAfter(s) → return 429 with Retry-After header
#pragma once
#include <optional>
#include <atomic>
#include <chrono>
#include <deque>
#include <functional>
#include <httplib.h>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <vector>

namespace ga_pipe::testing {

struct SeededRow {
    std::string id, page_url, referrer, visitor_id, user_agent, ip, country, viewed_at;
    int screen_width{1024};
};

class MockFlowblinqServer {
public:
    struct Forced { int status; std::optional<int> retry_after_s; };
    explicit MockFlowblinqServer(std::vector<SeededRow> rows, size_t page_size = 3)
        : m_rows(std::move(rows)), m_page_size(page_size) {
        routes();
        m_port = m_srv.bind_to_any_port("127.0.0.1");
        m_th = std::thread([this] { m_srv.listen_after_bind(); });
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    ~MockFlowblinqServer() { m_srv.stop(); if (m_th.joinable()) m_th.join(); }

    std::string baseUrl() const { return "http://127.0.0.1:" + std::to_string(m_port); }

    void queueForcedStatus(int status, std::optional<int> retry_after_s = std::nullopt) {
        std::lock_guard<std::mutex> g(m_mx);
        m_forced.push_back({status, retry_after_s});
    }
    int pageRequestCount() const { return m_page_req.load(); }
    int tokenRequestCount() const { return m_token_req.load(); }

private:
    void routes() {
        m_srv.Post("/api/oauth/token", [this](const httplib::Request&, httplib::Response& res) {
            m_token_req++;
            res.set_content(R"({"access_token":"test-jwt","expires_in":3600})", "application/json");
        });
        m_srv.Get("/api/v1/page_views", [this](const httplib::Request& req, httplib::Response& res) {
            m_page_req++;
            {
                std::lock_guard<std::mutex> g(m_mx);
                if (!m_forced.empty()) {
                    auto fs = m_forced.front(); m_forced.pop_front();
                    res.status = fs.status;
                    if (fs.retry_after_s) res.set_header("Retry-After", std::to_string(*fs.retry_after_s));
                    return;
                }
            }
            const int limit = req.has_param("limit") ? std::stoi(req.get_param_value("limit")) : 1000;
            const std::string cursor = req.get_param_value("cursor");
            size_t start = 0;
            if (!cursor.empty()) start = decodeCursorIndex(cursor);

            nlohmann::json body = {
                {"domain", req.get_param_value("domain")},
                {"slug_resolved", "mock-slug"},
                {"served_ts", "2026-04-21T15:30:00Z"},
                {"rows", nlohmann::json::array()},
                {"has_more", false},
                {"next_cursor", nullptr},
            };
            const size_t end = std::min(start + static_cast<size_t>(limit), m_rows.size());
            for (size_t i = start; i < end; ++i) {
                const auto& r = m_rows[i];
                body["rows"].push_back({
                    {"id", r.id}, {"page_url", r.page_url},
                    {"referrer", r.referrer}, {"visitor_id", r.visitor_id},
                    {"user_agent", r.user_agent}, {"ip", r.ip},
                    {"country", r.country}, {"screen_width", r.screen_width},
                    {"viewed_at", r.viewed_at},
                });
            }
            if (end < m_rows.size()) {
                body["has_more"] = true;
                body["next_cursor"] = encodeCursorIndex(end);
            }
            res.set_content(body.dump(), "application/json");
        });
    }

    static std::string encodeCursorIndex(size_t n) { return "idx:" + std::to_string(n); }
    static size_t decodeCursorIndex(const std::string& c) {
        if (c.rfind("idx:", 0) != 0) return 0;
        return std::stoull(c.substr(4));
    }
    httplib::Server m_srv;
    std::thread m_th;
    int m_port{0};
    std::vector<SeededRow> m_rows;
    size_t m_page_size;
    std::deque<Forced> m_forced;
    std::mutex m_mx;
    std::atomic<int> m_page_req{0}, m_token_req{0};
};

} // namespace ga_pipe::testing
