// ES-088 — Mock GA4 Measurement Protocol endpoint for integration tests.
// Accepts POST /mp/collect, validates basic shape, records every request.
// Test can inject failure modes: forceStatusOnNth, reject-all-mode, delay.
#pragma once
#include <optional>
#include <atomic>
#include <chrono>
#include <deque>
#include <httplib.h>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <vector>

namespace ga_pipe::testing {

class MockGa4Server {
public:
    struct Forced { int status; std::optional<int> retry_after_s; };
    MockGa4Server() {
        m_srv.Post("/mp/collect", [this](const httplib::Request& req, httplib::Response& res) {
            m_req_count++;
            {
                std::lock_guard<std::mutex> g(m_mx);
                if (!m_forced.empty()) {
                    auto fs = m_forced.front(); m_forced.pop_front();
                    res.status = fs.status;
                    if (fs.retry_after_s) res.set_header("Retry-After", std::to_string(*fs.retry_after_s));
                    return;
                }
                m_bodies.push_back(req.body);
            }
            res.status = 204;
        });
        m_port = m_srv.bind_to_any_port("127.0.0.1");
        m_th = std::thread([this] { m_srv.listen_after_bind(); });
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    ~MockGa4Server() { m_srv.stop(); if (m_th.joinable()) m_th.join(); }

    std::string baseUrl() const { return "http://127.0.0.1:" + std::to_string(m_port); }
    std::string endpointUrl() const { return baseUrl() + "/mp/collect"; }
    int requestCount() const { return m_req_count.load(); }
    std::vector<std::string> bodies() const {
        std::lock_guard<std::mutex> g(m_mx);
        return m_bodies;
    }
    void queueForcedStatus(int status, std::optional<int> retry_after_s = std::nullopt) {
        std::lock_guard<std::mutex> g(m_mx);
        m_forced.push_back({status, retry_after_s});
    }

private:
    httplib::Server m_srv;
    std::thread m_th;
    int m_port{0};
    std::atomic<int> m_req_count{0};
    std::vector<std::string> m_bodies;
    std::deque<Forced> m_forced;
    mutable std::mutex m_mx;
};

} // namespace ga_pipe::testing
